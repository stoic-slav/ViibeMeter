/**
 * Radix-2 Cooley-Tukey FFT implementation.
 * Input: real-valued time-domain samples (Float32Array or number[])
 * Output: magnitude spectrum (number[]), length = N/2
 */

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place radix-2 Cooley-Tukey FFT.
 * re and im are the real and imaginary parts, both length N (power of 2).
 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const N = re.length;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Cooley-Tukey butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);

    for (let i = 0; i < N; i += len) {
      let curRe = 1.0;
      let curIm = 0.0;

      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;

        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;

        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export interface FFTResult {
  magnitudes: number[];      // magnitude spectrum, length = N/2
  frequencies: number[];     // corresponding frequency for each bin (Hz)
  sampleRate: number;
  fftSize: number;
}

/**
 * Compute FFT magnitude spectrum from time-domain samples.
 * @param samples - Audio PCM samples (normalized -1 to 1)
 * @param sampleRate - Sample rate in Hz (e.g. 44100)
 * @returns FFTResult with magnitude spectrum and frequency bins
 */
export function computeFFT(samples: number[], sampleRate: number): FFTResult {
  const N = nextPowerOfTwo(Math.min(samples.length, 4096));
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  // Apply Hann window to reduce spectral leakage
  for (let i = 0; i < N && i < samples.length; i++) {
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    re[i] = samples[i] * window;
    im[i] = 0;
  }

  fftInPlace(re, im);

  // Compute magnitudes for positive frequencies (first N/2 bins)
  const halfN = N / 2;
  const magnitudes = new Array<number>(halfN);
  for (let i = 0; i < halfN; i++) {
    magnitudes[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / N;
  }

  // Compute frequency for each bin
  const frequencies = new Array<number>(halfN);
  const binWidth = sampleRate / N;
  for (let i = 0; i < halfN; i++) {
    frequencies[i] = i * binWidth;
  }

  return { magnitudes, frequencies, sampleRate, fftSize: N };
}

/**
 * Compute energy in a frequency band (Hz range).
 */
export function bandEnergy(result: FFTResult, lowHz: number, highHz: number): number {
  const binWidth = result.sampleRate / result.fftSize;
  const lowBin = Math.floor(lowHz / binWidth);
  const highBin = Math.min(Math.ceil(highHz / binWidth), result.magnitudes.length - 1);

  let energy = 0;
  for (let i = lowBin; i <= highBin; i++) {
    energy += result.magnitudes[i] * result.magnitudes[i];
  }
  return energy;
}

/**
 * Total energy across all bins.
 */
export function totalEnergy(result: FFTResult): number {
  return result.magnitudes.reduce((sum, m) => sum + m * m, 0);
}

/**
 * Spectral flatness: ratio of geometric mean to arithmetic mean of magnitudes.
 * 0.0 = perfectly tonal, 1.0 = white noise.
 */
export function spectralFlatness(magnitudes: number[]): number {
  const eps = 1e-10;
  const n = magnitudes.length;
  if (n === 0) return 1.0;

  const logSum = magnitudes.reduce((s, m) => s + Math.log(m + eps), 0);
  const geoMean = Math.exp(logSum / n);

  const arithMean = magnitudes.reduce((s, m) => s + m, 0) / n;
  if (arithMean < eps) return 1.0;

  return Math.min(1.0, geoMean / arithMean);
}
