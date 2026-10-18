import ActivityKit
import Foundation

/// The session's lock-screen card. ActivityKit matches the app's and the widget's copies of this
/// type by name and Codable shape, so keep it identical to
/// `modules/live-activity/ios/SessionActivityAttributes.swift`.
@available(iOS 16.2, *)
struct SessionActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var mode: String              // "session", "standby" (Going out) or "prompt" (sounds like a party)
    var sessionStartedAt: Date?   // the session timer counts from here (nil on standby)
    var venue: String?
    var due: Bool                 // a rating prompt is waiting
    var lastRating: Int?          // 1 / 3 / 5
    var thanksUntil: Date?        // show "Thanks" until then
  }

  var startedAt: Date             // when the card appeared (session start, or standby start)
}
