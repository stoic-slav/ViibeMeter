# VibeMeter — Implementation Plan for Claude Code

## Autonomous Development Guide

**Goal:** Build the VibeMeter sensor fusion validation app as defined in `vibe-meter-validation-prd-v2.md`. This document is written for Claude Code to execute with minimal human input. Every step includes verification, testing, and rollback instructions.

**Human input required only for:**
- Providing Supabase project credentials after creation
- Providing Apple Developer / Google Play credentials for TestFlight/dev builds
- Physical testing at real venues (Week 3)
- Go/no-go decision after analysis (Week 4)

---

## Phase 0 — Environment & Prerequisites

### 0.1 — System verification

Run these checks first. Do not proceed until all pass.

```bash
# Check Node.js (need 18+)
node --version

# Check npm
npm --version

# Check git
git --version

# Check if Expo CLI is available globally
npx expo --version

# Check if EAS CLI is available
npx eas-cli --version

# Check Python (for Week 4 analysis)
python3 --version
pip3 --version
```

**If any missing, install:**
```bash
# Node.js 18+ (if missing, instruct human to install via nvm)
# nvm install 18 && nvm use 18

# EAS CLI
npm install -g eas-cli

# Python packages for analysis (install now, use in Week 4)
pip3 install pandas numpy scipy scikit-learn matplotlib seaborn jupyter
```

**Verification:** All version checks return valid versions. Log output.

### 0.2 — Supabase CLI setup

```bash
# Install Supabase CLI
npm install -g supabase

# Verify
supabase --version
```

**Human action required:** Create a Supabase project at https://supabase.com/dashboard and provide:
- Project URL (e.g., `https://xxxx.supabase.co`)
- Anon key
- Service role key
- Project ref ID

Store these in a `.env` file (gitignored) and in the Expo app config.

### 0.3 — Project initialization

```bash
# Create project directory
mkdir vibemeter && cd vibemeter

# Initialize git
git init
echo "node_modules/\n.env\n.expo/\ndist/\n*.jks\n*.p8\n*.p12\n*.key\n*.mobileprovision\n*.orig.*\nweb-build/\n.DS_Store\nanalysis/data/\nanalysis/output/" > .gitignore

# Create Expo app
npx create-expo-app vibemeter-app --template blank-typescript
cd vibemeter-app

# Verify it runs
npx expo start --clear
# (Ctrl+C after confirming it starts without error)
```

**Verification:** `npx expo start` launches without errors. Metro bundler connects.

### 0.4 — Install all dependencies upfront

```bash
cd vibemeter-app

# Navigation
npx expo install expo-router expo-linking expo-constants expo-status-bar react-native-safe-area-context react-native-screens react-native-gesture-handler

# Sensors
npx expo install expo-sensors

# Audio (for microphone access + amplitude)
npx expo install expo-av

# Location (for GPS-based auto-session + dwell time)
npx expo install expo-location

# BLE scanning
npm install react-native-ble-plx
npx expo install expo-build-properties

# Background tasks
npx expo install expo-task-manager

# Notifications (for vibe prompts)
npx expo install expo-notifications

# Local storage (for on-device sensor buffering)
npx expo install expo-sqlite

# Supabase client
npm install @supabase/supabase-js

# Secure storage for Supabase auth tokens (even though we use anon device ID)
npx expo install expo-secure-store

# Crypto for device ID generation
npx expo install expo-crypto

# Charts for session summary
npm install react-native-svg victory-native

# Date handling
npm install date-fns

# UUID generation
npm install uuid
npm install --save-dev @types/uuid
```

**Verification:** Run `npx expo start` again. Confirm no dependency resolution errors. Check `package.json` has all packages listed.

### 0.5 — Configure app.json / app.config.ts

Create `app.config.ts` at project root:

```typescript
import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'VibeMeter',
  slug: 'vibemeter',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark', // Nightlife app = dark mode default
  splash: {
    backgroundColor: '#000000',
  },
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.vibemeter.app',
    infoPlist: {
      NSMicrophoneUsageDescription: 'VibeMeter measures ambient sound levels to compute vibe scores. No audio is recorded or stored.',
      NSLocationWhenInUseUsageDescription: 'VibeMeter uses your location to detect when you arrive at and leave venues.',
      NSLocationAlwaysAndWhenInUseUsageDescription: 'VibeMeter tracks your location in the background to measure how long you stay at a venue.',
      NSBluetoothAlwaysUsageDescription: 'VibeMeter scans for nearby Bluetooth devices to estimate crowd density. No device identities are stored.',
      UIBackgroundModes: ['location', 'audio', 'bluetooth-central'],
    },
  },
  android: {
    adaptiveIcon: {
      backgroundColor: '#000000',
    },
    package: 'com.vibemeter.app',
    permissions: [
      'RECORD_AUDIO',
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'BLUETOOTH',
      'BLUETOOTH_ADMIN',
      'BLUETOOTH_SCAN',
      'BLUETOOTH_CONNECT',
    ],
  },
  plugins: [
    'expo-router',
    'expo-sensors',
    'expo-location',
    'expo-notifications',
    'expo-secure-store',
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 23,
        },
      },
    ],
  ],
  extra: {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  },
});
```

**Verification:** `npx expo config` outputs valid config without errors.

### 0.6 — Supabase schema deployment

Create migration file: `supabase/migrations/001_initial_schema.sql`

