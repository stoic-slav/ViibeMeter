import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { AudioMetrics, AudioSample, AudioEvent, AudioClassification } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import {
  computeFFT, bandEnergy, totalEnergy,
  spectralCentroid as fftSpectralCentroid, subBassRatio, vocalPresence as fftVocalPresence,
  harmonicNoiseRatio as fftHNR, computeSpectralFlux, crestFactor as fftCrestFactor,
} from '../processing/FFTProcessor';
import { detectBPM } from '../processing/BPMDetector';
import { detectMusic, classifyAudio, computeRMS, rmsToDb, dbFullScaleToAmbient } from '../processing/AudioClassifier';

const LOG_TAG = '[AudioAnalyzer]';
const AUDD_TOKEN = process.env.EXPO_PUBLIC_AUDD_TOKEN ?? '';
const RECOGNITION_MIN_INTERVAL_MS = 5_000; // attempt once per 5s when music detected

export class AudioAnalyzer {
  private isRecording = false;
  private lastRecognitionAt = 0;
  private lastRecognizedSong: string | null = null;
  private lastRecognizedGenre: string | null = null;
  private lastRecognizedBpm: number | null = null;
  private pendingSong: string | null = null;      // candidate — must match twice before display
  private pendingGenre: string | null = null;
  private pendingBpm: number | null = null;

