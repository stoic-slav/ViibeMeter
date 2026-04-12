import { Accelerometer, Gyroscope } from 'expo-sensors';
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
  private accelSubscription: ReturnType<typeof Accelerometer.addListener> | null = null;
  private gyroSubscription: ReturnType<typeof Gyroscope.addListener> | null = null;
  private stationaryTimer: ReturnType<typeof setTimeout> | null = null;
  private isStationary = false;
  private stationaryStartTime = 0;

  /**
   * Sample accelerometer and gyroscope for MOTION_SAMPLE_DURATION_MS.
   * Returns aggregated metrics.
   */
  async sample(): Promise<MotionMetrics | null> {
    try {
      Accelerometer.setUpdateInterval(1000 / SENSOR_CONFIG.MOTION_SAMPLE_RATE_HZ);
      Gyroscope.setUpdateInterval(1000 / SENSOR_CONFIG.MOTION_SAMPLE_RATE_HZ);

      const accelSamples: MotionSample[] = [];
      const gyroData: { x: number; y: number; z: number }[] = [];

      const accelSub = Accelerometer.addListener(data => {
        accelSamples.push({
          timestamp: Date.now(),
          accelX: data.x,
          accelY: data.y,
          accelZ: data.z,
          gyroX: 0, gyroY: 0, gyroZ: 0, // filled separately
        });
      });

      const gyroSub = Gyroscope.addListener(data => {
        gyroData.push({ x: data.x, y: data.y, z: data.z });
      });

      await new Promise(r => setTimeout(r, SENSOR_CONFIG.MOTION_SAMPLE_DURATION_MS));

      accelSub.remove();
      gyroSub.remove();

      if (accelSamples.length === 0) {
        console.warn(`${LOG_TAG} No accelerometer data collected`);
        return null;
      }

      // Compute magnitudes (net dynamic acceleration, gravity removed)
      const magnitudes = accelSamples.map(s =>
        computeAccelMagnitude(s.accelX, s.accelY, s.accelZ)
      );
      const accelMagnitudeAvg = magnitudes.reduce((s, v) => s + v, 0) / magnitudes.length;
      const accelMagnitudeMax = Math.max(...magnitudes);
      const accelVariance = computeVariance(magnitudes);

      // Gyro magnitudes
      const gyroMagnitudes = gyroData.map(g => computeGyroMagnitude(g.x, g.y, g.z));
      const gyroActivityAvg = gyroMagnitudes.length > 0
        ? gyroMagnitudes.reduce((s, v) => s + v, 0) / gyroMagnitudes.length
        : 0;
      const gyroActivityMax = gyroMagnitudes.length > 0 ? Math.max(...gyroMagnitudes) : 0;

      const movementClassification = classifyMovement(accelMagnitudeAvg, accelVariance);

      // Track stationary state for battery optimization
      if (movementClassification === 'stationary') {
        if (!this.isStationary) {
          this.isStationary = true;
          this.stationaryStartTime = Date.now();
        }
      } else {
        this.isStationary = false;
        this.stationaryStartTime = 0;
      }

      return {
        accelMagnitudeAvg,
        accelMagnitudeMax,
        accelVariance,
        gyroActivityAvg,
        gyroActivityMax,
        movementClassification,
      };
    } catch (err) {
      console.error(`${LOG_TAG} Error sampling motion:`, err);
      return null;
    }
  }

  /**
   * Returns true if device has been stationary for longer than STATIONARY_TIMEOUT_MS.
   * Used by orchestrator to reduce motion sampling frequency.
   */
  isLongTermStationary(): boolean {
    if (!this.isStationary) return false;
    return Date.now() - this.stationaryStartTime > SENSOR_CONFIG.STATIONARY_TIMEOUT_MS;
  }

  resetStationaryState(): void {
    this.isStationary = false;
    this.stationaryStartTime = 0;
  }
}
