# AGENTS.md

Instructions for any AI coding agent working in this repository. This is the single source of truth for agents; tool-specific files (such as `CLAUDE.md`) only point here. Read it first.

## Read before starting
1. **`docs/HANDOFF.md`**: current state, decisions, what is untested, and the ordered "Do next" list. Start here to continue work in progress. If it conflicts with anything older, trust it, and update it when you finish a task.
2. **This file**: commands, architecture, scoring, build quirks, privacy and working rules.
3. **`README.md`**: product background, signal table, data-collection strategy and success criteria.

## How the owner works
They want the agent to drive the work end to end and give only minimal direction and oversight. Do the work, verify it, and report outcomes faithfully, including failures. Ask only when a decision is genuinely theirs: spending money, deleting data, anything outward-facing.

## Project overview
ViibeMeter is an iOS/Android app that passively measures "vibe" at venues using phone sensors (microphone, accelerometer/gyroscope, BLE) and uploads aggregated metrics to Supabase. It is a research MVP for validating whether passive sensor data correlates with subjective crowd-energy ratings. The central hypothesis is that people moving in sync with the music, and with each other, signals a high vibe.

## Product and UX direction (owner-agreed, 6 Oct 2026)
The consumer value is **"the best parties near me, for me, right now"**, but the app is in Phase 1: its job is to collect rated nights (sessions + 💀/🙂/🔥 ratings) to prove that sensors predict enjoyment. Design every screen so that starting a session and answering prompts stays effortless. Rules for UX work:
- **Contribution comes first.** The top of Home is always "You're at <confirmed venue>? Start session". Without contributors there is no live data for anyone.
- **Never show an empty or dead state as the main content.** "Live near you" appears only when real live data exists; venues without data are hidden, never shown as dead.
- **Rank by fit, not by an unproven vibe score.** Fit = genre (a one-time pick of 2–3 genres, then learned from the `song_genre` of the user's own sessions) + distance, with the reason shown ("techno · matches you · 6 min walk · 70% dancing · 9 phones"). Live activity is shown as separate indicators (dancing, energy, momentum, music, crowd, contributors/confidence), not one score, until the Phase 1 analysis validates which signals predict ratings; only then may a validated signal enter the ranking. No global "best party" leaderboard (unproven, and it sends everyone to one club).
- **Give-to-get stays:** venue names and distance are free; the indicators unlock after 10 contribution minutes or with a Night Pass.
- **No heat map yet.** It needs roughly 10+ live venues on a typical night in one city to beat the list (and a maps library, possibly another paid Google API). Add it then, as its own tab.
- **Planned order:** (1) merge the Live tab into Home (session card on top, "Live near you" top 3–5 by fit below) with the genre pick, tabs Home / Meter / History; (2) check the list with the first real nights; (3) add validated signals to the ranking after the Phase 1 analysis; (4) heat-map tab once coverage justifies it.

## Working rules
- **Privacy:** never store raw audio, BLE device identifiers or location coordinates. **One opt-in exception (build 29, owner decision 24 Oct 2026): "best moments"** (two separate off-by-default switches; see "Best moments" below); nothing else may keep or upload audio. Since build 15 the app uses location "While Using" only, to recognise the venue: the position, rounded to ~11 m, goes to the `identify-venue` Edge Function, which asks Google Maps and returns the place; the coordinates are never stored, logged or uploaded to the database, only the Google place ID, venue name and distance. No background location. Only aggregated per-window metrics (dB levels, BPM, device counts, movement stats, beat-sync scalars) are stored and uploaded. Do not add raw data storage.
- **Do not run `npx expo prebuild --clean`.** It wipes the local iOS build patches (see "iOS build quirks").
- **Beat sync, movement energy and crowd sync are collect-only.** Do not add them to the composite vibe score until the analysis validates them.
- **Singleton services:** do not re-instantiate them (see "Architecture").
- **Only commit to the branch you were assigned.** Do not open a pull request unless asked.
- **Never commit secrets.** `vibemeter-app/.env` stays local.
- **Keep the handoff current:** when you finish a meaningful chunk of work, or stop mid-task, update `docs/HANDOFF.md` (what changed, what was verified, what is still untested, next steps in order). A later agent should be able to continue from the repo alone, without your chat history.

## Commands
Run from `vibemeter-app/`:

```bash
npm start                    # Expo dev server
npm run ios                  # iOS simulator
npm run android              # Android emulator
npx expo prebuild            # generate native ios/ and android/ (first time only; never with --clean)

# iOS native build (after prebuild + pod install)
cd ios && pod install
xcodebuild -workspace VibeMeter.xcworkspace -scheme VibeMeter \
  -configuration Debug \
  -destination "id=<device-udid>" \
  ENABLE_USER_SCRIPT_SANDBOXING=NO build

bash ../deploy.sh            # JS-only fast deploy to a plugged-in iPhone (needs an existing native build, ios-deploy, idevicedebug)

eas build --platform ios                          # cloud build for TestFlight (download the .ipa and upload with Transporter)
eas build --platform android --profile preview    # installable Android APK
bash scripts/ship-testflight.sh                    # build locally AND ship to TestFlight's Public group (fastlane pilot: upload, What to Test from docs/testflight-whats-new.txt, notify, expire old builds). Needs the App Store Connect API key in ~/.appstoreconnect (setup at the top of the script). `--no-build` ships the newest ~/Downloads/ViibeCheck-build*.ipa
LANG=en_US.UTF-8 eas build --platform ios --local --output ~/Downloads/ViibeCheck-buildN.ipa   # free local build (needs fastlane; the EAS free plan has a monthly iOS build quota)
```

**Checks:** there are no test or lint scripts. `npx -p typescript@5.9 tsc --noEmit` (from `vibemeter-app/`) is the primary correctness check; the pinned TypeScript 5.3 cannot parse Expo's `module: preserve`. On this Mac, run `pod install` with `LANG=en_US.UTF-8`. For the analysis scripts, from `analysis/`: `python3 crowd_sync.py --selftest` (install deps with `pip install -r requirements.txt`, ideally in a virtualenv). On the owner's Mac a ready virtualenv with all deps plus Demucs and soundfile is at `analysis/.venv` (gitignored): run e.g. `analysis/.venv/bin/python analysis/clip_enhance.py --selftest`.

## Environment setup
Create `vibemeter-app/.env`:
```
EXPO_PUBLIC_SUPABASE_URL=<project>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
EXPO_PUBLIC_AUDD_TOKEN=<token>      # optional: song recognition
```
Analysis scripts need `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the environment (see `analysis/fetch_data.py`).

## Architecture

### Data flow
```
Session start → SensorOrchestrator (audio + motion captured together each cycle; BLE staggered)
  → BeatSync compares movement peaks with the audio beat grid from the same capture
  → At each wall-clock minute: SensorWindow aggregated + scored by VibeScoreEngine
  → Window written to SQLite (LocalBuffer, synced=0)
  → Every 5 min: SupabaseSync batches unsynced rows → Supabase, marks synced=1
  → UI (meter.tsx) receives vibe updates via callback
  → Every 5 min: VibePrompt fires micro-rating notification
  → Session end: SessionManager finalizes, final sync triggered
```

### Singleton services
All core services are singletons. Do not re-instantiate them:

| Service | Purpose |
|---------|---------|
| `SensorOrchestrator` | Coordinates all sensors; exposes `setVibeUpdateCallback()` for UI |
| `SessionManager` | Session lifecycle: start (with group code and phone placement), end, dwell time, `setEventCode` to join a group mid-session |
| `LocalBuffer` | SQLite CRUD for sessions, windows, ratings (tables use a `synced` flag) |
| `SupabaseSync` | Retry-aware batch upload (3 attempts, retry delays). Sessions, windows and ratings go through `SECURITY DEFINER` upload functions (`upload_sessions`, `upload_sensor_windows`, `upload_ratings`); clips use a plain insert |
| `DeviceIdentity` | Persistent anonymous UUID via Expo SecureStore |
| `VenueLocator` | Venue lookup: one "While Using" location fix, rounded to ~11 m, sent to the `identify-venue` Edge Function (closest Google Maps night club within 150 m, else bar or pub); keeps only the place |
| `VibePrompt` | Rating prompts and recording. Since build 29 the 5-minute buzz is **off by default** (`PromptSettings.ts`, toggle in Settings); when on: notification category `vibe-rating` with three rating actions, a pending prompt that stays until answered. Ratings can always be given from the Meter's rate button. It also starts/ends the lock-screen card |

**Consent and data rights (GDPR, since build 22):** before the first session `app/index.tsx` shows a consent screen (18+ confirmation; microphone required, motion / Bluetooth / location optional). Choices live in `src/storage/Consent.ts` (SecureStore, `CONSENT_VERSION`; bump it when what is collected changes) and are enforced by `sensorAllowed()` in `SensorOrchestrator` (motion, BLE) and `VenueLocator` (location). Each session stores `consent_version` and `sensors` (e.g. `mic,motion,ble,loc`). Start is blocked without microphone permission (on iPhone the open mic keeps the session alive when locked). `app/privacy.tsx` (link "Settings" on Home) changes choices and runs `deleteMyData()` (`src/storage/DataDeletion.ts` → `delete_my_data` RPC, local wipe, new device ID). Home's session list swipes left to a red Delete (`deleteSession()` in the same file → `delete_my_session(device, session)` RPC, which refuses sessions of other devices, then `deleteSessionLocal`; the server delete comes first, so a failure deletes nothing). Retention: `apply_retention` deletes sessions (cascading to windows, clips, ratings) after 24 months. DPIA draft: `docs/DPIA.md`.

**Lock-screen card (iOS Live Activity, since build 23; quiet since build 29):** while a session runs, the lock screen (and Dynamic Island) shows a card with the venue, a self-counting timer, STOP and the song heard now ("♪ Title - Artist", or "Listening for the song…"; the SensorOrchestrator pushes it each cycle via `setCardSong`, which falls back to "Listening…" after 2 minutes without a match). **No rating buttons since build 29** (owner decision: ratings come from the next day's 👍/👎 on the recap, plus the optional 5-minute buzz and the Meter's rate button; `RateVibeIntent` and the card's rating fields are gone, old builds' `rating_source = 'live_activity'` rows stay in the data). `src/notifications/LockScreenCard.ts` mirrors the session onto the card; a light update every 5 min renews its 15-minute stale date, so a card from a killed app turns grey: "Not measuring". `prompted` on a rating records whether a prompt was waiting. STOP opens `vibemeter://stop` (`app/stop.tsx`, needs the phone unlocked, then asks to confirm). At launch with no session running, `closeInterruptedSessions` (`LocalBuffer.ts`) closes sessions the app never ended (killed mid-session) with `end_reason = 'interrupted'`, and a leftover card is removed. iOS asks "Allow Live Activities from Viibe Check?" the first time a card appears.

**Your night in songs (since build 25; plan `docs/plans/build-25-night-in-songs.md`):**
- **What it is:** at Stop, `onSessionFinished` (`src/session/NightRecapService.ts`) ranks the songs the person moved to most and stores the recap on the phone (`night_recaps`). It schedules a "Your night in songs" notification at 12:00 the next day when there are entries; `app/recap.tsx` shows it (linked from the summary).
- **Ranking (refined in build 26):** pure and tested (`src/processing/NightRecap.ts`, `npx tsx scripts/night-recap-test.ts`).
  - Only on-body, non-walking 10 s clips count; everything is relative to the person's own night.
  - Six signals (build 29 added the last two, small on purpose): intensity (energy percentile, 0.30), entrainment (beat PLV, else movement tempo vs song tempo or a multiple of it: half/double 0.9, quarter/triple 0.6, four times 0.5 via `HARMONIC_WEIGHTS`, 0.27), persistence (share of the song moving more than usual, 0.17), lift (movement vs the 2 minutes before, 0.12), **groove** (0.08; song-level: pulse clarity, sub-bass and spectral flux against the rest of the night's music, plus tempo in 100-150 BPM; a prior about the song, from Burger 2013 and Ellamil 2016), **carry** (0.06; was moving before the song and kept moving through the change, from `engagement.py`'s through_song_change; missing when not moving before). These apply to the **recap only**; the live composite vibe score stays as it is (beat sync etc. remain collect-only). Missing signals drop out.
  - The four values are uploaded with each 👍/👎. **The 👍/👎 answers decide the weights** (and may call for new measures): read `docs/feedback-learning.md`; run `analysis/fit_recap_weights.py` after real nights. Research basis and table: `docs/plans/build-26-dj-venue-recap.md`.
  - Unrecognised stretches of music (≥ 2 min) are ranked the same way. Entries below 0.3 are not listed; at most 5.
- **Songs:** titles, artists and Apple Music IDs come from ShazamKit (`AudioAnalyzer` keeps them) and live only on the phone (`night_songs`, recorded by the orchestrator each cycle).
- **DJ credit:** from `venue_sets` (lineup per venue, written by us with SQL for now) through `venue_sets_for`.
- **Feedback:** 👍/👎 is uploaded via `upload_song_feedback` (`song_feedback`: ISRC, times, rank, score, liked, DJ; no titles).
- **Saving and sharing:**
  - Apple Music playlist: `modules/music-library` (MusicKit; needs the MusicKit App Service on the app ID, and the user's Apple Music access);
  - Spotify: a search link per song;
  - share card: a Wrapped-style 1080×1920 JPEG (`expo-linear-gradient`, `react-native-view-shot`);
  - "Share to Instagram Story" (`modules/story-share`), shown only when `extra.instagramAppId` (a Meta App ID) is set in app.json.
- **Display:** music Shazam can't name shows as "DJ edits" (or the registered edit's title).
- **DJ edits (iPhone only, ShazamKit custom catalog):**
  - **During sessions:** `audio-capture` keeps rolling 30 s fingerprints. When Shazam's catalog has no match, the latest one is uploaded (`edit_prints`, 90 days).
  - **Catalog:** `edit_catalog()` serves those taken during a known set (`venue_sets`), credited to that DJ, plus DJ-registered edits that we approved (`dj_edits`).
  - **Matching on the phone:** `src/session/EditCatalog.ts` downloads and caches the catalog (12 h) and loads it into ShazamKit; unknown music is matched against it on the phone.
  - **Registration:** DJs register edits on the hidden route `app/dj.tsx` (`vibemeter://dj`, one 60 s fingerprint, optional link). Approve with `update dj_edits set status = 'approved' where id = '…'`.
  - **Venue lineups:** venues enter who plays when on `app/lineup.tsx` (`vibemeter://lineup`) with a venue code (`venue_editors`, SHA-256 only; `save_venue_lineup`). DJ links from lineups and registrations show as FOLLOW DJ / LISTEN in the recap.
  - **Simulator limit:** acoustic matching can't be tested there (the Mac mic barely hears its own speakers).

**Best moments (iOS, build 29, opt-in; plan `docs/plans/build-29-best-moments.md`):**
- **Two separate off-by-default switches** in Settings (`src/storage/MomentSettings.ts`, not part of the main consent): *Keep my best moments* (clips stay on the phone) and *Send them to us* (needs keep). Each shows its own explanation first. Texts are in `app/privacy.tsx`; `docs/PRIVACY.md` and `docs/DPIA.md` describe them (legal review of recording bystanders is an open item before "send" goes beyond friends).
- **Capture** (`src/session/MomentKeeper.ts`, called per 10 s cycle by the orchestrator): after 2 minutes of the night, a cycle in the person's top fifth of movement energy (on body, moving, not walking) with loud music (`MOMENTS.*` in constants.ts: ≥78 dB, voice share ≤0.6, music classification) becomes a 15 s clip cut from the native ring buffer (now 20 s), max 5 per night (a better one replaces the weakest), at least 60 s apart. Written as WAV in `Documents/moments/` (excluded from backups via `excludeFromBackup` in `modules/audio-capture`), row in the `moments` table (titles/artists stay on the phone).
- **Cleaning on the phone** (`src/processing/ClipCleaner.ts`, test `npx tsx scripts/clip-cleaner-test.ts`): spectrum-domain 40 Hz high-pass, cloth-rustle bursts (treble spikes without bass that regular hi-hats don't trigger) turned down, levelled. Runs after the session, chunked so the UI stays responsive (`macroYield`); clips that turn out not bass-led or mostly rustle are deleted. Thresholds are first guesses.
- **Send:** raw + cleaned WAV through the `moments` Edge Function (service role; bucket `moments` is private, no public access) with device ID, session, group code, venue, ISRC, score. 14-day retention everywhere (phone and server; the function sweeps expired clips on each call). Deleting a clip, a session (`deleteSession`) or all data (`deleteMyData`) deletes the server copy first.
- **Server analysis** `analysis/clip_enhance.py` (`--fetch`, `--run [--shazam]`, `--sweep`, `--selftest`): layers raw, phone clean-up, Demucs voice/music separation (optional install), several phones' clips aligned (GCC-PHAT) and merged (average, and per-time-frequency median across phones), merged then separated; objective measures per layer and optional Shazam recognition. This is how "which route works best" is decided.
- **Playback:** `src/components/MomentsSection.tsx` on the recap (cleaned / as heard / delete).
- **Not verified on a device:** real pocket audio, thresholds, battery effect, the first upload from a phone.

**Going out standby (iOS, since build 24; plan `docs/plans/build-24-going-out-standby.md`):**
- **Switching it on:** opt-in on `app/going-out.tsx` (Home button "Going out tonight?", or the weekend reminder). The opt-in is stored separately from sensor consent, in `src/storage/StandbySettings.ts` (with the reminder days and time). The app must be in the foreground to start: iOS opens the microphone and starts a Live Activity only then.
- **Service and checks:** `src/session/Standby.ts` (singleton `standby`) runs `sensorOrchestrator.startStandby`: every 30 s, a light check with no Shazam, no clips, no windows (`AudioAnalyzer.analyze(…, { light: true })` + `MotionTracker.sample` + beat sync).
- **Detection rule** (`src/session/StandbyRules.ts`, constants `STANDBY`; test: `npx tsx scripts/standby-rules-test.ts`):
  - a music minute: ≥ 75 dB with a beat;
  - a moving minute: on a body, swaying/dancing/jumping, with a rhythm (PLV ≥ 0.4, tempo match ≥ 0.5, or rhythmicity ≥ 0.35 at 60–180 BPM);
  - prompt when the last 6 minutes have ≥ 5 music and ≥ 2 moving minutes, at 21:00–06:00, not in a vehicle (`isInVehicle` in `audio-capture`, Core Motion);
  - at most one prompt per 45 min and 4 per night.
- **Prompt:**
  - the lock-screen card switches to "Sounds like a party. Start measuring?" (ActivityKit alert), with a backup notification (category `standby-prompt`);
  - **Yes** runs `startSessionFromStandby` (SessionControl), which reuses the open microphone and turns the standby card into the session card in place, all without unlocking;
  - **Not now** waits out the cooldown.
- **Ends by itself:** at 06:00, after 6 h, at ≤ 20% battery, or when its session ends.
- **Logged:** counts per evening in `standby_nights` (`upload_standby_nights` RPC), and `sessions.start_source` (`manual` | `standby`). A standby left by a killed app is closed at launch as `interrupted`.
- **Reminder:** weekly local notifications, `src/notifications/NightReminder.ts`.
- **Card modes:** `session`, `standby`, `prompt` (`CardState.mode`). Buttons go through one action queue: `rate` → VibePrompt; `start`, `not_now`, `standby_off` → Standby, via `CardActionIntent`.

`src/storage/UserProfile.ts` holds the one-time dance-affinity answer (SecureStore). `src/session/SessionControl.ts` (imported in `index.ts`) is the one way a session ends: `stopEverything(reason)` for the Stop button and auto-stop, plus `onSessionEnded` for open screens.

### Venue, phone context and auto-stop (build 15)
- **Venue (always confirmed by the user):** the start screen looks the venue up and asks "Are you at X?" (`confirmVenue` in `VenueLocator.ts`). Only "Yes" links it (`venue_source = 'auto'`); "No" or dismissing leaves it blank, and that place is not proposed again until the next start screen. A typed name is `manual`, with no place ID, and stops re-checks. During a session the orchestrator looks it up again when the app comes to the foreground (at most every 10 min, `VENUE_RECHECK_MS`) and asks again only for a different place, so each window's `venue_place_id` follows people between clubs; no result keeps the current venue; the session keeps its first confirmed venue. The Edge Function (`supabase/functions/identify-venue`, secret `GOOGLE_PLACES_KEY`) upserts the place into `venues`.
- **Phone context** (`classifyPhoneContext` in `MovementClassifier.ts`, per 10 s cycle): `off_body` (tilt and motion almost constant: a table, a bag on the floor), `on_body_still`, `on_body_moving`, `uncertain`. Stored per clip, and per window as the dominant context plus `on_body_share`. The analysis drops `off_body`; the live view and give-to-get count only on-body minutes. Thresholds are first guesses, to check on a device.
- **Auto-stop** (`SensorOrchestrator.checkAutoStop`, once a minute): no music and below 60 dB for 20 consecutive minutes (10 if most of them are walking), 8 h, or battery ≤ 10% and not charging. It ends the session through `SessionControl` with `end_reason` (`user`, `no_music`, `max_duration`, `low_battery`; `interrupted` marks a session closed at the next launch after the app was killed) and posts a notification. Constants `AUTO_STOP_*`.

### Scoring system (`src/processing/VibeScoreEngine.ts`)
Each signal produces a 0–5 component score via piecewise linear curves defined in `src/config/constants.ts`. Composite = weighted sum:

- Energy (audio dB), 30%: dB curve (0.7×) + BPM bonus (0.3×) + music-detected bonus (+0.5)
- Music (FFT spectral), 25%: BPM score (0.5×) + sub-bass energy (1.5×) + spectral flux (0.8×) + HNR (0.7×)
- Movement (accelerometer), 20%: accel magnitude curve + gyro bonus
- Density (BLE), 15%: BLE count curve + filling/thinning trend (±0.5)
- Engagement, 10%: screen-off ratio × 5.0

If a signal is unavailable, its weight redistributes proportionally to present signals. A `confidence` field (0–1) tracks the fraction of signals used.

**Collect-only signals** (stored and uploaded, not in the composite):
- `movement_energy`: RMS of gravity-removed acceleration (`MotionTracker.ts`, using `DeviceMotion`).
- `beat_plv`, `beat_phase_mean`, `tempo_match` (`src/processing/BeatSync.ts`): how movement peaks land on the audio beat. Audio and motion are recorded at the same time so they share one clock.
- `beat_phase_clock` (`BeatSync.ts`): the same movement peaks folded onto a wall-clock grid at the recognised song's tempo. It uses no microphone timing, so a phone's own fabric rustle (which lands on the wearer's steps) cannot bias it, and it is comparable across phones if their clocks agree.
- Crowd sync (`analysis/crowd_sync.py`): computed server-side across devices that share an `event_code`; needs ≥3 devices. Windows are aligned to wall-clock minutes so devices can be compared. Reports both the heard-beat version (`crowd_phase_sync`, from `beat_phase_mean`) and the clock version (`crowd_phase_sync_clock`); the analysis decides which holds up.

**Beat sync robustness (phone in a pocket):** PLV needs only the beat period, so when the audio beat grid fails it falls back to the recognised song's tempo (`beat_phase_mean` is then null). A known song tempo also narrows the PCM tempo search. While the phone is moving, beats are found from the bass band only (rustle is mostly higher). Do not gate audio frames out at movement peaks: when someone dances on the beat that removes the real beats and biases the phase.

**Song recognition:** iOS uses ShazamKit on the in-memory audio buffer (fingerprint only; the ShazamKit App Service must be enabled on the app ID), at most every 30 s when the room is above `SHAZAM_MIN_DB`. Android falls back to AudD when `EXPO_PUBLIC_AUDD_TOKEN` is set (louder rooms only, since it is paid and uploads the clip). Deezer's ISRC lookup adds tempo and popularity; when Deezer has no tempo, the phone learns the song's tempo from the summed onset autocorrelation of its clips (`song_bpm_source`). ShazamKit's match offset gives `song_started_at` (the playback's start), voted over the playback's estimates because a repeated chorus can be matched instead. Stored per window, collect-only: `song_isrc`, `song_genre`, `song_bpm`, `song_popularity`, `recognition_source`. Android's temporary WAV clips are deleted after each analysis.

FFT-derived spectral metrics (sub-bass energy, spectral centroid, spectral flux, crest factor, vocal presence, harmonic-to-noise ratio) are computed in `src/processing/FFTProcessor.ts` (Cooley-Tukey) from raw PCM. BPM and the beat grid come from `src/processing/BPMDetector.ts` (onset-envelope autocorrelation with a 120 BPM tempo prior). iOS reads the latest 5 s from the continuous capture module; Android streams PCM per cycle via `react-native-audio-record`. Both run the same pipeline. The iOS mic runs in measurement mode (no automatic gain), so iOS uses its own dB offset, `IOS_RAW_MIC_DBFS_OFFSET`.

### Local native modules (`vibemeter-app/modules/`, autolinked)
- `audio-capture` (iOS, Swift): `AVAudioEngine` capture for the whole session into a 12 s in-memory ring buffer, plus ShazamKit matching. The continuously open mic, with `UIBackgroundModes: audio`, is what keeps iOS from suspending the app with the screen locked. Never write this audio to disk.
- `live-activity` (iOS, Swift, module `ViibeLiveActivity`): starts, updates (optionally with an alert) and ends the lock-screen card (`SessionActivityAttributes`, modes session/standby/prompt), and hands card button taps to JS (`takePendingActions` + the `onRating` event).
- **Widget extension `targets/live-activity`** (target `ViibeCard`, bundle ID `com.leogerasimov.vibemeter.card`, generated at prebuild by `@bacons/apple-targets`): the card's SwiftUI layout. `SessionActivityAttributes.swift` exists in both the module and the widget and must stay identical. The Going out buttons run `CardActionIntent` (a `LiveActivityIntent`), which iOS runs in the app's process and finds only in the app target's own App Intents metadata, so `plugins/withLiveActivityIntent.js` also compiles that file into the app target (and sets `NSSupportsLiveActivities`). The intent queues the tap in the app's UserDefaults and posts an in-process notification; no App Group and no push are needed (the app keeps running during a session).
- `session-service` (Android, Kotlin): a `microphone` foreground service with an ongoing notification, a headless JS task (`ViibeMeterSession`, registered in `index.ts`) that keeps JS timers running in the background, and native motion capture into an in-memory buffer, because `expo-sensors` stops in the background. `MotionTracker` reads that buffer while the service runs.

### Grouping phones at the same event
- **Group codes** (`event_code` column, `src/session/GroupCode.ts`): every session gets a random code (`G-XXXXXX`, created as a draft before the start so it can be shown early). One **Group sheet** (`GroupSheet` in `src/components/GroupQR.tsx`, from the start screen and the meter's GROUP button) toggles **SHARE** (QR + live "N phones measuring" from the `group_size(code)` RPC) and **SCAN** (in-app camera, `parseScan`). Friends can also scan with the phone's Camera app (deep link `vibemeter://join?code=…`, handled by `app/join.tsx` on every visit). A shared code is a definite "together" label; different codes do not mean apart.
- **Venue codes** (since build 17): `vibemeter://join?venue=<Google place ID>&name=…`, made on `app/venue-code.tsx` (Google text search via the `find-venue` Edge Function, which also upserts `venues`). Scanning one (`applyScan` in `SessionControl.ts`) confirms the venue (`venue_source = 'qr'`, no Google popup) and joins the venue's crowd group for the night, `V-` + 6 characters of SHA-256(place ID + night date, 06:00–06:00), **unless the phone already joined a friend's group** (kept, so friend subgroups survive). Custom-scheme links work only with the app installed (posters say "Scan with Viibe Check").
- **Automatic grouping** (`analysis/auto_groups.py`), from two evidence sources:
  - **Shazam playbacks:** phones that heard the same playback of the same track (`song_isrc`, and `song_started_at` within 1.5 s, from ShazamKit's match offset) were together; ≥2 shared playbacks link a pair.
  - **Bass-envelope room fingerprint** (`bass_envelope`, works without recognition): per minute, 240 frames of 40–150 Hz energy (250 ms on a wall-clock grid; iOS computes them natively and continuously in `modules/audio-capture`, Android from its 5 s clips via `src/processing/BassEnvelope.ts`, same biquads). Pairs are cross-correlated over ±2 s; peak r ≥ 0.60 is "together", ≤ 0.25 "apart" (thresholds from the self-test); ≥3 "together" minutes with a consistent lag (±1 frame) link a pair.
  - Evidence is time-decayed (±20 min), so people can move between venues, and phones with evidence of being apart are never merged. `crowd_sync.py --auto` groups by it instead of codes. Goal: no codes at all once validated against code-labelled data.
  - **Limits:** the same stream in two places at once looks like one room; quiet or flat sets give little evidence; Android covers only half of each minute (5 s of every 10 s) and its `AudioRecord` start time jitters; the simulation is optimistic, so validate on a real night (3–5 phones in one room, plus one phone in another room playing the same playlist 1 minute later).

### 10-second clips and clock alignment
Each audio + motion cycle starts on a wall-clock multiple of 10 s (`SensorOrchestrator.scheduleRhythm`; iOS reads exactly that range with `readRange`), so phones measure the same seconds. Each cycle also writes a lean `sensor_clips` row (beat PLV, clock beat phase, movement energy and tempo, song ISRC); `crowd_sync.py` computes crowd sync per 10 s slot from them. Server-side, a pg_cron job (`apply_retention`, daily) deletes clips and clears `bass_envelope` after 90 days. The app can only **insert** clips (no read access).

**Background limits:** neither platform allows useful BLE discovery with the screen off, so BLE scans are skipped while the app is not active (no measurement rather than a fake 0). To get a crowd count anyway, a scan also runs as soon as the app returns to the foreground (e.g. for the vibe prompt), debounced to 10 s.

**Movement tempo:** `computeMovementRhythm` looks for real autocorrelation peaks between 60 and 180 BPM, prefers the shorter period when it is nearly as strong, and reports a tempo only at rhythmicity ≥ 0.35 (slow sway used to read as 41–57 BPM).

### Storage schema
SQLite tables in `LocalBuffer`, mirrored in Supabase (plus `sensor_clips`, and `standby_nights` for Going out evenings since build 24):
- `sessions`: one row per session (venue, start/end, device ID, `event_code`, `phone_placement`, `dance_affinity`, `start_source` (`manual` or `standby`), and for the battery check `battery_start_pct` / `battery_end_pct` (null while charging) and `low_power_mode`; drain query in `analysis/monitoring_queries.sql`).
- `sensor_windows`: one row per window (component scores, composite, FFT metrics, movement energy/BPM/rhythmicity, beat-sync scalars).
- `subjective_ratings`: one row per vibe rating. Since build 12 the scale has three levels, 💀 Dead / 🙂 Decent / 🔥 Best, stored as `rating` 1 / 3 / 5 with `rating_scale = 3`; earlier rows used 1–5. `rating_source` is `lockscreen` (a notification button), `app` (the in-app sheet) or `live_activity` (a lock-screen card button, build 23+); `prompted` (build 23+) says whether a prompt was waiting. Music and crowd sub-ratings are no longer asked, so they are null.

**Live tab and give-to-get** (`app/live.tsx`, `src/storage/LiveAccess.ts`): the tab lists venues from `live_venues()` sorted by distance (computed on the phone from a foreground fix that is never kept or sent), with separate indicators (dancing, energy, momentum, music, crowd) and "N phones · confidence · updated"; never one overall score. It is unlocked for the rest of the night (until 06:00) by `LIVE_ACCESS.UNLOCK_MINUTES` valid contribution minutes tonight (windows with a venue, `on_body_share ≥ 0.5`, audio present; `countValidContributionMinutes`), or by one of the 2 free Night Passes (SecureStore). Gating is on the phone only for now. Each opening logs `log_live_view`.

Server-only tables (no anon access; read and written through functions): `venues` (public Google Maps places: place ID, name, types, location) and `live_views` (which venues a phone's live view showed, for the "does it change where people go?" question). `live_venues()` returns per-venue aggregates from the last 15 minutes of on-body phones (contributors, dancing share, energy level against each phone's own normal, momentum, genre, tempo, BLE crowd, confidence); `log_live_view()` inserts a view. Both are `SECURITY DEFINER`.

All tables have a `synced INTEGER DEFAULT 0` column. Sync deletes old synced windows to conserve space. SQLite has no `ADD COLUMN IF NOT EXISTS`, so schema upgrades go through the migration list in `LocalBuffer.ts`, which ignores duplicate-column errors.

Supabase migrations live in `vibemeter-app/supabase/migrations/`. Apply new ones to the live project and commit the SQL, so the repo and database stay in step.

### Key configuration (`src/config/constants.ts`)
All tunable parameters live here: sampling intervals, scoring curve breakpoints, window duration (60 s), sync interval (5 min), rating prompt interval (5 min), retry delays. Sync batch size (100 rows) is set in `SupabaseSync.ts`.

## iOS build quirks
These patches were applied to fix build issues. Do not revert:
- `ios/Podfile`: `ENABLE_USER_SCRIPT_SANDBOXING=NO` flag required
- `ios/Pods/fmt/base.h`: `FMT_USE_CONSTEVAL` disabled for Xcode 26/Clang compatibility
- `ios/VibeMeter/VibeMeter.entitlements`: APS push removed (Personal Team signing)
- `react-native/scripts/react-native-xcode.sh`: `ip.txt` write made non-fatal
- `plugins/withFmtConstevalFix.js` (config plugin): applies the fmt consteval fix on every fresh prebuild, so local EAS builds with Xcode 26 compile
- `plugins/withSceneLifecycle.js` (config plugin): **required for iOS 27.** Builds made with the iOS 27 SDK (Xcode 27.1) crash at launch on iOS 27 devices unless the app uses the UIScene lifecycle (`UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`). The plugin adds the scene manifest and a SceneDelegate that creates the window, starts React Native and forwards `vibemeter://` links. Builds 22–27 lacked it and crash on iOS 27. Expo's own fix arrives in a later SDK (expo/expo#50179); drop the plugin when upgrading
- After changing `targets/`, `app.json` plugins or a local module, regenerate the local project with `npx expo prebuild -p ios --no-install` (never `--clean`), then `pod install`. If prebuild fails with `removeFromProject` (`@bacons/apple-targets` 5 cannot update an existing card target), first restore the project file saved before the card was added: `cp ios/project.pbxproj.before-card ios/VibeMeter.xcodeproj/project.pbxproj` (local, gitignored with `ios/`). EAS builds start from a fresh project and are unaffected. The card target needs its own provisioning profile; EAS creates it from `extra.eas.build.experimental.ios.appExtensions`, which `@bacons/apple-targets` fills in

## Analysis scripts
Python scripts in `analysis/` query Supabase and run statistical analysis:
- `fetch_data.py`: pulls sessions, sensor windows and ratings to CSV (paginated).
- `correlations.py`: per-signal Pearson/Spearman, within-person correlations, per-person baselines (`<signal>_z`), headline tests (movement energy; crowd sync, residual sync and beat lock beyond movement energy), loudness against movement signals, moderators by platform, placement and dance affinity.
- `crowd_sync.py`: per group and minute crowd phase sync (heard-beat and clock versions), tempo agreement and combined crowd sync. `--auto` groups by music instead of group codes. `residual_sync` measures coordination beyond the shared beat, per group and 5-minute block: pairwise clock-phase agreement minus a time-shifted surrogate, and movement-energy correlation after removing what the music's bass loudness explains.
- `engagement.py`: per session and 15-minute block, dancing share, longest dancing streak, returns after breaks, and dancing through song changes (off-body minutes left out).
- `auto_groups.py`: automatic grouping of phones from shared song playbacks and bass envelopes; validation against group codes, per evidence source; `--selftest` runs synthetic venues and DJ sets.
- `optimize_weights.py`: Ridge and Random Forest weight analysis.
- `fit_recap_weights.py`: which recap signals predict a 👍, suggested weights (cross-validated by person); `--selftest`. The loop is described in `docs/feedback-learning.md`.
- `dj_report.py`: a private, draft "Here is your set" page for a DJ from the phones' data at a venue and time (tracklist from ISRCs with Deezer titles, unidentified stretches that may be the DJ's edits, a crowd curve, highlight clips from opted-in phones via `clip_enhance.py`); only minutes with ≥3 phones are shown, no identifiers; `--selftest`. Nothing is sent to a DJ automatically.
- `monitoring_queries.sql`: data quality checks.
