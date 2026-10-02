/**
 * BPM detection from the spectral-flux onset envelope.
 *
 * Algorithm:
 * 1. Compute FFT frame for each audio chunk
 * 2. Compute spectral flux (sum of positive magnitude differences between frames)
 * 3. Autocorrelate the flux envelope over lags for 60–200 BPM, weighted by a tempo
 *    prior centred on 120 BPM to avoid half/double-tempo errors, and take the peak
 * 4. Find the beat phase that best fits the envelope and return that beat grid
 *
 * Intervals between consecutive onsets are not used: hi-hats and snares between kicks
 * make them a fraction of the beat (120 BPM with off-beat hats reads as 240 BPM).
 */

import { computeFFT } from './FFTProcessor';
import { SENSOR_CONFIG } from '../config/constants';

export interface BPMResult {
  bpm: number | null;
  confidence: number;  // 0.0 to 1.0: normalized autocorrelation at the beat period (pulse clarity)
  onsetCount: number;
  onsetTimes: number[]; // beat grid, seconds from the start of the sample buffer
}

const HOP_SIZE = 512;   // samples between frames
const FRAME_SIZE = 2048;
const TEMPO_PRIOR_BPM = 120;
const TEMPO_PRIOR_OCTAVES = 1.0; // std-dev of the log2 tempo prior
const HALF_LAG_RATIO = 0.6;      // double-tempo preference threshold
const LOW_BAND_HZ = 200;

/**
 * Detect BPM from a sequence of PCM audio samples.
 * @param samples - Raw PCM samples (normalized -1.0 to 1.0)
 * @param sampleRate - e.g. 44100
 */
export function detectBPM(samples: number[], sampleRate: number): BPMResult {
  if (samples.length < FRAME_SIZE * 2) {
    return { bpm: null, confidence: 0, onsetCount: 0, onsetTimes: [] };
  }

  // Build sequence of FFT frames
  const frames: number[][] = [];
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    const chunk = samples.slice(start, start + FRAME_SIZE);
    const result = computeFFT(chunk, sampleRate);
    frames.push(result.magnitudes);
  }

  if (frames.length < 4) {
    return { bpm: null, confidence: 0, onsetCount: 0, onsetTimes: [] };
  }

  // Two flux signals: full band, and bass only (below ~200 Hz) where the kick drum lives.
  // A broadband snare dominates full-band flux and repeats every two beats; the bass band
  // keeps the beat itself in the envelope.
  const binHz = sampleRate / FRAME_SIZE;
  const lowBins = Math.max(2, Math.round(LOW_BAND_HZ / binHz));
  const fluxFull: number[] = [];
  const fluxLow: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    let full = 0, low = 0;
    for (let b = 0; b < frames[i].length; b++) {
      const diff = frames[i][b] - frames[i - 1][b];
      if (diff > 0) {
        full += diff;
        if (b < lowBins) low += diff;
      }
    }
    fluxFull.push(full);
    fluxLow.push(low);
  }

  const hopDuration = HOP_SIZE / sampleRate; // seconds per hop
  // flux[i] describes the change into frame i + 1; an attack registers while it enters
  // the frame, so report the frame centre
  const frameTime = (i: number) => (i + 1) * hopDuration + FRAME_SIZE / (2 * sampleRate);

  // Onset envelope: each flux minus its local mean, half-wave rectified, scaled to unit
  // energy, then summed so neither band dominates
  const envFull = normalize(onsetEnvelope(fluxFull));
  const envLow = normalize(onsetEnvelope(fluxLow));
  const env = envFull.map((v, i) => v + envLow[i]);
  const onsetCount = countPeaks(env);

  // Zero-mean copy for the autocorrelation, so steady noise does not look periodic
  const envMean = env.reduce((s, v) => s + v, 0) / env.length;
  const centered = env.map(v => v - envMean);
  const energy = centered.reduce((s, v) => s + v * v, 0);
  if (energy <= 0) return { bpm: null, confidence: 0, onsetCount, onsetTimes: [] };

  // Normalized autocorrelation over the beat-period lag range
  const minLag = Math.max(2, Math.floor(60 / (SENSOR_CONFIG.BPM_MAX * hopDuration)));
  const maxLag = Math.min(env.length - 2, Math.ceil(60 / (SENSOR_CONFIG.BPM_MIN * hopDuration)));
  if (maxLag <= minLag) return { bpm: null, confidence: 0, onsetCount, onsetTimes: [] };

  const acf: number[] = new Array(maxLag + 2).fill(0);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < centered.length; i++) s += centered[i] * centered[i + lag];
    // Unbiased: compensate for fewer overlapping terms at long lags
    acf[lag] = (s / energy) * (env.length / (env.length - lag));
  }

  let bestLag = -1, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (!(acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1])) continue; // local maxima only
    const bpm = 60 / (lag * hopDuration);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / TEMPO_PRIOR_BPM) / TEMPO_PRIOR_OCTAVES) ** 2);
    const score = acf[lag] * prior;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag < 0) return { bpm: null, confidence: 0, onsetCount, onsetTimes: [] };

  // Alternating kick/snare repeats every two beats, so the full pattern can out-score
  // the beat. Prefer the double tempo when its correlation is nearly as strong.
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag) {
    let h = halfLag;
    for (const cand of [halfLag - 1, halfLag + 1]) if (cand >= minLag && acf[cand] > acf[h]) h = cand;
    if (acf[h] >= HALF_LAG_RATIO * acf[bestLag]) bestLag = h;
  }

  // Parabolic interpolation for a sub-hop period estimate
  const a = acf[bestLag - 1], b = acf[bestLag], c = acf[bestLag + 1];
  const denom = a - 2 * b + c;
  const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom)) : 0;
  const periodHops = bestLag + offset;
  const bpm = 60 / (periodHops * hopDuration);
  const confidence = Math.max(0, Math.min(1, b));

  if (confidence < SENSOR_CONFIG.BPM_PCM_MIN_CLARITY || bpm < SENSOR_CONFIG.BPM_MIN || bpm > SENSOR_CONFIG.BPM_MAX) {
    return { bpm: null, confidence, onsetCount, onsetTimes: [] };
  }

  // Beat phase: the grid offset that collects the most onset energy
  const PHASE_STEPS = Math.max(8, Math.round(periodHops));
  let bestPhase = 0, bestPhaseSum = -Infinity;
  for (let k = 0; k < PHASE_STEPS; k++) {
    const phase = (k / PHASE_STEPS) * periodHops;
    let sum = 0;
    for (let t = phase; t < env.length; t += periodHops) {
      const i = Math.round(t);
      if (i < env.length) sum += env[i];
    }
    if (sum > bestPhaseSum) { bestPhaseSum = sum; bestPhase = phase; }
  }
  const onsetTimes: number[] = [];
  for (let t = bestPhase; t < env.length; t += periodHops) onsetTimes.push(frameTime(t));

  return { bpm: Math.round(bpm), confidence, onsetCount, onsetTimes };
}

function onsetEnvelope(flux: number[]): number[] {
  const LOCAL_WINDOW = 8;
  return flux.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - LOCAL_WINDOW); j <= Math.min(flux.length - 1, i + LOCAL_WINDOW); j++) {
      sum += flux[j]; n++;
    }
    return Math.max(0, flux[i] - sum / n);
  });
}

function normalize(x: number[]): number[] {
  const norm = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? x.map(v => v / norm) : x;
}

function countPeaks(env: number[]): number {
  let n = 0;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] > 0 && env[i] > env[i - 1] && env[i] >= env[i + 1]) n++;
  }
  return n;
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
