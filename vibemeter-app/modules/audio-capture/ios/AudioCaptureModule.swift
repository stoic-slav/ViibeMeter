import AVFoundation
import ExpoModulesCore
import ShazamKit

/// Keeps the microphone open for the whole session and holds only the last few seconds
/// of audio in a memory ring buffer (never written to disk). An always-running audio
/// input is what lets iOS keep the app alive in the background (UIBackgroundModes: audio);
/// recording in separate clips with gaps let iOS suspend the app between clips.
public class AudioCaptureModule: Module {
  private static let sampleRate: Double = 44100

  private let engine = AVAudioEngine()
  private let ringQueue = DispatchQueue(label: "vibemeter.audiocapture.ring")
  private var ring: [Int16] = []
  private var writeIndex = 0
  private var filled = 0
  private var lastSampleWallMs: Double = 0
  private var converter: AVAudioConverter?
  private var outFormat: AVAudioFormat?
  private var bufferSeconds: Double = 12
  private var running = false
  private var observers: [NSObjectProtocol] = []

  // Bass envelope (room fingerprint): 40–150 Hz band energy per 250 ms wall-clock frame.
  // Frame index = floor(wall ms / 250), so frames line up across phones. Only per-frame
  // sums of squares are kept (15 minutes), never the audio.
  static let bassFrameMs: Double = 250
  private static let bassKeepFrames: Int64 = 3600
  private var bassHP = Biquad.highPass(fc: 40, fs: AudioCaptureModule.sampleRate)
  private var bassLP = Biquad.lowPass(fc: 150, fs: AudioCaptureModule.sampleRate)
  private var bassFrames: [Int64: (sumSq: Double, count: Int)] = [:]

  // SHSession holds its delegate weakly, so keep both alive until the match finishes.
  private var inFlight: [UUID: (SHSession, MatchDelegate)] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("AudioCapture")

    AsyncFunction("start") { (seconds: Double) in
      try self.start(bufferSeconds: seconds)
    }

    AsyncFunction("stop") {
      self.stop()
    }

    Function("isRunning") { () -> Bool in
      self.running && self.engine.isRunning
    }

    /// The most recent `seconds` of audio as base64 16-bit mono PCM at 44.1 kHz, plus the
    /// wall-clock time (ms since epoch) of its first sample so it lines up with motion data.
    AsyncFunction("readRecent") { (seconds: Double) -> [String: Any] in
      let (samples, startMs) = self.copyRecent(seconds: seconds)
      let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
      return [
        "pcm": data.base64EncodedString(),
        "count": samples.count,
        "sampleRate": AudioCaptureModule.sampleRate,
        "startMs": startMs,
      ]
    }

    /// Audio from the wall-clock range [fromMs, toMs), clipped to what the buffer holds, so
    /// every phone analyses the same seconds (cycles are aligned to :00, :10, :20 …).
    AsyncFunction("readRange") { (fromMs: Double, toMs: Double) -> [String: Any] in
      let (samples, startMs) = self.copyRange(fromMs: fromMs, toMs: toMs)
      let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
      return [
        "pcm": data.base64EncodedString(),
        "count": samples.count,
        "sampleRate": AudioCaptureModule.sampleRate,
        "startMs": startMs,
      ]
    }

    /// Bass level (dB, uncalibrated) per 250 ms frame in [fromMs, toMs). nil where fewer than
    /// half of the frame's samples were captured.
    AsyncFunction("getBassEnvelope") { (fromMs: Double, toMs: Double) -> [Double?] in
      self.bassEnvelope(fromMs: fromMs, toMs: toMs)
    }

