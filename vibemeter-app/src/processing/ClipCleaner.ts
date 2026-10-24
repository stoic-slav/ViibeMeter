import { fftInPlace } from './FFTProcessor';

/**
 * Light clean-up of a short "moment" clip on the phone (build 29), and a check of whether the
 * music dominates it. Pure (no React Native), tested with `npx tsx scripts/clip-cleaner-test.ts`.
 *
 * Phone in a pocket or bag: the cloth rustles on the microphone in short, broadband bursts, while
 * the music is a steady, bass-heavy sound. So:
 * - a 40 Hz high-pass (in the spectrum, so no phase shift) removes handling rumble;
 * - frames whose treble (above 1.5 kHz) jumps far above its own recent level, with no matching
 *   bass, are rustle: their treble is turned down towards that level (not the music's hi-hats, which
 *   come with the beat and stay within the rolling baseline);
 * - the clip is brought to a comfortable level.
 * This is the first of several layers. Voices and the heavy lifting (voice/music separation,
 * merging several phones) happen on the server (`analysis/clip_enhance.py`), and the layers are
 * compared there. All thresholds are first guesses to check on a real night.
 */

const FRAME = 2048;
const HOP = 1024;
const HF_HZ = 1500;
const LF_HZ = 250;
const BASELINE_FRAMES = 65;      // ±1.5 s of frames at 44.1 kHz
const BASELINE_PCT = 0.85;       // of the treble energy in that span: regular hi-hats sit inside it, rare bursts don't
const RUSTLE_RATIO = 6;          // treble this many times its baseline = a burst
const BURST_TARGET = 2;         // a burst is turned down to about twice its baseline
const MIN_GAIN = 0.15;
const TARGET_PEAK = 0.7;         // about −3 dBFS
const MAX_BOOST = 16;            // never boost more than ~24 dB (near silence)

export interface MusicDominance {
  bassShare: number;     // 0–1: energy at 40–200 Hz of the energy at 40 Hz–8 kHz (club music is bass-heavy)
  rustleShare: number;   // 0–1: share of frames that are treble bursts (cloth, handling)
}

/** Sine window, used for analysis and synthesis: at 50% overlap the product sums to exactly 1. */
const win = (() => {
  const w = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) w[i] = Math.sin((Math.PI * (i + 0.5)) / FRAME);
  return w;
})();

interface Frames {
  re: Float32Array[];
  im: Float32Array[];
  hf: number[];   // treble energy per frame
  lf: number[];   // bass energy per frame
  bass: number;   // 40–200 Hz energy over the whole clip
  all: number;    // 40 Hz–8 kHz energy over the whole clip
}

/** Lets the app's other work (sensor timers, the screen) run between chunks of this one. */
export type Yielder = () => Promise<void>;
export const macroYield: Yielder = () => new Promise(resolve => setTimeout(resolve, 0));
const noYield: Yielder = () => Promise.resolve();
const FRAMES_PER_CHUNK = 12;

async function analyse(x: Float64Array, sampleRate: number, yielder: Yielder): Promise<Frames> {
  const re: Float32Array[] = [], im: Float32Array[] = [], hf: number[] = [], lf: number[] = [];
  const binHz = sampleRate / FRAME;
  const hfBin = Math.ceil(HF_HZ / binHz), lfBin = Math.floor(LF_HZ / binHz);
  const lo = Math.round(40 / binHz), mid = Math.round(200 / binHz), hi = Math.round(8000 / binHz);
  let bass = 0, all = 0, n = 0;
  for (let start = 0; start + FRAME <= x.length; start += HOP) {
    const r = new Float64Array(FRAME), i = new Float64Array(FRAME);
    for (let k = 0; k < FRAME; k++) r[k] = x[start + k] * win[k];
    fftInPlace(r, i);
    let h = 0, l = 0;
    for (let k = 1; k < FRAME / 2; k++) {
      const p = r[k] * r[k] + i[k] * i[k];
      if (k >= hfBin) h += p;
      else if (k <= lfBin) l += p;
      if (k >= lo && k < hi) { all += p; if (k < mid) bass += p; }
    }
    re.push(Float32Array.from(r)); im.push(Float32Array.from(i)); hf.push(h); lf.push(l);
    if (++n % FRAMES_PER_CHUNK === 0) await yielder();
  }
  return { re, im, hf, lf, bass, all };
}

