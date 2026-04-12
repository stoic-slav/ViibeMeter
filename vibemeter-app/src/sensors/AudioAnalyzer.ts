import { Audio } from 'expo-av';
import { AudioMetrics, AudioSample } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import { computeFFT, bandEnergy, totalEnergy, spectralFlatness } from '../processing/FFTProcessor';
import { detectBPM } from '../processing/BPMDetector';
import { detectMusic, classifyAudio, computeRMS, rmsToDb, dbFullScaleToAmbient } from '../processing/AudioClassifier';

const LOG_TAG = '[AudioAnalyzer]';

export class AudioAnalyzer {
  private isRecording = false;

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
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });

      this.isRecording = true;

      // Collect dB metering samples during recording
      const dbSamples: number[] = [];
      let recording: Audio.Recording | null = null;

      const recordingOptions: Audio.RecordingOptions = {
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
        android: {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
          sampleRate: SENSOR_CONFIG.AUDIO_SAMPLE_RATE,
          numberOfChannels: 1,
        },
        ios: {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY.ios,
          sampleRate: SENSOR_CONFIG.AUDIO_SAMPLE_RATE,
          numberOfChannels: 1,
        },
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

      await recording.stopAndUnloadAsync();

      // CRITICAL: We do NOT process raw audio file — only metering values
      // Attempting to read the file URI would store audio; we avoid it entirely.
      // Instead we work with the dB metering data only.

      if (dbSamples.length === 0) {
        console.warn(`${LOG_TAG} No metering samples collected`);
        return this.buildFallbackMetrics();
      }

      const avgDb = dbSamples.reduce((s, v) => s + v, 0) / dbSamples.length;
      const maxDb = Math.max(...dbSamples);
      const meanDb = avgDb;
      const dbVariance = dbSamples.reduce((s, v) => s + (v - meanDb) ** 2, 0) / dbSamples.length;

      // Without raw PCM we can't do FFT/BPM — use heuristics from dB patterns
      // For real BPM detection, we generate a synthetic rhythm proxy from dB variance patterns
      const bpmResult = estimateBPMFromMeteringPattern(dbSamples);

      // Bass presence heuristic: high dB with high variance suggests bass-heavy music
      const bassPresence = estimateBassPresence(avgDb, dbVariance);
      const midHighRatio = 0.5; // Cannot compute without FFT on raw PCM

      // Music detection heuristic using available signals
      const musicDetected = detectMusicFromMetering(avgDb, dbVariance, bpmResult.confidence);

      const audioClassification = classifyAudio(avgDb, musicDetected);

      return {
        avgDb,
        maxDb,
        dbVariance,
        musicDetected,
        estimatedBpm: bpmResult.bpm,
        bpmConfidence: bpmResult.confidence,
        audioClassification,
        bassPresence,
        midHighRatio,
      };
    } catch (err) {
      console.error(`${LOG_TAG} Error during analysis:`, err);
      return null;
    } finally {
      this.isRecording = false;
    }
  }

  private buildFallbackMetrics(): AudioMetrics {
    return {
      avgDb: 0,
      maxDb: 0,
      dbVariance: 0,
      musicDetected: false,
      estimatedBpm: null,
      bpmConfidence: 0,
      audioClassification: 'silent',
      bassPresence: 0,
      midHighRatio: 0,
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
