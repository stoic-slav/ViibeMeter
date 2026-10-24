// The lock-screen card's buttons run CardActionIntent, a LiveActivityIntent. iOS
// runs such an intent in the app's process, and finds it only in the app target's own App Intents
// metadata (not in a CocoaPods module), so the same Swift files that the widget target uses
// (targets/live-activity, linked by @bacons/apple-targets) are also compiled into the app target.
// Also declares Live Activity support in the app's Info.plist.
const { withInfoPlist, withXcodeProject, IOSConfig } = require('expo/config-plugins');

// Relative to ios/ (the app group has no path)
const INTENT_FILES = [
  '../targets/live-activity/CardActionIntent.swift',
];

module.exports = function withLiveActivityIntent(config) {
  config = withInfoPlist(config, cfg => {
    cfg.modResults.NSSupportsLiveActivities = true;
    return cfg;
  });
  return withXcodeProject(config, cfg => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
    for (const filepath of INTENT_FILES) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: projectName,
        project: cfg.modResults,
      });
    }
    return cfg;
  });
};
