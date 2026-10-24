import AVFoundation
import CoreMotion
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
  // DJ edits (build 25): reference fingerprints of music Apple's catalog doesn't know, labelled
  // with the DJ (from a venue lineup or a DJ's own registration). Matched on the phone.
  private var editCatalog: SHCustomCatalog?
  private var editCatalogSize = 0
  static let editIdKey = SHMediaItemProperty("viibeEditId")
  // Continuous fingerprints, fed from the tap on their own queue: a DJ's reference recording, and
  // during sessions a rolling 30 s fingerprint (contiguous, so prints taken at a known set cover
  // an edit end to end and a later 8 s query falls inside one of them)
  private let sigQueue = DispatchQueue(label: "vibemeter.audiocapture.signatures")
  private var refGenerator: SHSignatureGenerator?
  private var rollingEnabled = false
  private var rollGenerator: SHSignatureGenerator?
  private var rollStartMs: Double = 0
  private var rolled: (data: Data, startMs: Double, endMs: Double)?
  private static let rollMs: Double = 30_000
  private let lock = NSLock()
  private let activityManager = CMMotionActivityManager()

  public func definition() -> ModuleDefinition {
    Name("AudioCapture")

    AsyncFunction("start") { (seconds: Double) in
      try self.start(bufferSeconds: seconds)
    }

    AsyncFunction("stop") {
      self.stop()
    }

    /// Keeps a file or folder out of iCloud and device backups (the "best moments" clips).
    Function("excludeFromBackup") { (path: String) -> Bool in
      var url = path.hasPrefix("file://") ? (URL(string: path) ?? URL(fileURLWithPath: path)) : URL(fileURLWithPath: path)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      do {
        try url.setResourceValues(values)
        return true
      } catch {
        return false
      }
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

    /// The DJ edit catalog: [{ id, signature (base64 ShazamKit signature), dj, title }].
    /// Returns how many references were loaded.
    AsyncFunction("loadEditCatalog") { (entries: [[String: Any]]) -> Int in
      let catalog = SHCustomCatalog()
      var count = 0
      for entry in entries {
        guard let b64 = entry["signature"] as? String, let data = Data(base64Encoded: b64),
              let signature = try? SHSignature(dataRepresentation: data) else { continue }
        var properties: [SHMediaItemProperty: Any] = [AudioCaptureModule.editIdKey: entry["id"] as? String ?? ""]
        if let dj = entry["dj"] as? String { properties[.artist] = dj }
        if let title = entry["title"] as? String { properties[.title] = title }
        if (try? catalog.addReferenceSignature(signature, representing: [SHMediaItem(properties: properties)])) != nil {
          count += 1
        }
      }
      self.lock.lock()
      self.editCatalog = count > 0 ? catalog : nil
      self.editCatalogSize = count
      self.lock.unlock()
      return count
    }

    /// Rolling 30 s fingerprints during a session (off on standby and outside sessions).
    Function("setRollingPrints") { (enabled: Bool) in
      self.sigQueue.async {
        self.rollingEnabled = enabled
        self.rollGenerator = nil
        self.rollStartMs = 0
        if !enabled { self.rolled = nil }
      }
    }

    /// The latest completed 30 s fingerprint (taken once): { signature, startMs, endMs } or null.
    AsyncFunction("takeRolledSignature") { () -> [String: Any]? in
      return self.sigQueue.sync {
        guard let r = self.rolled else { return nil }
        self.rolled = nil
        return ["signature": r.data.base64EncodedString(), "startMs": r.startMs, "endMs": r.endMs]
      }
    }

    /// A DJ's reference recording: one continuous fingerprint from begin to end.
    Function("beginReferenceSignature") {
      self.sigQueue.async { self.refGenerator = SHSignatureGenerator() }
    }

    AsyncFunction("endReferenceSignature") { () -> String? in
      return self.sigQueue.sync {
        defer { self.refGenerator = nil }
        return self.refGenerator?.signature().dataRepresentation.base64EncodedString()
      }
    }

    /// A fingerprint of the last `seconds` of audio (base64), for a DJ registering an edit.
    AsyncFunction("signatureRecent") { (seconds: Double) -> String? in
      return self.makeSignature(seconds: seconds).0?.dataRepresentation.base64EncodedString()
    }

    /// Going out standby: whether iOS's motion coprocessor says the phone is in a vehicle now
    /// (a car radio is not a party). False when unknown or Motion & Fitness is not allowed;
    /// never asks for the permission, since standby runs in the background.
    AsyncFunction("isInVehicle") { (promise: Promise) in
      guard CMMotionActivityManager.isActivityAvailable(),
            CMMotionActivityManager.authorizationStatus() == .authorized else {
        promise.resolve(false)
        return
      }
      let now = Date()
      self.activityManager.queryActivityStarting(from: now.addingTimeInterval(-300), to: now, to: .main) { activities, _ in
        guard let last = activities?.last else {
          promise.resolve(false)
          return
        }
        promise.resolve(last.automotive && last.confidence != .low)
      }
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

    feedSignatures(channel: channel[0], count: n, endMs: endMs)

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

  /// Feeds the continuous fingerprint generators (only while one is active).
  private func feedSignatures(channel: UnsafeMutablePointer<Int16>, count n: Int, endMs: Double) {
    guard refGenerator != nil || rollingEnabled,
          let format = AVAudioFormat(standardFormatWithSampleRate: AudioCaptureModule.sampleRate, channels: 1),
          let floatBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)),
          let out = floatBuffer.floatChannelData else { return }
    floatBuffer.frameLength = AVAudioFrameCount(n)
    for i in 0..<n { out[0][i] = Float(channel[i]) / 32768 }
    sigQueue.async {
      if let ref = self.refGenerator { try? ref.append(floatBuffer, at: nil) }
      guard self.rollingEnabled else { return }
      if self.rollGenerator == nil {
        self.rollGenerator = SHSignatureGenerator()
        self.rollStartMs = endMs - Double(n) / AudioCaptureModule.sampleRate * 1000
      }
      try? self.rollGenerator?.append(floatBuffer, at: nil)
      if endMs - self.rollStartMs >= AudioCaptureModule.rollMs, let gen = self.rollGenerator {
        self.rolled = (gen.signature().dataRepresentation, self.rollStartMs, endMs)
        self.rollGenerator = nil
      }
    }
  }

  /// A ShazamKit signature (an irreversible fingerprint) of the last `seconds` of audio.
  private func makeSignature(seconds: Double) -> (SHSignature?, Double, String?) {
    let (samples, queryStartMs) = copyRecent(seconds: seconds)
    guard samples.count > Int(AudioCaptureModule.sampleRate * 2),
          let format = AVAudioFormat(standardFormatWithSampleRate: AudioCaptureModule.sampleRate, channels: 1),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
          let channel = buffer.floatChannelData else {
      return (nil, queryStartMs, "not enough audio")
    }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    for i in 0..<samples.count {
      channel[0][i] = Float(samples[i]) / 32768
    }
    do {
      let generator = SHSignatureGenerator()
      try generator.append(buffer, at: nil)
      return (generator.signature(), queryStartMs, nil)
    } catch {
      return (nil, queryStartMs, "signature: \(error.localizedDescription)")
    }
  }

  /// Apple's catalog first. Without a match, the result also carries the fingerprint (to learn
  /// DJ edits from) and, when an edit catalog is loaded, any DJ edit it matches.
  private func matchRecent(seconds: Double, promise: Promise) {
    let (made, queryStartMs, error) = makeSignature(seconds: seconds)
    guard let signature = made else {
      promise.resolve(["matched": false, "error": error ?? "signature"])
      return
    }

    run(signature: signature, catalog: nil, queryStartMs: queryStartMs) { [weak self] result in
      guard let self = self, (result["matched"] as? Bool) != true else {
        promise.resolve(result)
        return
      }
      var unmatched = result
      unmatched["signature"] = signature.dataRepresentation.base64EncodedString()
      self.lock.lock()
      let catalog = self.editCatalog
      self.lock.unlock()
      guard let editCatalog = catalog else {
        promise.resolve(unmatched)
        return
      }
      self.run(signature: signature, catalog: editCatalog, queryStartMs: queryStartMs) { edit in
        if (edit["matched"] as? Bool) == true {
          unmatched["edit"] = ["id": edit["editId"] ?? NSNull(), "dj": edit["artist"] ?? NSNull(), "title": edit["title"] ?? NSNull()]
        }
        promise.resolve(unmatched)
      }
    }
  }

  private func run(signature: SHSignature, catalog: SHCatalog?, queryStartMs: Double, done: @escaping ([String: Any]) -> Void) {
    let id = UUID()
    let delegate = MatchDelegate(queryStartMs: queryStartMs) { [weak self] result in
      done(result)
      self?.lock.lock()
      self?.inFlight.removeValue(forKey: id)
      self?.lock.unlock()
    }
    let session = catalog.map { SHSession(catalog: $0) } ?? SHSession()
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
      "editId": item[AudioCaptureModule.editIdKey] ?? NSNull(),
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