    /// Match the most recent audio against the Shazam catalog. Only the signature
    /// (an irreversible fingerprint) leaves the device.
    AsyncFunction("matchRecent") { (seconds: Double, promise: Promise) in
      self.matchRecent(seconds: seconds, promise: promise)
    }
  }

  // MARK: - Capture

  private func start(bufferSeconds: Double) throws {
    if running && engine.isRunning { return }
    self.bufferSeconds = max(1, bufferSeconds)

    let session = AVAudioSession.sharedInstance()
    // measurement mode turns off automatic gain, so dB levels stay comparable;
    // mixWithOthers avoids interrupting other audio on the phone.
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP])
    try session.setActive(true)

    ringQueue.sync {
      ring = [Int16](repeating: 0, count: Int(self.bufferSeconds * AudioCaptureModule.sampleRate))
      writeIndex = 0
      filled = 0
    }
    try configureAndStartEngine()
    running = true
    addObservers()
  }

  private func configureAndStartEngine() throws {
    let input = engine.inputNode
    input.removeTap(onBus: 0)
    let inFormat = input.outputFormat(forBus: 0)
    guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
      throw NSError(domain: "AudioCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "no microphone input available"])
    }
    guard let out = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: AudioCaptureModule.sampleRate, channels: 1, interleaved: true),
          let conv = AVAudioConverter(from: inFormat, to: out) else {
      throw NSError(domain: "AudioCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not create audio converter"])
    }
    outFormat = out
    converter = conv
    ringQueue.sync {
      bassHP.reset()
      bassLP.reset()
    }

    input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, when in
      self?.handle(buffer: buffer, when: when)
    }
    engine.prepare()
    try engine.start()
  }

  private func handle(buffer: AVAudioPCMBuffer, when: AVAudioTime) {
    guard let converter = converter, let outFormat = outFormat else { return }
    let ratio = AudioCaptureModule.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }

    var consumed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, let channel = out.int16ChannelData else { return }
    let n = Int(out.frameLength)
    if n == 0 { return }

    // Wall-clock time of the end of this buffer, derived from its host time
    let nowMs = Date().timeIntervalSince1970 * 1000
    var endMs = nowMs
    if when.isHostTimeValid {
      let ageSec = AVAudioTime.seconds(forHostTime: mach_absolute_time()) - AVAudioTime.seconds(forHostTime: when.hostTime)
      endMs = nowMs - ageSec * 1000 + Double(buffer.frameLength) / buffer.format.sampleRate * 1000
    }

    ringQueue.sync {
      let cap = ring.count
      if cap == 0 { return }
      for i in 0..<n {
        ring[writeIndex] = channel[0][i]
        writeIndex = (writeIndex + 1) % cap
      }
      filled = min(cap, filled + n)
      lastSampleWallMs = endMs
      accumulateBass(channel[0], count: n, endMs: endMs)
    }
  }

  /// Band-pass the samples and add their energy to the 250 ms frame each sample falls in.
  /// Called on ringQueue.
  private func accumulateBass(_ samples: UnsafeMutablePointer<Int16>, count n: Int, endMs: Double) {
    let msPerSample = 1000 / AudioCaptureModule.sampleRate
    let startMs = endMs - Double(n) * msPerSample
    var frame = Int64(floor(startMs / AudioCaptureModule.bassFrameMs))
    var nextBoundary = Double(frame + 1) * AudioCaptureModule.bassFrameMs
    var sumSq = 0.0, cnt = 0
    for i in 0..<n {
      let t = startMs + Double(i) * msPerSample
      if t >= nextBoundary {
        commitBass(frame, sumSq, cnt)
        frame = Int64(floor(t / AudioCaptureModule.bassFrameMs))
        nextBoundary = Double(frame + 1) * AudioCaptureModule.bassFrameMs
        sumSq = 0; cnt = 0
      }
      let y = bassLP.process(bassHP.process(Double(samples[i]) / 32768))
      sumSq += y * y
      cnt += 1
    }
    commitBass(frame, sumSq, cnt)
    let oldest = frame - AudioCaptureModule.bassKeepFrames
    if bassFrames.count > Int(AudioCaptureModule.bassKeepFrames) + 100 {
      bassFrames = bassFrames.filter { $0.key >= oldest }
    }
  }

  private func commitBass(_ frame: Int64, _ sumSq: Double, _ cnt: Int) {
    guard cnt > 0 else { return }
    let prev = bassFrames[frame] ?? (0, 0)
    bassFrames[frame] = (prev.sumSq + sumSq, prev.count + cnt)
  }

  private func bassEnvelope(fromMs: Double, toMs: Double) -> [Double?] {
    let first = Int64(ceil(fromMs / AudioCaptureModule.bassFrameMs))
    let end = Int64(ceil(toMs / AudioCaptureModule.bassFrameMs))
    guard end > first else { return [] }
    let needed = Int(AudioCaptureModule.sampleRate * AudioCaptureModule.bassFrameMs / 1000 / 2)
    return ringQueue.sync {
      (first..<end).map { k -> Double? in
        guard let f = bassFrames[k], f.count >= needed, f.count > 0 else { return nil }
        return 10 * log10(f.sumSq / Double(f.count) + 1e-12)
      }
    }
  }

  private func copyRange(fromMs: Double, toMs: Double) -> ([Int16], Double) {
    return ringQueue.sync {
      let cap = ring.count
      if cap == 0 || filled == 0 || toMs <= fromMs { return ([], 0) }
      let sr = AudioCaptureModule.sampleRate
      let bufferStartMs = lastSampleWallMs - Double(filled) / sr * 1000
      let from = max(fromMs, bufferStartMs)
      let to = min(toMs, lastSampleWallMs)
      if to <= from { return ([], 0) }
      // Samples counted back from the newest one
      let endBack = Int(((lastSampleWallMs - to) / 1000 * sr).rounded())
      let want = Int(((to - from) / 1000 * sr).rounded())
      if want <= 0 { return ([], 0) }
      var out = [Int16](repeating: 0, count: want)
      var idx = (writeIndex - endBack - want + 2 * cap) % cap
      for i in 0..<want {
        out[i] = ring[idx]
        idx = (idx + 1) % cap
      }
      return (out, from)
    }
  }

  private func copyRecent(seconds: Double) -> ([Int16], Double) {
    return ringQueue.sync {
      let cap = ring.count
      let want = min(filled, Int(seconds * AudioCaptureModule.sampleRate))
      if cap == 0 || want == 0 { return ([], 0) }
      var out = [Int16](repeating: 0, count: want)
      var idx = (writeIndex - want + cap) % cap
      for i in 0..<want {
        out[i] = ring[idx]
        idx = (idx + 1) % cap
      }
      let startMs = lastSampleWallMs - Double(want) / AudioCaptureModule.sampleRate * 1000
      return (out, startMs)
    }
  }

  private func stop() {
    removeObservers()
    if running {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    running = false
    // Drop the buffered audio as soon as the session ends
    ringQueue.sync {
      ring = []
      writeIndex = 0
      filled = 0
      bassFrames = [:]
    }
  }

  // MARK: - Interruptions and route changes

  private func addObservers() {
    removeObservers()
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      guard let self = self, self.running,
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
      self.restart()
    })
    observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      guard let self = self, self.running else { return }
      self.restart()
    })
    observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self = self, self.running else { return }
      self.restart()
    })
  }

  private func removeObservers() {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
  }

  private func restart() {
    engine.stop()
    try? AVAudioSession.sharedInstance().setActive(true)
    try? configureAndStartEngine()
  }

  // MARK: - ShazamKit

  private func matchRecent(seconds: Double, promise: Promise) {
    let (samples, queryStartMs) = copyRecent(seconds: seconds)
    guard samples.count > Int(AudioCaptureModule.sampleRate * 2),
          let format = AVAudioFormat(standardFormatWithSampleRate: AudioCaptureModule.sampleRate, channels: 1),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
          let channel = buffer.floatChannelData else {
      promise.resolve(["matched": false, "error": "not enough audio"])
      return
    }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    for i in 0..<samples.count {
      channel[0][i] = Float(samples[i]) / 32768
    }

    let signature: SHSignature
    do {
      let generator = SHSignatureGenerator()
      try generator.append(buffer, at: nil)
      signature = generator.signature()
    } catch {
      promise.resolve(["matched": false, "error": "signature: \(error.localizedDescription)"])
      return
    }

    let id = UUID()
    let delegate = MatchDelegate(queryStartMs: queryStartMs) { [weak self] result in
      promise.resolve(result)
      self?.lock.lock()
      self?.inFlight.removeValue(forKey: id)
      self?.lock.unlock()
    }
    let session = SHSession()
    session.delegate = delegate
    lock.lock()
    inFlight[id] = (session, delegate)
    lock.unlock()
    session.match(signature)
  }
}

