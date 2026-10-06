import * as Crypto from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import { startSessionService, stopSessionService } from '../../modules/session-service';
import * as Battery from 'expo-battery';
import { SensorWindow, Session, VibeScoreBreakdown, SensorReading, LiveDashboardData, TrendDir, AudioMetrics, MotionMetrics, MovementAxis, PhoneContext, EndReason } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import { AudioAnalyzer } from './AudioAnalyzer';
import { MotionTracker } from './MotionTracker';
import { BLEScanner } from './BLEScanner';
import { computeVibeScore } from '../processing/VibeScoreEngine';
import { computeBeatSync, computeTempoMatch, aggregateBeatSync, BeatSyncResult } from '../processing/BeatSync';
import { saveSensorWindow, deleteOldSyncedWindows, saveClip, deleteOldSyncedClips } from '../storage/LocalBuffer';
import { encodeEnvelope, BASS_FRAME_MS, FRAMES_PER_WINDOW } from '../processing/BassEnvelope';
import { syncAll } from '../storage/SupabaseSync';
import { venueLocator, Venue } from '../session/VenueLocator';

const LOG_TAG = '[SensorOrchestrator]';
const FOREGROUND_SCAN_DEBOUNCE_MS = 10_000;
const ROLLING_WINDOW_MS = 90_000;   // keep 90s of readings for display
const TREND_WINDOW_MS   = 900_000;  // keep 15min of window scores for trend
const MINUTE_MS = 60_000;
// A cycle that wakes up later than this after its 10 s boundary is skipped, not run late
const CYCLE_START_TOLERANCE_MS = 500;

type VibeUpdateCallback = (window: SensorWindow, breakdown: VibeScoreBreakdown, live: LiveDashboardData) => void;
// Steps per minute above which a moving phone counts as walking (for the going-home auto-stop)
const WALKING_CADENCE_SPM = 80;

export class SensorOrchestrator {
  private static instance: SensorOrchestrator | null = null;

  private audioAnalyzer = new AudioAnalyzer();
  private motionTracker = new MotionTracker();
  private bleScanner = new BLEScanner();

  private currentSession: Session | null = null;
  private currentWindow: Partial<SensorWindow> = {};
  private windowStartTime: Date | null = null;

  private audioTimer: ReturnType<typeof setTimeout> | null = null;
  private bleTimer: ReturnType<typeof setTimeout> | null = null;
  private bleScanning = false;
  private lastBleScanAt = 0;
  private appStateSub: { remove: () => void } | null = null;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private uploadTimer: ReturnType<typeof setInterval> | null = null;

  private onVibeUpdate: VibeUpdateCallback | null = null;
  private onAutoStop: ((reason: EndReason) => void) | null = null;
  private onVenueProposal: ((venue: Venue) => Promise<boolean>) | null = null;

  // Venue the phone is in now (per window), phone context per cycle, auto-stop state
  private currentVenue: Venue | null = null;
  private venueRecheck = true;
  private contextValues: PhoneContext[] = [];
  private lastPhoneContext: PhoneContext | null = null;
  private walkingFlags: boolean[] = [];
  private quietRun: boolean[] = []; // consecutive quiet minutes, each flagged walking or not
  private autoStopFired = false;

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
  private windowSong: Pick<SensorWindow, 'songIsrc' | 'songGenre' | 'songBpm' | 'songBpmSource' | 'songPopularity' | 'recognitionSource'> = emptySong();
  private songStarts: { isrc: string; trackStartMs: number; rawStartMs: number }[] = [];
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

  /** Called once when an auto-stop rule fires; the handler ends the session (SessionControl). */
  setAutoStopHandler(cb: (reason: EndReason) => void): void {
    this.onAutoStop = cb;
  }

