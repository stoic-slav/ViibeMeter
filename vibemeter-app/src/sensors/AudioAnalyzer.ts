import { Audio } from 'expo-av';
// SDK 54: the classic API lives under /legacy; the root import's readAsStringAsync throws.
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { AudioMetrics, AudioEvent, AudioClassification, RecognitionSource } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import {
  computeFFT, bandEnergy, totalEnergy,
  spectralCentroid as fftSpectralCentroid, subBassRatio, vocalPresence as fftVocalPresence,
  harmonicNoiseRatio as fftHNR, computeSpectralFlux, crestFactor as fftCrestFactor,
} from '../processing/FFTProcessor';
import { detectBPM } from '../processing/BPMDetector';
import { classifyAudio, computeRMS, rmsToDb, dbFullScaleToAmbient } from '../processing/AudioClassifier';
import AudioRecord from 'react-native-audio-record';
import {
  isAudioCaptureAvailable, startCapture, stopCapture, isCapturing, readRecent, matchRecent,
} from '../../modules/audio-capture';

const LOG_TAG = '[AudioAnalyzer]';
const AUDD_TOKEN = process.env.EXPO_PUBLIC_AUDD_TOKEN ?? '';
const RECOGNITION_MIN_INTERVAL_MS = 30_000;
// A recognized song is reported only while it was confirmed recently, so a track
// that ended does not keep tagging later windows.
const SONG_STALE_MS = 120_000;
// Rolling in-memory audio buffer on iOS; recognition matches the last few seconds of it
const CAPTURE_BUFFER_SECONDS = 12;
const SHAZAM_MATCH_SECONDS = 8;
const DB_CHUNK_SAMPLES = 2048;

interface RecognizedTrack {
  label: string;               // "Artist – Title", on-device display only
  genre: string | null;
  bpm: number | null;
  isrc: string | null;
  popularity: number | null;   // Deezer rank
  source: RecognitionSource;
  confirmedAt: number;
}

interface PendingAuddTrack {
  label: string;
  genre: string | null;
  bpm: number | null;
  isrc: string | null;
  popularity: number | null;
}

export class AudioAnalyzer {
  private isRecording = false;
  private lastRecognitionAt = 0;
  private track: RecognizedTrack | null = null;
  private pendingAudd: PendingAuddTrack | null = null;
  private deezerCache = new Map<string, { bpm: number | null; rank: number | null }>();
  private loggedShazamError = false;