```sql
-- ============================================
-- VibeMeter Validation Experiment Schema
-- ============================================

-- Sessions: one per social outing
create table public.sessions (
  id uuid default gen_random_uuid() primary key,
  device_id text not null,
  venue_name text,
  venue_type text check (venue_type in ('bar', 'club', 'house_party', 'concert', 'rooftop', 'restaurant', 'other')),
  started_at timestamptz not null,
  ended_at timestamptz,
  dwell_minutes integer,
  -- GPS context (no raw coords stored — only arrival/departure state)
  auto_detected boolean default false,     -- was session started by geofence?
  venue_latitude double precision,          -- approximate venue center (user-provided or auto)
  venue_longitude double precision,
  device_model text,                        -- for cross-device normalization
  os_version text,
  app_version text default '0.1.0',
  created_at timestamptz default now()
);

-- Sensor windows: 1-minute aggregated readings
create table public.sensor_windows (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references public.sessions(id) on delete cascade not null,
  window_start timestamptz not null,
  window_end timestamptz not null,

  -- Audio signals
  avg_db numeric(5,1),
  max_db numeric(5,1),
  db_variance numeric(7,2),                -- sound level stability
  music_detected boolean,
  estimated_bpm integer,
  audio_classification text check (audio_classification in (
    'silent', 'talking', 'low_music', 'high_music', 'loud_music'
  )),
  bass_presence numeric(3,2),              -- 0.0 to 1.0
  mid_high_ratio numeric(3,2),             -- frequency balance

  -- Motion signals
  accel_magnitude_avg numeric(6,3),
  accel_magnitude_max numeric(6,3),
  accel_variance numeric(8,4),             -- high variance = active movement
  gyro_activity_avg numeric(6,3),
  gyro_activity_max numeric(6,3),
  movement_classification text check (movement_classification in (
    'stationary', 'walking', 'swaying', 'dancing', 'jumping'
  )),

  -- Density signals (BLE)
  ble_device_count integer,
  ble_count_delta integer,                 -- change from previous window
  ble_count_trend text check (ble_count_trend in (
    'filling', 'stable', 'thinning', 'unknown'
  )),

  -- GPS signals
  gps_is_at_venue boolean,                 -- on-device geofence result
  gps_accuracy_meters numeric(5,1),

  -- Engagement signals (Tier 2 — nullable)
  screen_off_ratio numeric(3,2),           -- 0.0 to 1.0
  camera_activations integer,

  -- Computed on-device
  computed_energy_score numeric(3,1),       -- 0.0 to 5.0
  computed_density_score numeric(3,1),
  computed_movement_score numeric(3,1),
  computed_music_score numeric(3,1),
  computed_vibe_score numeric(3,1),         -- the composite

  created_at timestamptz default now()
);

-- Subjective ratings: user micro-prompts
create table public.subjective_ratings (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references public.sessions(id) on delete cascade not null,
  device_id text not null,
  rating integer check (rating between 1 and 5),
  rated_at timestamptz not null,
  nearest_window_id uuid references public.sensor_windows(id),
  response_time_ms integer,                -- how long user took to tap (engagement proxy)
  created_at timestamptz default now()
);

-- Indexes for analysis queries
create index idx_sensor_windows_session on public.sensor_windows(session_id, window_start);
create index idx_sensor_windows_time on public.sensor_windows(window_start);
create index idx_subjective_ratings_session on public.subjective_ratings(session_id);
create index idx_sessions_device on public.sessions(device_id);
create index idx_sessions_venue_type on public.sessions(venue_type);

-- RLS policies (permissive for validation — tighten for production)
alter table public.sessions enable row level security;
alter table public.sensor_windows enable row level security;
alter table public.subjective_ratings enable row level security;

-- Allow all inserts/reads for validation (no auth, device_id only)
create policy "Allow all session operations" on public.sessions
  for all using (true) with check (true);
create policy "Allow all sensor_window operations" on public.sensor_windows
  for all using (true) with check (true);
create policy "Allow all rating operations" on public.subjective_ratings
  for all using (true) with check (true);
```

**Deploy:**
```bash
supabase db push
# OR if using hosted Supabase without CLI link:
# Copy SQL into Supabase Dashboard → SQL Editor → Run
```

**Verification:** Query each table from Supabase dashboard. Confirm all columns and constraints exist:
```sql
select column_name, data_type from information_schema.columns
where table_name = 'sensor_windows' order by ordinal_position;
```

### 0.7 — EAS Build setup

```bash
npx eas-cli build:configure

# Create development build profile in eas.json
```

Ensure `eas.json` has a dev build profile:
```json
{
  "cli": { "version": ">= 3.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": { "simulator": true },
      "android": { "buildType": "apk" }
    },
    "preview": {
      "distribution": "internal"
    }
  }
}
```

**Note:** A dev build is required because `expo-sensors`, `expo-av`, `react-native-ble-plx`, and background tasks do NOT work in Expo Go. Build early:

```bash
# iOS simulator build (for development)
npx eas-cli build --profile development --platform ios

# Android APK (for sideloading to test devices)
npx eas-cli build --profile development --platform android
```

**Verification:** Dev build installs and launches on simulator/emulator. This is a blocking prerequisite — if the build fails, nothing else works.

---

## Phase 0 Exit Criteria Checklist

- [ ] All CLI tools installed and verified
- [ ] Expo project created and starts without errors
- [ ] All dependencies installed without conflicts
- [ ] app.config.ts valid with all permissions declared
- [ ] Supabase schema deployed and verified
- [ ] EAS dev build compiles for at least one platform
- [ ] .env file has Supabase credentials
- [ ] Git repo initialized with clean first commit

**Only proceed to Phase 1 after ALL items are checked.**

---

## Phase 1 — Sensor Pipeline (Week 1)

### Project structure

```
vibemeter-app/
├── app/                          # Expo Router screens
│   ├── _layout.tsx               # Root layout with tab navigation
│   ├── index.tsx                 # Home screen (start session)
│   ├── meter.tsx                 # Live vibe meter
│   ├── prompt.tsx                # Vibe check prompt (modal)
│   └── summary.tsx               # Session summary
├── src/
│   ├── sensors/
│   │   ├── AudioAnalyzer.ts      # Microphone → dB, FFT, BPM, classification
│   │   ├── MotionTracker.ts      # Accelerometer + gyroscope
│   │   ├── BLEScanner.ts         # Bluetooth device counting
│   │   ├── LocationTracker.ts    # GPS geofence + dwell time
│   │   └── SensorOrchestrator.ts # Coordinates all sensors, manages lifecycle
│   ├── processing/
│   │   ├── FFTProcessor.ts       # Fast Fourier Transform implementation
│   │   ├── BPMDetector.ts        # Beat/onset detection from FFT
│   │   ├── AudioClassifier.ts    # Classify audio state from features
│   │   ├── MovementClassifier.ts # Classify motion state
│   │   └── VibeScoreEngine.ts    # Composite score computation
│   ├── storage/
│   │   ├── LocalBuffer.ts        # SQLite buffer for sensor windows
│   │   ├── SupabaseSync.ts       # Batch upload to Supabase
│   │   └── DeviceIdentity.ts     # Anonymous device ID generation
│   ├── session/
│   │   ├── SessionManager.ts     # Start/stop/auto-detect sessions
│   │   └── GeofenceManager.ts    # GPS-based venue arrival/departure
│   ├── notifications/
│   │   └── VibePrompt.ts         # Periodic rating prompt
│   ├── config/
│   │   ├── constants.ts          # All tunable parameters in one place
│   │   └── supabase.ts           # Supabase client init
│   └── types/
│       └── index.ts              # TypeScript interfaces for all data
├── analysis/                     # Week 4 Python analysis
│   ├── fetch_data.py
│   ├── correlations.py
│   ├── signal_analysis.py
│   └── requirements.txt
└── tests/
    ├── AudioAnalyzer.test.ts
    ├── BPMDetector.test.ts
    ├── VibeScoreEngine.test.ts
    └── mocks/
        └── sensorData.ts         # Synthetic test data
```

### 1.1 — Types & Constants

Create `src/types/index.ts`:

```typescript
// Core data types for VibeMeter

export interface SensorWindow {
  id: string;
  sessionId: string;
  windowStart: Date;
  windowEnd: Date;

  // Audio
  avgDb: number | null;
  maxDb: number | null;
  dbVariance: number | null;
  musicDetected: boolean | null;
  estimatedBpm: number | null;
  audioClassification: AudioClassification | null;
  bassPresence: number | null;
  midHighRatio: number | null;

  // Motion
  accelMagnitudeAvg: number | null;
  accelMagnitudeMax: number | null;
  accelVariance: number | null;
  gyroActivityAvg: number | null;
  gyroActivityMax: number | null;
  movementClassification: MovementClassification | null;

  // Density
  bleDeviceCount: number | null;
  bleCountDelta: number | null;
  bleCountTrend: CrowdTrend | null;

  // GPS
  gpsIsAtVenue: boolean | null;
  gpsAccuracyMeters: number | null;

  // Engagement (Tier 2)
  screenOffRatio: number | null;
  cameraActivations: number | null;

  // Computed scores
  computedEnergyScore: number | null;
  computedDensityScore: number | null;
  computedMovementScore: number | null;
  computedMusicScore: number | null;
  computedVibeScore: number | null;
}

export type AudioClassification =
  | 'silent'
  | 'talking'
  | 'low_music'
  | 'high_music'
  | 'loud_music';

export type MovementClassification =
  | 'stationary'
  | 'walking'
  | 'swaying'
  | 'dancing'
  | 'jumping';

export type CrowdTrend = 'filling' | 'stable' | 'thinning' | 'unknown';

export type VenueType =
  | 'bar'
  | 'club'
  | 'house_party'
  | 'concert'
  | 'rooftop'
  | 'restaurant'
  | 'other';

export interface Session {
  id: string;
  deviceId: string;
  venueName: string | null;
  venueType: VenueType | null;
  startedAt: Date;
  endedAt: Date | null;
  dwellMinutes: number | null;
  autoDetected: boolean;
  venueLatitude: number | null;
  venueLongitude: number | null;
  deviceModel: string;
  osVersion: string;
}

export interface SubjectiveRating {
  id: string;
  sessionId: string;
  deviceId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  ratedAt: Date;
  nearestWindowId: string | null;
  responseTimeMs: number;
}

// Raw sensor sample types (on-device only, never uploaded)
export interface AudioSample {
  timestamp: number;
  rmsAmplitude: number;
  dbLevel: number;
  frequencyBands: Float32Array; // FFT output
}

export interface MotionSample {
  timestamp: number;
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroX: number;
  gyroY: number;
  gyroZ: number;
}

export interface BLEScanResult {
  timestamp: number;
  deviceCount: number;
}
```

Create `src/config/constants.ts`:

```typescript
// ============================================
// All tunable parameters — single source of truth
// ============================================

export const SENSOR_CONFIG = {
  // Audio sampling
  AUDIO_SAMPLE_DURATION_MS: 5000,       // 5 sec recording window
  AUDIO_SAMPLE_INTERVAL_MS: 120000,     // sample every 2 min
  AUDIO_SAMPLE_RATE: 44100,             // Hz
  FFT_SIZE: 2048,                       // FFT window size

  // Motion sampling
  MOTION_SAMPLE_RATE_HZ: 10,            // 10 samples/sec
  MOTION_SAMPLE_DURATION_MS: 5000,      // 5 sec burst
  MOTION_SAMPLE_INTERVAL_MS: 30000,     // every 30 sec
  MOTION_STATIONARY_THRESHOLD: 0.3,     // below = stationary
  MOTION_WALKING_THRESHOLD: 1.0,
  MOTION_DANCING_THRESHOLD: 2.5,
  MOTION_JUMPING_THRESHOLD: 5.0,

  // BLE scanning
  BLE_SCAN_DURATION_MS: 5000,           // 5 sec scan window
  BLE_SCAN_INTERVAL_MS: 60000,          // every 60 sec

  // GPS / Location
  GPS_CHECK_INTERVAL_MS: 120000,        // check every 2 min
  GPS_GEOFENCE_RADIUS_METERS: 100,      // venue geofence radius
  GPS_ACCURACY_THRESHOLD_METERS: 50,    // discard if worse

  // Aggregation
  WINDOW_DURATION_MS: 60000,            // 1-min aggregation windows

  // Upload
  UPLOAD_BATCH_INTERVAL_MS: 300000,     // upload every 5 min
  UPLOAD_RETRY_ATTEMPTS: 3,
  UPLOAD_RETRY_DELAY_MS: 10000,

  // Vibe prompt
  PROMPT_INTERVAL_MS: 1500000,          // every 25 min
  PROMPT_TIMEOUT_MS: 60000,             // dismiss after 60 sec if no response

  // Vibe score weights (initial — will be tuned by analysis)
  VIBE_WEIGHTS: {
    energy: 0.30,
    music: 0.25,
    movement: 0.20,
    density: 0.15,
    engagement: 0.10,
  },

  // Audio classification thresholds
  AUDIO_DB_SILENT: 30,
  AUDIO_DB_TALKING: 55,
  AUDIO_DB_LOW_MUSIC: 65,
  AUDIO_DB_HIGH_MUSIC: 78,
  AUDIO_DB_LOUD_MUSIC: 88,

  // BPM detection
  BPM_MIN: 60,
  BPM_MAX: 200,
  BPM_CONFIDENCE_THRESHOLD: 0.5,        // below = don't report BPM

  // Battery optimization
  STATIONARY_TIMEOUT_MS: 300000,         // stop motion sampling after 5 min stationary
} as const;

export const SUPABASE_CONFIG = {
  URL: process.env.EXPO_PUBLIC_SUPABASE_URL || '',
  ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '',
} as const;
```

**Verification:** TypeScript compiles without errors. Import types in a test file and confirm.

### 1.2 — Audio Analyzer

Build `src/sensors/AudioAnalyzer.ts`:

**Requirements:**
- Use `expo-av` Audio.Recording API to capture 5-second audio buffers
- Compute RMS amplitude → dB level from the metering data
- Implement FFT using a pure JS implementation (no native module needed for basic spectral analysis)
- Implement BPM detection via onset detection on FFT magnitude differences
- Classify audio state based on dB level + music detection + BPM presence
- **Never save audio to disk.** Process buffer → extract metrics → discard immediately
- Return: `{ avgDb, maxDb, musicDetected, estimatedBpm, audioClassification, bassPresence, midHighRatio }`

**Testing strategy (Claude Code can run these):**
- Unit test with synthetic sine wave data at known frequencies to verify FFT
- Unit test BPM detector with synthetic onset patterns at known BPMs (60, 90, 120, 128, 140)
- Test classification logic with mock dB + frequency inputs covering all 5 states
- Integration test: start recording → wait 5 sec → verify metrics object has all fields populated
- Edge case: test with silence (no microphone input) — should return `silent` classification

**Key implementation notes:**
- `expo-av` Audio.Recording provides `metering` data (dB levels) during recording via `onRecordingStatusUpdate`
- For FFT on the audio buffer, use a lightweight JS FFT library or implement Cooley-Tukey in-place
- BPM detection approach: compute spectral flux (frame-to-frame magnitude difference), find peaks, compute inter-peak intervals, convert to BPM
- Bass presence = energy ratio in 20-200Hz band vs total energy
- Music detection heuristic: sustained rhythmic peaks in FFT + bass presence > threshold + BPM confidence > threshold

### 1.3 — Motion Tracker

Build `src/sensors/MotionTracker.ts`:

**Requirements:**
- Use `expo-sensors` Accelerometer and Gyroscope APIs
- Sample at 10Hz for 5-second bursts
- Compute: magnitude = sqrt(x² + y² + z²) minus gravity (≈9.81)
- Compute variance over the burst window (high variance = active movement)
- Classify: stationary / walking / swaying / dancing / jumping based on magnitude + variance thresholds
- Return: `{ accelMagnitudeAvg, accelMagnitudeMax, accelVariance, gyroActivityAvg, gyroActivityMax, movementClassification }`

