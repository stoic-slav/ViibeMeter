/**
 * Bass-envelope room fingerprint (collect-only).
 *
 * Phones in one room hear the same speakers, so their bass loudness rises and falls together.
 * Per minute window the app stores 240 frames (250 ms each, on a wall-clock grid shared by all
 * phones) of 40–150 Hz energy in dB, relative to the window's median, one byte per frame.
 * analysis/auto_groups.py cross-correlates these between phones to group phones in the same
 * room even when no song is recognised. A loudness curve at 4 values per second cannot
 * reproduce speech or music.
 *
 * iOS computes frames natively and continuously (modules/audio-capture, same filters);
 * Android computes them here from each 5 s clip, so frames outside clips are missing.
 */

export const BASS_FRAME_MS = 250;
export const FRAMES_PER_WINDOW = 240;
const RANGE_DB = 24; // stored range: ±24 dB around the window median

/** Second-order IIR section (RBJ cookbook), transposed direct form II. Mirrors Biquad in Swift. */
class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(private b0: number, private b1: number, private b2: number, private a1: number, private a2: number) {}

  static lowPass(fc: number, fs: number, q = 0.7071): Biquad {
    const w0 = (2 * Math.PI * fc) / fs, c = Math.cos(w0), alpha = Math.sin(w0) / (2 * q), a0 = 1 + alpha;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - alpha) / a0);
  }

  static highPass(fc: number, fs: number, q = 0.7071): Biquad {
    const w0 = (2 * Math.PI * fc) / fs, c = Math.cos(w0), alpha = Math.sin(w0) / (2 * q), a0 = 1 + alpha;
    return new Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - alpha) / a0);
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Per-frame energy sums: frame index (floor(wall ms / 250)) → sum of squares and sample count. */
export type BassFrameStore = Map<number, { sumSq: number; count: number }>;

/**
 * Band-pass one clip (samples −1…1, first sample at startMs on the Date.now() clock) and add
 * its energy to the frames it covers. The filter starts from rest each clip, so the first
 * ~25 ms carry a small transient; the 50% coverage rule absorbs it.
 */
export function addBassFrames(store: BassFrameStore, samples: number[], sampleRate: number, startMs: number): void {
  const hp = Biquad.highPass(40, sampleRate);
  const lp = Biquad.lowPass(150, sampleRate);
  const msPerSample = 1000 / sampleRate;
  let frame = Math.floor(startMs / BASS_FRAME_MS);
  let nextBoundary = (frame + 1) * BASS_FRAME_MS;
  let sumSq = 0, count = 0;
  const commit = () => {
    if (count === 0) return;
    const prev = store.get(frame);
    store.set(frame, { sumSq: (prev?.sumSq ?? 0) + sumSq, count: (prev?.count ?? 0) + count });
  };
  for (let i = 0; i < samples.length; i++) {
    const t = startMs + i * msPerSample;
    if (t >= nextBoundary) {
      commit();
      frame = Math.floor(t / BASS_FRAME_MS);
      nextBoundary = (frame + 1) * BASS_FRAME_MS;
      sumSq = 0; count = 0;
    }
    const y = lp.process(hp.process(samples[i]));
    sumSq += y * y;
    count++;
  }
  commit();
}

/** dB per frame in [fromMs, toMs); null where fewer than half of the frame's samples exist. */
export function bassEnvelopeFromStore(store: BassFrameStore, fromMs: number, toMs: number, sampleRate: number): (number | null)[] {
  const first = Math.ceil(fromMs / BASS_FRAME_MS);
  const end = Math.ceil(toMs / BASS_FRAME_MS);
  const needed = (sampleRate * BASS_FRAME_MS) / 1000 / 2;
  const out: (number | null)[] = [];
  for (let k = first; k < end; k++) {
    const f = store.get(k);
    out.push(f && f.count >= needed ? 10 * Math.log10(f.sumSq / f.count + 1e-12) : null);
  }
  return out;
}

/** Drop frames older than `keepFromMs`. */
export function pruneBassFrames(store: BassFrameStore, keepFromMs: number): void {
  const oldest = Math.floor(keepFromMs / BASS_FRAME_MS);
  for (const k of store.keys()) if (k < oldest) store.delete(k);
}

/**
 * 240 frames → base64 (320 characters). Each byte is the frame's dB minus the window median,
 * clamped to ±24 dB and scaled to 1–255; 0 marks a missing frame. Null if no frame is valid.
 */
export function encodeEnvelope(frames: (number | null)[]): string | null {
  const valid = frames.filter((v): v is number => v != null && Number.isFinite(v));
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bytes = new Uint8Array(FRAMES_PER_WINDOW);
  for (let k = 0; k < FRAMES_PER_WINDOW; k++) {
    const v = frames[k];
    if (v == null || !Number.isFinite(v)) continue; // 0 = missing
    const rel = Math.max(-RANGE_DB, Math.min(RANGE_DB, v - median));
    bytes[k] = 1 + Math.round(((rel + RANGE_DB) / (2 * RANGE_DB)) * 254);
  }
  return toBase64(bytes);
}

/** Inverse of encodeEnvelope: dB relative to the window median, null for missing frames. */
export function decodeEnvelope(encoded: string): (number | null)[] {
  return Array.from(fromBase64(encoded), b => (b === 0 ? null : ((b - 1) / 254) * 2 * RANGE_DB - RANGE_DB));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=')
      + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0) << 6)
      | (i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0);
    out.push((n >> 16) & 255);
    if (i + 2 < clean.length) out.push((n >> 8) & 255);
    if (i + 3 < clean.length) out.push(n & 255);
  }
  return Uint8Array.from(out);
}