  /**
   * iOS: open the microphone for the whole session. A continuously running audio input
   * is what keeps the app alive in the background; separate clips with gaps let iOS
   * suspend it. Audio stays in a short in-memory ring buffer and is never written to disk.
   */
  async start(): Promise<void> {
    try {
      // Ask up front on every platform: Android's session service only gets microphone
      // access in the background if the permission is already granted when it starts.
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted || !isAudioCaptureAvailable) return;
      await startCapture(CAPTURE_BUFFER_SECONDS);
    } catch (err) {
      console.warn(`${LOG_TAG} Could not start continuous capture:`, err);
    }
  }

  async stop(): Promise<void> {
    if (!isAudioCaptureAvailable) return;
    await stopCapture().catch(() => {});
  }

  /**
   * Analyze a 5-second slice of audio and return computed metrics.
   * No audio is ever saved to disk permanently — only the metrics object is returned.
   * iOS: reads the latest 5 s from the continuous in-memory capture.
   * Android: streams raw PCM via react-native-audio-record for the same pipeline.
   */
  async analyze(): Promise<AudioMetrics | null> {
    if (this.isRecording) {
      console.warn(`${LOG_TAG} Already recording, skipping`);
      return null;
    }

    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        console.warn(`${LOG_TAG} Microphone permission not granted`);
        return this.buildFallbackMetrics();
      }

      this.isRecording = true;

      return Platform.OS === 'android'
        ? await this.analyzeAndroid()
        : await this.analyzeIOS();
    } catch (err) {
      console.warn(`${LOG_TAG} Error during analysis:`, err);
      return null;
    } finally {
      this.isRecording = false;
    }
  }

  // ─── iOS ─────────────────────────────────────────────────────────────────────

  private async analyzeIOS(): Promise<AudioMetrics | null> {
    if (!isCapturing()) await this.start();
    // Wait for a fresh 5 s of audio, recorded while motion is sampled in parallel
    await new Promise(r => setTimeout(r, SENSOR_CONFIG.AUDIO_SAMPLE_DURATION_MS));
    const recent = await readRecent(SENSOR_CONFIG.AUDIO_SAMPLE_DURATION_MS / 1000);
    if (!recent || recent.count < 4096) {
      console.warn(`${LOG_TAG} No audio from continuous capture`);
      return this.buildFallbackMetrics();
    }

    const pcmSamples = decodePCMChunk(recent.pcm);
    // dB per ~46 ms chunk, the same granularity as the Android path
    const dbSamples: number[] = [];
    for (let i = 0; i + DB_CHUNK_SAMPLES <= pcmSamples.length; i += DB_CHUNK_SAMPLES) {
      dbSamples.push(dbFullScaleToAmbient(rmsToDb(computeRMS(pcmSamples.slice(i, i + DB_CHUNK_SAMPLES))), SENSOR_CONFIG.IOS_RAW_MIC_DBFS_OFFSET));
    }
    return this.analyzePCMSamples(pcmSamples, dbSamples, null, 'audio/wav', recent.startMs);
  }

  // ─── Android ─────────────────────────────────────────────────────────────────

  private async analyzeAndroid(): Promise<AudioMetrics | null> {
    AudioRecord.init({
      sampleRate: SENSOR_CONFIG.AUDIO_SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6, // MediaRecorder.AudioSource.MIC
      wavFile: 'viibemeter_temp.wav',
    });

    const pcmSamples: number[] = [];
    const dbSamples: number[] = [];

    // The bundled TS types declare on() as void but the underlying NativeEventEmitter
    // returns an EmitterSubscription — cast it so we can clean up after stop().
    const subscription = (AudioRecord.on as unknown as (
      event: 'data',
      cb: (data: string) => void,
    ) => { remove: () => void })('data', (data: string) => {
      const chunk = decodePCMChunk(data);
      if (chunk.length === 0) return;
      for (const s of chunk) pcmSamples.push(s);
      // Derive dB from RMS so Android metering matches iOS granularity
      dbSamples.push(dbFullScaleToAmbient(rmsToDb(computeRMS(chunk))));
    });

    AudioRecord.start();
    const recordStartMs = Date.now();
    await new Promise(r => setTimeout(r, SENSOR_CONFIG.AUDIO_SAMPLE_DURATION_MS));
    const filePath = await AudioRecord.stop();
    subscription?.remove?.();

    if (dbSamples.length === 0) {
      console.warn(`${LOG_TAG} No audio chunks received from AudioRecord`);
      return this.buildFallbackMetrics();
    }

    // AudioRecord returns an absolute path; FormData upload needs a file:// URI
    const fileUri = filePath ? `file://${filePath}` : null;
    return this.analyzePCMSamples(pcmSamples, dbSamples, fileUri, 'audio/wav', recordStartMs);
  }

  // ─── Shared PCM analysis (called by both platforms) ──────────────────────────

  private async analyzePCMSamples(
    pcmSamples: number[],
    dbSamples: number[],
    fileUri: string | null,
    fileType: string,
    recordStartMs: number,
  ): Promise<AudioMetrics | null> {
    const avgDb = dbSamples.reduce((s, v) => s + v, 0) / dbSamples.length;
    const maxDb = Math.max(...dbSamples);
    const dbVariance = dbSamples.reduce((s, v) => s + (v - avgDb) ** 2, 0) / dbSamples.length;
    const clapCount = detectClaps(dbSamples);

    let bpmResult = estimateBPMFromMeteringPattern(dbSamples);
    let bassPresence = estimateBassPresence(avgDb, dbVariance);
    let midHighRatio = 0.5;
    let subBassEnergy = 0;
    let spectralCentroid = 0;
    let spectralFlux = 0;
    let crestFactorVal = 0;
    let vocalPresence = 0;
    let harmonicNoiseRatio = 0;
    let beatBpm: number | null = null;
    let beatOnsetTimesMs: number[] = [];

    let pulseClarity: number | null = null;
    if (pcmSamples.length >= 4096) {
      // A recognised song's tempo narrows the search, so the beat grid survives a muffled mic
      const knownBpm = this.track && Date.now() - this.track.confirmedAt <= SONG_STALE_MS ? this.track.bpm : null;
      const pcmBpm = detectBPM(pcmSamples, SENSOR_CONFIG.AUDIO_SAMPLE_RATE, knownBpm);
      pulseClarity = pcmBpm.confidence;
      if (pcmBpm.bpm != null) {
        bpmResult = pcmBpm;
        beatBpm = pcmBpm.bpm;
        beatOnsetTimesMs = pcmBpm.onsetTimes.map(t => recordStartMs + t * 1000);
      }

      const fft = computeFFT(pcmSamples.slice(0, 4096), SENSOR_CONFIG.AUDIO_SAMPLE_RATE);
      const total = totalEnergy(fft);
      if (total > 0) {
        bassPresence = Math.min(1, bandEnergy(fft, 20, 250) / total);
        const mid = bandEnergy(fft, 250, 4000);
        const high = bandEnergy(fft, 4000, 20000);
        midHighRatio = high > 0 ? mid / (mid + high) : 0.5;
        subBassEnergy = subBassRatio(fft);
        spectralCentroid = fftSpectralCentroid(fft);
        vocalPresence = fftVocalPresence(fft);
        harmonicNoiseRatio = fftHNR(fft);
      }
      crestFactorVal = fftCrestFactor(pcmSamples);
      spectralFlux = computeSpectralFlux(pcmSamples, SENSOR_CONFIG.AUDIO_SAMPLE_RATE);
    }

    const musicDetected = detectMusicFromMetering(avgDb, dbVariance, bpmResult.confidence);
    const audioClassification = classifyAudio(avgDb, musicDetected);
    const audioEvent = classifyAudioEvent(dbSamples, clapCount, avgDb, dbVariance, musicDetected);

    try {
      await this.attemptRecognition(fileUri, audioClassification, avgDb, fileType);
    } finally {
      // Raw audio must never persist on the device: drop the temp recording
      if (fileUri) await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
    }

    const track = this.track && Date.now() - this.track.confirmedAt <= SONG_STALE_MS ? this.track : null;

    return {
      avgDb,
      maxDb,
      dbVariance,
      musicDetected,
      estimatedBpm: bpmResult.bpm,
      recognizedBpm: track?.bpm ?? null,
      bpmConfidence: bpmResult.confidence,
      pulseClarity,
      audioClassification,
      bassPresence,
      midHighRatio,
      subBassEnergy,
      spectralCentroid,
      spectralFlux,
      crestFactor: crestFactorVal,
      vocalPresence,
      harmonicNoiseRatio,
      beatBpm,
      beatOnsetTimesMs,
      clapCount,
      audioEvent,
      recognizedSong: track?.label ?? null,
      recognizedGenre: track?.genre ?? null,
      recognizedIsrc: track?.isrc ?? null,
      trackPopularity: track?.popularity ?? null,
      recognitionSource: track?.source ?? null,
    };
  }

  // ─── Song recognition ─────────────────────────────────────────────────────────
  // iOS: ShazamKit on the in-memory audio (fingerprint only, free). Elsewhere: AudD (uploads the clip),
  // only when a token is configured. Deezer fills in tempo and popularity by ISRC.

  private async attemptRecognition(
    fileUri: string | null,
    classification: AudioClassification,
    avgDb: number,
    fileType: string,
  ): Promise<void> {
    if (Date.now() - this.lastRecognitionAt < RECOGNITION_MIN_INTERVAL_MS) return;

    try {
      if (isAudioCaptureAvailable) {
        // Shazam is free and only matches real music, so it also runs in quieter rooms
        // (background music in a café) that the classifier would call silent
        if (avgDb < SENSOR_CONFIG.SHAZAM_MIN_DB) return;
        this.lastRecognitionAt = Date.now();
        await this.recognizeWithShazam();
      } else if (AUDD_TOKEN && fileUri) {
        // AudD is paid and uploads the clip: only try when the room is clearly loud
        if (classification === 'silent' || avgDb < SENSOR_CONFIG.AUDIO_DB_TALKING) return;
        this.lastRecognitionAt = Date.now();
        await this.recognizeWithAudd(fileUri, fileType);
      }
    } catch (err) {
      console.warn(`${LOG_TAG} Song recognition error:`, err);
    }
  }

  private async recognizeWithShazam(): Promise<void> {
    const result = await matchRecent(SHAZAM_MATCH_SECONDS);
    if (!result) return;
    if (result.error && !this.loggedShazamError) {
      this.loggedShazamError = true;
      console.warn(`${LOG_TAG} ShazamKit: ${result.error}`);
    }
    if (!result.matched) return;

    const isrc = result.isrc ?? null;
    const deezer = isrc ? await this.lookupDeezer(isrc) : null;
    // A single ShazamKit match is reliable, so no second confirmation is needed
    this.track = {
      label: `${result.artist ?? '?'} – ${result.title ?? '?'}`,
      genre: result.genres?.[0] ?? null,
      bpm: deezer?.bpm ?? null,
      isrc,
      popularity: deezer?.rank ?? null,
      source: 'shazam',
      confirmedAt: Date.now(),
    };
  }

  private async recognizeWithAudd(fileUri: string, fileType: string): Promise<void> {
    const fileName = fileType === 'audio/wav' ? 'sample.wav' : 'sample.m4a';
    const formData = new FormData();
    formData.append('file', { uri: fileUri, type: fileType, name: fileName } as any);
    formData.append('api_token', AUDD_TOKEN);
    formData.append('return', 'apple_music,deezer');

    const response = await fetch('https://api.audd.io/', {
      method: 'POST',
      body: formData,
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();
    if (data.status !== 'success' || !data.result) {
      this.pendingAudd = null;
      return;
    }

    const amAttrs = data.result.apple_music?.attributes;
    const genres: string[] | undefined = amAttrs?.genreNames;
    const amTempo: number | null = amAttrs?.tempo ? Math.round(amAttrs.tempo) : null;
    const deezerBpm: number | null = data.result.deezer?.bpm ? Math.round(data.result.deezer.bpm) : null;
    const candidate: PendingAuddTrack = {
      label: `${data.result.artist} – ${data.result.title}`,
      genre: genres && genres.length > 0 ? genres[0] : null,
      bpm: amTempo ?? deezerBpm,
      isrc: amAttrs?.isrc ?? data.result.deezer?.isrc ?? null,
      popularity: data.result.deezer?.rank ?? null,
    };

    // AudD occasionally returns a wrong match, so require the same song twice in a row
    if (candidate.label === this.pendingAudd?.label) {
      this.track = { ...candidate, source: 'audd', confirmedAt: Date.now() };
    } else {
      this.pendingAudd = candidate;
    }
  }

  /** Tempo and popularity rank from Deezer's public API (only the ISRC is sent). */
  private async lookupDeezer(isrc: string): Promise<{ bpm: number | null; rank: number | null } | null> {
    const cached = this.deezerCache.get(isrc);
    if (cached) return cached;
    try {
      const response = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
      const data = await response.json();
      if (data.error) return null;
      const info = {
        bpm: typeof data.bpm === 'number' && data.bpm > 0 ? Math.round(data.bpm) : null,
        rank: typeof data.rank === 'number' && data.rank > 0 ? data.rank : null,
      };
      this.deezerCache.set(isrc, info);
      return info;
    } catch {
      return null;
    }
  }

  private buildFallbackMetrics(): AudioMetrics {
    return {
      avgDb: 0, maxDb: 0, dbVariance: 0, musicDetected: false,
      estimatedBpm: null, recognizedBpm: null, bpmConfidence: 0, pulseClarity: null, audioClassification: 'silent',
      bassPresence: 0, midHighRatio: 0,
      subBassEnergy: 0, spectralCentroid: 0, spectralFlux: 0,
      crestFactor: 0, vocalPresence: 0, harmonicNoiseRatio: 0,
      beatBpm: null, beatOnsetTimesMs: [],
      clapCount: 0, audioEvent: null, recognizedSong: null, recognizedGenre: null,
      recognizedIsrc: null, trackPopularity: null, recognitionSource: null,
    };
  }
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

/**
 * Decode a base64-encoded raw 16-bit LE PCM chunk (no WAV header) into
 * normalized float samples in [-1, 1]. Used by the Android AudioRecord path.
 */
function decodePCMChunk(base64: string): number[] {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const samples: number[] = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      let s = bytes[i] | (bytes[i + 1] << 8);
      if (s >= 32768) s -= 65536;
      samples.push(s / 32768);
    }
    return samples;
  } catch {
    return [];
  }
}

