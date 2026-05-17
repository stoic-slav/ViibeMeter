import { MovementClassification } from '../types';
import { SENSOR_CONFIG } from '../config/constants';

/**
 * Classify movement state from accelerometer magnitude, variance, and gyro activity.
 * Gyro (angular velocity) detects waving/rotating even when linear acceleration is low.
 */
export function classifyMovement(
  magnitudeAvg: number,
  magnitudeVariance: number,
  gyroAvg: number = 0,
): MovementClassification {
  // Combine accel and gyro into a single activity signal
  // Gyro in rad/s: gentle wave ≈ 1-2, vigorous ≈ 3-5+
  const gyroBoost = gyroAvg * 0.3; // weight gyro contribution
  const effectiveMag = magnitudeAvg + gyroBoost;

  if (effectiveMag < SENSOR_CONFIG.MOTION_STATIONARY_THRESHOLD && magnitudeVariance < 0.05) {
    return 'stationary';
  }

  if (effectiveMag >= SENSOR_CONFIG.MOTION_JUMPING_THRESHOLD) {
    return 'jumping';
  }

  if (effectiveMag >= SENSOR_CONFIG.MOTION_DANCING_THRESHOLD || magnitudeVariance > 1.5) {
    return 'dancing';
  }

  if (effectiveMag >= SENSOR_CONFIG.MOTION_SWAYING_THRESHOLD || magnitudeVariance > 0.5) {
    return 'swaying';
  }

  if (effectiveMag >= SENSOR_CONFIG.MOTION_WALKING_THRESHOLD) {
    return 'walking';
  }

  if (effectiveMag >= SENSOR_CONFIG.MOTION_STATIONARY_THRESHOLD) {
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
