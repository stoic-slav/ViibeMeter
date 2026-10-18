// The lock-screen card's rating buttons run RateVibeIntent, a LiveActivityIntent. iOS runs such
// an intent in the app's process, and finds it only in the app target's own App Intents metadata
// (not in a CocoaPods module), so the same Swift file that the widget target uses
// (targets/live-activity, linked by @bacons/apple-targets) is also compiled into the app target.
// Also declares Live Activity support in the app's Info.plist.
const { withInfoPlist, withXcodeProject, IOSConfig } = require('expo/config-plugins');

const INTENT_FILE = '../targets/live-activity/RateVibeIntent.swift'; // relative to ios/ (the app group has no path)

module.exports = function withLiveActivityIntent(config) {
  config = withInfoPlist(config, cfg => {
    cfg.modResults.NSSupportsLiveActivities = true;
    return cfg;
  });
  return withXcodeProject(config, cfg => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: INTENT_FILE,
      groupName: projectName,
      project: cfg.modResults,
    });
    return cfg;
  });
};