**Testing strategy:**
- Unit test classifier with synthetic magnitude sequences matching each classification
- Verify gravity subtraction works correctly
- Test that stationary timeout triggers (stop sampling after 5 min stationary)
- Verify listener cleanup on stop

### 1.4 — BLE Scanner

Build `src/sensors/BLEScanner.ts`:

**Requirements:**
- Use `react-native-ble-plx` BleManager
- Scan for 5 seconds, count unique device UUIDs detected
- Do NOT store any device identifiers — only the count
- Track delta from previous scan (filling/thinning trend)
- Return: `{ bleDeviceCount, bleCountDelta, bleCountTrend }`

**Testing strategy:**
- Mock BleManager for unit tests — verify count logic with 0, 5, 50, 200 mock devices
- Verify delta computation: if previous=10, current=15 → delta=+5, trend='filling'
- Verify no MAC addresses or device IDs are retained after scan
- Integration test on real device (requires dev build): verify scan starts and returns a count

**Known risk:** BLE scanning behavior differs significantly between iOS and Android, and between background/foreground states. Log platform + foreground state with every scan result for analysis.

### 1.5 — Location Tracker + Geofence

Build `src/sensors/LocationTracker.ts` and `src/session/GeofenceManager.ts`:

**Requirements — LocationTracker:**
- Use `expo-location` for periodic location checks
- Request foreground permission first; request background permission separately with clear justification
- Check location every 2 minutes during active session
- On-device geofence check: is user within GPS_GEOFENCE_RADIUS_METERS of session venue?
- Return: `{ gpsIsAtVenue, gpsAccuracyMeters }`
- **Never upload raw GPS coordinates to Supabase.** Only upload the boolean `gpsIsAtVenue` and accuracy

**Requirements — GeofenceManager:**
- If user has set a venue location (manual or from first GPS fix at session start), monitor for departure
- Departure detection: 3 consecutive location checks outside geofence radius → flag departure
- Arrival detection (for auto-session, Tier 2): if app has known venue locations from past sessions, detect when user enters geofence
- For validation experiment: auto-session is stretch goal. Manual start/stop is required. Auto-detect is nice-to-have.

**Privacy implementation:**
```typescript
// LocationTracker.ts — privacy-safe upload transform
function toUploadFormat(location: LocationObject, venueCoords: {lat: number, lng: number} | null) {
  // NEVER include raw coords in the return object
  const isAtVenue = venueCoords
    ? haversineDistance(location.coords, venueCoords) < SENSOR_CONFIG.GPS_GEOFENCE_RADIUS_METERS
    : null;

  return {
    gpsIsAtVenue: isAtVenue,
    gpsAccuracyMeters: location.coords.accuracy,
    // latitude: NEVER — do not include
    // longitude: NEVER — do not include
  };
}
```

**Testing strategy:**
- Unit test haversine distance calculation with known coordinate pairs
- Unit test geofence logic: inside radius → true, outside → false, edge cases
- Unit test departure detection: 1 outside → no trigger, 3 consecutive → trigger
- Mock location provider for deterministic tests

### 1.6 — FFT Processor & BPM Detector

Build `src/processing/FFTProcessor.ts` and `src/processing/BPMDetector.ts`:

**FFT Requirements:**
- Implement radix-2 Cooley-Tukey FFT (or use a lightweight library like `fft-js`)
- Input: Float32Array of audio samples (time domain)
- Output: Float32Array of magnitude spectrum (frequency domain)
- Bin resolution: sampleRate / fftSize (e.g., 44100/2048 ≈ 21.5 Hz per bin)

**BPM Detection Requirements:**
- Compute spectral flux: sum of positive magnitude differences between consecutive FFT frames
- Apply onset detection: find peaks in spectral flux above a dynamic threshold
- Compute inter-onset intervals (IOIs)
- Convert median IOI to BPM: `60 / medianIOI_seconds`
- Clamp to valid range (60–200 BPM)
- Report confidence: ratio of IOIs that agree with the median (±5%)

**Testing strategy (critical — this is the most valuable signal):**
- Generate synthetic audio: sine wave at 440Hz with amplitude envelope pulsing at 2Hz (120 BPM)
- Run through pipeline → verify BPM output is 120 ± 5
- Test with 128 BPM pulse → verify output is 128 ± 5
- Test with no rhythmic content (white noise) → verify low confidence, no BPM reported
- Test with two overlapping rhythms → verify it picks the dominant one
- Test with varying amplitudes → verify BPM detection is amplitude-invariant

### 1.7 — Audio Classifier

Build `src/processing/AudioClassifier.ts`:

```typescript
export function classifyAudio(
  avgDb: number,
  musicDetected: boolean,
  bpm: number | null,
  bassPresence: number,
): AudioClassification {
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_SILENT) return 'silent';
  if (!musicDetected) {
    return avgDb < SENSOR_CONFIG.AUDIO_DB_TALKING ? 'silent' : 'talking';
  }
  // Music detected
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_LOW_MUSIC) return 'low_music';
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_HIGH_MUSIC) return 'high_music';
  return 'loud_music';
}

export function detectMusic(
  bassPresence: number,
  bpmConfidence: number,
  spectralFlatness: number, // low = tonal (music), high = noise-like
): boolean {
  // Music has: bass presence, rhythmic content, tonal structure
  return (
    bassPresence > 0.3 &&
    bpmConfidence > SENSOR_CONFIG.BPM_CONFIDENCE_THRESHOLD &&
    spectralFlatness < 0.6
  );
}
```

**Testing strategy:**
- Test matrix of all 5 classification states with boundary values
- Verify that dB=75, music=false returns 'talking' (loud restaurant)
- Verify that dB=75, music=true, bpm=126 returns 'high_music' (party)
- This distinction is the core value proposition — test it thoroughly

### 1.8 — Vibe Score Engine

Build `src/processing/VibeScoreEngine.ts`:

**Requirements:**
- Takes all sensor readings for a window and computes sub-scores + composite
- Each sub-score normalized to 0.0–5.0 scale
- Composite = weighted average using `SENSOR_CONFIG.VIBE_WEIGHTS`
- Handle null/missing signals gracefully: if a signal is unavailable, redistribute its weight proportionally to other signals

```typescript
export interface VibeScoreBreakdown {
  energyScore: number;      // dB + BPM + music detection
  musicScore: number;        // music detected + BPM + bass presence
  movementScore: number;     // accelerometer + gyro
  densityScore: number;      // BLE device count + trend
  engagementScore: number;   // dwell time + screen-off (if available)
  compositeVibeScore: number; // weighted blend
  confidence: number;         // 0-1, based on how many signals contributed
}

export function computeVibeScore(window: Partial<SensorWindow>): VibeScoreBreakdown {
  // Implementation:
  // 1. Normalize each raw signal to 0-5 scale
  // 2. Compute sub-scores as combinations of related signals
  // 3. Apply weights, handling null signals by redistribution
  // 4. Compute confidence based on signal availability
}
```