function percentile(values: number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Per frame: 1 = fine, below 1 = a treble burst, turned down towards its baseline. */
function rustleGains(f: Frames): { gains: number[]; share: number } {
  const n = f.hf.length;
  const gains = new Array<number>(n).fill(1);
  let bursts = 0;
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, t - BASELINE_FRAMES), hi = Math.min(n, t + BASELINE_FRAMES + 1);
    const baseHf = percentile(f.hf.slice(lo, hi), BASELINE_PCT);
    const baseLf = percentile(f.lf.slice(lo, hi), BASELINE_PCT);
    // A kick brings bass with its treble; a rustle burst does not
    const burst = f.hf[t] > RUSTLE_RATIO * baseHf && f.lf[t] < 1.5 * baseLf;
    if (burst) {
      bursts++;
      gains[t] = Math.max(MIN_GAIN, Math.sqrt((BURST_TARGET * baseHf) / f.hf[t]));
    }
  }
  // Smooth over neighbours so the gain doesn't flutter
  const smooth = gains.map((_, t) => {
    let m = 1;
    for (let d = -1; d <= 1; d++) m = Math.min(m, gains[Math.max(0, Math.min(n - 1, t + d))] + Math.abs(d) * 0.15);
    return Math.min(1, m);
  });
  return { gains: smooth, share: n > 0 ? bursts / n : 0 };
}

function toFloat(samples: ArrayLike<number>, scale: number): Float64Array {
  const x = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) x[i] = samples[i] / scale;
  return x;
}

export interface ProcessedClip {
  pcm: Int16Array;            // the phone layer: rustle bursts turned down, levelled (16-bit)
  dominance: MusicDominance;  // of the clip as recorded
}

/**
 * Cleans a clip and measures whether music dominates it (16-bit PCM, or floats with `scale` 1).
 * Pass `macroYield` in the app so a 15 s clip (a few seconds of work) doesn't freeze the UI.
 */
export async function processClip(
  samples: ArrayLike<number>, sampleRate: number, opts: { scale?: number; yielder?: Yielder } = {},
): Promise<ProcessedClip> {
  const yielder = opts.yielder ?? noYield;
  const x = toFloat(samples, opts.scale ?? 32768);
  const f = await analyse(x, sampleRate, yielder);
  if (f.hf.length === 0) return { pcm: new Int16Array(x.length), dominance: { bassShare: 0, rustleShare: 1 } };

  const { gains, share } = rustleGains(f);
  const dominance: MusicDominance = { bassShare: f.all > 0 ? f.bass / f.all : 0, rustleShare: share };

  const binHz = sampleRate / FRAME;
  const hfBin = Math.ceil(HF_HZ / binHz);
  const hpBin = Math.max(2, Math.round(40 / binHz));

  const out = new Float64Array(x.length);
  for (let t = 0; t < f.re.length; t++) {
    const r = Float64Array.from(f.re[t]), i = Float64Array.from(f.im[t]), g = gains[t];
    // 40 Hz high-pass without phase shift: drop the bins below it (and half of the one at it)
    for (let k = 0; k < hpBin; k++) {
      const w = k < hpBin - 1 ? 0 : 0.5;
      r[k] *= w; i[k] *= w;
      if (k > 0) { r[FRAME - k] *= w; i[FRAME - k] *= w; }
    }
    if (g < 1) {
      // Turn the treble down (both halves of the spectrum, so the result stays real)
      for (let k = hfBin; k <= FRAME - hfBin; k++) { r[k] *= g; i[k] *= g; }
    }
    // Inverse FFT through conjugation
    for (let k = 0; k < FRAME; k++) i[k] = -i[k];
    fftInPlace(r, i);
    const start = t * HOP;
    for (let n = 0; n < FRAME; n++) out[start + n] += (r[n] / FRAME) * win[n];
    if ((t + 1) % FRAMES_PER_CHUNK === 0) await yielder();
  }
  // The first and last HOP samples are covered by one frame only: take the input there
  const covered = (f.re.length - 1) * HOP + HOP;
  for (let n = 0; n < Math.min(HOP, x.length); n++) out[n] = x[n];
  for (let n = covered; n < x.length; n++) out[n] = x[n];

  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const gain = peak > 1e-4 ? Math.min(MAX_BOOST, TARGET_PEAK / peak) : 1;
  const pcm = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * gain * 32767)));
  return { pcm, dominance };
}

/** A mono 16-bit WAV file. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return new Uint8Array(buf);
}

/** Base64 of bytes, for writing a file through expo-file-system. */
export function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}
