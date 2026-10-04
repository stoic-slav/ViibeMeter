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
  subBassEnergy: number | null;       // 0–1: fraction of energy in 20–80 Hz (kick/bass)
  spectralCentroid: number | null;    // Hz: frequency center of mass (brightness)
  spectralFlux: number | null;        // 0–1: frame-to-frame energy change (dynamics)
  crestFactor: number | null;         // dB: peak/RMS ratio (transient punchiness)
  vocalPresence: number | null;       // 0–1: fraction of energy in 300–3 kHz
  harmonicNoiseRatio: number | null;  // 0–1: tonal vs noisy content

  // Motion
  accelMagnitudeAvg: number | null;
  accelMagnitudeMax: number | null;
  accelVariance: number | null;
  gyroActivityAvg: number | null;
  gyroActivityMax: number | null;
  movementClassification: MovementClassification | null;
  movementEnergy: number | null;      // RMS of gravity-removed acceleration (m/s²)
  movementBpm: number | null;         // dominant movement tempo
  rhythmicity: number | null;         // 0–1: how periodic the movement is
  movementAxis: MovementAxis | null;  // which component the rhythm came from

  // Beat sync (person ↔ music) — collect-only, not in composite score
  beatPlv: number | null;             // 0–1 phase-locking of movement peaks to the beat
  beatPhaseMean: number | null;       // radians: where in the heard beat movement lands
  beatPhaseClock: number | null;      // radians: movement phase vs wall clock at the song tempo (crowd sync)
  tempoMatch: number | null;          // 0–1 graded movement-vs-music tempo agreement
  pulseClarity: number | null;        // 0–1 audio beat clarity (onset-interval agreement)

  // Recognized track (collect-only). No title/artist is stored, only these descriptors.
  songIsrc: string | null;            // ISRC of the track playing (same song across devices)
  songGenre: string | null;
  songBpm: number | null;             // song tempo: Deezer's, or learned from the song's clips
  songBpmSource: 'deezer' | 'learned' | null;
  songPopularity: number | null;      // Deezer rank (higher = more popular)
  recognitionSource: RecognitionSource | null;
  // When this playback of the track began (ms, wall clock), from ShazamKit's match offset.
  // Phones hearing the same speakers get the same value: the basis for automatic grouping.
  songStartMs: number | null;
  songStartSpreadMs: number | null;   // max − min of this window's estimates (accuracy check)

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

export type MovementAxis = 'vertical' | 'horizontal';

export type PhonePlacement = 'pocket' | 'hand' | 'bag';

export type CrowdTrend = 'filling' | 'stable' | 'thinning' | 'unknown';

export type RecognitionSource = 'shazam' | 'audd';

export type AudioEvent = 'crowd_clapping' | 'cheering' | 'dj_drop';

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
  eventCode: string | null;              // shared code so co-located testers can be grouped
  phonePlacement: PhonePlacement | null;
  danceAffinity: number | null;          // 1–5 self-reported enjoyment of dancing
}

export interface SubjectiveRating {
  id: string;
  sessionId: string;
  deviceId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  musicRating: 1 | 2 | 3 | 4 | 5 | null;
  crowdRating: 1 | 2 | 3 | 4 | 5 | null;
  ratedAt: Date;
  nearestWindowId: string | null;
  responseTimeMs: number;
}

// Raw sensor sample types (on-device only, never uploaded)
export interface AudioSample {
  timestamp: number;
  rmsAmplitude: number;
  dbLevel: number;
  frequencyBands: number[]; // FFT magnitude bins
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

export interface AudioMetrics {
  avgDb: number;
  maxDb: number;
  dbVariance: number;
  musicDetected: boolean;
  estimatedBpm: number | null;
  recognizedBpm: number | null;
  bpmConfidence: number;
  pulseClarity: number | null;      // PCM onset-autocorrelation clarity (null without PCM)
  audioClassification: AudioClassification;
  bassPresence: number;
  midHighRatio: number;
  subBassEnergy: number;        // 0–1: 20–80 Hz kick/bass fraction
  spectralCentroid: number;     // Hz: brightness
  spectralFlux: number;         // 0–1: mix dynamics
  crestFactor: number;          // dB: transient punchiness
  vocalPresence: number;        // 0–1: vocal/speech band
  harmonicNoiseRatio: number;   // 0–1: tonal vs noise
  beatBpm: number | null;               // tempo from this recording's onsets (null if unclear)
  beatOnsetTimesMs: number[];           // absolute onset times (Date.now() clock) for beat sync
  clapCount: number;
  recognizedSong: string | null;
  recognizedGenre: string | null;
  recognizedIsrc: string | null;
  trackPopularity: number | null;
  recognitionSource: RecognitionSource | null;
  songMatch: { isrc: string; trackStartMs: number; rawStartMs: number } | null; // fresh ShazamKit match this cycle
  songBpmSource: 'deezer' | 'learned' | null;
  audioEvent: AudioEvent | null;
}

export interface MotionMetrics {
  accelMagnitudeAvg: number;
  accelMagnitudeMax: number;
  accelVariance: number;
  gyroActivityAvg: number;
  gyroActivityMax: number;
  movementClassification: MovementClassification;
  stepCadence: number | null;    // steps per minute
  movementBpm: number | null;    // dominant rhythmic frequency (30–240 BPM) from accel FFT
  rhythmicity: number;           // 0–1: autocorrelation peak — how periodic the movement is
  movementEnergy: number | null; // RMS of gravity-removed acceleration (m/s²)
  movementAxis: MovementAxis | null;
  movementSeries: { t: number; v: number }[]; // on-device only, used for beat sync, never stored
}

export interface VibeScoreBreakdown {
  energyScore: number;
  musicScore: number;
  movementScore: number;
  densityScore: number;
  engagementScore: number;
  compositeVibeScore: number;
  confidence: number;
}

export interface SensorReading {
  t: number; // ms timestamp
  v: number;
}

export type TrendDir = 'up' | 'down' | 'flat';

export interface LiveDashboardData {
  dbReadings: SensorReading[];
  magReadings: SensorReading[];
  gyroReadings: SensorReading[];
  bleReadings: SensorReading[];
  bpmReadings: SensorReading[];
  stepReadings: SensorReading[];
  movementBpmReadings: SensorReading[];
  audioClass: string | null;
  movementClass: string | null;
  bleCount: number | null;
  bleTrend: CrowdTrend | null;
  stepCadence: number | null;
  clapCount: number;
  audioEvent: AudioEvent | null;
  recognizedSong: string | null;
  audioBpm: number | null;
  movementBpm: number | null;
  rhythmicity: number;
  beatPlv: number | null;
  tempoMatch: number;
  recognizedGenre: string | null;
  trend15m: TrendDir;
  // FFT-derived music features
  subBassEnergy: number;
  spectralCentroid: number;
  spectralFlux: number;
  crestFactor: number;
  vocalPresence: number;
  harmonicNoiseRatio: number;
}
