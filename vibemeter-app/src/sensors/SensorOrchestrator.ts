import { v4 as uuidv4 } from 'uuid';
import { SensorWindow, Session, VibeScoreBreakdown } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import { AudioAnalyzer } from './AudioAnalyzer';
import { MotionTracker } from './MotionTracker';
import { BLEScanner } from './BLEScanner';
import { LocationTracker } from './LocationTracker';
import { computeVibeScore } from '../processing/VibeScoreEngine';
import { saveSensorWindow, deleteOldSyncedWindows } from '../storage/LocalBuffer';
import { syncAll } from '../storage/SupabaseSync';

const LOG_TAG = '[SensorOrchestrator]';

type VibeUpdateCallback = (window: SensorWindow, breakdown: VibeScoreBreakdown) => void;

export class SensorOrchestrator {
  private static instance: SensorOrchestrator | null = null;

  private audioAnalyzer = new AudioAnalyzer();
  private motionTracker = new MotionTracker();
  private bleScanner = new BLEScanner();
  private locationTracker = new LocationTracker();

  private currentSession: Session | null = null;
  private currentWindow: Partial<SensorWindow> = {};
  private windowStartTime: Date | null = null;

  private audioTimer: ReturnType<typeof setTimeout> | null = null;
  private motionTimer: ReturnType<typeof setTimeout> | null = null;
  private bleTimer: ReturnType<typeof setTimeout> | null = null;
  private locationTimer: ReturnType<typeof setTimeout> | null = null;
  private windowTimer: ReturnType<typeof setInterval> | null = null;
  private uploadTimer: ReturnType<typeof setInterval> | null = null;

  private onVibeUpdate: VibeUpdateCallback | null = null;

  public isRunning = false;
  private lastVibeScore: number = 0;
  private lastBreakdown: VibeScoreBreakdown | null = null;

  static getInstance(): SensorOrchestrator {
    if (!SensorOrchestrator.instance) {
      SensorOrchestrator.instance = new SensorOrchestrator();
    }
    return SensorOrchestrator.instance;
  }

  setVibeUpdateCallback(cb: VibeUpdateCallback): void {
    this.onVibeUpdate = cb;
  }

  async startSession(session: Session): Promise<void> {
    if (this.isRunning) await this.stopSession();

    this.currentSession = session;
    this.isRunning = true;
    this.bleScanner.resetHistory();
    this.motionTracker.resetStationaryState();

    console.log(`${LOG_TAG} Starting sensors for session ${session.id}`);

    // Initialize location tracking
    await this.locationTracker.requestPermissions();

    // Start a new window
    this.startNewWindow();

    // Schedule sensors with staggered starts to avoid simultaneous CPU spikes
    // Audio: most expensive, starts after 2s
    this.audioTimer = setTimeout(() => this.scheduleAudio(), 2000);

    // Motion: starts after 5s
    this.motionTimer = setTimeout(() => this.scheduleMotion(), 5000);

    // BLE: starts after 8s
    this.bleTimer = setTimeout(() => this.scheduleBLE(), 8000);

    // Location: starts after 10s
    this.locationTimer = setTimeout(() => this.scheduleLocation(), 10000);

    // Window finalization: every 60 seconds
    this.windowTimer = setInterval(() => this.finalizeWindow(), SENSOR_CONFIG.WINDOW_DURATION_MS);

    // Upload: every 5 minutes
    this.uploadTimer = setInterval(() => this.runUpload(), SENSOR_CONFIG.UPLOAD_BATCH_INTERVAL_MS);
  }

  async stopSession(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Clear all timers
    [this.audioTimer, this.motionTimer, this.bleTimer, this.locationTimer].forEach(t => {
      if (t) clearTimeout(t);
    });
    if (this.windowTimer) clearInterval(this.windowTimer);
    if (this.uploadTimer) clearInterval(this.uploadTimer);

    this.audioTimer = this.motionTimer = this.bleTimer = this.locationTimer = null;
    this.windowTimer = this.uploadTimer = null;

    // Finalize the last partial window
    await this.finalizeWindow();

    // Final sync
    await syncAll();

    // Cleanup
    this.bleScanner.destroy();
    this.currentSession = null;
    this.currentWindow = {};
    this.windowStartTime = null;

    console.log(`${LOG_TAG} Sensors stopped`);
  }

