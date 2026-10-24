// Run: npx tsx scripts/clip-cleaner-test.ts
// Synthetic "club in a pocket": a kick and bass at 124 BPM with hi-hats, plus cloth rustle bursts
// and a voice-like noise. Checks the phone layer lowers the rustle without hurting the music, and
// that the music-dominance check tells music from rustle/speech-like clips.
import { processClip, encodeWav, toBase64 } from '../src/processing/ClipCleaner';

const cleanClip = async (x: ArrayLike<number>, sr: number, scale: number) => (await processClip(x, sr, { scale })).pcm;
const musicDominance = async (x: ArrayLike<number>, sr: number, scale: number) => (await processClip(x, sr, { scale })).dominance;

const SR = 44100;
let failed = 0;
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };

function music(seconds: number): Float64Array {
  const n = SR * seconds, x = new Float64Array(n);
  const beat = 60 / 124;
  for (let i = 0; i < n; i++) {
    const t = i / SR, ph = (t % beat) / beat;
    const kick = Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-ph * 30)) * t) * Math.exp(-ph * 9);
    const bass = 0.25 * Math.sin(2 * Math.PI * 48 * t);
    const hatPh = (t % (beat / 2)) / (beat / 2);
    const hat = rand() * 0.25 * Math.exp(-hatPh * 25);
    x[i] = 0.6 * kick + bass + hat;
  }
  return x;
}

function addRustle(x: Float64Array, bursts: number): Float64Array {
  const y = x.slice();
  for (let b = 0; b < bursts; b++) {
    const start = Math.floor(((b + 0.5) / bursts) * (x.length - SR / 4));
    const len = Math.floor(SR * 0.08);
    for (let i = 0; i < len; i++) y[start + i] += rand() * 2.0 * Math.exp(-i / (len / 2));
  }
  return y;
}

function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

function corr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb);
}

const clean = music(8);
const noisy = addRustle(clean, 6);
(async () => {
const out = await cleanClip(noisy, SR, 1);
const outF = Array.from(out, v => v / 32767);

// Compare against the reference music, both normalised to the same level
const norm = (x: ArrayLike<number>) => { const r = rms(x); return Array.from(x, v => v / r); };
const refN = norm(clean), noisyN = norm(noisy), outN = norm(outF);
const err = (a: ArrayLike<number>, b: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s / a.length); };
expect('cleaned clip is closer to the music than the rustled clip is', err(outN, refN) < err(noisyN, refN) * 0.85,
  `error before ${err(noisyN, refN).toFixed(3)}, after ${err(outN, refN).toFixed(3)}`);

// Rustle burst region: its energy comes down
const burstAt = Math.floor((0.5 / 6) * (clean.length - SR / 4));
const before = rms(noisy, burstAt, burstAt + SR * 0.08), after = rms(outF, burstAt, burstAt + SR * 0.08) * (rms(noisy) / rms(outF));
expect('energy in a rustle burst is reduced', after < before * 0.8, `before ${before.toFixed(3)}, after (level-matched) ${after.toFixed(3)}`);

// A clip with no rustle is left alone
const calmOut = Array.from(await cleanClip(clean, SR, 1), v => v / 32767);
// The synthetic hi-hats are short noise bursts, the very thing the rustle rule targets, so some sparkle goes
expect('a clean clip stays recognisably the same music', err(norm(calmOut), refN) < 0.35, err(norm(calmOut), refN).toFixed(3));
const calmPeak = calmOut.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
expect('output is levelled near −3 dBFS', calmPeak > 0.6 && calmPeak <= 1);

// Music dominance
const md = await musicDominance(clean, SR, 1);
expect('music is bass-heavy and has no rustle', md.bassShare > 0.6 && md.rustleShare < 0.1, `bass ${md.bassShare.toFixed(2)}, rustle ${md.rustleShare.toFixed(2)}`);
const hiss = new Float64Array(SR * 8).map(() => rand() * 0.3);
expect('treble-only noise is not music', (await musicDominance(hiss, SR, 1)).bassShare < 0.1);
const rustled = await musicDominance(addRustle(clean, 6), SR, 1);
expect('rustle bursts on the music are flagged', rustled.rustleShare > 0.03, rustled.rustleShare.toFixed(2));

// WAV
const wav = encodeWav(Int16Array.from([0, 1000, -1000]), SR);
const text = String.fromCharCode(...wav.slice(0, 4)) + String.fromCharCode(...wav.slice(8, 12));
expect('wav header is RIFF/WAVE and 44 + 2n bytes', text === 'RIFFWAVE' && wav.length === 50);
expect('base64 round-trips', Buffer.from(toBase64(wav), 'base64').equals(Buffer.from(wav)));

})().then(() => {
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nAll checks passed.');
});