**Normalization rules:**
- dB: 30→0.0, 55→1.5, 65→2.5, 78→3.5, 88→4.5, 95+→5.0 (interpolated)
- BPM: no music→0, 60-80→2.0, 80-110→3.0, 110-130→4.0, 130+→5.0
- Accelerometer magnitude: 0→0, 0.3→1.0, 1.0→2.0, 2.5→3.5, 5.0+→5.0
- BLE count: 0→0.0, 5→1.5, 15→3.0, 30→4.0, 50+→5.0
- These are initial guesses — the Week 4 analysis will tune them

**Testing strategy:**
- Test with "dead bar" inputs → expect score < 1.5
- Test with "loud restaurant" inputs → expect score 1.5-2.5 (high dB but no music/movement)
- Test with "peak party" inputs → expect score > 4.0
- Test with partial null inputs → verify weight redistribution works
- Test confidence: all signals present → 1.0, half missing → ~0.5

### 1.9 — Sensor Orchestrator

Build `src/sensors/SensorOrchestrator.ts`:

**Requirements:**
- Manages the lifecycle of all sensors
- Starts/stops sensors when session starts/stops
- Coordinates sampling intervals (staggered to avoid simultaneous CPU spikes)
- Aggregates raw samples into 1-minute SensorWindow objects
- Passes completed windows to LocalBuffer for storage
- Handles background execution via `expo-task-manager`

```typescript
export class SensorOrchestrator {
  private audioAnalyzer: AudioAnalyzer;
  private motionTracker: MotionTracker;
  private bleScanner: BLEScanner;
  private locationTracker: LocationTracker;
  private vibeEngine: VibeScoreEngine;
  private localBuffer: LocalBuffer;
  private currentWindow: Partial<SensorWindow>;
  private isRunning: boolean;

  async startSession(session: Session): Promise<void>;
  async stopSession(): Promise<void>;
  private async collectAudioSample(): Promise<void>;
  private async collectMotionSample(): Promise<void>;
  private async collectBLESample(): Promise<void>;
  private async collectLocationSample(): Promise<void>;
  private async finalizeWindow(): Promise<void>; // every 60 sec
  private scheduleNextSamples(): void;
}
```

**Background execution:**

```typescript
import * as TaskManager from 'expo-task-manager';

const BACKGROUND_SENSOR_TASK = 'VIBEMETER_SENSOR_COLLECTION';

TaskManager.defineTask(BACKGROUND_SENSOR_TASK, async () => {
  // Run sensor collection cycle
  // This is the make-or-break for iOS — if this doesn't fire reliably,
  // the entire approach needs rethinking
  return TaskManager.TaskManagerTaskBody.Result.Success;
});
```

**Testing strategy:**
- Start orchestrator → verify all sensors initialize without error
- Run for 2 minutes → verify at least 1 complete SensorWindow is produced
- Stop orchestrator → verify all sensors stop, no lingering listeners
- Simulate backgrounding → verify task fires (requires real device test)
- Log every sensor error with timestamp and sensor name — never silently swallow errors

### 1.10 — Local Buffer (SQLite)

Build `src/storage/LocalBuffer.ts`:

**Requirements:**
- Use `expo-sqlite` to store SensorWindows locally before upload
- Schema mirrors Supabase `sensor_windows` table
- Insert new windows as they're finalized by Orchestrator
- Query unsynced windows for batch upload
- Mark windows as synced after successful upload
- Delete synced windows older than 24 hours (keep device storage lean)

**Testing strategy:**
- Insert 100 mock windows → query unsynced → verify count is 100
- Mark 50 as synced → query unsynced → verify count is 50
- Verify delete cleans up old synced records

### 1.11 — Supabase Sync

Build `src/storage/SupabaseSync.ts`:

**Requirements:**
- Batch upload unsynced SensorWindows every 5 minutes
- Batch upload SubjectiveRatings immediately after user submits
- Upload Sessions on start and update on end
- Retry failed uploads with exponential backoff (3 attempts)
- Handle offline gracefully — buffer locally, sync when connection returns
- Log upload success/failure counts for monitoring

**Testing strategy:**
- Mock Supabase client → verify correct insert payloads
- Test with network error → verify retry logic triggers
- Test batch size: insert 50 windows → verify single batch insert (not 50 individual calls)
- Verify no raw GPS coordinates appear in upload payload

### 1.12 — Device Identity

Build `src/storage/DeviceIdentity.ts`:

```typescript
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'vibemeter_device_id';

export async function getDeviceId(): Promise<string> {
  let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}
```

**Testing strategy:** Call twice → verify same ID returned. Clear storage → verify new ID generated.

---

## Phase 1 Exit Criteria Checklist

- [ ] AudioAnalyzer records 5-sec buffer, computes dB, runs FFT, detects BPM, classifies audio
- [ ] BPM detector returns correct BPM (±5) for synthetic test signals
- [ ] Audio classifier correctly distinguishes all 5 states (silent/talking/low_music/high_music/loud_music)
- [ ] MotionTracker samples accelerometer+gyro, classifies movement
- [ ] BLEScanner counts devices and computes trend
- [ ] LocationTracker checks geofence, returns only boolean (no raw coords uploaded)
- [ ] VibeScoreEngine computes composite score from all inputs
- [ ] SensorOrchestrator coordinates all sensors, produces 1-min windows
- [ ] LocalBuffer stores and retrieves windows via SQLite
- [ ] SupabaseSync uploads batches successfully
- [ ] All unit tests pass
- [ ] Background task fires on real device (iOS and Android)
- [ ] No raw audio, GPS coords, or BLE identifiers leave the device

---

## Phase 2 — UI + Score Display + Prompts (Week 2)

### 2.1 — Navigation setup

Configure Expo Router with 4 screens:

```
app/
├── _layout.tsx          # Tab layout: Home, Meter, Summary
├── index.tsx            # Home (start/stop session)
├── meter.tsx            # Live vibe meter
├── summary.tsx          # Post-session summary
└── prompt.tsx           # Modal: vibe rating prompt
```

### 2.2 — Home Screen (`app/index.tsx`)

**Requirements:**
- Large "Start Session" button (primary action)
- Before starting: venue name input (optional text), venue type picker (bar/club/house_party/concert/rooftop/restaurant/other)
- During session: show session timer (elapsed time), "End Session" button
- Below: list of past sessions from SQLite with avg vibe score, venue name, dwell time, date
- Device ID shown in small text at bottom (for debugging during validation)

**UX details:**
- Dark background, vibrant accent color (neon green or electric blue — nightlife aesthetic)
- Session timer should be large and prominent when active
- Past sessions list sorted by most recent first

**Testing strategy:**
- Tap Start → verify session created in SQLite and Supabase
- Tap End → verify session updated with `ended_at` and `dwell_minutes`
- Verify past sessions list renders correctly with mock data
- Verify venue type picker has all 7 options

### 2.3 — Live Meter Screen (`app/meter.tsx`)