  /**
   * Called when a lookup during the session finds a different venue; resolves true when the
   * user confirms it (SessionControl asks). Unconfirmed venues are never recorded.
   */
  setVenueProposalHandler(cb: (venue: Venue) => Promise<boolean>): void {
    this.onVenueProposal = cb;
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
    this.quietRun = [];
    this.lastPhoneContext = null;
    this.autoStopFired = false;
    // The start screen looked the venue up; a typed (manual) venue is not overridden
    this.venueRecheck = session.venueSource !== 'manual';
    this.currentVenue = session.venuePlaceId
      ? { placeId: session.venuePlaceId, name: session.venueName ?? 'Unknown venue', distanceM: session.venueDistanceM }
      : null;

    console.log(`${LOG_TAG} Starting sensors for session ${session.id}`);

    // Open the microphone for the whole session: this is what keeps iOS from suspending
    // the app in the background between captures.
    await this.audioAnalyzer.start();
    // Android: a foreground service keeps mic, motion and JS timers running with the screen off.
    // Started after the permission prompts, since its type depends on what was granted.
    if (Platform.OS === 'android') {
      startSessionService('Viibe Check is measuring', 'Session running. Open the app to stop it.');
    }
    this.startNewWindow();

    // Audio + motion run together (beat sync needs them on one clock); others staggered
    this.audioTimer  = setTimeout(() => this.scheduleRhythm(),   0);
    this.bleTimer    = setTimeout(() => this.scheduleBLE(),     600);
    // Full Bluetooth discovery only works with the app open, so count the crowd as soon as it
    // comes to the foreground (typically to answer the vibe prompt)
    this.appStateSub = AppState.addEventListener('change', state => {
      if (state !== 'active' || !this.isRunning) return;
      if (Date.now() - this.lastBleScanAt > FOREGROUND_SCAN_DEBOUNCE_MS) this.collectBLESample();
      // Location is "While Using" only, so the venue is re-checked when the app is open
      if (venueLocator.msSinceCheck > SENSOR_CONFIG.VENUE_RECHECK_MS) this.recheckVenue();
    });
    if (!this.currentVenue) this.recheckVenue();

    this.scheduleWindowBoundary();
    this.uploadTimer = setInterval(() => this.runUpload(), SENSOR_CONFIG.UPLOAD_BATCH_INTERVAL_MS);
  }

  async stopSession(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    [this.audioTimer, this.bleTimer, this.windowTimer].forEach(t => {
      if (t) clearTimeout(t);
    });
    if (this.uploadTimer) clearInterval(this.uploadTimer);

    this.audioTimer = this.bleTimer = null;
    this.windowTimer = this.uploadTimer = null;

    await this.finalizeWindow();
    await this.audioAnalyzer.stop();
    stopSessionService();
    await syncAll();

    this.appStateSub?.remove();
    this.appStateSub = null;
    this.bleScanner.destroy();
    this.currentSession = null;
    this.currentWindow = {};
    this.windowStartTime = null;

    console.log(`${LOG_TAG} Sensors stopped`);
  }

  /**
   * Look the venue up again (people move between clubs) and propose a different one to the
   * user. No result keeps the current venue; a place the user declined is not proposed again.
   */
  private recheckVenue(): void {
    if (!this.venueRecheck) return;
    venueLocator.identify().then(async venue => {
      if (!venue || !this.isRunning) return;
      if (venue.placeId === this.currentVenue?.placeId || venueLocator.isDeclined(venue.placeId)) return;
      const yes = (await this.onVenueProposal?.(venue)) ?? false;
      if (!this.isRunning) return;
      if (yes) {
        console.log(`${LOG_TAG} Venue now: ${venue.name} (confirmed)`);
        this.currentVenue = venue;
      } else {
        venueLocator.decline(venue.placeId);
      }
    });
  }

