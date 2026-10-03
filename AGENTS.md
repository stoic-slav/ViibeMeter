# AGENTS.md

Instructions for any AI coding agent working in this repository. This is the single source of truth for agents; tool-specific files (such as `CLAUDE.md`) only point here. Read it first.

## Read before starting
1. **`docs/HANDOFF.md`**: current state, decisions, what is untested, and the ordered "Do next" list. Start here to continue work in progress. If it conflicts with anything older, trust it, and update it when you finish a task.
2. **This file**: commands, architecture, scoring, build quirks, privacy and working rules.
3. **`README.md`**: product background, signal table, data-collection strategy and success criteria.

## How the owner works
They want the agent to drive the work end to end and give only minimal direction and oversight. Do the work, verify it, and report outcomes faithfully, including failures. Ask only when a decision is genuinely theirs: spending money, deleting data, anything outward-facing.

## Project overview
ViibeMeter is an iOS/Android app that passively measures "vibe" at venues using phone sensors (microphone, accelerometer/gyroscope, BLE, GPS) and uploads aggregated metrics to Supabase. It is a research MVP for validating whether passive sensor data correlates with subjective crowd-energy ratings. The central hypothesis is that people moving in sync with the music, and with each other, signals a high vibe.

## Working rules
- **Privacy:** never store raw audio, BLE device identifiers or GPS coordinates. Only aggregated per-window metrics (dB levels, BPM, device counts, movement stats, beat-sync scalars) are stored and uploaded. Do not add raw data storage.
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
```

**Checks:** there are no test or lint scripts. `npx -p typescript@5.9 tsc --noEmit` (from `vibemeter-app/`) is the primary correctness check; the pinned TypeScript 5.3 cannot parse Expo's `module: preserve`. On this Mac, run `pod install` with `LANG=en_US.UTF-8`. For the analysis scripts, from `analysis/`: `python3 crowd_sync.py --selftest` (install deps with `pip install -r requirements.txt`, ideally in a virtualenv).

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
Session start → SensorOrchestrator (audio + motion captured together each cycle; BLE, location staggered)
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
| `SessionManager` | Session lifecycle: start (with event code and phone placement), end, dwell time |
| `LocalBuffer` | SQLite CRUD for sessions, windows, ratings (tables use a `synced` flag) |
| `SupabaseSync` | Retry-aware batch upload (3 attempts, retry delays) |
| `DeviceIdentity` | Persistent anonymous UUID via Expo SecureStore |
| `VibePrompt` | Notification scheduling + rating recording |

`src/storage/UserProfile.ts` holds the one-time dance-affinity answer (SecureStore).

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

**Song recognition:** iOS uses ShazamKit on the in-memory audio buffer (fingerprint only; the ShazamKit App Service must be enabled on the app ID), at most every 30 s when the room is above `SHAZAM_MIN_DB`. Android falls back to AudD when `EXPO_PUBLIC_AUDD_TOKEN` is set (louder rooms only, since it is paid and uploads the clip). Deezer's ISRC lookup adds tempo and popularity. Stored per window, collect-only: `song_isrc`, `song_genre`, `song_bpm`, `song_popularity`, `recognition_source`. Android's temporary WAV clips are deleted after each analysis.

FFT-derived spectral metrics (sub-bass energy, spectral centroid, spectral flux, crest factor, vocal presence, harmonic-to-noise ratio) are computed in `src/processing/FFTProcessor.ts` (Cooley-Tukey) from raw PCM. BPM and the beat grid come from `src/processing/BPMDetector.ts` (onset-envelope autocorrelation with a 120 BPM tempo prior). iOS reads the latest 5 s from the continuous capture module; Android streams PCM per cycle via `react-native-audio-record`. Both run the same pipeline. The iOS mic runs in measurement mode (no automatic gain), so iOS uses its own dB offset, `IOS_RAW_MIC_DBFS_OFFSET`.

### Local native modules (`vibemeter-app/modules/`, autolinked)
- `audio-capture` (iOS, Swift): `AVAudioEngine` capture for the whole session into a 12 s in-memory ring buffer, plus ShazamKit matching. The continuously open mic, with `UIBackgroundModes: audio`, is what keeps iOS from suspending the app with the screen locked. Never write this audio to disk.
- `session-service` (Android, Kotlin): a `microphone|location` foreground service with an ongoing notification, a headless JS task (`ViibeMeterSession`, registered in `index.ts`) that keeps JS timers running in the background, and native motion capture into an in-memory buffer, because `expo-sensors` stops in the background. `MotionTracker` reads that buffer while the service runs.

**Background limits:** neither platform allows useful BLE discovery with the screen off, so BLE scans are skipped while the app is not active (no measurement rather than a fake 0).

### Storage schema
Three SQLite tables in `LocalBuffer`, mirrored in Supabase:
- `sessions`: one row per session (venue, start/end, device ID, `event_code`, `phone_placement`, `dance_affinity`).
- `sensor_windows`: one row per window (component scores, composite, FFT metrics, movement energy/BPM/rhythmicity, beat-sync scalars).
- `subjective_ratings`: one row per micro-rating (overall 1–5, optional music and crowd ratings).

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

## Analysis scripts
Python scripts in `analysis/` query Supabase and run statistical analysis:
- `fetch_data.py`: pulls sessions, sensor windows and ratings to CSV (paginated).
- `correlations.py`: per-signal Pearson/Spearman, within-person correlations, headline tests (movement energy; crowd sync and beat lock beyond movement energy), moderators by platform, placement and dance affinity.
- `crowd_sync.py`: per event-code and minute crowd phase sync, tempo agreement and combined crowd sync.
- `optimize_weights.py`: Ridge and Random Forest weight analysis.
- `monitoring_queries.sql`: data quality checks.
