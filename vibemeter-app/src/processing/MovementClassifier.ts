import { MovementClassification } from '../types';
import { SENSOR_CONFIG } from '../config/constants';

/**
 * Classify movement state from accelerometer magnitude and variance.
 */
export function classifyMovement(
  magnitudeAvg: number,
  magnitudeVariance: number,
): MovementClassification {
  // High variance = erratic movement (dancing/jumping)
  // Low variance + low magnitude = stationary
  // Combine both to distinguish states

  if (magnitudeAvg < SENSOR_CONFIG.MOTION_STATIONARY_THRESHOLD && magnitudeVariance < 0.05) {
    return 'stationary';
  }

  if (magnitudeAvg >= SENSOR_CONFIG.MOTION_JUMPING_THRESHOLD) {
    return 'jumping';
  }

  if (magnitudeAvg >= SENSOR_CONFIG.MOTION_DANCING_THRESHOLD || magnitudeVariance > 1.5) {
    return 'dancing';
  }

  if (magnitudeAvg >= SENSOR_CONFIG.MOTION_SWAYING_THRESHOLD || magnitudeVariance > 0.5) {
    return 'swaying';
  }

  if (magnitudeAvg >= SENSOR_CONFIG.MOTION_WALKING_THRESHOLD) {
    return 'walking';
  }

  return 'stationary';
}

/**
 * Compute vector magnitude from x, y, z components.
 * Subtracts 1g (9.81 m/s²) to remove gravity — returns net dynamic acceleration.
 */
export function computeAccelMagnitude(x: number, y: number, z: number): number {
  const raw = Math.sqrt(x * x + y * y + z * z);
  // Subtract gravity (1g ≈ 9.81 m/s², but expo-sensors returns in g-units)
  return Math.abs(raw - 1.0);
}

/**
 * Compute variance of an array of numbers.
 */
export function computeVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sumSq = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  return sumSq / values.length;
}

/**
 * Compute gyroscope activity (magnitude of rotation rate vector).
 */
export function computeGyroMagnitude(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}
