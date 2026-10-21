import ExpoModulesCore
import MusicKit

/// "Your night in songs" → an Apple Music playlist in one tap (iOS 16+). Songs are found in the
/// catalog by their Apple Music ID (from ShazamKit), else by ISRC. Needs the MusicKit App Service
/// on the app ID and the user's Apple Music access; without a subscription it reports that and
/// the app falls back to per-song links.
public class ViibeMusicLibraryModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ViibeMusicLibrary")

    /// [{ ok, reason?, added? }]; reason: unsupported, denied, no_subscription, not_found, error
    AsyncFunction("createPlaylist") { (name: String, description: String, appleMusicIds: [String], isrcs: [String]) async -> [String: Any] in
      guard #available(iOS 16.0, *) else { return ["ok": false, "reason": "unsupported"] }
      let status = await MusicAuthorization.request()
      guard status == .authorized else { return ["ok": false, "reason": "denied"] }
      if let subscription = try? await MusicSubscription.current,
         !subscription.canPlayCatalogContent && !subscription.hasCloudLibraryEnabled {
        return ["ok": false, "reason": "no_subscription"]
      }
      var songs: [Song] = []
      for i in 0..<max(appleMusicIds.count, isrcs.count) {
        let id = i < appleMusicIds.count ? appleMusicIds[i] : ""
        let isrc = i < isrcs.count ? isrcs[i] : ""
        if let song = await Self.findSong(id: id, isrc: isrc) { songs.append(song) }
      }
      if songs.isEmpty { return ["ok": false, "reason": "not_found"] }
      do {
        _ = try await MusicLibrary.shared.createPlaylist(name: name, description: description, items: songs)
        return ["ok": true, "added": songs.count]
      } catch {
        print("[ViibeMusicLibrary] createPlaylist failed: \(error)")
        return ["ok": false, "reason": "error", "message": String(describing: error)]
      }
    }
  }

  @available(iOS 16.0, *)
  private static func findSong(id: String, isrc: String) async -> Song? {
    if !id.isEmpty {
      let request = MusicCatalogResourceRequest<Song>(matching: \.id, equalTo: MusicItemID(id))
      if let song = try? await request.response().items.first { return song }
    }
    if !isrc.isEmpty {
      let request = MusicCatalogResourceRequest<Song>(matching: \.isrc, equalTo: isrc)
      if let song = try? await request.response().items.first { return song }
    }
    return nil
  }
}
