// iOS 27 aborts apps built with the iOS 27 SDK that don't use the UIScene lifecycle
// (UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption at launch). Expo SDK 54's
// AppDelegate creates the window itself. This plugin:
//   1. adds UIApplicationSceneManifest to Info.plist, pointing at a SceneDelegate;
//   2. changes AppDelegate.swift so it only remembers the launch options (the window and
//      startReactNative move to the scene);
//   3. appends a SceneDelegate that creates the window from the scene, starts React Native, and
//      forwards links (cold-start and while running) to the AppDelegate's open-URL path, which
//      expo-linking / expo-router read. Without that, vibemeter:// links would stop working.
// Based on the workaround in expo/expo#50179. Safe to run twice (marker comment).
const { withInfoPlist, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '// withSceneLifecycle';

const SCENE_DELEGATE = `
${MARKER}: the scene creates the window and starts React Native (required on iOS 27)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    // The launch options a link would have produced under the old lifecycle
    var launchOptions = appDelegate.launchOptions ?? [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }

    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)

    // A link that cold-started the app: expo-linking reads it from the AppDelegate's subscribers
    for context in connectionOptions.urlContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: [:])
    }
    for activity in connectionOptions.userActivities where activity.activityType == NSUserActivityTypeBrowsingWeb {
      _ = appDelegate.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`;

function patchAppDelegate(src) {
  if (src.includes(MARKER)) return src; // already patched

  // Remember the launch options for the scene
  if (!/var window: UIWindow\?/.test(src)) throw new Error('withSceneLifecycle: AppDelegate has no window property');
  src = src.replace(/(var window: UIWindow\?)/, '$1\n  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?');

  // Window creation and startReactNative move to the scene
  const block = /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif/;
  if (!block.test(src)) throw new Error('withSceneLifecycle: the AppDelegate template changed; update the plugin');
  src = src.replace(block, `${MARKER}: the window and React Native start in SceneDelegate (iOS 27)\n    self.launchOptions = launchOptions`);

  return src + SCENE_DELEGATE;
}

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, cfg => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });
  return withDangerousMod(config, ['ios', async cfg => {
    const file = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName, 'AppDelegate.swift');
    fs.writeFileSync(file, patchAppDelegate(fs.readFileSync(file, 'utf8')));
    return cfg;
  }]);
};
