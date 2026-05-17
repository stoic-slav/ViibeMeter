// ============================================
// All tunable parameters — single source of truth
// ============================================

export const SENSOR_CONFIG = {
  // Audio sampling
  AUDIO_SAMPLE_DURATION_MS: 2000,
  AUDIO_SAMPLE_INTERVAL_MS: 8000,       // sample every 8s (2s record + 8s gap)
  AUDIO_SAMPLE_RATE: 44100,
  FFT_SIZE: 2048,

  // Motion sampling
  MOTION_SAMPLE_RATE_HZ: 50,          // higher rate needed for movement BPM FFT
  MOTION_SAMPLE_DURATION_MS: 3000,
  MOTION_SAMPLE_INTERVAL_MS: 10000,     // every 10 sec
  MOTION_STATIONARY_THRESHOLD: 0.15,
  MOTION_WALKING_THRESHOLD: 0.4,
  MOTION_SWAYING_THRESHOLD: 0.8,
  MOTION_DANCING_THRESHOLD: 1.5,
  MOTION_JUMPING_THRESHOLD: 3.0,

  // BLE scanning
  BLE_SCAN_DURATION_MS: 3000,
  BLE_SCAN_INTERVAL_MS: 20000,          // every 20s (3s scan + 17s gap)

  // GPS / Location
  GPS_CHECK_INTERVAL_MS: 120000,        // check every 2 min
  GPS_GEOFENCE_RADIUS_METERS: 100,
  GPS_ACCURACY_THRESHOLD_METERS: 50,

  // Aggregation
  WINDOW_DURATION_MS: 60000,            // 1-min aggregation windows

  // Upload
  UPLOAD_BATCH_INTERVAL_MS: 300000,     // upload every 5 min
  UPLOAD_RETRY_ATTEMPTS: 3,
  UPLOAD_RETRY_DELAY_MS: 10000,

  // Vibe prompt
  PROMPT_INTERVAL_MS: 300000,           // every 5 min
  PROMPT_MIN_SESSION_MS: 60000,         // don't prompt in first 1 min
  PROMPT_TIMEOUT_MS: 60000,

  // Vibe score weights (initial — will be tuned by analysis)
  VIBE_WEIGHTS: {
    energy: 0.30,
    music: 0.25,
    movement: 0.20,
    density: 0.15,
    engagement: 0.10,
  },

  // Audio classification dB thresholds
  AUDIO_DB_SILENT: 30,
  AUDIO_DB_TALKING: 55,
  AUDIO_DB_LOW_MUSIC: 65,
  AUDIO_DB_HIGH_MUSIC: 78,
  AUDIO_DB_LOUD_MUSIC: 88,

  // Music detection thresholds
  MUSIC_BASS_PRESENCE_MIN: 0.3,
  MUSIC_BPM_CONFIDENCE_MIN: 0.5,
  MUSIC_SPECTRAL_FLATNESS_MAX: 0.6,

  // BPM detection
  BPM_MIN: 60,
  BPM_MAX: 200,
  BPM_CONFIDENCE_THRESHOLD: 0.5,
  BPM_TOLERANCE_PCT: 0.05,             // ±5% for consensus check

  // Battery optimization
  STATIONARY_TIMEOUT_MS: 300000,        // stop motion sampling after 5 min stationary

  // BLE trend thresholds
  BLE_TREND_FILLING_DELTA: 3,
  BLE_TREND_THINNING_DELTA: -3,
} as const;

export const SUPABASE_CONFIG = {
  URL: process.env.EXPO_PUBLIC_SUPABASE_URL || '',
  ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '',
} as const;

// dB → normalized 0-5 score lookup table (linear interpolation between points)
export const DB_SCORE_CURVE: [number, number][] = [
  [0, 0.0],
  [30, 0.0],
  [45, 0.5],
  [55, 1.5],
  [65, 2.5],
  [78, 3.5],
  [88, 4.5],
  [95, 5.0],
  [999, 5.0],
];

// BPM → normalized 0-5 score
export const BPM_SCORE_CURVE: [number, number][] = [
  [0, 0.0],
  [60, 1.5],
  [80, 2.5],
  [110, 3.5],
  [130, 4.5],
  [160, 5.0],
  [999, 5.0],
];

// Accelerometer magnitude → normalized 0-5 score
export const ACCEL_SCORE_CURVE: [number, number][] = [
  [0, 0.0],
  [0.3, 1.0],
  [1.0, 2.0],
  [1.5, 2.5],
  [2.5, 3.5],
  [4.0, 4.5],
  [5.0, 5.0],
  [999, 5.0],
];

// BLE device count → normalized 0-5 score
export const BLE_SCORE_CURVE: [number, number][] = [
  [0, 0.0],
  [5, 1.5],
  [10, 2.5],
  [15, 3.0],
  [25, 3.5],
  [40, 4.5],
  [50, 5.0],
  [9999, 5.0],
];
