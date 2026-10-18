import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

private let accent = Color(red: 0.0, green: 0.91, blue: 0.63)     // #00E8A0
private let dim = Color(red: 0.6, green: 0.6, blue: 0.75)         // #9898c0
private let card = Color(red: 0.024, green: 0.024, blue: 0.031)   // #060608

private struct RatingOption: Identifiable {
  let value: Int
  let emoji: String
  let label: String
  var id: Int { value }
}

// Same three levels as the notification (stored as 1 / 3 / 5)
private let options = [
  RatingOption(value: 1, emoji: "💀", label: "Dead"),
  RatingOption(value: 3, emoji: "🙂", label: "Decent"),
  RatingOption(value: 5, emoji: "🔥", label: "Best"),
]

private let stopURL = URL(string: "vibemeter://stop")!

struct SessionLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SessionActivityAttributes.self) { context in
      LockScreenCard(context: context)
        .activityBackgroundTint(card)
        .activitySystemActionForegroundColor(accent)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text(context.state.venue ?? "Viibe Check")
            .font(.system(.caption, design: .monospaced).bold())
            .foregroundColor(.white)
            .lineLimit(1)
            .padding(.leading, 8)   // clear the island's rounded corner
        }
        DynamicIslandExpandedRegion(.trailing) {
          if context.isStale {
            Text("off")
              .font(.system(.caption, design: .monospaced))
              .foregroundColor(dim)
          } else {
            Text(context.attributes.startedAt, style: .timer)
              .font(.system(.caption, design: .monospaced))
              .monospacedDigit()
              .foregroundColor(dim)
              .multilineTextAlignment(.trailing)
              .padding(.trailing, 8)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          CardBody(context: context)
        }
      } compactLeading: {
        LiveDot(stale: context.isStale, due: context.state.due)
      } compactTrailing: {
        if context.isStale {
          Text("off")
            .font(.system(.caption2, design: .monospaced))
            .foregroundColor(dim)
        } else {
          Text(context.attributes.startedAt, style: .timer)
            .font(.system(.caption2, design: .monospaced))
            .monospacedDigit()
            .foregroundColor(accent)
            .frame(maxWidth: 52)
        }
      } minimal: {
        LiveDot(stale: context.isStale, due: context.state.due)
      }
      .widgetURL(URL(string: "vibemeter://"))
    }
  }
}

private struct LockScreenCard: View {
  let context: ActivityViewContext<SessionActivityAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        LiveDot(stale: context.isStale, due: context.state.due)
        Text(context.state.venue ?? "Viibe Check")
          .font(.system(.footnote, design: .monospaced).bold())
          .foregroundColor(.white)
          .lineLimit(1)
        // A stale card belongs to an app that stopped running: no counting timer, nothing to stop
        if !context.isStale {
          Text(context.attributes.startedAt, style: .timer)
            .font(.system(.footnote, design: .monospaced))
            .monospacedDigit()
            .foregroundColor(dim)
        }
        Spacer(minLength: 4)
        if !context.isStale {
          Link(destination: stopURL) {
            Text("STOP")
              .font(.system(.caption2, design: .monospaced).bold())
              .foregroundColor(dim)
              .padding(.horizontal, 10)
              .padding(.vertical, 5)
              .overlay(Capsule().stroke(dim.opacity(0.5), lineWidth: 1))
          }
        }
      }
      CardBody(context: context)
    }
    .padding(14)
  }
}

/// The headline and the rating buttons, or the "not measuring" note once the app stopped updating.
private struct CardBody: View {
  let context: ActivityViewContext<SessionActivityAttributes>

  var body: some View {
    if context.isStale {
      Text("Not measuring. Open Viibe Check to start again.")
        .font(.system(.footnote, design: .monospaced))
        .foregroundColor(dim)
    } else {
      VStack(alignment: .leading, spacing: 8) {
        Text(headline)
          .font(.system(.subheadline, design: .monospaced).bold())
          .foregroundColor(context.state.due ? accent : .white)
        if #available(iOS 17.0, *) {
          HStack(spacing: 8) {
            ForEach(options) { option in
              Button(intent: RateVibeIntent(value: option.value)) {
                RatingLabel(option: option, due: context.state.due, chosen: chosen == option.value)
              }
              .buttonStyle(.plain)
            }
          }
        } else {
          Text("Long-press the notification to rate.")
            .font(.system(.caption, design: .monospaced))
            .foregroundColor(dim)
        }
      }
    }
  }

  private var thanking: Bool {
    guard let until = context.state.thanksUntil else { return false }
    return until > Date()
  }

  private var chosen: Int? { thanking ? context.state.lastRating : nil }

  private var headline: String {
    if thanking, let r = context.state.lastRating, let o = options.first(where: { $0.value == r }) {
      return "Thanks \(o.emoji)"
    }
    return context.state.due ? "How's the vibe right now?" : "Rate the vibe any time"
  }
}

private struct RatingLabel: View {
  let option: RatingOption
  let due: Bool
  let chosen: Bool

  var body: some View {
    VStack(spacing: 2) {
      Text(option.emoji).font(.title3)
      Text(option.label.uppercased())
        .font(.system(.caption2, design: .monospaced).bold())
        .foregroundColor(due || chosen ? .white : dim)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
    .background(
      RoundedRectangle(cornerRadius: 12)
        .fill(chosen ? accent.opacity(0.35) : (due ? accent.opacity(0.18) : Color.white.opacity(0.07)))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12)
        .stroke(due || chosen ? accent : Color.clear, lineWidth: 1)
    )
  }
}

private struct LiveDot: View {
  let stale: Bool
  let due: Bool

  var body: some View {
    Circle()
      .fill(stale ? dim : accent)
      .frame(width: 8, height: 8)
      .opacity(due && !stale ? 1 : 0.85)
  }
}