**Requirements:**
- Large circular or arc vibe score display (1.0–5.0), animates on update
- Score updates every time a new SensorWindow is finalized (every 60 sec)
- Sub-score breakdown below main score: Energy, Music, Movement, Density
- Each sub-score as a small bar or radial indicator
- BPM display when music is detected (e.g., "128 BPM" with a pulse animation)
- Crowd trend indicator: ↑ filling / → stable / ↓ thinning (with color: green/yellow/red)
- Audio classification badge: current state (silent/talking/low_music/etc.)
- "Last updated: 30 sec ago" timestamp
- Must work when screen is off — scores should be current when user opens the app

**Animation:**
- Main score: smooth interpolation between values (spring animation)
- BPM display: subtle pulse at the detected tempo
- Trend arrow: animate direction changes

**Testing strategy:**
- Feed mock SensorWindows → verify score display updates
- Test with null/partial data → verify graceful degradation (show "--" for missing signals)
- Test transition between all audio classifications → verify badge updates
- Verify screen doesn't blank when no new data (show last known values with stale indicator)

### 2.4 — Vibe Check Prompt (`app/prompt.tsx` + `src/notifications/VibePrompt.ts`)

**Requirements:**
- Modal overlay (or notification that opens modal when tapped)
- "How's the vibe right now?"
- 5 tappable options arranged horizontally:
  1. Dead (💀)
  2. Meh (😐)
  3. Decent (🙂)
  4. Great (🔥)
  5. Peak (🤯)
- Single tap selects and dismisses — must take < 3 seconds total
- Record `response_time_ms` (timestamp of prompt shown → timestamp of tap)
- Associate rating with nearest SensorWindow by timestamp
- Schedule: fire every 25 minutes during active session
- If app is backgrounded: send local notification that opens the prompt
- If user doesn't respond within 60 sec: dismiss, don't re-prompt until next interval
- Don't prompt in the first 5 minutes of a session (let user settle in)

**VibePrompt.ts:**
```typescript
export class VibePrompt {
  private intervalId: NodeJS.Timeout | null = null;

  startPromptSchedule(sessionId: string): void;
  stopPromptSchedule(): void;
  private async showPrompt(): Promise<void>;
  private async scheduleNotification(): Promise<void>; // for background
  async recordRating(rating: 1|2|3|4|5, responseTimeMs: number): Promise<void>;
}
```

**Testing strategy:**
- Start schedule → verify first prompt fires after PROMPT_INTERVAL_MS
- Verify prompt doesn't fire in first 5 minutes
- Tap rating → verify stored in SQLite with correct sessionId and responseTimeMs
- Verify nearest window association works (find window closest to rating timestamp)
- Test timeout: don't tap → verify prompt auto-dismisses after 60 sec

### 2.5 — Session Summary Screen (`app/summary.tsx`)

**Requirements:**
- Shown after "End Session" (or accessible from past sessions list)
- Timeline chart (x-axis = time, y-axis = vibe score 0-5)
  - Line: computed vibe score over session duration
  - Dots: subjective ratings plotted at their timestamps
  - Visual comparison: where did sensor score agree/disagree with user rating?
- Signal contribution chart: stacked area showing energy/music/movement/density over time
- Stats summary:
  - Session duration
  - Average vibe score
  - Peak vibe score + time
  - BPM range detected
  - Audio classification breakdown (% time in each state)
  - BLE device count range
  - Number of subjective ratings submitted
- "This is where the magic is" — the summary should be genuinely fun and interesting to look at. It's what makes friends want to keep using the app.

**Testing strategy:**
- Feed 30 mock SensorWindows + 3 mock ratings → verify timeline renders correctly
- Test with minimal data (2 windows, 0 ratings) → verify graceful empty states
- Test with long session (120 windows) → verify chart scrolls/scales properly
- Verify all stats compute correctly from mock data

### 2.6 — Background task integration

**Critical path item.** Wire up `expo-task-manager` to keep sensors running when app is backgrounded.

```typescript
// In app/_layout.tsx or app entry point
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';

TaskManager.defineTask('VIBEMETER_BACKGROUND', async () => {
  const orchestrator = SensorOrchestrator.getInstance();
  if (orchestrator.isRunning) {
    await orchestrator.runCollectionCycle();
  }
  return BackgroundFetch.BackgroundFetchResult.NewData;
});
```

**iOS-specific concerns:**
- Background audio: use `Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true })` to keep audio session alive
- Background location: if enabled, keeps app alive — but requires justification for App Store review
- Background fetch: iOS throttles this heavily — may only fire every 15-30 min
- **Test this on a real iOS device immediately.** If background collection drops data, the experiment's value drops proportionally.

**Testing strategy:**
- Start session → background app → wait 5 minutes → foreground → check if new SensorWindows were created
- Check timestamps: are windows evenly spaced or are there gaps?
- Log every background task execution with timestamp
- Test on both iOS and Android — behavior will differ

---

## Phase 2 Exit Criteria Checklist

- [ ] All 4 screens render and navigate correctly
- [ ] Start/End session flow works end-to-end
- [ ] Live meter updates with real sensor data on a real device
- [ ] BPM displays when music is detected
- [ ] Vibe prompt fires on schedule, records rating with response time
- [ ] Session summary renders timeline chart with real data
- [ ] Background sensor collection works on both platforms (with gap analysis)
- [ ] Data flows: sensor → orchestrator → SQLite → Supabase
- [ ] Past sessions list populates from local storage
- [ ] No crashes on extended use (30+ minute session test)

---

## Phase 3 — Deploy & Collect (Week 3)

### 3.1 — Build for distribution

```bash
# iOS: TestFlight internal testing
npx eas-cli build --profile preview --platform ios
# Upload to TestFlight after build completes

# Android: generate APK for sideloading
npx eas-cli build --profile preview --platform android
```

**Human action required:**
- Distribute TestFlight link to iOS testers
- Distribute APK to Android testers
- Brief testers on how to use the app and the importance of honest ratings

### 3.2 — Tester briefing document

Generate a briefing doc to share with test users:

```
VibeMeter Testing Guide
========================

What this app does:
- Measures ambient sound, music, movement, and crowd density from your phone sensors
- Asks you "How's the vibe?" every ~25 minutes
- Produces a "vibe score" that we're testing for accuracy

How to use it:
1. Open VibeMeter when you arrive at a bar, party, or event
2. Tap "Start Session", optionally name the venue
3. Put your phone back in your pocket — the app works in the background
4. When you get the "How's the vibe?" notification, tap your honest rating (takes 2 seconds)
5. When you leave, open the app and tap "End Session"
6. Check the Session Summary to see if the score matched your experience!

Important:
- Be HONEST with your ratings. The whole experiment depends on this.
- You can ignore a prompt if you're busy — just catch the next one
- The app does NOT record audio — only sound levels
- The app does NOT track your location — only checks if you're still at the venue
- Battery impact should be under 5% per hour

What to test at:
- Bars (quiet, loud, with/without music)
- Clubs
- House parties
- Concerts
- Restaurants (control — should score low)
- At home doing nothing (control — should score very low)
```

### 3.3 — Data monitoring during collection

Set up a simple Supabase dashboard query to monitor data quality:

