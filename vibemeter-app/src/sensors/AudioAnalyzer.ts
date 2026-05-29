import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { AudioMetrics, AudioEvent, AudioClassification } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import {
  computeFFT, bandEnergy, totalEnergy,
  spectralCentroid as fftSpectralCentroid, subBassRatio, vocalPresence as fftVocalPresence,
  harmonicNoiseRatio as fftHNR, computeSpectralFlux, crestFactor as fftCrestFactor,
} from '../processing/FFTProcessor';
import { detectBPM } from '../processing/BPMDetector';
import { classifyAudio, computeRMS, rmsToDb, dbFullScaleToAmbient } from '../processing/AudioClassifier';
import AudioRecord from 'react-native-audio-record';

const LOG_TAG = '[AudioAnalyzer]';
const AUDD_TOKEN = process.env.EXPO_PUBLIC_AUDD_TOKEN ?? '';
const RECOGNITION_MIN_INTERVAL_MS = 5_000;

export class AudioAnalyzer {
  private isRecording = false;
  private lastRecognitionAt = 0;
  private lastRecognizedSong: string | null = null;
  private lastRecognizedGenre: string | null = null;
  private lastRecognizedBpm: number | null = null;
  private pendingSong: string | null = null;
  private pendingGenre: string | null = null;
  private pendingBpm: number | null = null;

