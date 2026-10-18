import AppIntents
import Foundation

/// A rating button on the lock-screen card. This file is compiled into the widget (to draw the
/// buttons) and into the app (plugins/withLiveActivityIntent.js): the system runs a
/// LiveActivityIntent in the app's process, waking the app if needed. The tap is queued in the
/// app's UserDefaults and announced in-process; ViibeLiveActivityModule hands it to JS.
/// Keep the key and notification name in sync with ViibeLiveActivityModule.swift.
@available(iOS 17.0, *)
struct RateVibeIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Rate the vibe"
  static var isDiscoverable: Bool = false

  @Parameter(title: "Rating")
  var value: Int

  init() {}

  init(value: Int) {
    self.value = value
  }

  func perform() async throws -> some IntentResult {
    let key = "viibe.liveActivity.pendingRatings"
    let defaults = UserDefaults.standard
    var queue = defaults.array(forKey: key) as? [[String: Any]] ?? []
    queue.append(["action": "rate", "value": value, "atMs": Date().timeIntervalSince1970 * 1000])
    defaults.set(queue, forKey: key)
    await MainActor.run {
      NotificationCenter.default.post(name: Notification.Name("ViibeLiveActivityRating"), object: nil)
    }
    return .result()
  }
}
