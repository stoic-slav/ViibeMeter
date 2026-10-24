# Handoff: continue ViibeMeter work

Updated 3 October 2026 at the end of a local (Mac) session, so the next session can continue without the chat history.
**How the owner works:** they want Claude to drive end to end and give only minimal direction and oversight. Do the work, verify it, and report outcomes plainly, including failures. Ask only when a decision is genuinely theirs.

## Goal
Decide whether ViibeMeter is worth building out. The question is whether passive phone-sensor data (mic, motion, BLE) predicts how people rate the vibe at parties and clubs. Beat sync and crowd sync are the owner's central hypothesis: moving in sync with the music, and with each other, signals a high vibe.

## State

### Distribution
- **Apple Developer Program is active** (individual, team `APRS7H5DD6`). The owner's iPhone is company-managed: **Developer Mode is off and must stay off**, so the only install route is **TestFlight**.
- **Bundle ID is `com.leogerasimov.vibemeter`.** Do not change it: it is tied to the App Store Connect record, certificates and the TestFlight group. The Android package is still `com.vibemeter.app` (no Play listing).
- **App Store Connect:** app **ViibeMeter**, ASC app id `6818585201` (pinned in `eas.json`). The TestFlight internal group "Team (Expo)" contains the owner. ShazamKit App Service is enabled on the app ID.
- **EAS:** Expo account `stoicslav`, project `@stoicslav/vibemeter`. The Supabase URL and anon key are EAS env vars. `EXPO_PUBLIC_AUDD_TOKEN` is local `.env` only, so cloud builds have no AudD.
- **Upload route:** `eas submit` sat in the free-tier queue for hours, so builds are downloaded (`ViibeMeter.ipa`, gitignored) and the owner uploads them with **Transporter** on the Mac.
- **iOS builds:** 1 (rejected by Apple: background mode `processing`, ITMS-90771), 2 (fixed), 3 (continuous background capture, BPM rewrite), 4 (dB calibration, no fake BLE zeros), 5 (Shazam runs above 40 dB), **6 = beat sync from song tempo, dB offset 110**, **7 = bass-only beat finding while moving, `beat_phase_clock`, movement BPM capped at 180, real `app_version` on sessions**, **8 = no GPS, song start time, group QR codes** (3 Oct), **10 = learned song tempo, start consensus, music detected from recognition** (4 Oct; number 9 was used up by a build request that failed with an EAS 503). Build numbers auto-increment remotely.
- **Android:** preview APK builds on EAS (`eas build -p android --profile preview`). Current APK: build `efe19aae-…` (4 Oct, same code as iOS build 13): https://expo.dev/artifacts/eas/TumyAK3uygenEDtNUGOEZVstc-I7NmQHFa2SDChp8Lw.apk (checked: no background location; microphone-only foreground service) No Android device has run any build yet; the owner will share the APK link with friends.

### Audio pipeline (iOS), changed 2–3 Oct
- **Continuous capture:** local Expo module `vibemeter-app/modules/audio-capture` (Swift; replaces the earlier `shazam-match`). `AVAudioEngine` input tap into a 12 s in-memory ring buffer (Int16, 44.1 kHz mono); nothing is written to disk. Session category `.playAndRecord`, mode `.measurement` (no automatic gain), `.mixWithOthers`. It restarts itself after interruptions, route changes and media-server resets.
- **Why:** with separate 5 s clips, iOS suspended the app between clips once the screen locked, so sessions paused. A continuously open mic plus `UIBackgroundModes: audio` keeps it running. **Verified on the owner's iPhone (build 3, screen off).**
- `AudioAnalyzer.start()`/`stop()` open and close the mic for the whole session (called by `SensorOrchestrator`). Each cycle reads the latest 5 s with `readRecent`.
- **ShazamKit** matches the last 8 s of the ring buffer (`matchRecent`); only the fingerprint leaves the device. It runs at most every 30 s when the room is above `SHAZAM_MIN_DB` (40). Deezer's `track/isrc:` lookup adds tempo and popularity. Not yet confirmed on a device: the 3 Oct hand test had too low a dB reading for the old 55 dB gate.
- **dB calibration:** measurement mode has no auto gain, so raw levels are ~25 dB lower than the old 94 dB offset assumed. iOS now uses `IOS_RAW_MIC_DBFS_OFFSET = 120`. The owner's Apple Watch read ~50 dB for music that the app (old offset 94) logged as 34 dB, suggesting ~110 may be closer. **Calibrate in the next test** by noting the Watch reading next to the app's value. Android keeps offset 94 (unverified).
- **BPM detector rewritten** (`BPMDetector.ts`): inter-onset intervals read hi-hats as >200 BPM, so real music never got a tempo. Now it uses an onset envelope (full band + bass band below 200 Hz), centred unbiased autocorrelation, a 120 BPM log-tempo prior, a double-tempo check, parabolic interpolation and a fitted beat-grid phase. Synthetic tests: 90/117/120/128/140 BPM exact, phase error ≤ 5 ms, noise rejected. Results below `BPM_PCM_MIN_CLARITY` (0.3) are dropped.

### Android background (new 3 Oct, untested on a device)
Android stops an app's work with the screen off in three ways, and `modules/session-service` (Kotlin, Android only) handles each:
1. Background mic and location need a **foreground service** of type `microphone|location` (ongoing notification "ViibeMeter is measuring"). It is started in `SensorOrchestrator.startSession` after the permission prompts and stopped in `stopSession`.
2. React Native pauses JS timers when the app is backgrounded unless a **headless JS task** is running. The service starts task `ViibeMeterSession` (registered in `vibemeter-app/index.ts`), which stays pending until the session stops.
3. `expo-sensors` stops listening when the activity is backgrounded, so the service records **accelerometer, gravity, linear acceleration and gyroscope natively** into a 15 s in-memory buffer. `MotionTracker` reads it on Android while the service runs.
Audio on Android still uses `react-native-audio-record` per cycle, which the microphone-type service allows in the background. The Kotlin has only been compiled by EAS, never run.

### BLE
iOS cannot discover arbitrary nearby devices in the background, and Android pauses unfiltered scans with the screen off. Scans are now skipped while the app is not active, so locked-phone windows record no BLE count instead of a fake 0. Crowd density therefore only comes from minutes when the screen is on.

