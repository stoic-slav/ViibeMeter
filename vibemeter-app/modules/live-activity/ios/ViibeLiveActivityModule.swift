import ActivityKit
import ExpoModulesCore
import Foundation

/// Shared with the card's intents (`RateVibeIntent`, `CardActionIntent`, compiled into the app
/// target): a tap on a card button is queued here and announced in-process, and JS drains the
/// queue. Keep the names in sync.
private let pendingRatingsKey = "viibe.liveActivity.pendingRatings"
private let ratingNotification = Notification.Name("ViibeLiveActivityRating")

/// How long the card counts as current without an update. The app renews it every few minutes,
/// so a card that goes stale means the app stopped (killed or crashed): the card then says so.
private let staleAfter: TimeInterval = 15 * 60

struct CardState: Record {
  @Field var mode: String = "session"
  @Field var sessionStartedAtMs: Double? = nil
  @Field var venue: String? = nil
  @Field var due: Bool = false
  @Field var lastRating: Int? = nil
  @Field var thanksUntilMs: Double? = nil
}

/// Lights the screen and plays the alert sound with an update (the Going out prompt).
struct CardAlert: Record {
  @Field var title: String = ""
  @Field var body: String = ""
}

/// The lock-screen Live Activity of a running session (iOS 16.2+; rating buttons need iOS 17).
/// Started and updated locally: the session's open microphone keeps the app running, so no push.
public class ViibeLiveActivityModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("ViibeLiveActivity")

    Events("onRating")

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(
        forName: ratingNotification, object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onRating", [:])
      }
    }

    OnStopObserving {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      self.observer = nil
    }

    /// False below iOS 16.2 or when the user turned Live Activities off for the app.
    Function("isSupported") { () -> Bool in
      if #available(iOS 16.2, *) { return ActivityAuthorizationInfo().areActivitiesEnabled }
      return false
    }

    /// Starts the card (ending any left from an earlier run). Must run with the app in the foreground.
    AsyncFunction("start") { (startedAtMs: Double, state: CardState) -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      await Self.endAll()
      let attributes = SessionActivityAttributes(startedAt: Date(timeIntervalSince1970: startedAtMs / 1000))
      do {
        _ = try Activity.request(attributes: attributes, content: Self.content(state), pushType: nil)
        return true
      } catch {
        print("[ViibeLiveActivity] start failed: \(error)")
        return false
      }
    }

    AsyncFunction("update") { (state: CardState, alert: CardAlert?) in
      guard #available(iOS 16.2, *) else { return }
      for activity in Activity<SessionActivityAttributes>.activities {
        if let alert = alert {
          let config = AlertConfiguration(
            title: LocalizedStringResource(stringLiteral: alert.title),
            body: LocalizedStringResource(stringLiteral: alert.body),
            sound: .default
          )
          await activity.update(Self.content(state), alertConfiguration: config)
        } else {
          await activity.update(Self.content(state))
        }
      }
    }

    AsyncFunction("end") {
      guard #available(iOS 16.2, *) else { return }
      await Self.endAll()
    }

    /// Number of cards on screen (0 or 1); a card left from a killed run shows up here.
    Function("activeCount") { () -> Int in
      if #available(iOS 16.2, *) { return Activity<SessionActivityAttributes>.activities.count }
      return 0
    }

    /// Card button taps since the last call, oldest first: [{ action, value?, atMs }].
    Function("takePendingActions") { () -> [[String: Any]] in
      let defaults = UserDefaults.standard
      let queue = defaults.array(forKey: pendingRatingsKey) as? [[String: Any]] ?? []
      defaults.removeObject(forKey: pendingRatingsKey)
      return queue
    }
  }

  @available(iOS 16.2, *)
  private static func content(_ s: CardState) -> ActivityContent<SessionActivityAttributes.ContentState> {
    let state = SessionActivityAttributes.ContentState(
      mode: s.mode,
      sessionStartedAt: s.sessionStartedAtMs.map { Date(timeIntervalSince1970: $0 / 1000) },
      venue: s.venue,
      due: s.due,
      lastRating: s.lastRating,
      thanksUntil: s.thanksUntilMs.map { Date(timeIntervalSince1970: $0 / 1000) }
    )
    return ActivityContent(state: state, staleDate: Date().addingTimeInterval(staleAfter))
  }

  @available(iOS 16.2, *)
  private static func endAll() async {
    for activity in Activity<SessionActivityAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }
}
