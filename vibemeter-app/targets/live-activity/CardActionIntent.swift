import AppIntents
import Foundation

/// The Going out buttons on the lock-screen card: "start" (Yes, start measuring), "not_now"
/// and "standby_off". This file is compiled into the widget and the app
/// (plugins/withLiveActivityIntent.js); the system runs it in the app's process, where the tap is
/// queued for JS. Keep the key and notification name in sync with ViibeLiveActivityModule.swift.
@available(iOS 17.0, *)
struct CardActionIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Viibe Check card action"
  static var isDiscoverable: Bool = false

  @Parameter(title: "Action")
  var action: String

  init() {}

  init(action: String) {
    self.action = action
  }

  func perform() async throws -> some IntentResult {
    let key = "viibe.liveActivity.pendingRatings"
    let defaults = UserDefaults.standard
    var queue = defaults.array(forKey: key) as? [[String: Any]] ?? []
    queue.append(["action": action, "atMs": Date().timeIntervalSince1970 * 1000])
    defaults.set(queue, forKey: key)
    await MainActor.run {
      NotificationCenter.default.post(name: Notification.Name("ViibeLiveActivityRating"), object: nil)
    }
    return .result()
  }
}