  /**
   * Capture a 5-second audio sample and return computed metrics.
   * No audio is ever saved to disk permanently — only the metrics object is returned.
   * iOS: records 16-bit PCM WAV via expo-av, extracts samples after recording.
   * Android: streams raw PCM via react-native-audio-record for full FFT parity with iOS.
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
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
    });

    const dbSamples: number[] = [];
    const recording = new Audio.Recording();

    await recording.prepareToRecordAsync({
      isMeteringEnabled: true,
      android: Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
      ios: {
        extension: '.wav',
        audioQuality: Audio.IOSAudioQuality.HIGH,
        sampleRate: SENSOR_CONFIG.AUDIO_SAMPLE_RATE,
        numberOfChannels: 1,
        bitRate: 128000,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      },
      web: {},
    });

    // Collect dB metering samples during recording (~10/sec)
    recording.setOnRecordingStatusUpdate((status) => {
      if (status.isRecording && status.metering != null) {
        dbSamples.push(dbFullScaleToAmbient(status.metering));
      }
    });

    await recording.startAsync();
    await new Promise(r => setTimeout(r, SENSOR_CONFIG.AUDIO_SAMPLE_DURATION_MS));
    const fileUri = recording.getURI() ?? null;
    await recording.stopAndUnloadAsync();

    if (dbSamples.length === 0) {
      console.warn(`${LOG_TAG} No metering samples collected`);
      return this.buildFallbackMetrics();
    }

    // Extract raw PCM from the WAV file for FFT and BPM analysis
    const pcmSamples: number[] = [];
    if (fileUri) {
      const pcm = await extractPCMFromWAV(fileUri);
      if (pcm) pcmSamples.push(...pcm);
    }

    return this.analyzePCMSamples(pcmSamples, dbSamples, fileUri, 'audio/m4a');
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
      pcmSamples.push(...chunk);
      // Derive dB from RMS so Android metering matches iOS granularity
      dbSamples.push(dbFullScaleToAmbient(rmsToDb(computeRMS(chunk))));
    });

    AudioRecord.start();
    await new Promise(r => setTimeout(r, SENSOR_CONFIG.AUDIO_SAMPLE_DURATION_MS));
    const filePath = await AudioRecord.stop();
    subscription?.remove?.();

    if (dbSamples.length === 0) {
      console.warn(`${LOG_TAG} No audio chunks received from AudioRecord`);
      return this.buildFallbackMetrics();
    }

    // AudioRecord returns an absolute path; FormData upload needs a file:// URI
    const fileUri = filePath ? `file://${filePath}` : null;
    return this.analyzePCMSamples(pcmSamples, dbSamples, fileUri, 'audio/wav');
  }

  // ─── Shared PCM analysis (called by both platforms) ──────────────────────────

  private async analyzePCMSamples(
    pcmSamples: number[],
    dbSamples: number[],
    fileUri: string | null,
    fileType: string,
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

    if (pcmSamples.length >= 4096) {
      const pcmBpm = detectBPM(pcmSamples, SENSOR_CONFIG.AUDIO_SAMPLE_RATE);
      if (pcmBpm.bpm != null) bpmResult = pcmBpm;

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

    await this.attemptRecognition(fileUri, audioClassification, avgDb, fileType);

    return {
      avgDb,
      maxDb,
      dbVariance,
      musicDetected,
      estimatedBpm: bpmResult.bpm,
      recognizedBpm: this.lastRecognizedBpm,
      bpmConfidence: bpmResult.confidence,
      audioClassification,
      bassPresence,
      midHighRatio,
      subBassEnergy,
      spectralCentroid,
      spectralFlux,
      crestFactor: crestFactorVal,
      vocalPresence,
      harmonicNoiseRatio,
      clapCount,
      audioEvent,
      recognizedSong: this.lastRecognizedSong,
      recognizedGenre: this.lastRecognizedGenre,
    };
  }

  // ─── AudD song recognition ────────────────────────────────────────────────────

  private async attemptRecognition(
    fileUri: string | null,
    classification: AudioClassification,
    avgDb: number,
    fileType: string,
  ): Promise<void> {
    if (!AUDD_TOKEN || !fileUri) return;
    if (classification === 'silent') return;
    if (avgDb < SENSOR_CONFIG.AUDIO_DB_TALKING) return;
    if (Date.now() - this.lastRecognitionAt < RECOGNITION_MIN_INTERVAL_MS) return;

    try {
      this.lastRecognitionAt = Date.now();
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
      if (data.status === 'success' && data.result) {
        const candidate = `${data.result.artist} – ${data.result.title}`;
        const amAttrs = data.result.apple_music?.attributes;
        const genres: string[] | undefined = amAttrs?.genreNames;
        const genre = genres && genres.length > 0 ? genres[0] : null;
        const amTempo: number | null = amAttrs?.tempo ? Math.round(amAttrs.tempo) : null;
        const deezerBpm: number | null = data.result.deezer?.bpm ? Math.round(data.result.deezer.bpm) : null;
        const bpm = amTempo ?? deezerBpm;
        if (candidate === this.pendingSong) {
          this.lastRecognizedSong = candidate;
          this.lastRecognizedGenre = genre ?? this.lastRecognizedGenre;
          this.lastRecognizedBpm = bpm ?? this.lastRecognizedBpm;
        } else {
          this.pendingSong = candidate;
          this.pendingGenre = genre;
          this.pendingBpm = bpm;
        }
      } else {
        this.pendingSong = null;
        this.pendingGenre = null;
        this.pendingBpm = null;
      }
    } catch (err) {
      console.warn(`${LOG_TAG} Song recognition error:`, err);
    }
  }

  private buildFallbackMetrics(): AudioMetrics {
    return {
      avgDb: 0, maxDb: 0, dbVariance: 0, musicDetected: false,
      estimatedBpm: null, recognizedBpm: null, bpmConfidence: 0, audioClassification: 'silent',
      bassPresence: 0, midHighRatio: 0,
      subBassEnergy: 0, spectralCentroid: 0, spectralFlux: 0,
      crestFactor: 0, vocalPresence: 0, harmonicNoiseRatio: 0,
      clapCount: 0, audioEvent: null, recognizedSong: null, recognizedGenre: null,
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
 * Parse a WAV file (written by expo-av with linearPCMBitDepth:16) and return
 * normalized float32 samples in [-1, 1]. Returns null on any parse error.
 * Used by the iOS path only.
 */
async function extractPCMFromWAV(fileUri: string): Promise<number[] | null> {
  try {
    const b64 = await FileSystem.readAsStringAsync(fileUri, { encoding: 'base64' as any });
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    if (bytes.length < 44) return null;
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (riff !== 'RIFF') return null;

    let offset = 12;
    while (offset + 8 < bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
      const chunkSize = bytes[offset+4] | (bytes[offset+5] << 8) | (bytes[offset+6] << 16) | (bytes[offset+7] << 24);
      if (id === 'data') {
        offset += 8;
        const samples: number[] = [];
        for (let i = offset; i + 1 < offset + chunkSize && i + 1 < bytes.length; i += 2) {
          let s = bytes[i] | (bytes[i+1] << 8);
          if (s >= 32768) s -= 65536;
          samples.push(s / 32768);
        }
        return samples;
      }
      offset += 8 + chunkSize;
    }
    return null;
  } catch {
    return null;
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