  /**
   * Run one collection cycle — called by background task.
   */
  async runCollectionCycle(): Promise<void> {
    if (!this.isRunning || !this.currentSession) return;
    console.log(`${LOG_TAG} Background collection cycle`);
    await Promise.allSettled([
      this.collectAudioSample(),
      this.collectMotionSample(),
      this.collectBLESample(),
      this.collectLocationSample(),
    ]);
  }

  get currentVibeScore(): number {
    return this.lastVibeScore;
  }

  get currentBreakdown(): VibeScoreBreakdown | null {
    return this.lastBreakdown;
  }

  // ── Private methods ──────────────────────────────────────────────────────────

  private startNewWindow(): void {
    this.windowStartTime = new Date();
    this.currentWindow = {
      id: uuidv4(),
      sessionId: this.currentSession!.id,
      windowStart: this.windowStartTime,
    };
  }

  private scheduleAudio(): void {
    if (!this.isRunning) return;
    this.collectAudioSample().then(() => {
      if (this.isRunning) {
        this.audioTimer = setTimeout(
          () => this.scheduleAudio(),
          SENSOR_CONFIG.AUDIO_SAMPLE_INTERVAL_MS
        );
      }
    });
  }

  private scheduleMotion(): void {
    if (!this.isRunning) return;
    if (this.motionTracker.isLongTermStationary()) {
      // Device is stationary — extend interval to save battery
      console.log(`${LOG_TAG} Device stationary, extending motion interval`);
      this.motionTimer = setTimeout(() => this.scheduleMotion(), SENSOR_CONFIG.MOTION_SAMPLE_INTERVAL_MS * 3);
      return;
    }
    this.collectMotionSample().then(() => {
      if (this.isRunning) {
        this.motionTimer = setTimeout(
          () => this.scheduleMotion(),
          SENSOR_CONFIG.MOTION_SAMPLE_INTERVAL_MS
        );
      }
    });
  }

  private scheduleBLE(): void {
    if (!this.isRunning) return;
    this.collectBLESample().then(() => {
      if (this.isRunning) {
        this.bleTimer = setTimeout(
          () => this.scheduleBLE(),
          SENSOR_CONFIG.BLE_SCAN_INTERVAL_MS
        );
      }
    });
  }

  private scheduleLocation(): void {
    if (!this.isRunning) return;
    this.collectLocationSample().then(() => {
      if (this.isRunning) {
        this.locationTimer = setTimeout(
          () => this.scheduleLocation(),
          SENSOR_CONFIG.GPS_CHECK_INTERVAL_MS
        );
      }
    });
  }

  private async collectAudioSample(): Promise<void> {
    try {
      const metrics = await this.audioAnalyzer.analyze();
      if (!metrics) return;

      // Update current window with audio data
      const dbValues = this.currentWindow.avgDb
        ? [(this.currentWindow.avgDb ?? 0), metrics.avgDb]
        : [metrics.avgDb];

      this.currentWindow.avgDb = dbValues.reduce((s, v) => s + v, 0) / dbValues.length;
      this.currentWindow.maxDb = Math.max(this.currentWindow.maxDb ?? 0, metrics.maxDb);
      this.currentWindow.dbVariance = metrics.dbVariance;
      this.currentWindow.musicDetected = metrics.musicDetected;
      this.currentWindow.estimatedBpm = metrics.estimatedBpm;
      this.currentWindow.audioClassification = metrics.audioClassification;
      this.currentWindow.bassPresence = metrics.bassPresence;
      this.currentWindow.midHighRatio = metrics.midHighRatio;

      console.log(`${LOG_TAG} Audio: ${metrics.avgDb.toFixed(1)}dB, music=${metrics.musicDetected}, bpm=${metrics.estimatedBpm}`);
    } catch (err) {
      console.error(`${LOG_TAG} Audio collection error:`, err);
    }
  }

  private async collectMotionSample(): Promise<void> {
    try {
      const metrics = await this.motionTracker.sample();
      if (!metrics) return;

      this.currentWindow.accelMagnitudeAvg = metrics.accelMagnitudeAvg;
      this.currentWindow.accelMagnitudeMax = metrics.accelMagnitudeMax;
      this.currentWindow.accelVariance = metrics.accelVariance;
      this.currentWindow.gyroActivityAvg = metrics.gyroActivityAvg;
      this.currentWindow.gyroActivityMax = metrics.gyroActivityMax;
      this.currentWindow.movementClassification = metrics.movementClassification;

      console.log(`${LOG_TAG} Motion: ${metrics.movementClassification}, mag=${metrics.accelMagnitudeAvg.toFixed(3)}`);
    } catch (err) {
      console.error(`${LOG_TAG} Motion collection error:`, err);
    }
  }