private final class MatchDelegate: NSObject, SHSessionDelegate {
  private let onDone: ([String: Any]) -> Void
  private let queryStartMs: Double
  private var finished = false

  init(queryStartMs: Double, onDone: @escaping ([String: Any]) -> Void) {
    self.queryStartMs = queryStartMs
    self.onDone = onDone
  }

  private func finish(_ result: [String: Any]) {
    guard !finished else { return }
    finished = true
    onDone(result)
  }

  func session(_ session: SHSession, didFind match: SHMatch) {
    guard let item = match.mediaItems.first else {
      finish(["matched": false])
      return
    }
    finish([
      "matched": true,
      "title": item.title ?? NSNull(),
      "artist": item.artist ?? NSNull(),
      "isrc": item.isrc ?? NSNull(),
      "genres": item.genres,
      "appleMusicID": item.appleMusicID ?? NSNull(),
      // matchOffset: position in the track (s) where the query audio starts. Subtracting it from
      // the query's wall-clock start gives when this playback of the track began, which is the
      // same for every phone hearing the same speakers.
      "matchOffset": item.matchOffset,
      "queryStartMs": queryStartMs,
      "trackStartMs": queryStartMs - item.matchOffset * 1000,
    ])
  }

  func session(_ session: SHSession, didNotFindMatchFor signature: SHSignature, error: Error?) {
    var result: [String: Any] = ["matched": false]
    if let error = error { result["error"] = error.localizedDescription }
    finish(result)
  }
}

/// Second-order IIR section (RBJ cookbook), transposed direct form II. The same filters are
/// implemented in src/processing/BassEnvelope.ts for Android, so both platforms measure the
/// same band.
struct Biquad {
  let b0, b1, b2, a1, a2: Double
  var z1 = 0.0, z2 = 0.0

  static func lowPass(fc: Double, fs: Double, q: Double = 0.7071) -> Biquad {
    let w0 = 2 * Double.pi * fc / fs, c = cos(w0), alpha = sin(w0) / (2 * q), a0 = 1 + alpha
    return Biquad(b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0)
  }

  static func highPass(fc: Double, fs: Double, q: Double = 0.7071) -> Biquad {
    let w0 = 2 * Double.pi * fc / fs, c = cos(w0), alpha = sin(w0) / (2 * q), a0 = 1 + alpha
    return Biquad(b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0)
  }

  mutating func process(_ x: Double) -> Double {
    let y = b0 * x + z1
    z1 = b1 * x - a1 * y + z2
    z2 = b2 * x - a2 * y
    return y
  }

  mutating func reset() { z1 = 0; z2 = 0 }
}