```sql
-- Daily data health check
select
  date_trunc('day', sw.created_at) as day,
  count(distinct s.id) as sessions,
  count(distinct s.device_id) as unique_devices,
  count(sw.id) as sensor_windows,
  count(sr.id) as ratings,
  round(avg(sw.computed_vibe_score), 2) as avg_vibe,
  round(avg(sw.avg_db), 1) as avg_db,
  count(case when sw.music_detected then 1 end) as windows_with_music,
  count(case when sw.estimated_bpm is not null then 1 end) as windows_with_bpm
from sessions s
left join sensor_windows sw on sw.session_id = s.id
left join subjective_ratings sr on sr.session_id = s.id
group by 1
order by 1 desc;

-- Per-session quality check
select
  s.id,
  s.venue_name,
  s.venue_type,
  s.dwell_minutes,
  count(sw.id) as windows,
  count(sr.id) as ratings,
  round(avg(sw.computed_vibe_score), 2) as avg_vibe,
  round(avg(sr.rating), 2) as avg_user_rating,
  round(avg(sw.avg_db), 1) as avg_db,
  bool_or(sw.music_detected) as any_music_detected,
  s.device_model
from sessions s
left join sensor_windows sw on sw.session_id = s.id
left join subjective_ratings sr on sr.session_id = s.id
where s.ended_at is not null
group by s.id
order by s.started_at desc;

-- Signal coverage: what % of windows have each signal?
select
  count(*) as total_windows,
  round(100.0 * count(avg_db) / count(*), 1) as pct_has_audio,
  round(100.0 * count(estimated_bpm) / count(*), 1) as pct_has_bpm,
  round(100.0 * count(accel_magnitude_avg) / count(*), 1) as pct_has_motion,
  round(100.0 * count(ble_device_count) / count(*), 1) as pct_has_ble,
  round(100.0 * count(gps_is_at_venue) / count(*), 1) as pct_has_gps,
  round(100.0 * count(screen_off_ratio) / count(*), 1) as pct_has_screen
from sensor_windows;
```

**Run these daily during Week 3.** Flag issues immediately:
- If audio coverage drops below 80% → background audio is failing
- If BLE coverage is low → permissions issue or scanner bug
- If ratings are sparse → prompts aren't firing or users are ignoring them
- If certain devices have no data → device-specific bugs

### 3.4 — Bug fixes during collection

Expect bugs. Prioritize:
1. **P0 — Data loss:** Background task not firing, sensors crashing → fix immediately
2. **P1 — Signal quality:** BPM always null, BLE counts always 0 → investigate and fix
3. **P2 — UX issues:** Prompt timing off, summary chart glitchy → fix if time permits
4. **P3 — Cosmetic:** Animations janky, colors off → ignore until after data collection

---

## Phase 3 Exit Criteria

- [ ] App distributed to 5-10 testers on both platforms
- [ ] At least 8 sessions completed across 3+ venue types
- [ ] At least 30 subjective ratings collected
- [ ] Signal coverage above 70% for audio, motion, BLE
- [ ] No critical data loss bugs remaining
- [ ] Daily data monitoring confirms data flowing to Supabase

---

## Phase 4 — Analysis & Findings (Week 4)

### 4.1 — Data export

Create `analysis/fetch_data.py`:

```python
import os
import pandas as pd
from supabase import create_client

url = os.environ['SUPABASE_URL']
key = os.environ['SUPABASE_SERVICE_KEY']  # Use service role for full read access
supabase = create_client(url, key)

# Fetch all data
sessions = pd.DataFrame(supabase.table('sessions').select('*').execute().data)
windows = pd.DataFrame(supabase.table('sensor_windows').select('*').execute().data)
ratings = pd.DataFrame(supabase.table('subjective_ratings').select('*').execute().data)

# Save locally for analysis
sessions.to_csv('analysis/data/sessions.csv', index=False)
windows.to_csv('analysis/data/sensor_windows.csv', index=False)
ratings.to_csv('analysis/data/ratings.csv', index=False)

print(f"Sessions: {len(sessions)}")
print(f"Sensor windows: {len(windows)}")
print(f"Ratings: {len(ratings)}")
print(f"Unique devices: {sessions['device_id'].nunique()}")
print(f"Venue types: {sessions['venue_type'].value_counts().to_dict()}")
```

### 4.2 — Correlation analysis

Create `analysis/correlations.py`:

```python
import pandas as pd
import numpy as np
from scipy import stats

# Load data
windows = pd.read_csv('analysis/data/sensor_windows.csv')
ratings = pd.read_csv('analysis/data/ratings.csv')

# Join ratings to nearest sensor window
# For each rating, find the sensor window with closest timestamp
ratings['rated_at'] = pd.to_datetime(ratings['rated_at'])
windows['window_start'] = pd.to_datetime(windows['window_start'])

def find_nearest_window(rating_time, session_windows):
    """Find the sensor window closest in time to the rating."""
    time_diffs = abs(session_windows['window_start'] - rating_time)
    nearest_idx = time_diffs.idxmin()
    return session_windows.loc[nearest_idx]

# Build paired dataset: each row = one rating + its nearest window
paired = []
for _, rating in ratings.iterrows():
    session_windows = windows[windows['session_id'] == rating['session_id']]
    if len(session_windows) == 0:
        continue
    nearest = find_nearest_window(rating['rated_at'], session_windows)
    row = {
        'rating': rating['rating'],
        'response_time_ms': rating['response_time_ms'],
        **{col: nearest[col] for col in [
            'avg_db', 'max_db', 'db_variance', 'music_detected', 'estimated_bpm',
            'bass_presence', 'mid_high_ratio',
            'accel_magnitude_avg', 'accel_variance', 'gyro_activity_avg',
            'ble_device_count', 'ble_count_delta',
            'screen_off_ratio',
            'computed_energy_score', 'computed_density_score',
            'computed_movement_score', 'computed_music_score',
            'computed_vibe_score',
        ]}
    }
    paired.append(row)

paired_df = pd.DataFrame(paired)

# ============================================
# Per-signal correlation with subjective rating
# ============================================
signals = [
    'avg_db', 'max_db', 'db_variance',
    'estimated_bpm', 'bass_presence', 'mid_high_ratio',
    'accel_magnitude_avg', 'accel_variance', 'gyro_activity_avg',
    'ble_device_count', 'ble_count_delta',
    'screen_off_ratio',
    'computed_energy_score', 'computed_density_score',
    'computed_movement_score', 'computed_music_score',
    'computed_vibe_score',
]

print("\n=== Per-Signal Correlation with Subjective Rating ===\n")
print(f"{'Signal':<30} {'Pearson r':>10} {'p-value':>10} {'Spearman ρ':>10} {'p-value':>10} {'N':>5}")
print("-" * 85)

results = []
for signal in signals:
    valid = paired_df[['rating', signal]].dropna()
    if len(valid) < 5:
        print(f"{signal:<30} {'N/A':>10} {'N/A':>10} {'N/A':>10} {'N/A':>10} {len(valid):>5}")
        continue

    pearson_r, pearson_p = stats.pearsonr(valid['rating'], valid[signal])
    spearman_r, spearman_p = stats.spearmanr(valid['rating'], valid[signal])

    results.append({
        'signal': signal,
        'pearson_r': pearson_r,
        'pearson_p': pearson_p,
        'spearman_r': spearman_r,
        'spearman_p': spearman_p,
        'n': len(valid),
    })

    print(f"{signal:<30} {pearson_r:>10.3f} {pearson_p:>10.4f} {spearman_r:>10.3f} {spearman_p:>10.4f} {len(valid):>5}")

results_df = pd.DataFrame(results).sort_values('spearman_r', ascending=False)
results_df.to_csv('analysis/output/signal_correlations.csv', index=False)

# ============================================
# Key questions to answer
# ============================================

print("\n=== Key Findings ===\n")

# 1. Does the composite vibe score correlate?
composite = paired_df[['rating', 'computed_vibe_score']].dropna()
if len(composite) >= 5:
    r, p = stats.spearmanr(composite['rating'], composite['computed_vibe_score'])
    print(f"Composite vibe score vs rating: ρ={r:.3f}, p={p:.4f}, n={len(composite)}")
    print(f"  → {'PASS' if r >= 0.5 else 'FAIL'}: threshold is r ≥ 0.5")

# 2. Does BPM + dB outperform dB alone?
has_bpm = paired_df[paired_df['estimated_bpm'].notna()]
no_bpm = paired_df[paired_df['estimated_bpm'].isna()]
if len(has_bpm) >= 5:
    r_with, _ = stats.spearmanr(has_bpm['rating'], has_bpm['computed_energy_score'])
    print(f"\nEnergy score when BPM detected: ρ={r_with:.3f} (n={len(has_bpm)})")
if len(no_bpm) >= 5:
    r_without, _ = stats.spearmanr(no_bpm['rating'], no_bpm['avg_db'])
    print(f"dB alone when no BPM: ρ={r_without:.3f} (n={len(no_bpm)})")

# 3. Which individual signals are strongest?
print(f"\nTop 5 signals by Spearman correlation:")
for _, row in results_df.head(5).iterrows():
    print(f"  {row['signal']}: ρ={row['spearman_r']:.3f}")

# 4. Does it work across venue types?
print(f"\nCorrelation by venue type:")
for vtype in paired_df.get('venue_type', pd.Series()).unique():
    subset = paired_df[paired_df.get('venue_type') == vtype][['rating', 'computed_vibe_score']].dropna()
    if len(subset) >= 3:
        r, _ = stats.spearmanr(subset['rating'], subset['computed_vibe_score'])
        print(f"  {vtype}: ρ={r:.3f} (n={len(subset)})")
```

