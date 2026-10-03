import * as Crypto from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import { startSessionService, stopSessionService } from '../../modules/session-service';
import { SensorWindow, Session, VibeScoreBreakdown, SensorReading, LiveDashboardData, TrendDir, AudioMetrics, MotionMetrics, MovementAxis } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import { AudioAnalyzer } from './AudioAnalyzer';
import { MotionTracker } from './MotionTracker';
import { BLEScanner } from './BLEScanner';
import { LocationTracker } from './LocationTracker';
import { computeVibeScore } from '../processing/VibeScoreEngine';
import { computeBeatSync, computeTempoMatch, aggregateBeatSync, BeatSyncResult } from '../processing/BeatSync';
import { saveSensorWindow, deleteOldSyncedWindows } from '../storage/LocalBuffer';
import { syncAll } from '../storage/SupabaseSync';

const LOG_TAG = '[SensorOrchestrator]';
const ROLLING_WINDOW_MS = 90_000;   // keep 90s of readings for display
const TREND_WINDOW_MS   = 900_000;  // keep 15min of window scores for trend
const MINUTE_MS = 60_000;

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
  private bleTimer: ReturnType<typeof setTimeout> | null = null;
  private locationTimer: ReturnType<typeof setTimeout> | null = null;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
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

  // Per-window accumulators for rhythm / beat-sync metrics (one entry per capture)
  private beatResults: BeatSyncResult[] = [];
  private energyValues: number[] = [];
  private movementBpmValues: number[] = [];
  private rhythmicityValues: number[] = [];
  private axisValues: MovementAxis[] = [];
  private pulseClarityValues: number[] = [];
  private windowSong: Pick<SensorWindow, 'songIsrc' | 'songGenre' | 'songBpm' | 'songPopularity' | 'recognitionSource'> = emptySong();
  private lastBeatSync: BeatSyncResult | null = null;
  private cycleCount = 0;

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
    // Open the microphone for the whole session: this is what keeps iOS from suspending
    // the app in the background between captures.
    await this.audioAnalyzer.start();
    // Android: a foreground service keeps mic, motion and JS timers running with the screen off.
    // Started after the permission prompts, since its type depends on what was granted.
    if (Platform.OS === 'android') {
      startSessionService('ViibeMeter is measuring', 'Session running. Open the app to stop it.');
    }
    this.startNewWindow();

    // Audio + motion run together (beat sync needs them on one clock); others staggered
    this.audioTimer  = setTimeout(() => this.scheduleRhythm(),   0);
    this.bleTimer    = setTimeout(() => this.scheduleBLE(),     600);
    this.locationTimer = setTimeout(() => this.scheduleLocation(), 900);

    this.scheduleWindowBoundary();
    this.uploadTimer = setInterval(() => this.runUpload(), SENSOR_CONFIG.UPLOAD_BATCH_INTERVAL_MS);
  }

  async stopSession(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    [this.audioTimer, this.bleTimer, this.locationTimer, this.windowTimer].forEach(t => {
      if (t) clearTimeout(t);
    });
    if (this.uploadTimer) clearInterval(this.uploadTimer);

    this.audioTimer = this.bleTimer = this.locationTimer = null;
    this.windowTimer = this.uploadTimer = null;

    await this.finalizeWindow();
    await this.audioAnalyzer.stop();
    stopSessionService();
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
      this.collectRhythmCycle(),
      this.collectBLESample(),
      this.collectLocationSample(),
    ]);
  }

  get currentVibeScore(): number { return this.lastVibeScore; }
  get currentBreakdown(): VibeScoreBreakdown | null { return this.lastBreakdown; }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Windows are aligned to wall-clock minutes so windows from different phones share
   * the same window_start — required for crowd sync. The first window of a session
   * is partial (session start → next minute boundary).
   */
  private startNewWindow(boundaryMs?: number): void {
    const start = boundaryMs ?? Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    this.windowStartTime = new Date(start);
    this.currentWindow = {
      id: Crypto.randomUUID(),
      sessionId: this.currentSession!.id,
      windowStart: this.windowStartTime,
    };
    this.beatResults = [];
    this.energyValues = [];
    this.movementBpmValues = [];
    this.rhythmicityValues = [];
    this.axisValues = [];
    this.pulseClarityValues = [];
    this.windowSong = emptySong();
  }

  /** Fire finalizeWindow at each wall-clock minute boundary (recomputed every time to avoid drift). */
  private scheduleWindowBoundary(): void {
    if (!this.isRunning) return;
    const now = Date.now();
    const next = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    this.windowTimer = setTimeout(async () => {
      await this.finalizeWindow(next);
      this.scheduleWindowBoundary();
    }, next - now);
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
    const rhythmicity = this.rhythmicityValues.length ? this.rhythmicityValues[this.rhythmicityValues.length - 1] : 0;

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
      beatPlv:             this.lastBeatSync?.plv ?? null,
      tempoMatch:          computeTempoMatch(lastMovBpm, audioBpm).tempoMatch,
      trend15m:            this.compute15mTrend(),
      subBassEnergy:       this.currentWindow.subBassEnergy ?? 0,
      spectralCentroid:    this.currentWindow.spectralCentroid ?? 0,
      spectralFlux:        this.currentWindow.spectralFlux ?? 0,
      crestFactor:         this.currentWindow.crestFactor ?? 0,
      vocalPresence:       this.currentWindow.vocalPresence ?? 0,
      harmonicNoiseRatio:  this.currentWindow.harmonicNoiseRatio ?? 0,
    };
  }

  private scheduleRhythm(): void {
    if (!this.isRunning) return;
    this.collectRhythmCycle().then(() => {
      if (this.isRunning) {
        this.audioTimer = setTimeout(() => this.scheduleRhythm(), SENSOR_CONFIG.AUDIO_SAMPLE_INTERVAL_MS);
      }
    });
  }

  /**
   * One capture: record audio and motion at the same time, then compute beat sync
   * from the overlapping window. When the user has been stationary for a long time,
   * motion is sampled only every 3rd cycle to save battery.
   */
  private async collectRhythmCycle(): Promise<void> {
    this.cycleCount++;
    const skipMotion = this.motionTracker.isLongTermStationary() && this.cycleCount % 3 !== 0;
    const [audioRes, motionRes] = await Promise.allSettled([
      this.audioAnalyzer.analyze(),
      skipMotion ? Promise.resolve(null) : this.motionTracker.sample(),
    ]);
    const audio = audioRes.status === 'fulfilled' ? audioRes.value : null;
    const motion = motionRes.status === 'fulfilled' ? motionRes.value : null;
    if (audioRes.status === 'rejected') console.warn(`${LOG_TAG} Audio collection error:`, audioRes.reason);
    if (motionRes.status === 'rejected') console.warn(`${LOG_TAG} Motion collection error:`, motionRes.reason);

    if (audio) this.applyAudioMetrics(audio);
    if (motion) this.applyMotionMetrics(motion);

    this.lastBeatSync = null;
    // Tempo from the audio beat grid, else from the recognised song: PLV needs only the period,
    // so a muffled mic (phone in a pocket while dancing) still yields beat sync.
    const musicBpm = audio?.beatBpm ?? audio?.recognizedBpm ?? null;
    if (audio && motion && musicBpm != null) {
      const onsets = audio.beatBpm != null ? audio.beatOnsetTimesMs : [];
      const sync = computeBeatSync(motion.movementSeries, onsets, musicBpm, motion.movementBpm, audio.recognizedBpm);
      if (sync) {
        this.beatResults.push(sync);
        this.lastBeatSync = sync;
        console.log(`${LOG_TAG} BeatSync: plv=${sync.plv.toFixed(2)} tempo=${sync.tempoMatch.toFixed(2)} ×${sync.harmonic} peaks=${sync.peakCount}`);
      }
    }
    if (audio || motion) this.emitPreviewUpdate();
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

  private applyAudioMetrics(metrics: AudioMetrics): void {
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
    if (metrics.pulseClarity != null) this.pulseClarityValues.push(metrics.pulseClarity);
    // Latest recognized track in the window wins
    if (metrics.recognitionSource) {
      this.windowSong = {
        songIsrc: metrics.recognizedIsrc,
        songGenre: metrics.recognizedGenre,
        songBpm: metrics.recognizedBpm,
        songPopularity: metrics.trackPopularity,
        recognitionSource: metrics.recognitionSource,
      };
    }

    this.pushReading(this.dbReadings, metrics.avgDb);
    if (bestBpm) this.pushReading(this.bpmReadings, bestBpm);
    (this.currentWindow as any)._clapCount = metrics.clapCount;
    (this.currentWindow as any)._audioEvent = metrics.audioEvent;
    (this.currentWindow as any)._recognizedSong = metrics.recognizedSong;
    (this.currentWindow as any)._recognizedGenre = metrics.recognizedGenre;

    console.log(`${LOG_TAG} Audio: ${metrics.avgDb.toFixed(1)}dB bpm=${bestBpm} (recog=${metrics.recognizedBpm}) claps=${metrics.clapCount} song=${metrics.recognizedSong} genre=${metrics.recognizedGenre}`);
  }

  private applyMotionMetrics(metrics: MotionMetrics): void {
    this.audioAnalyzer.setPhoneMoving(metrics.movementClassification !== 'stationary');
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
    this.rhythmicityValues.push(metrics.rhythmicity);
    if (metrics.movementEnergy != null) this.energyValues.push(metrics.movementEnergy);
    if (metrics.movementBpm != null) this.movementBpmValues.push(metrics.movementBpm);
    if (metrics.movementAxis) this.axisValues.push(metrics.movementAxis);

    console.log(`${LOG_TAG} Motion: ${metrics.movementClassification} energy=${metrics.movementEnergy?.toFixed(2)} movBPM=${metrics.movementBpm} rhythm=${metrics.rhythmicity.toFixed(2)} axis=${metrics.movementAxis} steps=${metrics.stepCadence}spm`);
  }

  private async collectBLESample(): Promise<void> {
    // iOS does not let apps discover arbitrary nearby devices in the background, and Android
    // pauses unfiltered scans with the screen off, so a locked-phone scan finds 0. Record no
    // measurement rather than an empty room.
    if (AppState.currentState !== 'active') return;
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
      ...this.aggregateRhythmMetrics(),
      ...this.windowSong,
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

  private aggregateRhythmMetrics(): Pick<SensorWindow,
    'movementEnergy' | 'movementBpm' | 'rhythmicity' | 'movementAxis' |
    'beatPlv' | 'beatPhaseMean' | 'beatPhaseClock' | 'tempoMatch' | 'pulseClarity'> {
    const beat = aggregateBeatSync(this.beatResults);
    return {
      movementEnergy: mean(this.energyValues),
      movementBpm: median(this.movementBpmValues),
      rhythmicity: mean(this.rhythmicityValues),
      movementAxis: mode(this.axisValues),
      beatPlv: beat.plv,
      beatPhaseMean: beat.phaseMean,
      beatPhaseClock: beat.clockPhase,
      tempoMatch: beat.tempoMatch,
      pulseClarity: mean(this.pulseClarityValues),
    };
  }

  private async finalizeWindow(boundaryMs?: number): Promise<void> {
    if (!this.currentSession || !this.windowStartTime) return;
    if (!this.currentWindow.avgDb && !this.currentWindow.accelMagnitudeAvg && !this.currentWindow.bleDeviceCount) {
      this.startNewWindow(boundaryMs);
      return;
    }

    const windowEnd = new Date(boundaryMs ?? Date.now());
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
    this.startNewWindow(boundaryMs);
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

function emptySong(): Pick<SensorWindow, 'songIsrc' | 'songGenre' | 'songBpm' | 'songPopularity' | 'recognitionSource'> {
  return { songIsrc: null, songGenre: null, songBpm: null, songPopularity: null, recognitionSource: null };
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function mode<T>(values: T[]): T | null {
  if (!values.length) return null;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