  /**
   * Capture a 5-second audio sample and return computed metrics.
   * No audio is ever saved to disk — only the metrics object is returned.
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

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });

      this.isRecording = true;

      // Collect dB metering samples during recording
      const dbSamples: number[] = [];
      let recording: Audio.Recording | null = null;

      // On iOS: record as 16-bit PCM WAV so we can extract samples for real BPM detection.
      // On Android: fall back to AAC metering (no WAV linear PCM support via expo-av).
      const recordingOptions: Audio.RecordingOptions = Platform.OS === 'ios'
        ? {
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
          }
        : {
            ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
            isMeteringEnabled: true,
            android: {
              ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
              sampleRate: SENSOR_CONFIG.AUDIO_SAMPLE_RATE,
              numberOfChannels: 1,
            },
            ios: Audio.RecordingOptionsPresets.HIGH_QUALITY.ios,
          };

      recording = new Audio.Recording();
      await recording.prepareToRecordAsync(recordingOptions);

      // Listen for metering updates (fires ~10x/sec)
      recording.setOnRecordingStatusUpdate((status) => {
        if (status.isRecording && status.metering != null) {
          // metering is dBFS (negative, 0 = full scale)
          // Convert to ambient dB SPL
          const ambient = dbFullScaleToAmbient(status.metering);
          dbSamples.push(ambient);
        }
      });

      await recording.startAsync();

      // Wait for the sample duration
      await new Promise(r => setTimeout(r, SENSOR_CONFIG.AUDIO_SAMPLE_DURATION_MS));

      const fileUri = recording.getURI() ?? null;
      await recording.stopAndUnloadAsync();

      // Clap / transient detection + crowd event classification
      const clapCount = detectClaps(dbSamples);

      if (dbSamples.length === 0) {
        console.warn(`${LOG_TAG} No metering samples collected`);
        return this.buildFallbackMetrics();
      }

      const avgDb = dbSamples.reduce((s, v) => s + v, 0) / dbSamples.length;
      const maxDb = Math.max(...dbSamples);
      const meanDb = avgDb;
      const dbVariance = dbSamples.reduce((s, v) => s + (v - meanDb) ** 2, 0) / dbSamples.length;

      // On iOS: extract PCM from WAV file → real spectral BPM + FFT features.
      // On Android: fall back to metering-based heuristic.
      let bpmResult = estimateBPMFromMeteringPattern(dbSamples);
      let bassPresence = estimateBassPresence(avgDb, dbVariance);
      let midHighRatio = 0.5;
      let subBassEnergy = 0;
      let spectralCentroid = 0;
      let spectralFlux = 0;
      let crestFactorVal = 0;
      let vocalPresence = 0;
      let harmonicNoiseRatio = 0;

      if (Platform.OS === 'ios' && fileUri) {
        const pcm = await extractPCMFromWAV(fileUri);
        if (pcm && pcm.length >= 4096) {
          const pcmBpm = detectBPM(pcm, SENSOR_CONFIG.AUDIO_SAMPLE_RATE);
          if (pcmBpm.bpm != null) bpmResult = pcmBpm;
          const fft = computeFFT(pcm.slice(0, 4096), SENSOR_CONFIG.AUDIO_SAMPLE_RATE);
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
          crestFactorVal = fftCrestFactor(pcm);
          spectralFlux = computeSpectralFlux(pcm, SENSOR_CONFIG.AUDIO_SAMPLE_RATE);
        }
      }

      // Music detection heuristic using available signals
      const musicDetected = detectMusicFromMetering(avgDb, dbVariance, bpmResult.confidence);

      const audioClassification = classifyAudio(avgDb, musicDetected);
      const audioEvent = classifyAudioEvent(dbSamples, clapCount, avgDb, dbVariance, musicDetected);

      // Song recognition (opt-in, requires EXPO_PUBLIC_AUDD_TOKEN)
      await this.attemptRecognition(fileUri, audioClassification, avgDb);

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
    } catch (err) {
      console.warn(`${LOG_TAG} Error during analysis:`, err);
      return null;
    } finally {
      this.isRecording = false;
    }
  }

  private async attemptRecognition(
    fileUri: string | null,
    classification: AudioClassification,
    avgDb: number,
  ): Promise<void> {
    if (!AUDD_TOKEN || !fileUri) return;
    if (classification === 'silent') return;
    if (avgDb < SENSOR_CONFIG.AUDIO_DB_TALKING) return;
    if (Date.now() - this.lastRecognitionAt < RECOGNITION_MIN_INTERVAL_MS) return;

    try {
      this.lastRecognitionAt = Date.now();
      const formData = new FormData();
      formData.append('file', { uri: fileUri, type: 'audio/m4a', name: 'sample.m4a' } as any);
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
        // Genre from Apple Music genreNames (most reliable source)
        const amAttrs = data.result.apple_music?.attributes;
        const genres: string[] | undefined = amAttrs?.genreNames;
        const genre = genres && genres.length > 0 ? genres[0] : null;
        // BPM: prefer Apple Music tempo, fall back to Deezer bpm field
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

/**
 * Estimate BPM from dB metering pattern using rhythm in amplitude envelope.
 * This is a simplified approach that works without raw PCM.
 * Looks for periodic peaks in the metering signal.
 */
function estimateBPMFromMeteringPattern(dbSamples: number[]): { bpm: number | null; confidence: number } {
  if (dbSamples.length < 20) return { bpm: null, confidence: 0 };

  // Find peaks in the dB envelope (local maxima above mean)
  const mean = dbSamples.reduce((s, v) => s + v, 0) / dbSamples.length;
  const std = Math.sqrt(dbSamples.reduce((s, v) => s + (v - mean) ** 2, 0) / dbSamples.length);

  if (std < 2) {
    // Very flat signal — no rhythmic content detectable
    return { bpm: null, confidence: 0 };
  }

  const threshold = mean + std * 0.5;
  const peakIndices: number[] = [];

  for (let i = 1; i < dbSamples.length - 1; i++) {
    if (dbSamples[i] > threshold &&
        dbSamples[i] > dbSamples[i - 1] &&
        dbSamples[i] > dbSamples[i + 1]) {
      // Avoid double-counting peaks within 3 samples of each other
      if (peakIndices.length === 0 || i - peakIndices[peakIndices.length - 1] > 3) {
        peakIndices.push(i);
      }
    }
  }

  if (peakIndices.length < 3) return { bpm: null, confidence: 0 };

  // Metering fires ~10x/sec, so each sample ≈ 0.1s
  const SAMPLE_INTERVAL_SEC = SENSOR_CONFIG.AUDIO_SAMPLE_DURATION_MS / 1000 / dbSamples.length;

  const iois: number[] = [];
  for (let i = 1; i < peakIndices.length; i++) {
    const ioi = (peakIndices[i] - peakIndices[i - 1]) * SAMPLE_INTERVAL_SEC;
    const bpm = 60 / ioi;
    if (bpm >= SENSOR_CONFIG.BPM_MIN && bpm <= SENSOR_CONFIG.BPM_MAX) {
      iois.push(bpm);
    }
  }

  if (iois.length < 2) return { bpm: null, confidence: 0 };

  const sorted = [...iois].sort((a, b) => a - b);
  const medianBPM = sorted[Math.floor(sorted.length / 2)];
  const tolerance = medianBPM * 0.1; // ±10% for metering-based estimate (less precise)
  const agreeing = iois.filter(b => Math.abs(b - medianBPM) <= tolerance).length;
  const confidence = agreeing / iois.length * 0.7; // Scale down confidence vs raw FFT method

  if (confidence < SENSOR_CONFIG.BPM_CONFIDENCE_THRESHOLD) {
    return { bpm: null, confidence };
  }

  return { bpm: Math.round(medianBPM), confidence };
}

function estimateBassPresence(avgDb: number, dbVariance: number): number {
  // Heuristic: high dB + high variance suggests bass-heavy content
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_TALKING) return 0;
  const normalizedDb = Math.min(1, (avgDb - SENSOR_CONFIG.AUDIO_DB_TALKING) / 40);
  const normalizedVar = Math.min(1, dbVariance / 100);
  return (normalizedDb * 0.6 + normalizedVar * 0.4);
}

