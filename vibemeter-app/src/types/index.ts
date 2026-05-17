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
  estimatedBpm: number | null;      // metering-based heuristic (low accuracy)
  recognizedBpm: number | null;     // exact BPM from Apple Music metadata
  bpmConfidence: number;
  audioClassification: AudioClassification;
  bassPresence: number;
  midHighRatio: number;
  clapCount: number;
  recognizedSong: string | null;    // "Artist – Title" or null
  recognizedGenre: string | null;   // genre from AudD/Spotify metadata, e.g. "Tech House"
  audioEvent: AudioEvent | null;    // crowd moment label
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
  rhythmicity: number;           // 0–1: ratio of peak power to total — how periodic the movement is
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
  phaseCoherence: number;   // 0–1: how well movement rhythm matches audio BPM
  recognizedGenre: string | null;
  trend15m: TrendDir;
}
