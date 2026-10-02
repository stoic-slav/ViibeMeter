import AVFoundation
import ExpoModulesCore
import ShazamKit

/// Matches an already-recorded audio file against the Shazam catalog.
/// Only a signature (an irreversible fingerprint) leaves the device, never the audio itself.
public class ShazamMatchModule: Module {
  // SHSession holds its delegate weakly, so keep both alive until the match finishes.
  private var inFlight: [UUID: (SHSession, MatchDelegate)] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("ShazamMatch")

    AsyncFunction("matchFile") { (uri: String, promise: Promise) in
      let url = URL(string: uri).flatMap { $0.isFileURL ? $0 : nil } ?? URL(fileURLWithPath: uri)

      let signature: SHSignature
      do {
        let file = try AVAudioFile(forReading: url)
        guard let buffer = AVAudioPCMBuffer(
          pcmFormat: file.processingFormat,
          frameCapacity: AVAudioFrameCount(file.length)
        ) else {
          promise.resolve(["matched": false, "error": "could not allocate audio buffer"])
          return
        }
        try file.read(into: buffer)
        let generator = SHSignatureGenerator()
        try generator.append(buffer, at: nil)
        signature = generator.signature()
      } catch {
        promise.resolve(["matched": false, "error": "signature: \(error.localizedDescription)"])
        return
      }

      let id = UUID()
      let delegate = MatchDelegate { [weak self] result in
        promise.resolve(result)
        self?.lock.lock()
        self?.inFlight.removeValue(forKey: id)
        self?.lock.unlock()
      }
      let session = SHSession()
      session.delegate = delegate
      self.lock.lock()
      self.inFlight[id] = (session, delegate)
      self.lock.unlock()
      session.match(signature)
    }
  }
}

private final class MatchDelegate: NSObject, SHSessionDelegate {
  private let onDone: ([String: Any]) -> Void
  private var finished = false

  init(onDone: @escaping ([String: Any]) -> Void) {
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
    ])
  }

  func session(_ session: SHSession, didNotFindMatchFor signature: SHSignature, error: Error?) {
    var result: [String: Any] = ["matched": false]
    if let error = error { result["error"] = error.localizedDescription }
    finish(result)
  }
}