### Device test results (owner's iPhone, 2 Oct, session `954f077f`, placement hand, Billie Jean from a laptop)
- Screen-off recording continuous (both minutes present).
- Window 1: BPM 117 (song is ~117), pulse clarity 0.21. Window 2: beat PLV 0.82, tempo match 0.71, movement BPM 60, classified "dancing".
- dB 34 (pre-calibration), so music was not detected and Shazam did not run. BLE 0 (background; now skipped).

### Device test 3 (build 5, 3 Oct, session `a75445e4`, pocket, Billie Jean via AirPlay to a HomePod, ~5 min)
Owner's plan: 1 min still, ~3 min dancing on the beat, ~2 min deliberately off the beat. Watch not checked (owner estimates 50–60 dB).
- **Works:** 6 continuous windows with the screen off; **Shazam matched every window** (ISRC `USSM19902991`, Pop, Deezer BPM 117); music detected in every window; movement energy tracks the plan (1.7 still → 3.6–5.5 dancing); movement BPM 120 in the main on-beat minute.
- **Failed:** the on-beat minutes (09:14, 09:15) had **no beat PLV**. The PCM beat grid fell below the 0.3 clarity bar, most likely because the pocket muffles the mic and dancing adds fabric noise. The off-beat minute got PLV 0.60 from few cycles, so it is not meaningful.
- **Fixed in build 6:** beat sync falls back to the recognised song's tempo (PLV needs only the beat period; `beat_phase_mean` stays null without a grid). A known tempo also narrows the PCM search and lowers its clarity bar to 0.1. `pulse_clarity` now stores only PCM clarity (it used to mix in the metering estimate). iOS dB offset set to 110: app read 66–72 dB with offset 120, against ~50–60 on the Watch.
- Movement BPM sometimes read 200–231 (implausible); capped at 180 in build 7.

### Device test 4 (build 8, 4 Oct, session `96d2e4e6`, pocket, Dua Lipa and others, ~11 min)
Plan: ~1.5 min still, on beat to ~5 min, 2 min off beat, 1 min still, ~2.5 min on beat. Apple Watch ~60 dB, app ~60 dB: **dB offset 110 confirmed**.
- Movement energy tracks the plan (still ≈ 1, dancing 3–6); movement tempo 125 vs song 124 while on beat.
- Beat PLV where measurable: 0.59 on beat vs 0.01 off beat (few minutes; directionally right). Missing in most dancing minutes because **Deezer had no tempo for songs 2–4** and single pocket clips were below the clarity bar.
- **Song start times are very precise:** song 1's four estimates agreed within 0.09 s across 4 minutes. But some estimates were off by 30–80 s (ShazamKit matched a repeated chorus), and a wrong one can recur: song 2 had two wrong estimates against one right one.
- `music_detected` was false at ~60 dB (needs 65 dB) even with a song recognised.

### Build 10 (4 Oct; the code described as "build 9" in chat, number 9 was lost to an EAS outage)
- **Song tempo learned on the phone** when Deezer has none: each clip's onset autocorrelation (lag axis) is summed per song, and clips wait until a match confirms which song they belong to (`tempoFromAccumulated`; ≥3 clips, stable to 2%, folded into 80–160 BPM). Synthetic clips too noisy alone (clarity 0.1–0.3) give 124.1/115.7/94.8 for 124/116/95 after 2–3 clips; 128 read as 64 until the 7th clip; noise alone gives none. `song_bpm_source` = `deezer` | `learned` (migration `20261004110000_song_bpm_source.sql`, applied). The clock grid uses the tempo rounded, so phones share the period.
- **Song start consensus on the phone:** estimates that agree within 1.5 s vote; estimates from before the previous song was last heard are rejected (that rule fixes test 4's song 2). `song_start_spread_ms` still reports the raw spread.
- **Server:** `auto_groups.py` keeps only the biggest estimate cluster per song playback and no longer counts "same song, different start" as apart. Synthetic stress test with 15–30% chorus outliers: precision 0.92–1.00.
- A recognised song in the last 2 minutes now counts as `music_detected`.

### Build 8 (3 Oct): no GPS, group QR codes, automatic grouping
- **GPS removed** (checked in the build 8 ipa: no location usage strings, background modes audio/bluetooth-central/fetch). `gps_is_at_venue` was empty in every window (the venue location was never set), so location only cost battery and permissions. `LocationTracker` and `expo-location` are gone; iOS has no location permission or background mode; the Android foreground service is microphone-only; Android keeps `ACCESS_FINE_LOCATION` solely because BLE scanning on Android 11 and below requires it (`neverForLocation` set for 12+), and `ACCESS_BACKGROUND_LOCATION` is blocked. The local `ios/` folder still has old location strings, but EAS builds from app.json.
- **Song start time:** ShazamKit's `matchOffset` gives when this playback of the track began (`song_started_at`, plus `song_start_spread_ms` = spread of a window's estimates as an accuracy check). Supabase migration `20261003130000_song_start_time.sql`, applied. **Unverified on a device:** check that the spread is under ~1 s, and, with two phones, that they agree.
- **Group codes without typing:** every session gets a random `G-XXXXXX` code. The meter screen's GROUP button shows it as a QR; friends scan it in-app (`expo-camera`, camera permission) or with the Camera app (`vibemeter://join?code=…`). Joining mid-session updates the session's `event_code` and re-uploads it. The typed field is now a fallback ("or type a code"). Pocket is preselected; venue name is optional.
- **Automatic grouping** (`analysis/auto_groups.py`): pairs that share ≥2 playbacks (same ISRC, starts within 1.5 s) are linked, using time-decayed evidence within ±20 min; phones with evidence of being apart are never merged. Synthetic venues (two sharing a playlist, one phone walking between them, 40% of minutes unrecognised): precision 0.996, recall 0.993. With 70% unrecognised it stays at 0.95–1.00 precision; at 85% recall drops (0.4–0.8) but precision mostly holds. `crowd_sync.py --auto` uses it.
- **To decide later:** once real code-labelled nights exist, compare `crowd_sync.py` with and without `--auto`, and `validate_against_codes`. If they agree, the group QR becomes optional.

