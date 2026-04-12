/**
 * BPM detection via spectral flux onset detection.
 *
 * Algorithm:
 * 1. Compute FFT frame for each audio chunk
 * 2. Compute spectral flux (sum of positive magnitude differences between frames)
 * 3. Find peaks in the flux signal (onsets)
 * 4. Compute inter-onset intervals → BPM
 */

import { computeFFT, FFTResult } from './FFTProcessor';
import { SENSOR_CONFIG } from '../config/constants';

export interface BPMResult {
  bpm: number | null;
  confidence: number;  // 0.0 to 1.0
  onsetCount: number;
}

const HOP_SIZE = 512;   // samples between frames
const FRAME_SIZE = 2048;

/**
 * Detect BPM from a sequence of PCM audio samples.
 * @param samples - Raw PCM samples (normalized -1.0 to 1.0)
 * @param sampleRate - e.g. 44100
 */
export function detectBPM(samples: number[], sampleRate: number): BPMResult {
  if (samples.length < FRAME_SIZE * 2) {
    return { bpm: null, confidence: 0, onsetCount: 0 };
  }

  // Build sequence of FFT frames
  const frames: number[][] = [];
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    const chunk = samples.slice(start, start + FRAME_SIZE);
    const result = computeFFT(chunk, sampleRate);
    frames.push(result.magnitudes);
  }

  if (frames.length < 4) {
    return { bpm: null, confidence: 0, onsetCount: 0 };
  }

  // Compute spectral flux between consecutive frames
  const flux: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    let f = 0;
    for (let b = 0; b < frames[i].length; b++) {
      const diff = frames[i][b] - frames[i - 1][b];
      if (diff > 0) f += diff;
    }
    flux.push(f);
  }

  // Dynamic threshold: local mean + 1.5 * local std over a window
  const THRESHOLD_WINDOW = 10;
  const onsetTimes: number[] = [];
  const hopDuration = HOP_SIZE / sampleRate; // seconds per hop

  for (let i = 1; i < flux.length - 1; i++) {
    const windowStart = Math.max(0, i - THRESHOLD_WINDOW);
    const windowEnd = Math.min(flux.length, i + THRESHOLD_WINDOW);
    const window = flux.slice(windowStart, windowEnd);

    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const std = Math.sqrt(
      window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length
    );
    const threshold = mean + 1.5 * std;

    // Peak: higher than neighbors and above threshold
    if (flux[i] > threshold && flux[i] > flux[i - 1] && flux[i] > flux[i + 1]) {
      onsetTimes.push((i + 1) * hopDuration); // +1 because flux[0] = diff(frame1, frame0)
    }
  }

  if (onsetTimes.length < 3) {
    return { bpm: null, confidence: 0, onsetCount: onsetTimes.length };
  }

  // Compute inter-onset intervals (IOIs)
  const iois: number[] = [];
  for (let i = 1; i < onsetTimes.length; i++) {
    iois.push(onsetTimes[i] - onsetTimes[i - 1]);
  }

  // Convert IOIs to BPM candidates
  const bpmCandidates = iois.map((ioi) => 60 / ioi);

  // Filter to valid BPM range
  const validCandidates = bpmCandidates.filter(
    (b) => b >= SENSOR_CONFIG.BPM_MIN && b <= SENSOR_CONFIG.BPM_MAX
  );

  if (validCandidates.length < 2) {
    return { bpm: null, confidence: 0, onsetCount: onsetTimes.length };
  }

  // Find median BPM
  const sorted = [...validCandidates].sort((a, b) => a - b);
  const medianBPM = sorted[Math.floor(sorted.length / 2)];

  // Compute confidence: fraction of candidates within ±5% of median
  const tolerance = medianBPM * SENSOR_CONFIG.BPM_TOLERANCE_PCT;
  const agreeing = validCandidates.filter(
    (b) => Math.abs(b - medianBPM) <= tolerance
  ).length;
  const confidence = agreeing / validCandidates.length;

  if (confidence < SENSOR_CONFIG.BPM_CONFIDENCE_THRESHOLD) {
    return { bpm: null, confidence, onsetCount: onsetTimes.length };
  }

  return {
    bpm: Math.round(medianBPM),
    confidence,
    onsetCount: onsetTimes.length,
  };
}

/**
 * Compute spectral flux between two FFT magnitude arrays.
 * Used for audio energy variance tracking.
 */
export function spectralFlux(prev: number[], curr: number[]): number {
  let flux = 0;
  const len = Math.min(prev.length, curr.length);
  for (let i = 0; i < len; i++) {
    const diff = curr[i] - prev[i];
    if (diff > 0) flux += diff;
  }
  return flux;
}
