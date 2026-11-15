import CoreLocation
import ExpoModulesCore
import UserNotifications

/// One club the system should watch, with the words of its notification.
struct ArrivalRegion: Record {
  @Field var id: String = ""        // Google place ID
  @Field var name: String = ""      // the club's name
  @Field var lat: Double = 0
  @Field var lng: Double = 0
  @Field var title: String = ""
  @Field var body: String = ""
}

/// Arrival nudges (build 32): location-triggered local notifications. The system watches the
/// regions itself, so nothing runs in the app, no location is read by us and no battery is spent;
/// when the phone walks into one, the notification appears even with the app closed, and the app
/// only learns about it if the person taps it. Needs "While Using" location permission, which the
/// app already asks for. The notification carries the place ID and name for the express start.
public class ViibeArrivalNudgeModule: Module {
  private static let prefix = "arrival-"

  public func definition() -> ModuleDefinition {
    Name("ViibeArrivalNudge")

    /// Replaces any pending arrival nudges with these regions. Returns how many were scheduled.
    AsyncFunction("schedule") { (regions: [ArrivalRegion], radius: Double, category: String) -> Int in
      let center = UNUserNotificationCenter.current()
      await ViibeArrivalNudgeModule.removeAll(center)
      var count = 0
      for r in regions {
        let region = CLCircularRegion(
          center: CLLocationCoordinate2D(latitude: r.lat, longitude: r.lng),
          radius: radius,
          identifier: "\(ViibeArrivalNudgeModule.prefix)\(r.id)"
        )
        region.notifyOnEntry = true
        region.notifyOnExit = false

        let content = UNMutableNotificationContent()
        content.title = r.title
        content.body = r.body
        content.sound = .default
        content.categoryIdentifier = category
        content.userInfo = ["type": "arrival", "placeId": r.id, "name": r.name]

        let trigger = UNLocationNotificationTrigger(region: region, repeats: false)
        let request = UNNotificationRequest(identifier: region.identifier, content: content, trigger: trigger)
        do {
          try await center.add(request)
          count += 1
        } catch {
          // Out of the system's limit or no location permission: the rest still goes in
          continue
        }
      }
      return count
    }

    AsyncFunction("cancelAll") { () -> Void in
      await ViibeArrivalNudgeModule.removeAll(UNUserNotificationCenter.current())
    }

    AsyncFunction("pendingCount") { () -> Int in
      let pending = await UNUserNotificationCenter.current().pendingNotificationRequests()
      return pending.filter { $0.identifier.hasPrefix(ViibeArrivalNudgeModule.prefix) }.count
    }
  }

  private static func removeAll(_ center: UNUserNotificationCenter) async {
    let pending = await center.pendingNotificationRequests()
    let ids = pending.map(\.identifier).filter { $0.hasPrefix(prefix) }
    center.removePendingNotificationRequests(withIdentifiers: ids)
  }
}
