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
  bpmConfidence: number;
  audioClassification: AudioClassification;
  bassPresence: number;
  midHighRatio: number;
}

export interface MotionMetrics {
  accelMagnitudeAvg: number;
  accelMagnitudeMax: number;
  accelVariance: number;
  gyroActivityAvg: number;
  gyroActivityMax: number;
  movementClassification: MovementClassification;
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
