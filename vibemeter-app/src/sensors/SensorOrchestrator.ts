import * as Crypto from 'expo-crypto';
import { SensorWindow, Session, VibeScoreBreakdown, SensorReading, LiveDashboardData, TrendDir } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import { AudioAnalyzer } from './AudioAnalyzer';
import { MotionTracker } from './MotionTracker';
import { BLEScanner } from './BLEScanner';
import { LocationTracker } from './LocationTracker';
import { computeVibeScore } from '../processing/VibeScoreEngine';
import { saveSensorWindow, deleteOldSyncedWindows } from '../storage/LocalBuffer';
import { syncAll } from '../storage/SupabaseSync';

const LOG_TAG = '[SensorOrchestrator]';
const ROLLING_WINDOW_MS = 90_000;   // keep 90s of readings for display
const TREND_WINDOW_MS   = 900_000;  // keep 15min of window scores for trend

type VibeUpdateCallback = (window: SensorWindow, breakdown: VibeScoreBreakdown, live: LiveDashboardData) => void;

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

  // Rolling sensor reading buffers (for sparklines)
  private dbReadings: SensorReading[] = [];
  private magReadings: SensorReading[] = [];
  private gyroReadings: SensorReading[] = [];
  private bleReadings: SensorReading[] = [];
  private bpmReadings: SensorReading[] = [];
  private stepReadings: SensorReading[] = [];
  private movementBpmReadings: SensorReading[] = [];

  // Finalized window vibe scores for 15min trend
  private windowVibeHistory: { t: number; score: number }[] = [];

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
    this.dbReadings = [];
    this.magReadings = [];
    this.gyroReadings = [];
    this.bleReadings = [];
    this.bpmReadings = [];
    this.stepReadings = [];
    this.movementBpmReadings = [];
    this.windowVibeHistory = [];

    console.log(`${LOG_TAG} Starting sensors for session ${session.id}`);

    await this.locationTracker.requestPermissions();
    this.startNewWindow();

    // Staggered starts — short enough to feel instant
    this.audioTimer  = setTimeout(() => this.scheduleAudio(),    0);
    this.motionTimer = setTimeout(() => this.scheduleMotion(),  300);
    this.bleTimer    = setTimeout(() => this.scheduleBLE(),     600);
    this.locationTimer = setTimeout(() => this.scheduleLocation(), 900);

    this.windowTimer = setInterval(() => this.finalizeWindow(), SENSOR_CONFIG.WINDOW_DURATION_MS);
    this.uploadTimer = setInterval(() => this.runUpload(), SENSOR_CONFIG.UPLOAD_BATCH_INTERVAL_MS);
  }

  async stopSession(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    [this.audioTimer, this.motionTimer, this.bleTimer, this.locationTimer].forEach(t => {
      if (t) clearTimeout(t);
    });
    if (this.windowTimer) clearInterval(this.windowTimer);
    if (this.uploadTimer) clearInterval(this.uploadTimer);

    this.audioTimer = this.motionTimer = this.bleTimer = this.locationTimer = null;
    this.windowTimer = this.uploadTimer = null;

    await this.finalizeWindow();
    await syncAll();

    this.bleScanner.destroy();
    this.currentSession = null;
    this.currentWindow = {};
    this.windowStartTime = null;

    console.log(`${LOG_TAG} Sensors stopped`);
  }

  async runCollectionCycle(): Promise<void> {
    if (!this.isRunning || !this.currentSession) return;
    await Promise.allSettled([
      this.collectAudioSample(),
      this.collectMotionSample(),
      this.collectBLESample(),
      this.collectLocationSample(),
    ]);
  }

  get currentVibeScore(): number { return this.lastVibeScore; }
  get currentBreakdown(): VibeScoreBreakdown | null { return this.lastBreakdown; }

  // ── Private ──────────────────────────────────────────────────────────────────

  private startNewWindow(): void {
    this.windowStartTime = new Date();
    this.currentWindow = {
      id: Crypto.randomUUID(),
      sessionId: this.currentSession!.id,
      windowStart: this.windowStartTime,
    };
  }

  private pushReading(buf: SensorReading[], value: number): void {
    const now = Date.now();
    buf.push({ t: now, v: value });
    const cutoff = now - ROLLING_WINDOW_MS;
    while (buf.length > 0 && buf[0].t < cutoff) buf.shift();
  }

  private compute15mTrend(): TrendDir {
    const now = Date.now();
    const cutoff15 = now - TREND_WINDOW_MS;
    const recent = this.windowVibeHistory.filter(e => e.t >= cutoff15);
    if (recent.length < 4) return 'flat';

    const mid = now - TREND_WINDOW_MS / 3;
    const older = recent.filter(e => e.t < mid);
    const newer = recent.filter(e => e.t >= mid);
    if (older.length === 0 || newer.length === 0) return 'flat';

    const avgOlder = older.reduce((s, e) => s + e.score, 0) / older.length;
    const avgNewer = newer.reduce((s, e) => s + e.score, 0) / newer.length;
    const delta = avgNewer - avgOlder;

    if (delta > 0.25) return 'up';
    if (delta < -0.25) return 'down';
    return 'flat';
  }

  private buildLiveDashboard(): LiveDashboardData {
    const lastStep   = this.stepReadings.length ? this.stepReadings[this.stepReadings.length - 1].v : null;
    const lastMovBpm = this.movementBpmReadings.length ? this.movementBpmReadings[this.movementBpmReadings.length - 1].v : null;
    const audioBpm   = this.currentWindow.estimatedBpm ?? null;
    const rhythmicity = (this.currentWindow as any)._rhythmicity ?? 0;

    return {
      dbReadings:          [...this.dbReadings],
      magReadings:         [...this.magReadings],
      gyroReadings:        [...this.gyroReadings],
      bleReadings:         [...this.bleReadings],
      bpmReadings:         [...this.bpmReadings],
      stepReadings:        [...this.stepReadings],
      movementBpmReadings: [...this.movementBpmReadings],
      audioClass:          this.currentWindow.audioClassification ?? null,
      movementClass:       this.currentWindow.movementClassification ?? null,
      bleCount:            this.currentWindow.bleDeviceCount ?? null,
      bleTrend:            this.currentWindow.bleCountTrend ?? null,
      stepCadence:         lastStep,
      clapCount:           (this.currentWindow as any)._clapCount ?? 0,
      audioEvent:          (this.currentWindow as any)._audioEvent ?? null,
      recognizedSong:      (this.currentWindow as any)._recognizedSong ?? null,
      recognizedGenre:     (this.currentWindow as any)._recognizedGenre ?? null,
      audioBpm,
      movementBpm:         lastMovBpm,
      rhythmicity,
      phaseCoherence:      computePhaseCoherence(lastMovBpm, audioBpm),
      trend15m:            this.compute15mTrend(),
      subBassEnergy:       this.currentWindow.subBassEnergy ?? 0,
      spectralCentroid:    this.currentWindow.spectralCentroid ?? 0,
      spectralFlux:        this.currentWindow.spectralFlux ?? 0,
      crestFactor:         this.currentWindow.crestFactor ?? 0,
      vocalPresence:       this.currentWindow.vocalPresence ?? 0,
      harmonicNoiseRatio:  this.currentWindow.harmonicNoiseRatio ?? 0,
    };
  }

  private scheduleAudio(): void {
    if (!this.isRunning) return;
    this.collectAudioSample().then(() => {
      if (this.isRunning) {
        this.audioTimer = setTimeout(() => this.scheduleAudio(), SENSOR_CONFIG.AUDIO_SAMPLE_INTERVAL_MS);
      }
    });
  }

  private scheduleMotion(): void {
    if (!this.isRunning) return;
    if (this.motionTracker.isLongTermStationary()) {
      this.motionTimer = setTimeout(() => this.scheduleMotion(), SENSOR_CONFIG.MOTION_SAMPLE_INTERVAL_MS * 3);
      return;
    }
    this.collectMotionSample().then(() => {
      if (this.isRunning) {
        this.motionTimer = setTimeout(() => this.scheduleMotion(), SENSOR_CONFIG.MOTION_SAMPLE_INTERVAL_MS);
      }
    });
  }

  private scheduleBLE(): void {
    if (!this.isRunning) return;
    this.collectBLESample().then(() => {
      if (this.isRunning) {
        this.bleTimer = setTimeout(() => this.scheduleBLE(), SENSOR_CONFIG.BLE_SCAN_INTERVAL_MS);
      }
    });
  }

  private scheduleLocation(): void {
    if (!this.isRunning) return;
    this.collectLocationSample().then(() => {
      if (this.isRunning) {
        this.locationTimer = setTimeout(() => this.scheduleLocation(), SENSOR_CONFIG.GPS_CHECK_INTERVAL_MS);
      }
    });
  }

  private async collectAudioSample(): Promise<void> {
    try {
      const metrics = await this.audioAnalyzer.analyze();
      if (!metrics) return;

      const dbValues = this.currentWindow.avgDb
        ? [this.currentWindow.avgDb, metrics.avgDb]
        : [metrics.avgDb];

      this.currentWindow.avgDb = dbValues.reduce((s, v) => s + v, 0) / dbValues.length;
      this.currentWindow.maxDb = Math.max(this.currentWindow.maxDb ?? 0, metrics.maxDb);
      this.currentWindow.dbVariance = metrics.dbVariance;
      this.currentWindow.musicDetected = metrics.musicDetected;
      // Prefer exact metadata BPM over metering heuristic
      const bestBpm = metrics.recognizedBpm ?? metrics.estimatedBpm;
      this.currentWindow.estimatedBpm = bestBpm;
      this.currentWindow.audioClassification = metrics.audioClassification;
      this.currentWindow.bassPresence = metrics.bassPresence;
      this.currentWindow.midHighRatio = metrics.midHighRatio;
      this.currentWindow.subBassEnergy = metrics.subBassEnergy;
      this.currentWindow.spectralCentroid = metrics.spectralCentroid;
      this.currentWindow.spectralFlux = metrics.spectralFlux;
      this.currentWindow.crestFactor = metrics.crestFactor;
      this.currentWindow.vocalPresence = metrics.vocalPresence;
      this.currentWindow.harmonicNoiseRatio = metrics.harmonicNoiseRatio;

      this.pushReading(this.dbReadings, metrics.avgDb);
      if (bestBpm) this.pushReading(this.bpmReadings, bestBpm);
      (this.currentWindow as any)._clapCount = metrics.clapCount;
      (this.currentWindow as any)._audioEvent = metrics.audioEvent;
      (this.currentWindow as any)._recognizedSong = metrics.recognizedSong;
      (this.currentWindow as any)._recognizedGenre = metrics.recognizedGenre;

      console.log(`${LOG_TAG} Audio: ${metrics.avgDb.toFixed(1)}dB bpm=${bestBpm} (recog=${metrics.recognizedBpm}) claps=${metrics.clapCount} song=${metrics.recognizedSong} genre=${metrics.recognizedGenre}`);
      this.emitPreviewUpdate();
    } catch (err) {
      console.warn(`${LOG_TAG} Audio collection error:`, err);
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

      this.pushReading(this.magReadings, metrics.accelMagnitudeAvg);
      this.pushReading(this.gyroReadings, metrics.gyroActivityAvg);
      if (metrics.stepCadence != null)  this.pushReading(this.stepReadings, metrics.stepCadence);
      if (metrics.movementBpm != null)  this.pushReading(this.movementBpmReadings, metrics.movementBpm);
      (this.currentWindow as any)._rhythmicity = metrics.rhythmicity;

      console.log(`${LOG_TAG} Motion: ${metrics.movementClassification} movBPM=${metrics.movementBpm} rhythm=${metrics.rhythmicity.toFixed(2)} steps=${metrics.stepCadence}spm`);
      this.emitPreviewUpdate();
    } catch (err) {
      console.warn(`${LOG_TAG} Motion collection error:`, err);
    }
  }

  private async collectBLESample(): Promise<void> {
    try {
      const metrics = await this.bleScanner.scan();
      if (!metrics) return;

      this.currentWindow.bleDeviceCount = metrics.bleDeviceCount;
      this.currentWindow.bleCountDelta = metrics.bleCountDelta;
      this.currentWindow.bleCountTrend = metrics.bleCountTrend;

      this.pushReading(this.bleReadings, metrics.bleDeviceCount);

      console.log(`${LOG_TAG} BLE: ${metrics.bleDeviceCount} devices trend=${metrics.bleCountTrend}`);
      this.emitPreviewUpdate();
    } catch (err) {
      console.warn(`${LOG_TAG} BLE collection error:`, err);
    }
  }

  private async collectLocationSample(): Promise<void> {
    try {
      const metrics = await this.locationTracker.check();
      this.currentWindow.gpsIsAtVenue = metrics.gpsIsAtVenue;
      this.currentWindow.gpsAccuracyMeters = metrics.gpsAccuracyMeters;
    } catch (err) {
      console.warn(`${LOG_TAG} Location collection error:`, err);
    }
  }

  private emitPreviewUpdate(): void {
    if (!this.onVibeUpdate || !this.currentSession || !this.windowStartTime) return;
    const breakdown = computeVibeScore(this.currentWindow);
    this.lastVibeScore = breakdown.compositeVibeScore;
    this.lastBreakdown = breakdown;
    const preview = this.buildSensorWindow(breakdown);
    this.onVibeUpdate(preview, breakdown, this.buildLiveDashboard());
  }

  private buildSensorWindow(breakdown: VibeScoreBreakdown, windowEnd?: Date): SensorWindow {
    return {
      id: this.currentWindow.id ?? Crypto.randomUUID(),
      sessionId: this.currentSession!.id,
      windowStart: this.windowStartTime!,
      windowEnd: windowEnd ?? new Date(),
      avgDb: this.currentWindow.avgDb ?? null,
      maxDb: this.currentWindow.maxDb ?? null,
      dbVariance: this.currentWindow.dbVariance ?? null,
      musicDetected: this.currentWindow.musicDetected ?? null,
      estimatedBpm: this.currentWindow.estimatedBpm ?? null,
      audioClassification: this.currentWindow.audioClassification ?? null,
      bassPresence: this.currentWindow.bassPresence ?? null,
      midHighRatio: this.currentWindow.midHighRatio ?? null,
      subBassEnergy: this.currentWindow.subBassEnergy ?? null,
      spectralCentroid: this.currentWindow.spectralCentroid ?? null,
      spectralFlux: this.currentWindow.spectralFlux ?? null,
      crestFactor: this.currentWindow.crestFactor ?? null,
      vocalPresence: this.currentWindow.vocalPresence ?? null,
      harmonicNoiseRatio: this.currentWindow.harmonicNoiseRatio ?? null,
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
  }

  private async finalizeWindow(): Promise<void> {
    if (!this.currentSession || !this.windowStartTime) return;
    if (!this.currentWindow.avgDb && !this.currentWindow.accelMagnitudeAvg && !this.currentWindow.bleDeviceCount) {
      this.startNewWindow();
      return;
    }

    const windowEnd = new Date();
    const breakdown = computeVibeScore(this.currentWindow);
    const window = this.buildSensorWindow(breakdown, windowEnd);

    this.lastVibeScore = breakdown.compositeVibeScore;
    this.lastBreakdown = breakdown;

    // Track for 15min trend
    const now = Date.now();
    this.windowVibeHistory.push({ t: now, score: breakdown.compositeVibeScore });
    const cutoff = now - TREND_WINDOW_MS;
    while (this.windowVibeHistory.length > 0 && this.windowVibeHistory[0].t < cutoff) {
      this.windowVibeHistory.shift();
    }

    await saveSensorWindow(window);
    console.log(`${LOG_TAG} Window finalized: vibe=${breakdown.compositeVibeScore.toFixed(2)}`);

    if (this.onVibeUpdate) {
      this.onVibeUpdate(window, breakdown, this.buildLiveDashboard());
    }

    await deleteOldSyncedWindows();
    this.startNewWindow();
  }

  private async runUpload(): Promise<void> {
    try {
      await syncAll();
    } catch (err) {
      console.warn(`${LOG_TAG} Upload error:`, err);
    }
  }
}

export const sensorOrchestrator = SensorOrchestrator.getInstance();

// Returns 0–1: how well the movement rhythm matches the audio beat (or its harmonics).
function computePhaseCoherence(movementBpm: number | null, audioBpm: number | null): number {
  if (!movementBpm || !audioBpm) return 0;
  const harmonics = [0.5, 1, 2, 3];
  for (const h of harmonics) {
    const target = audioBpm * h;
    if (target > 0 && Math.abs(movementBpm - target) / target < 0.1) return 1;
  }
  return 0;
}
