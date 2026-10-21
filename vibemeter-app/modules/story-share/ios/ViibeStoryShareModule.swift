import ExpoModulesCore
import UIKit

/// "Share to Instagram Story" without the share sheet: the card image goes on the pasteboard
/// (expires after 5 minutes) and Instagram opens on a new Story with it as the background.
/// Instagram requires the app's Meta (Facebook) App ID as source_application.
public class ViibeStoryShareModule: Module {
  private static let pasteboardKey = "com.instagram.sharedSticker.backgroundImage"

  public func definition() -> ModuleDefinition {
    Name("ViibeStoryShare")

    AsyncFunction("canShareToInstagram") { () -> Bool in
      guard let url = URL(string: "instagram-stories://share") else { return false }
      return await MainActor.run { UIApplication.shared.canOpenURL(url) }
    }

    AsyncFunction("shareToInstagramStory") { (fileUri: String, appId: String, topColor: String, bottomColor: String) async -> Bool in
      guard let fileUrl = URL(string: fileUri), let data = try? Data(contentsOf: fileUrl),
            let storiesUrl = URL(string: "instagram-stories://share?source_application=\(appId)") else { return false }
      return await MainActor.run {
        guard UIApplication.shared.canOpenURL(storiesUrl) else { return false }
        UIPasteboard.general.setItems(
          [[
            ViibeStoryShareModule.pasteboardKey: data,
            "com.instagram.sharedSticker.backgroundTopColor": topColor,
            "com.instagram.sharedSticker.backgroundBottomColor": bottomColor,
          ]],
          options: [.expirationDate: Date().addingTimeInterval(300)]
        )
        UIApplication.shared.open(storiesUrl)
        return true
      }
    }
  }
}