/**
 * Estimate BPM from dB metering pattern using rhythm in amplitude envelope.
 * Fallback when PCM samples are unavailable or too short.
 */
function estimateBPMFromMeteringPattern(dbSamples: number[]): { bpm: number | null; confidence: number } {
  if (dbSamples.length < 20) return { bpm: null, confidence: 0 };

  const mean = dbSamples.reduce((s, v) => s + v, 0) / dbSamples.length;
  const std = Math.sqrt(dbSamples.reduce((s, v) => s + (v - mean) ** 2, 0) / dbSamples.length);

  if (std < 2) return { bpm: null, confidence: 0 };

  const threshold = mean + std * 0.5;
  const peakIndices: number[] = [];

  for (let i = 1; i < dbSamples.length - 1; i++) {
    if (dbSamples[i] > threshold &&
        dbSamples[i] > dbSamples[i - 1] &&
        dbSamples[i] > dbSamples[i + 1]) {
      if (peakIndices.length === 0 || i - peakIndices[peakIndices.length - 1] > 3) {
        peakIndices.push(i);
      }
    }
  }

  if (peakIndices.length < 3) return { bpm: null, confidence: 0 };

  const SAMPLE_INTERVAL_SEC = SENSOR_CONFIG.AUDIO_SAMPLE_DURATION_MS / 1000 / dbSamples.length;
  const iois: number[] = [];
  for (let i = 1; i < peakIndices.length; i++) {
    const ioi = (peakIndices[i] - peakIndices[i - 1]) * SAMPLE_INTERVAL_SEC;
    const bpm = 60 / ioi;
    if (bpm >= SENSOR_CONFIG.BPM_MIN && bpm <= SENSOR_CONFIG.BPM_MAX) iois.push(bpm);
  }

  if (iois.length < 2) return { bpm: null, confidence: 0 };

  const sorted = [...iois].sort((a, b) => a - b);
  const medianBPM = sorted[Math.floor(sorted.length / 2)];
  const tolerance = medianBPM * 0.1;
  const agreeing = iois.filter(b => Math.abs(b - medianBPM) <= tolerance).length;
  const confidence = agreeing / iois.length * 0.7;

  if (confidence < SENSOR_CONFIG.BPM_CONFIDENCE_THRESHOLD) return { bpm: null, confidence };
  return { bpm: Math.round(medianBPM), confidence };
}

