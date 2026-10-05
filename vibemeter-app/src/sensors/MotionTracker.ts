import { Platform } from 'react-native';
import { Accelerometer, DeviceMotion, Gyroscope, Pedometer } from 'expo-sensors';
import { isSessionServiceRunning, readNativeMotion } from '../../modules/session-service';
import { MotionMetrics, MotionSample, MovementAxis } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import {
  computeAccelMagnitude,
  computeVariance,
  computeGyroMagnitude,
  classifyMovement,
  classifyPhoneContext,
} from '../processing/MovementClassifier';

const LOG_TAG = '[MotionTracker]';
const G = 9.80665; // m/s² per g

type Vec3 = { x: number; y: number; z: number };
const MAX_MOVEMENT_BPM = 180;
// Below 60 a "rhythm" is slow, irregular sway (device test 4 read 41–57 BPM while swaying).
// 60 still covers moving on every other beat of a 120+ BPM song.
const MIN_MOVEMENT_BPM = 60;
const MOVEMENT_HALF_PERIOD_RATIO = 0.85;

export class MotionTracker {
  private isStationary = false;
  private stationaryStartTime = 0;
  private pedometerAvailable: boolean | null = null;

  private deviceMotionAvailable: boolean | null = null;

  /**
   * Sample motion for MOTION_SAMPLE_DURATION_MS.
   * Uses DeviceMotion (gravity removed, as in Ellamil et al. 2016) when available and splits
   * linear acceleration into vertical (along gravity) and horizontal components, which is
   * independent of how the phone sits in a pocket. Falls back to the raw accelerometer.
   */
  async sample(): Promise<MotionMetrics | null> {
    try {
      if (this.deviceMotionAvailable === null) {
        this.deviceMotionAvailable = await DeviceMotion.isAvailableAsync().catch(() => false);
      }
      const intervalMs = 1000 / SENSOR_CONFIG.MOTION_SAMPLE_RATE_HZ;
      Gyroscope.setUpdateInterval(intervalMs);

      const accelSamples: MotionSample[] = [];
      const gyroData: { x: number; y: number; z: number }[] = [];
      const vertical: { t: number; v: number }[] = [];
      const horizontal: { t: number; v: number }[] = [];
      const linearMag: number[] = [];

      // One DeviceMotion-style reading: g includes gravity, a is linear acceleration (m/s²)
      const addMotion = (t: number, g: Vec3, a: Vec3 | null) => {
        // Legacy fields stay in g-units so existing thresholds keep working
        accelSamples.push({ timestamp: t, accelX: g.x / G, accelY: g.y / G, accelZ: g.z / G, gyroX: 0, gyroY: 0, gyroZ: 0 });
        if (!a) return;
        const gx = g.x - a.x, gy = g.y - a.y, gz = g.z - a.z;
        const gn = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (gn < 1e-3) return;
        const vert = (a.x * gx + a.y * gy + a.z * gz) / gn;
        const total = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
        vertical.push({ t, v: vert });
        horizontal.push({ t, v: Math.sqrt(Math.max(0, total * total - vert * vert)) });
        linearMag.push(total);
      };

      let cadenceResult: PromiseSettledResult<unknown>[];
      if (Platform.OS === 'android' && isSessionServiceRunning()) {
        // Android: expo-sensors stops in the background, so the session service records motion
        // natively; wait out the sample and read the same span back.
        cadenceResult = await Promise.allSettled([
          Promise.resolve(null),
          new Promise(r => setTimeout(r, SENSOR_CONFIG.MOTION_SAMPLE_DURATION_MS)),
        ]);
        const native = readNativeMotion(SENSOR_CONFIG.MOTION_SAMPLE_DURATION_MS / 1000);
        if (native) {
          const L = native.linear;
          if (L.length >= 7) {
            for (let i = 0; i + 6 < L.length; i += 7) {
              const a = { x: L[i + 1], y: L[i + 2], z: L[i + 3] };
              addMotion(L[i], { x: a.x + L[i + 4], y: a.y + L[i + 5], z: a.z + L[i + 6] }, a);
            }
          } else {
            const A = native.accel;
            for (let i = 0; i + 3 < A.length; i += 4) addMotion(A[i], { x: A[i + 1], y: A[i + 2], z: A[i + 3] }, null);
          }
          const W = native.gyro;
          for (let i = 0; i + 3 < W.length; i += 4) gyroData.push({ x: W[i + 1], y: W[i + 2], z: W[i + 3] });
        }
      } else {
        let accelSub: { remove: () => void };
        if (this.deviceMotionAvailable) {
          DeviceMotion.setUpdateInterval(intervalMs);
          accelSub = DeviceMotion.addListener(m => {
            const g = m.accelerationIncludingGravity;
            if (g) addMotion(Date.now(), g, m.acceleration ?? null);
          });
        } else {
          Accelerometer.setUpdateInterval(intervalMs);
          accelSub = Accelerometer.addListener(data => {
            accelSamples.push({ timestamp: Date.now(), accelX: data.x, accelY: data.y, accelZ: data.z, gyroX: 0, gyroY: 0, gyroZ: 0 });
          });
        }
        const gyroSub = Gyroscope.addListener(data => {
          gyroData.push({ x: data.x, y: data.y, z: data.z });
        });

        cadenceResult = await Promise.allSettled([
          this.sampleCadence(),
          new Promise(r => setTimeout(r, SENSOR_CONFIG.MOTION_SAMPLE_DURATION_MS)),
        ]);

        accelSub.remove();
        gyroSub.remove();
      }

      if (accelSamples.length === 0) {
        console.warn(`${LOG_TAG} No accelerometer data collected`);
        return null;
      }

      const magnitudes = accelSamples.map(s => computeAccelMagnitude(s.accelX, s.accelY, s.accelZ));
      const accelMagnitudeAvg = magnitudes.reduce((s, v) => s + v, 0) / magnitudes.length;
      const accelMagnitudeMax = Math.max(...magnitudes);
      const accelVariance = computeVariance(magnitudes);

      const gyroMagnitudes = gyroData.map(g => computeGyroMagnitude(g.x, g.y, g.z));
      const gyroActivityAvg = gyroMagnitudes.length > 0
        ? gyroMagnitudes.reduce((s, v) => s + v, 0) / gyroMagnitudes.length : 0;
      const gyroActivityMax = gyroMagnitudes.length > 0 ? Math.max(...gyroMagnitudes) : 0;

      const movementClassification = classifyMovement(accelMagnitudeAvg, accelVariance, gyroActivityAvg);

      // Rhythm: take whichever gravity-free component is more periodic.
      // Fallback (no DeviceMotion): magnitude series, as before.
      let movementBpm: number | null;
      let rhythmicity: number;
      let movementAxis: MovementAxis | null = null;
      let movementSeries: { t: number; v: number }[];
      let movementEnergy: number | null = null;
      if (vertical.length >= 20) {
        const rv = computeMovementRhythm(vertical.map(p => p.v), SENSOR_CONFIG.MOTION_SAMPLE_RATE_HZ);
        const rh = computeMovementRhythm(horizontal.map(p => p.v), SENSOR_CONFIG.MOTION_SAMPLE_RATE_HZ);
        const useVertical = rv.rhythmicity >= rh.rhythmicity;
        ({ movementBpm, rhythmicity } = useVertical ? rv : rh);
        movementAxis = useVertical ? 'vertical' : 'horizontal';
        movementSeries = useVertical ? vertical : horizontal;
        movementEnergy = Math.sqrt(linearMag.reduce((s, v) => s + v * v, 0) / linearMag.length);
      } else {
        ({ movementBpm, rhythmicity } = computeMovementRhythm(magnitudes, SENSOR_CONFIG.MOTION_SAMPLE_RATE_HZ));
        movementSeries = accelSamples.map((s, i) => ({ t: s.timestamp, v: magnitudes[i] }));
        movementEnergy = Math.sqrt(magnitudes.reduce((s, v) => s + v * v, 0) / magnitudes.length) * G;
      }

      if (movementClassification === 'stationary') {
        if (!this.isStationary) { this.isStationary = true; this.stationaryStartTime = Date.now(); }
      } else {
        this.isStationary = false; this.stationaryStartTime = 0;
      }

      const phoneContext = classifyPhoneContext(
        accelSamples.map(a => ({ x: a.accelX, y: a.accelY, z: a.accelZ })), gyroActivityAvg,
        movementEnergy,
      );

      const stepCadence = cadenceResult[0].status === 'fulfilled' ? (cadenceResult[0].value as number | null) : null;

      return {
        accelMagnitudeAvg, accelMagnitudeMax, accelVariance,
        gyroActivityAvg, gyroActivityMax, movementClassification,
        stepCadence, movementBpm, rhythmicity,
        movementEnergy, movementAxis, movementSeries, phoneContext,
      };
    } catch (err) {
      console.warn(`${LOG_TAG} Error sampling motion:`, err);
      return null;
    }
  }

