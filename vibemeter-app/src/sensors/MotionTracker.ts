import { Accelerometer, Gyroscope, Pedometer } from 'expo-sensors';
import { MotionMetrics, MotionSample } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import {
  computeAccelMagnitude,
  computeVariance,
  computeGyroMagnitude,
  classifyMovement,
} from '../processing/MovementClassifier';

const LOG_TAG = '[MotionTracker]';

export class MotionTracker {
  private isStationary = false;
  private stationaryStartTime = 0;
  private pedometerAvailable: boolean | null = null;

  async sample(): Promise<MotionMetrics | null> {
    try {
      Accelerometer.setUpdateInterval(1000 / SENSOR_CONFIG.MOTION_SAMPLE_RATE_HZ);
      Gyroscope.setUpdateInterval(1000 / SENSOR_CONFIG.MOTION_SAMPLE_RATE_HZ);

      const accelSamples: MotionSample[] = [];
      const gyroData: { x: number; y: number; z: number }[] = [];

      const accelSub = Accelerometer.addListener(data => {
        accelSamples.push({ timestamp: Date.now(), accelX: data.x, accelY: data.y, accelZ: data.z, gyroX: 0, gyroY: 0, gyroZ: 0 });
      });
      const gyroSub = Gyroscope.addListener(data => {
        gyroData.push({ x: data.x, y: data.y, z: data.z });
      });

      const cadenceResult = await Promise.allSettled([
        this.sampleCadence(),
        new Promise(r => setTimeout(r, SENSOR_CONFIG.MOTION_SAMPLE_DURATION_MS)),
      ]);

      accelSub.remove();
      gyroSub.remove();

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
      const { movementBpm, rhythmicity } = computeMovementRhythm(magnitudes, SENSOR_CONFIG.MOTION_SAMPLE_RATE_HZ);

      if (movementClassification === 'stationary') {
        if (!this.isStationary) { this.isStationary = true; this.stationaryStartTime = Date.now(); }
      } else {
        this.isStationary = false; this.stationaryStartTime = 0;
      }

      const stepCadence = cadenceResult[0].status === 'fulfilled' ? cadenceResult[0].value : null;

      return {
        accelMagnitudeAvg, accelMagnitudeMax, accelVariance,
        gyroActivityAvg, gyroActivityMax, movementClassification,
        stepCadence, movementBpm, rhythmicity,
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

function computeMovementRhythm(
  magnitudes: number[],
  sampleRateHz: number,
): { movementBpm: number | null; rhythmicity: number } {
  if (magnitudes.length < 20) return { movementBpm: null, rhythmicity: 0 };

  const mean = magnitudes.reduce((s, v) => s + v, 0) / magnitudes.length;
  const centered = magnitudes.map(v => v - mean);
  const r0 = centered.reduce((s, v) => s + v * v, 0);
  if (r0 < 0.001) return { movementBpm: null, rhythmicity: 0 };

  const minLag = Math.max(2, Math.round((sampleRateHz * 60) / 240));
  const maxLag = Math.min(magnitudes.length - 2, Math.round((sampleRateHz * 60) / 30));

  let bestLag = minLag;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const n = magnitudes.length - lag;
    for (let i = 0; i < n; i++) {
      corr += centered[i] * centered[i + lag];
    }
    corr /= n;
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  const rhythmicity = Math.max(0, Math.min(1, bestCorr / (r0 / magnitudes.length)));
  if (rhythmicity < 0.25) return { movementBpm: null, rhythmicity };

  return { movementBpm: Math.round((sampleRateHz * 60) / bestLag), rhythmicity };
}