### Build 7 (3 Oct): rustle-robust beat phase
- **Bass-only onsets while moving** (`detectBPM(..., bassOnly)`, set from the previous motion sample's classification). Synthetic test with heavy high-frequency rustle: clarity 0.99 bass-only against 0.61–0.77 full band.
- **Motion-gated audio suppression was considered and rejected:** when someone dances on the beat, cutting audio at movement peaks removes the real beats and biases the phase away from the movement.
- **`beat_phase_clock`** (new column, Supabase migration `20261003120000_beat_phase_clock.sql`, applied): movement phase against a wall-clock grid at the song tempo, for crowd sync without microphone timing. `crowd_sync.py` reports `crowd_phase_sync_clock` and `crowd_sync_clock` alongside the heard-beat versions (selftest extended and passing). Synthetic check: two phones moving together but capturing 3.3 s apart gave 2.12 and 2.13 rad.
- Sessions now upload the real `app_version`, e.g. `0.2.0 (7)` (`expo-application`), so analysis can tell calibrations and algorithm versions apart. Earlier rows all say `0.2.0`.

### Earlier changes (2 Oct)
- iOS PCM read fixed (`expo-file-system/legacy`; SDK 54 root import throws). Old May data has no valid iOS FFT or beat data.
- Collect-only song columns `song_isrc`, `song_genre`, `song_bpm`, `song_popularity`, `recognition_source` (SQLite migration and Supabase migration `20261002163648_song_descriptors.sql`, applied).
- Home screen shows the anonymous device ID. `analysis/fetch_data.py` paginates past 1,000 rows. `docs/PRIVACY.md` (live on GitHub, contact stoicslav@gmail.com) and `TESTER_GUIDE.md`.

### Local build notes
- `pod install` needs `LANG=en_US.UTF-8` on this Mac.
- Type-check with `npx -p typescript@5.9 tsc --noEmit` (the pinned 5.3 cannot parse Expo's `module: preserve`).
- No Java or Android SDK on this Mac: Android code is only compiled on EAS.

## Supabase
- Project `VibeMeter`, id `fjbqyoulfihewafdkkvt`, eu-west-3. Free tier, pauses when idle.
- **Purged on 2 Oct 2026.** Since then only test sessions exist (simulator `SIMTEST`, `TEST1`, and the hand test `954f077f`). Ask the owner before deleting them ahead of a real pilot.

### iOS 27 launch crash and its fix (22 Oct) — read this
- **Incident:** after the owner updated TestFlight build 26 on two iPhones (iOS 27.0.1), the app crashed on launch. Crash log (pulled from the iPhone 13 with `xcrun devicectl device copy from --device <udid> --domain-type systemCrashLogs --source / --destination <dir>`): `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. **Not caused by the new features:** every build made with Xcode 27.1 (iOS 27 SDK; builds 22–27) crashes on iOS 27.
- **Fix:** `plugins/withSceneLifecycle.js` (see AGENTS.md). Verified: simulator Release build (window, `vibemeter://privacy` link) and **a signed Release build running on the iPhone 13 (iOS 27.0.1) with the app alive after 12 s and no new crash log**. Installing on a device without Xcode's account: `xcodebuild … -destination id=<udid> -allowProvisioningUpdates -allowProvisioningDeviceRegistration -authenticationKeyPath ~/.appstoreconnect/AuthKey.p8 -authenticationKeyID … -authenticationKeyIssuerID …`, then `xcrun devicectl device install app --device <udid> <.app>`.
- **Shipped (22 Oct):** build 28 is live in Public via `ship-testflight.sh` (upload via fastlane pilot, processing, What to Test, group, expiry all ran unattended, so the whole workflow is verified end to end). Builds 26 and 27 are expired. Owner still to confirm on the iPhone 16 and the other iPhone. Original note: the fixed build is 28 (`~/Downloads/ViibeCheck-build28.ipa`). Builds 13/21/22/23 were expired in the Public group when 26 shipped and cannot be restored, so testers need 28. Build 27 (the workflow test build, internal group only) also crashes on iOS 27.
- **Lesson:** after any Xcode/iOS SDK upgrade, run the Release build on a real device of the newest iOS before shipping to testers.

### TestFlight shipping is scripted (21 Oct)
`vibemeter-app/scripts/ship-testflight.sh` uploads the ipa, sets the What to Test text (`docs/testflight-whats-new.txt`), adds it to the Public group, notifies testers and expires old builds, with no Transporter or clicking. **The App Store Connect API key is set up** (`~/.appstoreconnect/AuthKey.p8` + `viibe.env`, never committed; key ID HMG6R77ZT8). Run `bash scripts/ship-testflight.sh` from `vibemeter-app/` (add `--no-build` to ship an ipa that is already built). It skips the upload if that build number is already in App Store Connect, waits for processing, sets What to Test (**no emoji: Apple rejects them**), adds the build to the Public group, submits it for beta review and expires older Public builds once the new one is live. Verified on build 26 (21 Oct): Public now has build 26 only; builds 13, 21, 22, 23 are expired. Upload via `fastlane pilot` authenticated but was not exercised (the owner had already delivered 26). Ask the owner before shipping: it reaches testers.

### Build 26 (21 Oct, built locally, ipa in ~/Downloads, upload pending): refined vibe ranking, DJ links, venue lineup page
- Plan, research table and checks: `docs/plans/build-26-dj-venue-recap.md`. Migration `20261021154904` (applied).
- **Build 25 was built** (`~/Downloads/ViibeCheck-build25.ipa`, checked: app and card 25, Instagram query scheme, Apple Music text) and handed to the owner for Transporter.
- Strategy doc: new section "Cold start and the triangle: audience, DJs, venues".
- **Not verified on a device:** the refined ranking on real nights, live edit matching, Apple Music playlist, Instagram button.

### Build 25 (21 Oct, not built yet): "Your night in songs"
- **Why:** cold start. One person gets value from their own night (the songs they moved to most), and every 👍/👎 is ground truth for "does movement predict enjoying a song?". Plan and owner decisions: `docs/plans/build-25-night-in-songs.md` (Apple Music playlist + Spotify links; lineup per venue night with the QR unchanged; recap at Stop + 12:00 reminder; image card for Stories).
- **What was built:** see AGENTS.md "Your night in songs". Migration `20261021124557` (applied): `venue_sets`, `venue_sets_for`, `song_feedback`, `upload_song_feedback`, deletion and retention. New native module `modules/music-library`; new dependency `react-native-view-shot` 4.0.3.
- **Verified:**
  - `npx tsx scripts/night-recap-test.ts` (10 checks): dancing on the beat ranks first; a danced-to unrecognised edit is ranked and credited to the DJ; the song heard with the phone on the bar, a 15 s song and a song stood through are not listed.
  - **Simulator, with a synthetic C12 night** written into the local database and a test lineup on the server (both removed afterwards):
    - the recap showed Levitating (credited to the warm-up DJ), the unrecognised stretch (headliner) and Delilah, with reasons;
    - 👍 and 👎 uploaded with ISRC/rank/score/DJ and no titles;
    - Add to Apple Music asked for access with our text, then failed gracefully (no Apple Music account in the simulator, MusicKit not yet enabled);
    - Share produced a PNG card in the share sheet;
    - Stop built an (empty) recap without errors;
    - the summary shows the recap link.
- **Not verified:**
  - real ShazamKit songs on a device;
  - the Apple Music playlist (needs the MusicKit service and an Apple Music subscription);
  - the 12:00 notification;
  - how many songs get recognised at a club (check after the first real night: coverage in the recap header).
- **MusicKit:** the owner enabled the MusicKit App Service (21 Oct). In the simulator the app then obtained a developer token and reached playlist creation, which waits indefinitely without an Apple Music account, so the call is now capped at 25 s. The real playlist still needs a check on a phone with Apple Music.
- **Wording:** music Shazam can't name is shown as "DJ edits · <DJ> · <times>" (owner's choice). Recognising DJs or their edits by sound: `docs/ideas/dj-fingerprints.md`.
- **Part 2 (21 Oct):**
  - Wrapped-style share card;
  - Share to Instagram Story (Meta App ID `1102053282622187`, the owner's Meta developer app "Viibe Check", in `app.json` `extra.instagramAppId`);
  - DJ edits via a ShazamKit custom catalog (learned from lineup sets, plus DJ registrations at `vibemeter://dj`, QR `docs/assets/dj-register-qr.png`, approved by us);
  - migration `20261021133324_dj_edits` (applied).
  - Details and what was checked: `docs/plans/build-25-night-in-songs.md`, part 2.
  - Live acoustic matching is unverified (simulator limit), so check on a phone: register a song through the DJ screen, approve it, then play it from a speaker during a session.
- **Adding a lineup** (until clubs have a page): `insert into venue_sets (place_id, dj_name, starts_at, ends_at) values ('<Google place ID>', '<DJ>', '<start with time zone>', '<end>');`. C12's place ID is `ChIJpzxaoX_Ew0cRDSgjKYR0C4U`.

### Build 24 (18 Oct, built locally): weekend-night reminder and opt-in "Going out" standby
- **Status:** `~/Downloads/ViibeCheck-build24.ipa` (checked: app and card build 24, `CardActionIntent` registered, no background-location strings). Owner uploads with Transporter after build 23.
- **Device checks still to do (TestFlight):** `docs/device-test-plan.md`.
- **Plan with the owner's decisions:** `docs/plans/build-24-going-out-standby.md`. Movement condition added by the owner: loud music alone is not enough, some dancing rhythm is needed too.
- **What was built:**
  - `src/session/Standby.ts` + `StandbyRules.ts`, `SensorOrchestrator.startStandby/stopStandby` (light checks every 30 s, nothing stored);
  - `isInVehicle` (Core Motion) in `audio-capture`;
  - card modes standby/prompt with `CardActionIntent` (Yes, start / Not now / Turn off) and alerts;
  - `startSessionFromStandby` reusing the open microphone; `app/going-out.tsx` (opt-in, on/off, reminder days and time); Home button "Going out tonight?"; a Privacy & data row to withdraw;
  - `NightReminder.ts` (weekly local notifications);
  - `standby_nights` + `sessions.start_source` (migrations `20261018183326`, `20261018183808`, applied; deletion and retention cover them);
  - the meter timer now counts from the session's real start.
- **Verified in the simulator:**
  - **Prompting and starting:**
    - the opt-in screen;
    - standby card on the lock screen;
    - with the 124 BPM test track played from the Mac (thresholds temporarily lowered: the Mac's speakers reach only ~50–60 dB at the simulator mic, and the simulator has no motion), the card switched to "Sounds like a party 🎶 Start measuring?" plus the notification;
    - **Yes, start** on the locked screen started a session (`start_source = standby`) that reused the microphone and turned the card into the session card.
  - **Other buttons:**
    - card STOP → confirm ended the session, and standby ended as `session_ended`;
    - **Not now** → back to standing by, logged as declined;
    - **Turn off** → ended as `user`;
    - card ratings still work (`live_activity`).
  - **Saved counts:** `standby_nights` rows uploaded with correct counts.
  - **Rule test:** `npx tsx scripts/standby-rules-test.ts` passes 21 cases (club dancing yes; loud bar without dancing, walking, standing, phone on a table, restaurant, quiet room no; night hours; 06:00 end).
- **Not verified:**
  - the movement rule on a real phone (the simulator has no motion);
  - battery per hour on standby;
  - the Live Activity alert's buzz in a pocket;
  - the reminder firing (scheduling verified in the log only);
  - the vehicle check.
- **Look at after the first nights:** `standby_nights` (battery drain, prompts accepted vs declined/ignored, music-only minutes when no prompt came).
- **Local project quirk:** re-running `expo prebuild` on a project that already has the card target fails in `@bacons/apple-targets` (`removeFromProject`); restore `ios/project.pbxproj.before-card` first (see AGENTS.md). EAS builds are unaffected.

### Build 23 (18 Oct, built locally): lock-screen rating card (Live Activity), closing interrupted sessions
- **Status:** built with `eas build --local` after the owner signed in to Apple once; EAS registered `com.leogerasimov.vibemeter.card` and its App Store profile (push notifications: not set up, not needed). `~/Downloads/ViibeCheck-build23.ipa`, checked: build 23 for both app and card, card signed for team APRS7H5DD6, `RateVibeIntent` in the app's metadata, only the While-Using location string. Future local builds can run non-interactively again.
- **Plan and owner decisions:** `docs/plans/build-23-live-activity.md` (buttons always work, highlighted when due; the vibrating notification stays; card shows venue + timer + STOP).
- **What was built:**
  - widget extension `targets/live-activity` (target `ViibeCard`, bundle ID `com.leogerasimov.vibemeter.card`, `@bacons/apple-targets` 5.0.0);
  - local module `modules/live-activity` (`ViibeLiveActivity`);
  - `plugins/withLiveActivityIntent.js` (compiles `RateVibeIntent.swift` into the app target too, sets `NSSupportsLiveActivities`);
  - `src/notifications/LockScreenCard.ts` (driven by `VibePrompt`);
  - `app/stop.tsx` (STOP deep link with confirmation);
  - `closeInterruptedSessions` at launch;
  - `ios.appleTeamId` in app.json.
- **Database:** migration `20261018140457` (applied): `subjective_ratings.prompted`, `end_reason` may be `interrupted`. `rating_source` gains `live_activity` (no constraint).
- **Verified in the simulator (iPhone 17, iOS 26.5):**
  - **Lock-screen card and ratings:**
    - the card appears at session start; iOS asks "Allow Live Activities from Viibe Check?" once;
    - an unprompted 🔥 tap reached JS through the intent and uploaded (`live_activity`, `prompted = false`);
    - at the prompt the card switched to "How's the vibe right now?" with highlighted buttons while the notification also fired;
    - a 🙂 tap then uploaded with `prompted = true`, response 10 s, showed "Thanks 🙂" and cleared the notification.
  - **STOP:** opened the app on "End this session?".
  - **Dynamic Island:** compact (dot + timer) and expanded with working buttons.
  - **Killed app:**
    - after the app was killed, the card turned grey after 15 min ("Not measuring");
    - relaunching closed the session as `interrupted` at its last rating, uploaded it, and removed the card;
    - the same launch closed the simulator's two old open sessions (4 and 6 Oct).
  - **Metadata:** `Metadata.appintents` of both the app and the card lists `RateVibeIntent`.
- **Fixed after the first check:** a grey card no longer shows a running timer or STOP; the expanded island's top text is inset from its corners. Both rechecked in the simulator.
- **Killed app, card still live:** a tap within the 15 minutes woke the app in the background (verified). It dropped the tap (no session running), closed the old session as `interrupted` and removed the card.
- **iOS prompts:** iOS asks a second time later: "Do you want to continue to allow Live Activities…? Don't Allow / Always Allow". The tester guide says to allow both.
- **Not verified:**
  - a real device: Face ID on STOP, buzzing, battery effect of the 5-minute card updates;
  - iOS 16.2–16.x (card without buttons);
  - the EAS signing of the new extension.

### Build 22 (18 Oct, built locally): P0 from the 17 Oct feedback: consent, mic required, deletion, retention
- **Status:** built with `eas build --local` (build number 22, version 0.2.0, only the While-Using location string), `~/Downloads/ViibeCheck-build22.ipa`; owner uploads with Transporter and adds it to the TestFlight `Public` group.
- **Context:** a friend's feedback session (17 Oct) and the agreed 90-day plan (strategy doc "MVP scope and 90-day pilot"). P0 = compliance + mic requirement + Live Activity rating. Outreach drafts for labs (UCLouvain Rhythm & Brains, imec-SMIT VUB, IPEM Ghent), the Brussels Night Council and C12: `docs/outreach/drafts-2026-10.md`. Owner picks: students, city centre, C12.
- **Consent screen** before the first session: 18+ checkbox, microphone required, motion/Bluetooth/location toggles (whole row toggles; the native switch is display-only because synthetic taps on it were unreliable and a tap could toggle twice). Stored in SecureStore; enforced in the orchestrator and VenueLocator. Sessions store `consent_version` and `sensors` (migration `20261017153439`).
- **Mic required:** Start asks for microphone permission and blocks with "Microphone needed … Open Settings" if refused (verified in the simulator by revoking the permission).
- **Privacy & data screen:** consent toggles, anonymous ID, privacy-policy link, "Delete my data" (confirm dialog → `delete_my_data` RPC, local wipe, new ID, consent and dance answer cleared).
- **Retention:** `apply_retention` now also deletes sessions older than 24 months.
- **Verified:** server deletion with a throwaway device via the public key (session and rating gone, second call 0, bad ID refused); in the simulator: consent flow, toggles, stored consent on the session, privacy screen, delete confirmation (cancelled, so no simulator data deleted), mic-refused block. **Not verified:** a full in-app deletion on a device (do it with a test install), Android permission behaviour.
- **Docs:** `docs/PRIVACY.md` (18+, consent basis, in-app deletion, 24 months), `docs/DPIA.md` draft (needs legal review).
- **Still to do in P0:** Live Activity rating buttons (iPhone), Android device test.
- **Side note:** a simulator session from 10 Oct stayed open for 693 minutes; the 8 h auto-stop did not fire while the simulator app was suspended. Check on a device whether auto-stop runs during long locked sessions.

### Build 17 (6 Oct; TestFlight build number 21): Group sheet with Show/Scan, venue QR codes
- **Built locally** (`eas build --platform ios --local`, fastlane from Homebrew) because the EAS free plan's iOS builds for October were used up (resets 1 Nov). The remote build number advanced on each attempt, so this build is **21**. Local builds use Xcode 26.6, which needs `plugins/withFmtConstevalFix.js` (patches React Native's fmt 11 consteval check in a Podfile post_install); cloud builds used an older Xcode and never needed it.
- **Group sheet** (`GroupSheet`): one modal with SHARE | SCAN from the start screen and the meter. A draft group code exists before the start (`getDraftGroupCode`). "N phones measuring in this group" from `group_size(code)` (migration `20261006211208`: also adds `venue_source = 'qr'`).
- **Venue codes:** `vibemeter://join?venue=…&name=…`; made on `app/venue-code.tsx` with the new `find-venue` Edge Function (Google text search; "C12 Brussels" → C12, Rue du Marché aux Herbes 116). Scanning confirms the venue and joins `V-` + SHA-256(place ID + night) unless the phone is in a friend's group.
- **Verified in the simulator** (camera-free, via `xcrun simctl openurl` deep links): venue link before the start → name filled "📍 From the venue's code", Group sheet shows the crowd code V-N74Q4E, session uploaded with `venue_source = qr`, `event_code = V-N74Q4E`; venue link during a session → "Joined tonight's crowd", `group_size` = 1; a session that joined a friend's code (G-FRND22) kept it after a venue scan; the venue-code screen's QR decodes (OpenCV) to `vibemeter://join?venue=ChIJpzxaoX_Ew0cRDSgjKYR0C4U&name=C12`.
- **Fixed during testing:** Start read the scanned venue after clearing it (session saved as `auto` with its own code); the join route ran only on first mount (tab screens stay mounted), so a second identical link hung on the spinner (now `useFocusEffect`).
- **Not verified:** scanning with a real camera (in-app and the Camera app); two real phones seeing each other in `group_size`.
- **Simulator notes:** an old simulator install `com.vibemeter.app` also claimed the `vibemeter://` scheme and was removed. One simulator crash in `AVAudioEngine inputNode` (RPC timeout to the simulator's audio service, `abort`) during a session start after many restarts; the audio code is unchanged since build 11, so likely simulator-only, but watch for it on devices.

### Build 16 (6 Oct): venue confirmation, real Google lookup, no "Always" location string
- **Google key set up by the owner** (`GOOGLE_PLACES_KEY`). Real lookups verified with the public key: inside Galerie Horta (50.8463, 4.3560) → **C12** (night_club, 28 m); 40 m away the closest "night club" is a restaurant-bar (Sentro), near Grand Place → Che Habana Café; a street with nothing within 150 m → none. Places Google tags `night_club` include restaurants, so confirmation is needed.
- **Confirmation popup (owner's request):** "Are you at X? … Confirm it to link your session to it." Yes / No (`confirmVenue`). Verified in the simulator at C12 with the real lookup: **No** → field blank, "Venue left blank", session uploaded with no venue, and the immediate in-session re-check did not ask again; **Yes** → "📍 Confirmed · 28 m away", session `venue_source = auto`, both windows carry C12's place ID. **Not verified:** the in-session proposal of a *different* venue (needs moving and reopening the app after 10 min).
- **Info.plist:** `locationAlwaysAndWhenInUsePermission` and `locationAlwaysPermission` set to false in the expo-location plugin, so only `NSLocationWhenInUseUsageDescription` remains (checked with `expo config --type introspect`).

### Build 15 (6 Oct): venue auto-identification, phone context, auto-stop, Live tab with give-to-get, engagement analysis
- **Owner prerequisite (done 6 Oct):** Google Cloud project with **Places API (New)** enabled and billing on, an API key restricted to that API, saved as the Edge Function secret `GOOGLE_PLACES_KEY` (Supabase Dashboard → Edge Functions → Secrets). Until then `identify-venue` answers 503 and the app shows "Couldn't recognise the venue"; everything else works.
- **Venue:** `src/session/VenueLocator.ts` (expo-location, While Using only) → Edge Function `identify-venue` (closest night club within 150 m, else bar or pub; the rounded position is not stored or logged) → `sessions.venue_place_id / venue_source / venue_distance_m` and per-window `venue_place_id`. The start screen pre-fills the name; a typed name is `manual` and stops the re-checks. Re-check on foreground every 10 min at most.
- **Phone context:** `classifyPhoneContext` per cycle (`off_body`, `on_body_still`, `on_body_moving`, `uncertain`); `sensor_clips.phone_context`, `sensor_windows.phone_context` and `on_body_share`. **Thresholds unverified on a device** (the simulator has no motion sensors).
- **Auto-stop:** `SessionControl.stopEverything(reason)`; rules in `SensorOrchestrator.checkAutoStop`; `sessions.end_reason`; notification on auto-stop.
- **Live tab** (planned as build 16, shipped in 15 to save an upload): `app/live.tsx` and `src/storage/LiveAccess.ts`. Verified in the simulator: the test venue appears locked ("10 more minutes"), a free Night Pass unlocks it until 06:00, and the view is logged in `live_views`. **Not verified:** unlocking by 10 contribution minutes (the simulator has no motion, so its windows have no on-body share).
- **Server for the live view:** tables `venues` and `live_views` (no anon privileges), `live_venues()` and `log_live_view()` (migration `20261005220027`, grants `20261005221801`). `upload_sessions` now updates venue fields and `end_reason`.
- **Analysis:** per-person z-scores (`<signal>_z`), off-body windows dropped, loudness-vs-movement test (`correlations.py`); `residual_sync` in `crowd_sync.py`; new `engagement.py`. Self-tests pass (beat-only crowd: residual phase −0.01, energy +0.01; coupled crowd: +0.21, +0.51). Ran end to end on the real data (too little data for results).
- **Verified in the simulator:** auto-stop after quiet minutes (`end_reason = no_music`, threshold temporarily lowered); with a temporary stand-in of the Edge Function returning "Test Club": the start screen pre-filled it ("Found on the map · 40 m away"), the session and all 3 windows uploaded with the place ID, and `live_venues()` returned the venue with 1 contributor, confidence low. The real function was redeployed afterwards (answers 503 until the key is set). Test rows left: venue `TEST_PLACE_SIM` ("Test Club (simulator)") and its session; the earlier `RPCTEST` live view row.
- **Not verified:** real Google lookups; phone-context thresholds; the low-battery and 8 h rules; auto-stop while locked on a device.

### Build 14 (5 Oct): uploads through RPC functions (lockdown step 2a), battery logging
- **Upload functions** (migration `20261004233010_upload_rpc_functions`, applied with the owner's OK): `upload_sessions`, `upload_sensor_windows`, `upload_ratings`, all `SECURITY DEFINER`, JSON array of at most 500 rows. Sessions update on conflict only when `device_id` matches; windows and ratings are kept as first written. `SupabaseSync` calls them instead of table upserts; clips still use a plain insert.
- **Verified with the anon key (curl):** insert, end-of-session update, an update from another device_id refused (0 rows), duplicate window ignored, bad payload refused. A test session `RPCTEST` (device `RPCTEST`) was left in the database. **Verified in the simulator:** session, 4 windows (with bass envelopes), 21 clips and two ratings (3 and 5, `rating_source = app`) uploaded through the functions (session `SIM RPC`).
- **Lockdown step 2b (to do):** once every tester is on build 14 or later (check `app_version` of recent sessions), drop the anon SELECT and UPDATE policies on `sessions`, `sensor_windows` and `subjective_ratings`. Older builds would then fail to upload.
- **Battery logging:** `sessions.battery_start_pct`, `battery_end_pct` (0–100, null while charging or unknown, e.g. in the simulator) and `low_power_mode` (migration `20261004232957`, `expo-battery`). Drain query at the end of `analysis/monitoring_queries.sql`.

### Build 13 (4 Oct): app renamed "Viibe Check", new icon, vibrating prompt
- **Public TestFlight link (enabled by the owner, 10 Oct): https://testflight.apple.com/join/arweYPp8** (group `Public`; also in `TESTER_GUIDE.md`). New builds reach friends once they are added to that group.
- **Status:** built on EAS (`01842212-…`), uploaded via Transporter. App Store Connect name changed to "Viibe Check". **Submitted for Beta App Review on 4 Oct** in the external group `Public` (Test Information and review notes filled from `docs/TESTFLIGHT_PUBLIC.md`, no sign-in). After approval: enable the Public Link in that group and share it with `TESTER_GUIDE.md`.
- **Name:** display name and all user-facing text say "Viibe Check" (app.json `name`, permission strings, home wordmark, tab title, Android session notification, group sheet, privacy page, tester guide, TestFlight text). Unchanged: bundle ID `com.leogerasimov.vibemeter`, Android package, repo and URLs, the internal `ViibeMeterSession` task name. Done in App Store Connect too.
- **Icon:** designed in Figma (https://www.figma.com/design/PwDGNebtd9RSCSB3uAPAWt). "Viibe" over "Check" in Outfit SemiBold, white on pure black; the V is a green check with a dark-green outline, and the dots of the two i's are flames. The flame and check are original vector drawings, not Apple emoji (Apple's emoji artwork is not licensed for app icons). `assets/icon.png` is flattened to RGB because App Store icons must not have alpha. `assets/adaptive-icon.png` holds the icon at 78% on transparency for Android's mask, with a #000000 background. `splash-icon.png` is the same artwork.
- **Vibration:** the vibe-check notification plays the default sound on iOS (iOS only vibrates with a sound; in silent mode it only vibrates), and Android uses a new `vibe-check` channel with a vibration pattern (the old silent `vibe-prompt` channel is deleted).

### Build 12 (code done 4 Oct): 3-level rating from the lock screen, calm meter screen
- **Why:** only **1 rating** arrived since the 2 Oct purge, across about 25 minutes of device tests (about 5 expected). The notification auto-dismissed after 60 s, its `vibe-rating` category was never registered (so it had no buttons), nothing handled taps, and the in-app sheet closed after 15 s.
- **Rating scale (owner's decision):** 💀 Dead / 🙂 Decent / 🔥 Best, identical on iOS and Android, stored as 1 / 3 / 5 (`rating_scale = 3`) to fit the 1–5 column and its CHECK. Music and crowd sub-ratings were dropped from the UI.
- **Lock screen:** the category is registered with three actions (`opensAppToForeground: false`); `addNotificationResponseReceivedListener` records them as `rating_source = 'lockscreen'`. The prompt is no longer auto-dismissed; a new prompt replaces an unanswered one. Tapping the notification body, or reopening the app with a pending prompt, shows the one-tap sheet (`rating_source = 'app'`). Migration `20261004142238_rating_scale_and_source`.
- **Meter screen:** the calm default view while recording shows the vibe ring, the song or "Listening…", "next vibe check in N min", "Rate the vibe now" and "details". The four technical tabs are unchanged behind "details".
- **Unverified on a device:** whether iOS delivers a lock-screen action to JS while the app runs in the background (it should, since the continuous mic keeps JS alive).

### Build 11 (4 Oct): 10 s clips, bass-envelope grouping, foreground BLE, movement tempo
- **Clock-aligned cycles:** each audio + motion cycle starts at a multiple of 10 s; a late wake-up (> 0.5 s) skips to the next boundary. iOS reads exactly `[T, T+5 s)` with native `readRange`.
- **`sensor_clips`** (Supabase table, migrations `20261004122616` and `20261004122731`): one lean row per cycle. The app can only insert (verified with the anon key: insert ok, duplicate rejected with 23505, select and update refused). Uploads use plain insert, retrying row by row on duplicates.
- **Retention:** pg_cron job `viibemeter-retention` (daily 03:17 UTC, `public.apply_retention()`) deletes clips and clears `bass_envelope` after 90 days (migration `20261004122802`).
- **Bass envelope:** `bass_envelope` per window (240 × 250 ms, base64). Filter check: 40–150 Hz passband, −32 dB at 1 kHz, −57 dB at 4 kHz; quantisation error ≤ 0.2 dB. Server matching thresholds T_hi 0.60 and T_lo 0.25 come from synthetic DJ sets: the same-room median r is 0.75, while different rooms (same set 90 s later, or another set at the same tempo) have a median of 0.04–0.11 but a p99 of 0.71, so a single minute is not enough. Linking needs ≥3 lag-consistent minutes, and "apart" minutes count against. Envelope-only self-test: precision 1.00, recall 0.985–0.991; the mover switches rooms; an Android-style phone (half coverage) groups correctly. With noisier phones (4.5 dB noise, double chatter) recall drops to 0.34 but precision stays 1.00. Detrending the envelopes was tried and made separation worse.
- **Movement tempo:** 60–180 BPM, local peaks only, prefer the half period at ≥ 0.85, report at rhythmicity ≥ 0.35. Synthetic: 120→120, 62→63, 90→91, 128→130, 150→150, jittery 120→120, slow sway and noise → none.
- **Foreground BLE scan** on app activation (10 s debounce).
- **Database lockdown, step 1 done (owner's choice):** the anon key can no longer DELETE or TRUNCATE `sessions`, `sensor_windows` or `subjective_ratings` (migration `20261004124542_block_anon_delete`). Verified with the anon key: upsert of a new and an existing session works, delete is refused (42501). `sensor_clips` is insert-only. **Step 2 (to do):** a probe table showed `upsert` fails under RLS without SELECT, even with `ignoreDuplicates`. So first switch `SupabaseSync` to `SECURITY DEFINER` RPC functions (for example `upsert_sessions(jsonb)`) in a build, wait until testers have updated, then drop the SELECT policies. Security advisors now only flag the remaining anon/authenticated SELECT.
- Migration files renamed to the versions Supabase recorded.

### Build 29 (24 Oct, built in the repo, not yet shipped): quiet card, best moments, swipe to delete
Plan and decisions: `docs/plans/build-29-best-moments.md`. Details in AGENTS.md ("Lock-screen card", "Best moments").
- **Card:** venue, timer, STOP and the live song (`setCardSong`); the three vibe buttons are gone (`RateVibeIntent` deleted, card state has `song` instead of `due/lastRating/thanksUntil`). Needs the regenerated iOS project (done locally with the `project.pbxproj.before-card` restore, then `pod install`).
- **Buzz:** the 5-minute prompt is off by default (`PromptSettings.ts`, toggle in privacy & data). The Meter's rate button still rates.
- **Recap:** tempo multiples weigh by distance from the beat (`HARMONIC_WEIGHTS`; test updated: `npx tsx scripts/night-recap-test.ts`, 21 checks).
- **Swipe a past session to the left to delete it** (`delete_my_session` RPC, migration `20261024072334`, and `deleteSessionLocal`; the server goes first; moment clips are deleted with it).
- **Best moments (opt-in, owner asked for both routes):** `MomentKeeper`, `ClipCleaner`, `MomentsSection`, `MomentSettings`; table `moments` (phone), `moment_clips` + private bucket `moments` + Edge Function `moments` (server; migrations `20261024074015` and `20261024075500`); `analysis/clip_enhance.py`. Privacy docs updated (PRIVACY.md, DPIA.md v0.2).
- **Verified:** `npx -p typescript@5.9 tsc --noEmit` clean; tests `night-recap-test`, `standby-rules-test`, `clip-cleaner-test` pass; `clip_enhance.py --selftest` and a synthetic `--run` pass (venv with numpy and scipy only); the `moments` Edge Function end to end with a throwaway device (bad requests refused, upload to the private bucket, other device refused, public key cannot read the bucket or the table, delete removes file and row, no leftovers); RPC `delete_my_session` (other device refused). Simulator (Release build, iPhone 17): app launches; privacy & data shows the three new switches off by default and the "Keep my best moments" explanation; a synthetic clip inserted into the app's folder and database shows on the recap, plays (button turns to STOP) and deletes (row and files gone); a real session shows the quiet lock-screen card (venue, timer, STOP, "Listening for the song…", no vibe buttons) and the Meter has no 5-minute countdown.
- **Not verified:** everything audio: real pocket recordings, the moment thresholds (`MOMENTS`), the cleaner on real audio, Demucs and `--shazam` (not installed here), battery. The first upload from a phone, the lock-screen card on a real iPhone with the song line, and deleting a synced session from a device.
- **Debug builds:** a Debug (dev-client) simulator build crashes at launch with the scene-lifecycle plugin (`ExpoDevLauncher ... Cannot find the keyWindow`). Test with Release builds (`xcodebuild -configuration Release -sdk iphonesimulator`, JS embedded) or EAS builds, which don't include the dev launcher.
- **Ship:** the owner said one build with everything; shipping still needs their okay (standing rule), then `bash scripts/ship-testflight.sh` (the What to Test text is already updated in `docs/testflight-whats-new.txt`).

## Do next, in order
0. **Build 29 (best moments etc.):** ship after the owner's okay; at the first night with 2+ friends who opted in to both switches, run `analysis/clip_enhance.py --fetch --run` (install `demucs` and optionally `shazamio` first) and decide which layer is best; then decide whether the upload route earns its privacy cost. Legal review of recording bystanders (DPIA open item) before offering "Send them to us" beyond friends.
1. **First real rated night (owner, highest value):** 2–3 friends on build 23 (or 22) via the public TestFlight link, one shared group code (GROUP → SHARE/SCAN), a city-centre venue (C12 or a student night), ratings every 5 minutes, Stop when leaving. Add 20–30 minutes in a quiet bar for contrast. Without rated nights nothing can be validated.
2. ~~Stop the open session on the owner's iPhone 16~~: deleted on 18 Oct at the owner's request (session `697b622b`, device `d345a62e`, an 80-second test with one rating and no windows).
3. **Outreach (owner):** fill in contacts and send the drafts in `docs/outreach/drafts-2026-10.md` (Rhythm & Brains UCLouvain, imec-SMIT VUB, C12 / Deep in House, Brussels Night Council).
4. **Build 23** (lock-screen rating card, built 18 Oct): owner uploads with Transporter and adds it to the Public group; then test on a real iPhone (Face ID on STOP, buzzing, battery).
5. **Recap feedback loop (core):** the 👍/👎 answers on the recap decide how the signals are weighed and when new analysis is needed. After real nights: `fetch_data.py`, then `fit_recap_weights.py`; follow `docs/feedback-learning.md`.
6. **After the first night:** `monitoring_queries.sql` data-quality checks, then `fetch_data.py`, `correlations.py`, `crowd_sync.py`, `engagement.py`. Report what holds up, including against the busyness proxy (loudness + crowd size).
6. **Android on a friend's phone:** install the APK, run a locked 10-minute session, check windows are continuous and motion is non-zero (`SessionService` in logcat if it fails). Calibrate the Android dB offset.
7. **Validation night for automatic grouping:** 3–5 phones in one room, plus one phone in another room playing the same playlist 1 minute later; then `auto_groups.py` and `crowd_sync.py --auto`.
8. **Build 24** (Going out standby + weekend reminder): owner uploads, then tests on a real iPhone: arm at home, check the prompt comes at a party with dancing and not in a loud bar without dancing, note battery. Venue beacons for partner venues: `docs/ideas/venue-beacons.md` (raise with C12).
9. **Later:** lockdown step 2b (drop anon SELECT/UPDATE once everyone is on build ≥14); legal review of `docs/DPIA.md`; Home redesign (Live merged into Home, ranked by fit) after real nights.

## Known caveats
- Battery: on iOS the mic is open for the whole session, and on Android a wake lock is held while the session service runs.
- Android has never run on a device.
- `expo-av` and `expo-background-fetch` are deprecated in SDK 54 (warnings only).
- A spurious BPM of 200 on ambient noise was seen once in the simulator.

## Research basis (why these signals)
Ranked by how directly each is tied to enjoyment. No paper proves any signal predicts a vibe rating, which is the gap this app tests.
- **Movement energy:** Martella et al. 2015 (accelerometer predicted enjoyment at ~90% balanced accuracy, 32 people). Witek et al. 2014 (wanting to move ≈ pleasure, r = .96).
- **Crowd sync:** Tarr et al. 2016 (synchronised dancing raises closeness). Ellamil et al. 2016 (club group synchrony measured with phones). Dotov et al. 2021. Bonding effect is small (Mogan 2017, r ≈ .17). Tschacher 2023 found no link to affect in seated classical concerts.
- **Beat lock:** Swarbrick et al. 2019 (indirect). It is also the input to crowd sync.
- **Music features:** Burger et al. 2013 and Ellamil et al. 2016 (pulse clarity, 100–150 BPM, spectral flux).
- **Only Witek 2014 and Ellamil 2016 were read in full.** The rest come from abstracts and summaries.
- **Not building:** audio entropy (poor predictor in Witek 2014), raw 3-axis magnitude as a rhythm source (worst in Ellamil 2016), syncopation estimation.

## Phase 2 backlog (lower evidence)
Hi-hat spectral flux (6.4–12.8 kHz) in `FFTProcessor.ts`, whether track popularity (now collected) relates to ratings, and whether to add beat sync to the composite score after validation.