  private async sampleCadence(): Promise<number | null> {
    try {
      if (this.pedometerAvailable === null) {
        this.pedometerAvailable = await Pedometer.isAvailableAsync();
      }
      if (!this.pedometerAvailable) return null;
      const end = new Date();
      const start = new Date(end.getTime() - 30000);
      const result = await Pedometer.getStepCountAsync(start, end);
      return Math.round((result.steps / 30) * 60);
    } catch (err) {
      return null;
    }
  }

  isLongTermStationary(): boolean {
    if (!this.isStationary) return false;
    return Date.now() - this.stationaryStartTime > SENSOR_CONFIG.STATIONARY_TIMEOUT_MS;
  }

  resetStationaryState(): void {
    this.isStationary = false;
    this.stationaryStartTime = 0;
  }
}

export function computeMovementRhythm(
  magnitudes: number[],
  sampleRateHz: number,
): { movementBpm: number | null; rhythmicity: number } {
  if (magnitudes.length < 20) return { movementBpm: null, rhythmicity: 0 };

  const mean = magnitudes.reduce((s, v) => s + v, 0) / magnitudes.length;
  const centered = magnitudes.map(v => v - mean);
  const r0 = centered.reduce((s, v) => s + v * v, 0);
  if (r0 < 0.001) return { movementBpm: null, rhythmicity: 0 };

  // Body movement above ~180 per minute is jitter or a footstep harmonic, not a dance tempo
  const minLag = Math.max(2, Math.round((sampleRateHz * 60) / MAX_MOVEMENT_BPM));
  const maxLag = Math.min(magnitudes.length - 2, Math.round((sampleRateHz * 60) / MIN_MOVEMENT_BPM));

  const acf: number[] = [];
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let corr = 0;
    const n = magnitudes.length - lag;
    for (let i = 0; i < n; i++) {
      corr += centered[i] * centered[i + lag];
    }
    acf[lag] = n > 0 ? corr / n : 0;
  }
  // Only real peaks count: for slow, smooth sway the autocorrelation simply decays, and its
  // largest value would sit at the shortest lag (a spurious ~180 BPM)
  let bestLag = -1;
  let bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1] && acf[lag] > bestCorr) {
      bestCorr = acf[lag];
      bestLag = lag;
    }
  }
  if (bestLag < 0) return { movementBpm: null, rhythmicity: 0 };
  // A regular movement correlates as well at two cycles as at one: prefer the shorter period
  // when its peak is nearly as strong (otherwise a 120 bounce reads as 60)
  const half = Math.round(bestLag / 2);
  for (const lag of [half - 1, half, half + 1]) {
    if (lag >= minLag && acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1]
        && acf[lag] >= MOVEMENT_HALF_PERIOD_RATIO * bestCorr) {
      bestLag = lag;
      bestCorr = acf[lag];
      break;
    }
  }

  const rhythmicity = Math.max(0, Math.min(1, bestCorr / (r0 / magnitudes.length)));
  if (rhythmicity < SENSOR_CONFIG.MOVEMENT_MIN_RHYTHMICITY) return { movementBpm: null, rhythmicity };

  return { movementBpm: Math.round((sampleRateHz * 60) / bestLag), rhythmicity };
}