  async runCollectionCycle(): Promise<void> {
    if (!this.isRunning || !this.currentSession) return;
    await Promise.allSettled([
      this.collectRhythmCycle(),
      this.collectBLESample(),
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
    this.songStarts = [];
    this.contextValues = [];
    this.walkingFlags = [];
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

  /**
   * Run each audio + motion cycle on a wall-clock multiple of 10 s (:00, :10, :20 …), so every
   * phone measures the same seconds and their 10 s clips line up for crowd sync. A cycle that
   * overruns or wakes up late skips to the next boundary instead of drifting.
   */
  private scheduleRhythm(): void {
    if (!this.isRunning) return;
    const interval = SENSOR_CONFIG.AUDIO_SAMPLE_INTERVAL_MS;
    this.audioTimer = setTimeout(() => {
      if (!this.isRunning) return;
      const now = Date.now();
      const boundary = Math.floor(now / interval) * interval;
      if (now - boundary > CYCLE_START_TOLERANCE_MS) {
        this.scheduleRhythm();
        return;
      }
      this.collectRhythmCycle(boundary).finally(() => this.scheduleRhythm());
    }, interval - (Date.now() % interval));
  }

  /**
   * One capture: record audio and motion at the same time, then compute beat sync
   * from the overlapping window. When the user has been stationary for a long time,
   * motion is sampled only every 3rd cycle to save battery.
   */
  private async collectRhythmCycle(cycleStartMs: number = Date.now()): Promise<void> {
    this.cycleCount++;
    const skipMotion = this.motionTracker.isLongTermStationary() && this.cycleCount % 3 !== 0;
    const [audioRes, motionRes] = await Promise.allSettled([
      this.audioAnalyzer.analyze(cycleStartMs),
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
      // The clock grid needs the identical period on every phone, so it uses the song tempo rounded
      const clockBpm = audio.recognizedBpm != null ? Math.round(audio.recognizedBpm) : null;
      const sync = computeBeatSync(motion.movementSeries, onsets, musicBpm, motion.movementBpm, clockBpm);
      if (sync) {
        this.beatResults.push(sync);
        this.lastBeatSync = sync;
        console.log(`${LOG_TAG} BeatSync: plv=${sync.plv.toFixed(2)} tempo=${sync.tempoMatch.toFixed(2)} ×${sync.harmonic} peaks=${sync.peakCount}`);
      }
    }
    if ((audio || motion) && this.currentSession) {
      // One lean row per 10 s cycle (collect-only): the values the minute row averages
      saveClip({
        id: Crypto.randomUUID(),
        sessionId: this.currentSession.id,
        clipStart: cycleStartMs,
        beatPlv: this.lastBeatSync?.plv ?? null,
        beatPhaseClock: this.lastBeatSync?.clockPhase ?? null,
        movementEnergy: motion?.movementEnergy ?? null,
        movementBpm: motion?.movementBpm ?? null,
        songIsrc: audio?.recognizedIsrc ?? null,
        // A skipped motion sample (long stationary) keeps the last known context
        phoneContext: motion?.phoneContext ?? (skipMotion ? this.lastPhoneContext : null),
      }).catch(err => console.warn(`${LOG_TAG} Clip save error:`, err));
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
    if (metrics.songMatch) this.songStarts.push(metrics.songMatch);
    // Latest recognized track in the window wins
    if (metrics.recognitionSource) {
      this.windowSong = {
        songIsrc: metrics.recognizedIsrc,
        songGenre: metrics.recognizedGenre,
        songBpm: metrics.recognizedBpm,
        songBpmSource: metrics.songBpmSource,
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
    this.contextValues.push(metrics.phoneContext);
    this.lastPhoneContext = metrics.phoneContext;
    this.walkingFlags.push(
      metrics.movementClassification === 'walking' || (metrics.stepCadence ?? 0) >= WALKING_CADENCE_SPM,
    );

    console.log(`${LOG_TAG} Motion: ${metrics.movementClassification} energy=${metrics.movementEnergy?.toFixed(2)} movBPM=${metrics.movementBpm} rhythm=${metrics.rhythmicity.toFixed(2)} axis=${metrics.movementAxis} steps=${metrics.stepCadence}spm`);
  }

  private async collectBLESample(): Promise<void> {
    // iOS does not let apps discover arbitrary nearby devices in the background, and Android
    // pauses unfiltered scans with the screen off, so a locked-phone scan finds 0. Record no
    // measurement rather than an empty room.
    if (AppState.currentState !== 'active' || this.bleScanning) return;
    this.bleScanning = true;
    try {
      const metrics = await this.bleScanner.scan();
      this.lastBleScanAt = Date.now();
      if (!metrics) return;

      this.currentWindow.bleDeviceCount = metrics.bleDeviceCount;
      this.currentWindow.bleCountDelta = metrics.bleCountDelta;
      this.currentWindow.bleCountTrend = metrics.bleCountTrend;

      this.pushReading(this.bleReadings, metrics.bleDeviceCount);

      console.log(`${LOG_TAG} BLE: ${metrics.bleDeviceCount} devices trend=${metrics.bleCountTrend}`);
      this.emitPreviewUpdate();
    } catch (err) {
      console.warn(`${LOG_TAG} BLE collection error:`, err);
    } finally {
      this.bleScanning = false;
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
      ...this.aggregateSongStart(),
      bassEnvelope: null, // filled in finalizeWindow (needs an async native read)
      venuePlaceId: this.currentVenue?.placeId ?? null,
      ...this.aggregatePhoneContext(),
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

  /**
   * The minute's bass envelope: 240 frames from the minute boundary (frame k = minute + k·250 ms),
   * so phones' envelopes line up frame by frame. A first window that starts mid-minute simply
   * has missing frames before the session began.
   */
  private async bassEnvelopeFor(windowStart: Date): Promise<string | null> {
    const minute = Math.floor(windowStart.getTime() / MINUTE_MS) * MINUTE_MS;
    try {
      const frames = await this.audioAnalyzer.getBassEnvelope(minute, minute + FRAMES_PER_WINDOW * BASS_FRAME_MS);
      return frames ? encodeEnvelope(frames) : null;
    } catch {
      return null;
    }
  }

  /** The window's dominant phone context (ignoring "uncertain" cycles) and its on-body share. */
  private aggregatePhoneContext(): Pick<SensorWindow, 'phoneContext' | 'onBodyShare'> {
    const known = this.contextValues.filter(c => c !== 'uncertain');
    if (this.contextValues.length === 0) return { phoneContext: null, onBodyShare: null };
    if (known.length === 0) return { phoneContext: 'uncertain', onBodyShare: null };
    const onBody = known.filter(c => c !== 'off_body').length;
    return { phoneContext: mode(known), onBodyShare: onBody / known.length };
  }

  /**
   * Auto-stop rules, checked once a minute: no music for 20 min (10 if mostly walking, i.e.
   * going home), longer than 8 h, or the battery at 10% and not charging.
   */
  private async checkAutoStop(w: SensorWindow, walking: boolean): Promise<EndReason | null> {
    const C = SENSOR_CONFIG;
    const quiet = !w.musicDetected && (w.avgDb == null || w.avgDb < C.AUTO_STOP_QUIET_DB);
    this.quietRun = quiet ? [...this.quietRun, walking] : [];
    const run = this.quietRun.length;
    if (run >= C.AUTO_STOP_QUIET_MINUTES) return 'no_music';
    if (run >= C.AUTO_STOP_QUIET_WALKING_MINUTES) {
      const last = this.quietRun.slice(-C.AUTO_STOP_QUIET_WALKING_MINUTES);
      if (last.filter(Boolean).length / last.length >= C.AUTO_STOP_WALKING_SHARE) return 'no_music';
    }
    if (this.currentSession && Date.now() - this.currentSession.startedAt.getTime() >= C.AUTO_STOP_MAX_SESSION_MS) {
      return 'max_duration';
    }
    try {
      const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
      const charging = state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
      if (level >= 0 && !charging && level * 100 <= C.AUTO_STOP_LOW_BATTERY_PCT) return 'low_battery';
    } catch { /* battery unknown: no rule */ }
    return null;
  }

  /** Median track start of this window's matches of its song, and how far the estimates spread. */
  private aggregateSongStart(): Pick<SensorWindow, 'songStartMs' | 'songStartSpreadMs'> {
    const matches = this.songStarts.filter(m => m.isrc === this.windowSong.songIsrc);
    if (matches.length === 0) return { songStartMs: null, songStartSpreadMs: null };
    // The start uses the playback consensus (repeat-chorus matches outvoted); the spread keeps
    // the raw estimates, as a check on ShazamKit's accuracy
    const raw = matches.map(m => m.rawStartMs);
    return {
      songStartMs: Math.round(matches[matches.length - 1].trackStartMs),
      songStartSpreadMs: raw.length > 1 ? Math.max(...raw) - Math.min(...raw) : null,
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
    window.bassEnvelope = await this.bassEnvelopeFor(this.windowStartTime);

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
    console.log(`${LOG_TAG} Window finalized: vibe=${breakdown.compositeVibeScore.toFixed(2)} context=${window.phoneContext} venue=${window.venuePlaceId ? this.currentVenue?.name : '-'}`);

    // Auto-stop only from the minute timer (boundaryMs set), not from the final flush of a stop
    if (boundaryMs != null && this.isRunning && !this.autoStopFired) {
      const walking = this.walkingFlags.length > 0
        && this.walkingFlags.filter(Boolean).length / this.walkingFlags.length >= 0.5;
      const reason = await this.checkAutoStop(window, walking);
      if (reason) {
        this.autoStopFired = true;
        console.log(`${LOG_TAG} Auto-stop: ${reason}`);
        // After this minute's bookkeeping; stopping re-enters finalizeWindow
        setTimeout(() => this.onAutoStop?.(reason), 0);
      }
    }

    if (this.onVibeUpdate) {
      this.onVibeUpdate(window, breakdown, this.buildLiveDashboard());
    }

    await deleteOldSyncedWindows();
    await deleteOldSyncedClips();
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

function emptySong(): Pick<SensorWindow, 'songIsrc' | 'songGenre' | 'songBpm' | 'songBpmSource' | 'songPopularity' | 'recognitionSource'> {
  return { songIsrc: null, songGenre: null, songBpm: null, songBpmSource: null, songPopularity: null, recognitionSource: null };
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
