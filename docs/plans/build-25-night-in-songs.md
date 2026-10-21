# Plan: build 25. "Your night in songs"

Status: built and checked in the simulator on 21 Oct 2026 (see HANDOFF, build 25). Owner decisions (21 Oct):
- **Saving songs:** Apple Music playlist in one tap, plus an "Open in Spotify" button per song.
- **DJ info:** the night's lineup is stored on the server for the venue; the venue QR stays the same.
- **When the recap appears:** at Stop, plus a reminder at 12:00 the next day.
- **Sharing:** an image card for Stories.

## Why
The cold-start problem: live venue data is only valuable once many people contribute. The recap gives one person value from their own night, with nobody else needed. It shows the songs they moved to most, ranked passively from movement (Witek 2014: wanting to move ≈ pleasure; Martella 2015: accelerometer predicts enjoyment), with no rating needed. Each recap also asks 👍/👎 per song, which is new ground truth for "does movement predict enjoying a song?". Shared cards spread the app.

## What the user sees
- **After Stop** (and from the 12:00 notification the next day): "Your night in songs".
  - **Header:** venue, date, how long, minutes dancing, "we recognised 7 songs".
  - **Top 5 (or fewer).** Each entry has:
    - title and artist, or "Unrecognised tracks 23:40–23:52";
    - a reason ("on the beat for 3 min", "you moved most to this one");
    - "played by DJ X" when the lineup is known;
    - 👍 / 👎;
    - Spotify and Apple Music buttons.
  - **ADD TO APPLE MUSIC:** one tap creates the playlist "Viibe Check · C12 · 24 Oct". It needs Apple Music access; without a subscription it says so and the per-song buttons still work.
  - **SHARE:** an image card "My night at C12 in 5 songs" (title, artist, DJ) for Instagram Stories or WhatsApp.
- **Edits and unknown tracks:** ShazamKit often matches the original when an edit uses enough of it; then the original's title shows. Stretches it can't match become "Unrecognised tracks HH:MM–HH:MM" entries, credited to the DJ playing then.

## How songs are ranked (on the phone, `src/processing/NightRecap.ts`)
- **Data:** the session's 10 s clips (movement energy, beat PLV, phone context, song ISRC), its windows (music detected), and the recognised songs.
- **Baseline:** only clips with the phone on a body count. Movement energy becomes a percentile within that night (each person against their own night, so a calm dancer isn't penalised).
- **Per song (≥ 3 on-body clips, i.e. ≥ 30 s):**
  - score = 0.65 × mean energy percentile + 0.35 × mean beat PLV (energy only when no PLV);
  - the reason comes from the minutes locked to the beat (PLV ≥ 0.4), else the minutes of strong movement.
- **Unknown stretches:** consecutive on-body clips with music but no song, ≥ 2 min, scored the same way.
- **Coverage:** recognised songs, and the share of music clips that had a song.

## Data
- **Phone only:** `night_songs` (per session: ISRC, title, artist, Apple Music ID, first and last heard) and `night_recaps` (the computed recap, kept for the history). Titles are never uploaded (unchanged promise).
- **Uploaded:** `song_feedback` via `upload_song_feedback`, one row per 👍/👎:
  - session, device, kind (`song` / `unknown`), ISRC, start/end, rank, score, liked;
  - covered by `delete_my_data` and the 24-month retention.
- **Server:** `venue_sets` (place ID, DJ name, start, end), read through `venue_sets_for(place_id, from, to)`. Public lineup info only. Written by us with SQL for now; a club self-service page with an editor code comes when a venue partners.

## Technical
- **Recording songs:** `AudioAnalyzer` keeps title, artist and Apple Music ID per match. The orchestrator records each new ISRC into `night_songs`.
- **Building the recap:** `stopEverything` builds and saves the recap and schedules the 12:00 notification (only if there is something to show). The `/recap` route builds it on demand if missing.
- **Apple Music:** a new local module `modules/music-library` (Swift, MusicKit):
  - `authorize`, then `createPlaylist(name, description, appleMusicIds, isrcs)`;
  - catalog lookup by ID, else by ISRC; then `MusicLibrary.createPlaylist` (iOS 16+);
  - Info.plist `NSAppleMusicUsageDescription`.
  - **Owner step:** enable the **MusicKit** App Service for `com.leogerasimov.vibemeter` in the Apple Developer account (Identifiers → App Services), like ShazamKit.
- **Spotify:** `open.spotify.com/search/<title artist>`, which opens the Spotify app on its search. No API, no account.
- **Share card:** `react-native-view-shot` (Expo SDK 54: 4.0.3) captures the card; iOS's share sheet sends it.

## Steps
1. Song capture (title, artist, Apple Music ID) and `night_songs`.
2. `NightRecap.ts`, plus a test script with synthetic nights.
3. Database: `venue_sets`, `venue_sets_for`, `song_feedback`, `upload_song_feedback`, deletion and retention.
4. Recap screen, summary link, 12:00 notification.
5. MusicKit module, Spotify links, share card.
6. Simulator check (a session with the test track; ShazamKit can't match synthetic audio, so recognised songs are injected for the test), docs, push, build 25.