function detectMusicFromMetering(avgDb: number, dbVariance: number, bpmConfidence: number): boolean {
  // Music tends to have: moderate-to-high dB, rhythmic variance, detected rhythm
  if (avgDb < SENSOR_CONFIG.AUDIO_DB_TALKING) return false;
  // If BPM was detected with decent confidence, likely music
  if (bpmConfidence >= SENSOR_CONFIG.BPM_CONFIDENCE_THRESHOLD) return true;
  // High dB with notable variance and no clear rhythm → could be music or crowd
  // Be conservative: require both dB threshold and variance signal
  return avgDb > SENSOR_CONFIG.AUDIO_DB_LOW_MUSIC && dbVariance > 10;
}

// Classify the overall audio event for the current window.
// Priority: dj_drop > crowd_clapping > cheering
function classifyAudioEvent(
  dbSamples: number[],
  clapCount: number,
  avgDb: number,
  dbVariance: number,
  musicDetected: boolean,
): AudioEvent | null {
  if (dbSamples.length < 4) return null;

  const range = Math.max(...dbSamples) - Math.min(...dbSamples);

  // DJ drop: massive dynamic range within the window — music suddenly surging from a quiet build-up
  // Signature: range >35dB AND high variance AND music detected
  if (range > 35 && dbVariance > 180 && musicDetected) return 'dj_drop';

  // Crowd clapping: 2+ sharp transients in the window
  if (clapCount >= 2) return 'crowd_clapping';

  // Cheering: loud, chaotic, sustained — high dB, high variance, not structured as music
  if (avgDb > 70 && dbVariance > 60 && !musicDetected) return 'cheering';

  return null;
}

/**
 * Parse a WAV file (written by expo-av with linearPCMBitDepth:16) and return
 * normalized float32 samples in [-1, 1].  Returns null on any parse error.
 */
async function extractPCMFromWAV(fileUri: string): Promise<number[] | null> {
  try {
    const b64 = await FileSystem.readAsStringAsync(fileUri, { encoding: 'base64' as any });
    // Decode base64 to byte array
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Parse WAV header: "RIFF....WAVEfmt " starts at offset 0
    if (bytes.length < 44) return null;
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (riff !== 'RIFF') return null;

    // Find "data" chunk
    let offset = 12;
    while (offset + 8 < bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
      const chunkSize = bytes[offset+4] | (bytes[offset+5] << 8) | (bytes[offset+6] << 16) | (bytes[offset+7] << 24);
      if (id === 'data') {
        offset += 8;
        const samples: number[] = [];
        // 16-bit little-endian signed PCM
        for (let i = offset; i + 1 < offset + chunkSize && i + 1 < bytes.length; i += 2) {
          let s = bytes[i] | (bytes[i+1] << 8);
          if (s >= 32768) s -= 65536; // sign extend
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

// Detect transient spikes (claps, snaps, crowd noise bursts) in metering data.
// A clap = sudden dB spike >15dB above mean that peaks then drops within the next sample.
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
      i += 3; // skip past the transient
    } else {
      i++;
    }
  }
  return count;
}
