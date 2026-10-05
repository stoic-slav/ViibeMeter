import { MovementClassification, PhoneContext } from '../types';
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

/**
 * Where the phone is, from one cycle of motion (collect-only; also gates give-to-get credit and
 * the live view). A phone lying on a table or in a bag on the floor keeps its gravity direction
 * fixed and barely moves; one on a body keeps tilting slightly (breathing, weight shifts) even
 * when its owner stands still. Thresholds are first guesses, to be checked on a device: phone
 * on a table, in a pocket standing still, dancing.
 *
 * gravity: per-sample acceleration including gravity, in g. linearRms: gravity-free RMS (m/s²).
 */
export function classifyPhoneContext(
  gravity: { x: number; y: number; z: number }[],
  gyroAvg: number,
  linearRms: number | null,
): PhoneContext {
  if (gravity.length < PHONE_CONTEXT_MIN_SAMPLES) return 'uncertain';
  // Spread of the gravity direction: 0 when the phone's tilt never changes
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (const g of gravity) {
    const m = Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z);
    if (m < 0.5) continue;
    sx += g.x / m; sy += g.y / m; sz += g.z / m; n++;
  }
  if (n < PHONE_CONTEXT_MIN_SAMPLES) return 'uncertain';
  const tiltSpread = 1 - Math.sqrt(sx * sx + sy * sy + sz * sz) / n;
  const energy = linearRms ?? 0;

  if (energy >= ON_BODY_MOVING_RMS) return 'on_body_moving';
  if (tiltSpread < OFF_BODY_TILT_SPREAD && gyroAvg < OFF_BODY_GYRO && energy < OFF_BODY_RMS) return 'off_body';
  return 'on_body_still';
}

const PHONE_CONTEXT_MIN_SAMPLES = 50;   // 1 s at 50 Hz
const ON_BODY_MOVING_RMS = 0.5;         // m/s², gravity-free: clearly moving (walking, dancing)
const OFF_BODY_TILT_SPREAD = 2e-5;      // ≈ 0.4° of tilt wobble
const OFF_BODY_GYRO = 0.02;             // rad/s
const OFF_BODY_RMS = 0.05;              // m/s²
