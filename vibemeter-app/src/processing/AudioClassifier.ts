import { AudioClassification } from '../types';
import { SENSOR_CONFIG } from '../config/constants';

/**
 * Classify audio state from dB level + music detection flag.
 */
export function classifyAudio(
  avgDb: number,
  musicDetected: boolean,
): AudioClassification {
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_SILENT) return 'silent';

  if (!musicDetected) {
    return avgDb < SENSOR_CONFIG.AUDIO_DB_TALKING ? 'silent' : 'talking';
  }

  // Music detected — classify by loudness
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_LOW_MUSIC) return 'low_music';
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_HIGH_MUSIC) return 'high_music';
  return 'loud_music';
}

/**
 * Determine whether music is likely playing from spectral features.
 * Music has: bass energy, rhythmic content (BPM), tonal structure (low spectral flatness).
 */
export function detectMusic(
  bassPresence: number,
  bpmConfidence: number,
  spectralFlatnessValue: number,
): boolean {
  return (
    bassPresence > SENSOR_CONFIG.MUSIC_BASS_PRESENCE_MIN &&
    bpmConfidence > SENSOR_CONFIG.MUSIC_BPM_CONFIDENCE_MIN &&
    spectralFlatnessValue < SENSOR_CONFIG.MUSIC_SPECTRAL_FLATNESS_MAX
  );
}

/**
 * Compute RMS amplitude from a buffer of PCM samples.
 */
export function computeRMS(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sumSq = samples.reduce((s, x) => s + x * x, 0);
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Convert RMS amplitude (0–1 normalized) to dB SPL approximation.
 * Reference: 0 dB = full scale.
 */
export function rmsToDb(rms: number): number {
  if (rms <= 0) return -100;
  return 20 * Math.log10(Math.max(rms, 1e-10));
}

/**
 * Convert a dB value relative to full scale to an approximate ambient SPL.
 * Assumes typical phone mic sensitivity with ~94 dB offset.
 */
export function dbFullScaleToAmbient(dbFS: number): number {
  // Add approximate mic sensitivity offset to get ambient dB SPL
  return dbFS + 94;
}
