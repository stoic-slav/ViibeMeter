/**
 * The session's lock-screen Live Activity (rating buttons, timer, venue, Stop).
 * Built by @bacons/apple-targets at prebuild; bundle ID com.leogerasimov.vibemeter.card.
 * CardActionIntent.swift is also compiled into the app (plugins/withLiveActivityIntent.js),
 * because the system runs a LiveActivityIntent in the app's process.
 */
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'ViibeCard',
  displayName: 'Viibe Check',
  bundleIdentifier: '.card',
  deploymentTarget: '16.2',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit', 'AppIntents'],
  colors: {
    $accent: '#00E8A0',
    $widgetBackground: '#060608',
  },
};