function estimateBassPresence(avgDb: number, dbVariance: number): number {
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_TALKING) return 0;
  const normalizedDb = Math.min(1, (avgDb - SENSOR_CONFIG.AUDIO_DB_TALKING) / 40);
  const normalizedVar = Math.min(1, dbVariance / 100);
  return (normalizedDb * 0.6 + normalizedVar * 0.4);
}

function detectMusicFromMetering(avgDb: number, dbVariance: number, bpmConfidence: number): boolean {
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_TALKING) return false;
  if (bpmConfidence >= SENSOR_CONFIG.BPM_CONFIDENCE_THRESHOLD) return true;
  return avgDb > SENSOR_CONFIG.AUDIO_DB_LOW_MUSIC && dbVariance > 10;
}

function classifyAudioEvent(
  dbSamples: number[],
  clapCount: number,
  avgDb: number,
  dbVariance: number,
  musicDetected: boolean,
): AudioEvent | null {
  if (dbSamples.length < 4) return null;
  const range = Math.max(...dbSamples) - Math.min(...dbSamples);
  if (range > 35 && dbVariance > 180 && musicDetected) return 'dj_drop';
  if (clapCount >= 2) return 'crowd_clapping';
  if (avgDb > 70 && dbVariance > 60 && !musicDetected) return 'cheering';
  return null;
}

function detectClaps(dbSamples: number[]): number {
  if (dbSamples.length < 4) return 0;
  const mean = dbSamples.reduce((s, v) => s + v, 0) / dbSamples.length;
  let count = 0;
  let i = 1;
  while (i < dbSamples.length - 1) {
    const spike = dbSamples[i] - mean;
    const rising  = dbSamples[i] > dbSamples[i - 1] + 8;
    const falling = dbSamples[i] > dbSamples[i + 1] + 5;
    if (spike > 15 && rising && falling) {
      count++;
      i += 3;
    } else {
      i++;
    }
  }
  return count;
}
