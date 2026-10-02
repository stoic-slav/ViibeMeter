/**
 * Beat synchronisation between body movement and the music beat.
 *
 * Event-based circular statistics (standard in sensorimotor-synchronisation
 * research): each movement peak is assigned a phase relative to the audio beat
 * grid, then
 *   PLV        = |mean(e^{iφ})|  — 1 = every peak lands at the same beat phase
 *   phaseMean  = arg(mean(e^{iφ})) — where in the beat the movement lands
 *
 * PLV is unaffected by a constant clock/latency offset between audio and motion,
 * so device-specific recording latency does not bias it. phaseMean is used
 * server-side to compare devices (crowd sync).
 *
 * Evidence: Ellamil et al. 2016 (phase-based synchrony from phone accelerometers),
 * Witek et al. 2014 (desire to move ≈ pleasure), Tarr et al. 2016 (synchrony → bonding).
 */

export interface TimedSample {
  t: number; // ms timestamp (Date.now() clock)
  v: number;
}

export interface BeatSyncResult {
  plv: number;          // 0–1 phase-locking value
  phaseMean: number;    // radians, (-π, π]
  tempoMatch: number;   // 0–1 graded tempo agreement at the best harmonic
  harmonic: number;     // movement BPM ≈ harmonic × music BPM
  peakCount: number;    // movement peaks used
}

const HARMONICS = [0.5, 1, 2, 3];
const TEMPO_TOLERANCE = 0.1;  // ±10% of target counts as a match
const MIN_PEAKS = 4;

/**
 * Graded tempo agreement: 1 at an exact harmonic match, falling linearly to 0
 * at ±10% of the target. Returns the best harmonic.
 */
export function computeTempoMatch(
  movementBpm: number | null,
  musicBpm: number | null,
): { tempoMatch: number; harmonic: number } {
  if (!movementBpm || !musicBpm) return { tempoMatch: 0, harmonic: 1 };
  let best = { tempoMatch: 0, harmonic: 1 };
  for (const h of HARMONICS) {
    const target = musicBpm * h;
    const relErr = Math.abs(movementBpm - target) / target;
    const score = Math.max(0, 1 - relErr / TEMPO_TOLERANCE);
    if (score > best.tempoMatch) best = { tempoMatch: score, harmonic: h };
  }
  return best;
}

/**
 * Phase of the beat grid: circular mean of onset times folded onto the beat period.
 * Returns the reference time (ms) of one beat, or null if onsets are too few.
 */
export function beatReference(onsetTimesMs: number[], beatPeriodMs: number): number | null {
  if (onsetTimesMs.length < 3 || beatPeriodMs <= 0) return null;
  let c = 0, s = 0;
  for (const t of onsetTimesMs) {
    const a = (2 * Math.PI * t) / beatPeriodMs;
    c += Math.cos(a);
    s += Math.sin(a);
  }
  const theta = Math.atan2(s, c);
  return (theta / (2 * Math.PI)) * beatPeriodMs;
}

/**
 * Peaks of a movement signal: smoothed local maxima above mean + 0.5·std,
 * at least `minGapMs` apart.
 */
export function findMovementPeaks(series: TimedSample[], minGapMs: number): number[] {
  if (series.length < 5) return [];
  // 3-point moving average to suppress sensor jitter
  const sm = series.map((p, i) => {
    const a = series[Math.max(0, i - 1)].v, b = p.v, c = series[Math.min(series.length - 1, i + 1)].v;
    return (a + b + c) / 3;
  });
  const mean = sm.reduce((x, y) => x + y, 0) / sm.length;
  const std = Math.sqrt(sm.reduce((x, y) => x + (y - mean) ** 2, 0) / sm.length);
  if (std < 1e-4) return [];
  const threshold = mean + 0.5 * std;

  const peakIdx: number[] = [];
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] > threshold && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) {
      const last = peakIdx.length ? peakIdx[peakIdx.length - 1] : -1;
      if (last < 0 || series[i].t - series[last].t >= minGapMs) {
        peakIdx.push(i);
      } else if (sm[i] > sm[last]) {
        peakIdx[peakIdx.length - 1] = i; // keep the taller peak within the gap
      }
    }
  }
  return peakIdx.map(i => series[i].t);
}

/**
 * Compute beat sync for one capture where audio and motion overlap in time.
 *
 * @param movement      movement signal (e.g. vertical linear acceleration), ms timestamps
 * @param onsetTimesMs  absolute audio onset times (ms, same clock as movement)
 * @param musicBpm      tempo of the music in this capture
 * @param movementBpm   dominant movement tempo (null if movement is not rhythmic)
 */
export function computeBeatSync(
  movement: TimedSample[],
  onsetTimesMs: number[],
  musicBpm: number | null,
  movementBpm: number | null,
): BeatSyncResult | null {
  if (!musicBpm || musicBpm <= 0) return null;
  const { tempoMatch, harmonic } = computeTempoMatch(movementBpm, musicBpm);

  const beatPeriodMs = 60000 / musicBpm;
  const ref = beatReference(onsetTimesMs, beatPeriodMs);
  if (ref == null) return null;

  // Movement cycles at harmonic × beat rate; fold peaks onto that period.
  const cyclePeriodMs = beatPeriodMs / harmonic;
  const peaks = findMovementPeaks(movement, cyclePeriodMs * 0.6);
  if (peaks.length < MIN_PEAKS) return null;

  let c = 0, s = 0;
  for (const t of peaks) {
    const phi = (2 * Math.PI * (t - ref)) / cyclePeriodMs;
    c += Math.cos(phi);
    s += Math.sin(phi);
  }
  c /= peaks.length;
  s /= peaks.length;

  return {
    plv: Math.min(1, Math.sqrt(c * c + s * s)),
    phaseMean: Math.atan2(s, c),
    tempoMatch,
    harmonic,
    peakCount: peaks.length,
  };
}

/**
 * Aggregate several captures into one window value:
 * mean PLV, PLV-weighted circular mean phase, mean tempo match.
 */
export function aggregateBeatSync(results: BeatSyncResult[]): {
  plv: number | null; phaseMean: number | null; tempoMatch: number | null;
} {
  if (results.length === 0) return { plv: null, phaseMean: null, tempoMatch: null };
  let c = 0, s = 0, plvSum = 0, tmSum = 0;
  for (const r of results) {
    c += r.plv * Math.cos(r.phaseMean);
    s += r.plv * Math.sin(r.phaseMean);
    plvSum += r.plv;
    tmSum += r.tempoMatch;
  }
  return {
    plv: plvSum / results.length,
    phaseMean: plvSum > 0 ? Math.atan2(s, c) : null,
    tempoMatch: tmSum / results.length,
  };
}