  private async collectBLESample(): Promise<void> {
    try {
      const metrics = await this.bleScanner.scan();
      if (!metrics) return;

      this.currentWindow.bleDeviceCount = metrics.bleDeviceCount;
      this.currentWindow.bleCountDelta = metrics.bleCountDelta;
      this.currentWindow.bleCountTrend = metrics.bleCountTrend;

      console.log(`${LOG_TAG} BLE: ${metrics.bleDeviceCount} devices, trend=${metrics.bleCountTrend}`);
    } catch (err) {
      console.error(`${LOG_TAG} BLE collection error:`, err);
    }
  }

  private async collectLocationSample(): Promise<void> {
    try {
      const metrics = await this.locationTracker.check();
      this.currentWindow.gpsIsAtVenue = metrics.gpsIsAtVenue;
      this.currentWindow.gpsAccuracyMeters = metrics.gpsAccuracyMeters;
    } catch (err) {
      console.error(`${LOG_TAG} Location collection error:`, err);
    }
  }

  private async finalizeWindow(): Promise<void> {
    if (!this.currentSession || !this.windowStartTime) return;
    if (!this.currentWindow.avgDb && !this.currentWindow.accelMagnitudeAvg && !this.currentWindow.bleDeviceCount) {
      // Empty window — skip saving
      this.startNewWindow();
      return;
    }

    const windowEnd = new Date();
    const breakdown = computeVibeScore(this.currentWindow);

    const window: SensorWindow = {
      id: this.currentWindow.id ?? uuidv4(),
      sessionId: this.currentSession.id,
      windowStart: this.windowStartTime,
      windowEnd,
      avgDb: this.currentWindow.avgDb ?? null,
      maxDb: this.currentWindow.maxDb ?? null,
      dbVariance: this.currentWindow.dbVariance ?? null,
      musicDetected: this.currentWindow.musicDetected ?? null,
      estimatedBpm: this.currentWindow.estimatedBpm ?? null,
      audioClassification: this.currentWindow.audioClassification ?? null,
      bassPresence: this.currentWindow.bassPresence ?? null,
      midHighRatio: this.currentWindow.midHighRatio ?? null,
      accelMagnitudeAvg: this.currentWindow.accelMagnitudeAvg ?? null,
      accelMagnitudeMax: this.currentWindow.accelMagnitudeMax ?? null,
      accelVariance: this.currentWindow.accelVariance ?? null,
      gyroActivityAvg: this.currentWindow.gyroActivityAvg ?? null,
      gyroActivityMax: this.currentWindow.gyroActivityMax ?? null,
      movementClassification: this.currentWindow.movementClassification ?? null,
      bleDeviceCount: this.currentWindow.bleDeviceCount ?? null,
      bleCountDelta: this.currentWindow.bleCountDelta ?? null,
      bleCountTrend: this.currentWindow.bleCountTrend ?? null,
      gpsIsAtVenue: this.currentWindow.gpsIsAtVenue ?? null,
      gpsAccuracyMeters: this.currentWindow.gpsAccuracyMeters ?? null,
      screenOffRatio: this.currentWindow.screenOffRatio ?? null,
      cameraActivations: this.currentWindow.cameraActivations ?? null,
      computedEnergyScore: breakdown.energyScore,
      computedDensityScore: breakdown.densityScore,
      computedMovementScore: breakdown.movementScore,
      computedMusicScore: breakdown.musicScore,
      computedVibeScore: breakdown.compositeVibeScore,
    };

    this.lastVibeScore = breakdown.compositeVibeScore;
    this.lastBreakdown = breakdown;

    await saveSensorWindow(window);

    console.log(`${LOG_TAG} Window finalized: vibe=${breakdown.compositeVibeScore.toFixed(2)}`);

    if (this.onVibeUpdate) {
      this.onVibeUpdate(window, breakdown);
    }

    // Cleanup old data
    await deleteOldSyncedWindows();

    this.startNewWindow();
  }

  private async runUpload(): Promise<void> {
    try {
      await syncAll();
    } catch (err) {
      console.error(`${LOG_TAG} Upload error:`, err);
    }
  }
}

export const sensorOrchestrator = SensorOrchestrator.getInstance();
