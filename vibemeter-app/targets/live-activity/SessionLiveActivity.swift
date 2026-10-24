import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

private let accent = Color(red: 0.0, green: 0.91, blue: 0.63)     // #00E8A0
private let dim = Color(red: 0.6, green: 0.6, blue: 0.75)         // #9898c0
private let card = Color(red: 0.024, green: 0.024, blue: 0.031)   // #060608

private let stopURL = URL(string: "vibemeter://stop")!

/// The card has three modes: a running session (venue, timer, STOP and the song heard now), Going out standby
/// ("Standing by", TURN OFF) and the standby prompt ("Sounds like a party. Start measuring?").
private extension ActivityViewContext where Attributes == SessionActivityAttributes {
  var isSession: Bool { state.mode == "session" }
  var isPrompt: Bool { state.mode == "prompt" }
  var timerStart: Date { state.sessionStartedAt ?? attributes.startedAt }
  var title: String { isSession ? (state.venue ?? "Viibe Check") : "Going out" }
}

struct SessionLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SessionActivityAttributes.self) { context in
      LockScreenCard(context: context)
        .activityBackgroundTint(card)
        .activitySystemActionForegroundColor(accent)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text(context.title)
            .font(.system(.caption, design: .monospaced).bold())
            .foregroundColor(.white)
            .lineLimit(1)
            .padding(.leading, 8)   // clear the island's rounded corner
        }
        DynamicIslandExpandedRegion(.trailing) {
          if context.isSession && !context.isStale {
            Text(context.timerStart, style: .timer)
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
        LiveDot(stale: context.isStale, on: context.isSession || context.isPrompt)
      } compactTrailing: {
        if context.isStale {
          CompactLabel(text: "off", color: dim)
        } else if context.isPrompt {
          CompactLabel(text: "party?", color: accent)
        } else if !context.isSession {
          CompactLabel(text: "ready", color: dim)
        } else {
          Text(context.timerStart, style: .timer)
            .font(.system(.caption2, design: .monospaced))
            .monospacedDigit()
            .foregroundColor(accent)
            .frame(maxWidth: 52)
        }
      } minimal: {
        LiveDot(stale: context.isStale, on: context.isSession || context.isPrompt)
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
        LiveDot(stale: context.isStale, on: context.isSession || context.isPrompt)
        Text(context.title)
          .font(.system(.footnote, design: .monospaced).bold())
          .foregroundColor(.white)
          .lineLimit(1)
        // A stale card belongs to an app that stopped running: no counting timer, nothing to stop
        if context.isSession && !context.isStale {
          Text(context.timerStart, style: .timer)
            .font(.system(.footnote, design: .monospaced))
            .monospacedDigit()
            .foregroundColor(dim)
        }
        Spacer(minLength: 4)
        if context.isSession && !context.isStale {
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

/// What the card shows below its header, by mode; a "not running" note once the app stopped updating.
private struct CardBody: View {
  let context: ActivityViewContext<SessionActivityAttributes>

  var body: some View {
    if context.isStale {
      Text(context.isSession
           ? "Not measuring. Open Viibe Check to start again."
           : "Going out mode stopped. Open Viibe Check to turn it on again.")
        .font(.system(.footnote, design: .monospaced))
        .foregroundColor(dim)
    } else if context.isPrompt {
      PromptBody()
    } else if !context.isSession {
      StandbyBody()
    } else {
      SongBody(context: context)
    }
  }
}

/// Going out standby: listening on the phone, nothing stored, until it sounds like a party.
private struct StandbyBody: View {
  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Standing by")
          .font(.system(.subheadline, design: .monospaced).bold())
          .foregroundColor(.white)
        Text("We'll ask when it sounds and moves like a party.")
          .font(.system(.caption, design: .monospaced))
          .foregroundColor(dim)
      }
      Spacer(minLength: 4)
      if #available(iOS 17.0, *) {
        Button(intent: CardActionIntent(action: "standby_off")) {
          Text("TURN OFF")
            .font(.system(.caption2, design: .monospaced).bold())
            .foregroundColor(dim)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .overlay(Capsule().stroke(dim.opacity(0.5), lineWidth: 1))
        }
        .buttonStyle(.plain)
      }
    }
  }
}

/// "Sounds like a party. Start measuring?" Yes starts a session without unlocking.
private struct PromptBody: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Sounds like a party 🎶 Start measuring?")
        .font(.system(.subheadline, design: .monospaced).bold())
        .foregroundColor(accent)
      if #available(iOS 17.0, *) {
        HStack(spacing: 8) {
          Button(intent: CardActionIntent(action: "start")) {
            ActionLabel(text: "YES, START", primary: true)
          }
          .buttonStyle(.plain)
          Button(intent: CardActionIntent(action: "not_now")) {
            ActionLabel(text: "NOT NOW", primary: false)
          }
          .buttonStyle(.plain)
        }
      } else {
        Text("Use the notification or open Viibe Check to start.")
          .font(.system(.caption, design: .monospaced))
          .foregroundColor(dim)
      }
    }
  }
}

/// A running session: the song heard now (or that the phone is listening for one).
private struct SongBody: View {
  let context: ActivityViewContext<SessionActivityAttributes>

  var body: some View {
    HStack(spacing: 8) {
      Text("♪")
        .font(.system(.subheadline, design: .monospaced).bold())
        .foregroundColor(context.state.song == nil ? dim : accent)
      Text(context.state.song ?? "Listening for the song…")
        .font(.system(.subheadline, design: .monospaced).bold())
        .foregroundColor(context.state.song == nil ? dim : .white)
        .lineLimit(2)
      Spacer(minLength: 0)
    }
  }
}

private struct ActionLabel: View {
  let text: String
  let primary: Bool

  var body: some View {
    Text(text)
      .font(.system(.caption, design: .monospaced).bold())
      .foregroundColor(primary ? card : .white)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
      .background(
        RoundedRectangle(cornerRadius: 12)
          .fill(primary ? accent : Color.white.opacity(0.1))
      )
  }
}

private struct CompactLabel: View {
  let text: String
  let color: Color

  var body: some View {
    Text(text)
      .font(.system(.caption2, design: .monospaced))
      .foregroundColor(color)
  }
}

private struct LiveDot: View {
  let stale: Bool
  let on: Bool

  var body: some View {
    Circle()
      .fill(stale ? dim : accent)
      .frame(width: 8, height: 8)
      .opacity(stale || on ? 1 : 0.45)
  }
}
