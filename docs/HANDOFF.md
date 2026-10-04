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

### Build 13 (4 Oct): app renamed "Viibe Check", new icon, vibrating prompt
- **Status:** built on EAS (`01842212-…`), uploaded via Transporter. App Store Connect name changed to "Viibe Check". **Submitted for Beta App Review on 4 Oct** in the external group `Public` (Test Information and review notes filled from `docs/TESTFLIGHT_PUBLIC.md`, no sign-in). After approval: enable the Public Link in that group and share it with `TESTER_GUIDE.md`.
- **Name:** display name and all user-facing text say "Viibe Check" (app.json `name`, permission strings, home wordmark, tab title, Android session notification, group sheet, privacy page, tester guide, TestFlight text). Unchanged: bundle ID `com.leogerasimov.vibemeter`, Android package, repo and URLs, the internal `ViibeMeterSession` task name. Done in App Store Connect too.
- **Icon:** designed in Figma (https://www.figma.com/design/PwDGNebtd9RSCSB3uAPAWt). "Viibe" over "Check" in Outfit SemiBold, white on pure black; the V is a green check with a dark-green outline, and the dots of the two i's are flames. The flame and check are original vector drawings, not Apple emoji (Apple's emoji artwork is not licensed for app icons). `assets/icon.png` is flattened to RGB because App Store icons must not have alpha. `assets/adaptive-icon.png` holds the icon at 78% on transparency for Android's mask, with a #000000 background. `splash-icon.png` is the same artwork.
- **Vibration:** the vibe-check notification plays the default sound on iOS (iOS only vibrates with a sound; in silent mode it only vibrates), and Android uses a new `vibe-check` channel with a vibration pattern (the old silent `vibe-prompt` channel is deleted).

### Build 12 (code done 4 Oct): 3-level rating from the lock screen, calm meter screen
- **Why:** only **1 rating** arrived since the 2 Oct purge, across about 25 minutes of device tests (about 5 expected). The notification auto-dismissed after 60 s, its `vibe-rating` category was never registered (so it had no buttons), nothing handled taps, and the in-app sheet closed after 15 s.
- **Rating scale (owner's decision):** 💀 Dead / 🙂 Decent / 🔥 Best, identical on iOS and Android, stored as 1 / 3 / 5 (`rating_scale = 3`) to fit the 1–5 column and its CHECK. Music and crowd sub-ratings were dropped from the UI.
- **Lock screen:** the category is registered with three actions (`opensAppToForeground: false`); `addNotificationResponseReceivedListener` records them as `rating_source = 'lockscreen'`. The prompt is no longer auto-dismissed; a new prompt replaces an unanswered one. Tapping the notification body, or reopening the app with a pending prompt, shows the one-tap sheet (`rating_source = 'app'`). Migration `20261004142238_rating_scale_and_source`.
- **Meter screen:** the calm default view while recording shows the vibe ring, the song or "Listening…", "next vibe check in N min", "Rate the vibe now" and "details". The four technical tabs are unchanged behind "details".
- **Lockdown step 2a (upload RPC functions) and battery logging:** drafted, not applied. The live-database change needs the owner's explicit OK.
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

## Do next, in order
1. **Device test of build 13** (owner): lock-screen rating buttons and vibration, tapping the notification opens the sheet, both ratings reach Supabase with the right `rating_source`. Also **retest beat sync** with songs Deezer lacks a tempo for: check `song_bpm_source = learned`, beat PLV present in dancing minutes, and higher on beat than off beat. Also tap GROUP and check the QR scans with the Camera app: same protocol, pocket, about 10 minutes. Check that the on-beat minutes now have beat PLV above the off-beat ones, and that dB is close to the Watch reading.
2. If PLV still does not separate on-beat from off-beat, look at movement peak detection (`findMovementPeaks`) and the movement axis choice next.
3. **Android on a friend's phone:** install the current APK (see Distribution), run a locked 10-minute session and check that windows are continuous and motion is non-zero. If the service fails to start, look for `SessionService` in logcat. Calibrate the Android dB offset too.
4. **Pilot at a real venue with ≥3 phones** on one event code (crowd sync), ratings every 5 minutes. Testers install through the public TestFlight link once build 13 is approved (group `Public`).
5. **Analysis:** `fetch_data.py`, then `correlations.py` and `crowd_sync.py`.
6. **Validation night for automatic grouping:** 3–5 phones in one room, plus one phone in another room playing the same playlist 1 minute later. Then run `auto_groups.py` (and `validate_by_source`) and `crowd_sync.py --auto`.

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