### 4.3 — Weight optimization

Create `analysis/optimize_weights.py`:

```python
from sklearn.linear_model import Ridge
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.metrics import r2_score, mean_absolute_error

# Use session_id as group for leave-one-session-out cross-validation
# This prevents data leakage between windows from the same session

features = ['avg_db', 'estimated_bpm', 'bass_presence', 'accel_magnitude_avg',
            'accel_variance', 'ble_device_count', 'music_detected_int']

# Fill missing BPM with 0, music_detected as int
paired_df['music_detected_int'] = paired_df['music_detected'].astype(int)
paired_df['estimated_bpm'] = paired_df['estimated_bpm'].fillna(0)

X = paired_df[features].fillna(0)
y = paired_df['rating']

# Ridge regression — interpretable weights
ridge = Ridge(alpha=1.0)
ridge.fit(X, y)
print("Ridge weights:")
for feat, coef in zip(features, ridge.coef_):
    print(f"  {feat}: {coef:.4f}")

# Random forest — captures non-linear relationships
rf = RandomForestRegressor(n_estimators=100, max_depth=4, random_state=42)
rf.fit(X, y)
print("\nRandom forest feature importance:")
for feat, imp in sorted(zip(features, rf.feature_importances_), key=lambda x: -x[1]):
    print(f"  {feat}: {imp:.4f}")

# Cross-validated R² (leave-one-session-out)
# ... implement LOGO CV ...
```

### 4.4 — Findings document generation

After analysis, Claude Code should generate `analysis/output/FINDINGS.md`:

```markdown
# VibeMeter Validation — Findings

## Data Summary
- Sessions collected: X
- Sensor windows: X
- Subjective ratings: X
- Venue types covered: X
- Unique devices: X
- Date range: X to X

## Primary Result
Composite vibe score vs subjective rating: ρ = X.XXX (p = X.XXXX)
→ [PASS/FAIL/AMBIGUOUS] against r ≥ 0.5 threshold

## Per-Signal Rankings
[Table of signals ranked by correlation]

## Key Findings
1. [Which signals work?]
2. [Does BPM add value over dB alone?]
3. [Does it work across venue types?]
4. [Which venue types correlate best?]
5. [Optimal weights from regression]

## Signal Reliability
[Table: % of windows with each signal, variance, device differences]

## Recommendation
[GO / PARTIAL GO / NO-GO + reasoning]

## If GO: Recommended changes for ViibeCheck
- [Which signals to keep/drop]
- [Optimized weights]
- [Minimum user density needed]
- [Target venue types]
```

---

## Phase 4 Exit Criteria

- [ ] All data exported from Supabase
- [ ] Per-signal correlations computed
- [ ] Composite correlation computed and evaluated against r ≥ 0.5
- [ ] Weight optimization run
- [ ] Venue-type segmentation analysis complete
- [ ] FINDINGS.md generated with clear go/no-go recommendation
- [ ] All analysis code committed and reproducible

---

## Development Principles for Claude Code

### Error handling
- Never silently swallow sensor errors. Log every error with: timestamp, sensor name, error message, device info.
- If a sensor fails to initialize, mark it as unavailable and continue with other sensors. Compute vibe score with available signals only.
- If Supabase upload fails, buffer locally. Never lose data.

### Testing approach
- Write unit tests for all processing logic (FFT, BPM, classification, scoring)
- Use synthetic sensor data for deterministic tests
- Integration tests require real device — document which tests need manual device testing
- Keep a `tests/mocks/sensorData.ts` file with representative synthetic data for all scenarios

### Performance
- Stagger sensor sampling to avoid CPU spikes (don't run audio + BLE + motion simultaneously)
- Batch SQLite writes (don't write every individual sample)
- Batch Supabase uploads (every 5 min, not every window)
- Target < 5% battery drain per hour of active session

### Privacy — hard rules
- NEVER write raw audio to disk or upload it anywhere
- NEVER upload raw GPS coordinates to Supabase
- NEVER store BLE device MAC addresses or identifiers
- ONLY upload: computed metrics, classifications, scores, booleans, counts
- Users are anonymous device IDs — no names, emails, phone numbers

### Git discipline
- Commit after each sub-step completion
- Commit message format: `phase-X.Y: description`
- Tag phase completions: `git tag phase-0-complete`, `git tag phase-1-complete`, etc.

---

*This implementation plan is the operational complement to `vibe-meter-validation-prd-v2.md`. The PRD defines WHAT and WHY. This document defines HOW and IN WHAT ORDER. Both are source of truth.*
