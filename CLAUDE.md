# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ViibeMeter is an iOS/Android app that passively measures "vibe" at venues using phone sensors (microphone, accelerometer, gyroscope, BLE, GPS) and uploads aggregated metrics to Supabase. The app is a research MVP for validating whether passive sensor data correlates with subjective crowd energy ratings.

## Commands

All commands run from `vibemeter-app/`:

```bash
# Start Expo dev server
npm start

# Run on iOS simulator
npm run ios

# Run on Android emulator
npm run android

# Generate native ios/ and android/ directories (required before native builds)
npx expo prebuild

# iOS native build (after prebuild + pod install)
cd ios && pod install
xcodebuild -workspace VibeMeter.xcworkspace -scheme VibeMeter \
  -configuration Debug \
  -destination "id=<device-udid>" \
  ENABLE_USER_SCRIPT_SANDBOXING=NO build

# Cloud build for TestFlight
eas build --platform ios
```

No test or lint scripts are configured. TypeScript type-checking serves as the primary correctness check.

## Environment Setup

Create `vibemeter-app/.env`:
```
EXPO_PUBLIC_SUPABASE_URL=<project>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
```

## Architecture

### Data Flow

```
Session start → SensorOrchestrator (staggered launch: audio 2s, motion 5s, BLE 8s, location 10s)
  → 4 parallel collectors run on timers
  → Every 60s: SensorWindow aggregated + scored by VibeScoreEngine
  → Window written to SQLite (LocalBuffer, synced=0)
  → Every 5 min: SupabaseSync batches unsynced rows → Supabase, marks synced=1
  → UI (meter.tsx) receives vibe updates via callback
  → Every 25 min: VibePrompt fires micro-rating notification
  → Session end: SessionManager finalizes, final sync triggered
```

### Singleton Services

All core services are singletons — do not re-instantiate them:

| Service | Purpose |
|---------|---------|
| `SensorOrchestrator` | Coordinates all 4 sensors; exposes `setVibeUpdateCallback()` for UI |
| `SessionManager` | Session lifecycle: start, end, dwell-time calculation |
| `LocalBuffer` | SQLite CRUD for sessions, windows, ratings (tables use `synced` flag) |
| `SupabaseSync` | Retry-aware batch upload (3 attempts, exponential backoff) |
| `DeviceIdentity` | Persistent UUID via Expo SecureStore |
| `VibePrompt` | Notification scheduling + rating recording |

### Scoring System (`src/processing/VibeScoreEngine.ts`)

Each signal produces a 0–5 component score via piecewise linear curves defined in `src/config/constants.ts`. Composite score = weighted sum:

- Energy (audio dB) — 30%
- Music (BPM detection) — 25%
- Movement (accelerometer) — 20%
- Density (BLE device count) — 15%
- Engagement (location transitions) — 10%

If a signal is unavailable, its weight redistributes proportionally to present signals. A `confidence` field (0–1) tracks the fraction of signals used.

### Storage Schema

Three SQLite tables in `LocalBuffer`:
- `sessions` — one row per session (venue, start/end times, device ID)
- `sensor_windows` — one row per 60s window (all component scores + composite)
- `ratings` — one row per user micro-rating (1–5 stars)

All tables have a `synced INTEGER DEFAULT 0` column. Sync deletes old synced windows to conserve space.

### Key Configuration (`src/config/constants.ts`)

All tunable parameters live here: sampling intervals, scoring curve breakpoints, window duration (60s), sync interval (5 min), rating prompt interval (25 min), batch size (100 rows), retry delays.

## iOS Build Quirks

These patches were applied to fix build issues — do not revert:

- `ios/Podfile`: `ENABLE_USER_SCRIPT_SANDBOXING=NO` flag required
- `ios/Pods/fmt/base.h`: `FMT_USE_CONSTEVAL` disabled for Xcode 26/Clang compatibility  
- `ios/VibeMeter/VibeMeter.entitlements`: APS push removed (Personal Team signing)
- `react-native/scripts/react-native-xcode.sh`: `ip.txt` write made non-fatal

## Privacy Constraints

The app intentionally never stores: raw audio recordings, BLE device identifiers, GPS coordinates. Only aggregated metrics (dB levels, BPM, device counts, movement magnitudes) are stored and uploaded. Do not add raw data storage.

## Analysis Scripts

Python scripts in `/analysis/` query Supabase and run statistical analysis:
- `fetch_data.py` — pulls sensor windows + ratings
- `correlations.py` — Pearson/Spearman between sensor signals and user ratings
- `optimize_weights.py` — gradient-descent weight optimization for scoring
- `monitoring_queries.sql` — data quality checks
