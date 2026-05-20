import { SensorWindow, VibeScoreBreakdown } from '../types';
import {
  SENSOR_CONFIG,
  DB_SCORE_CURVE,
  BPM_SCORE_CURVE,
  ACCEL_SCORE_CURVE,
  BLE_SCORE_CURVE,
} from '../config/constants';

/**
 * Linear interpolation along a curve defined as [x, y] pairs (sorted by x).
 */
function interpolate(curve: readonly (readonly [number, number])[], x: number): number {
  if (x <= curve[0][0]) return curve[0][1];
  if (x >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];

  for (let i = 0; i < curve.length - 1; i++) {
    const [x0, y0] = curve[i];
    const [x1, y1] = curve[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return curve[curve.length - 1][1];
}

/**
 * Compute vibe score breakdown from a (partial) sensor window.
 * Handles missing signals gracefully by redistributing their weight.
 */
export function computeVibeScore(window: Partial<SensorWindow>): VibeScoreBreakdown {
  const weights = { ...SENSOR_CONFIG.VIBE_WEIGHTS };

  // ── Energy score ────────────────────────────────────────────────
  let energyScore: number | null = null;
  if (window.avgDb != null) {
    const dbScore = interpolate(DB_SCORE_CURVE, window.avgDb);
    let bpmBonus = 0;
    if (window.estimatedBpm != null) {
      bpmBonus = interpolate(BPM_SCORE_CURVE, window.estimatedBpm) * 0.3;
    }
    const musicBonus = window.musicDetected ? 0.5 : 0;
    energyScore = Math.min(5.0, dbScore * 0.7 + bpmBonus + musicBonus);
  }

  // ── Music score ──────────────────────────────────────────────────
  let musicScore: number | null = null;
  if (window.musicDetected != null) {
    if (!window.musicDetected) {
      musicScore = 0;
    } else {
      const bpmScore = window.estimatedBpm != null
        ? interpolate(BPM_SCORE_CURVE, window.estimatedBpm)
        : 2.0;
      // Sub-bass (kick/bass): strongest dance-floor signal (20–80 Hz fraction)
      const subBassBonus = (window.subBassEnergy ?? 0) * 1.5;
      // Spectral flux: dynamic/evolving mix vs static loop
      const fluxBonus = (window.spectralFlux ?? 0) * 0.8;
      // Harmonic-to-noise ratio: tonal music vs crowd noise
      const hnrBonus = (window.harmonicNoiseRatio ?? 0) * 0.7;
      musicScore = Math.min(5.0, bpmScore * 0.5 + subBassBonus + fluxBonus + hnrBonus);
    }
  }

  // ── Movement score ───────────────────────────────────────────────
  let movementScore: number | null = null;
  if (window.accelMagnitudeAvg != null) {
    const accelScore = interpolate(ACCEL_SCORE_CURVE, window.accelMagnitudeAvg);
    const gyroBonus = window.gyroActivityAvg != null
      ? Math.min(1.0, window.gyroActivityAvg * 0.5)
      : 0;
    movementScore = Math.min(5.0, accelScore + gyroBonus);
  }

  // ── Density score ────────────────────────────────────────────────
  let densityScore: number | null = null;
  if (window.bleDeviceCount != null) {
    const bleScore = interpolate(BLE_SCORE_CURVE, window.bleDeviceCount);
    // Trend bonus: filling gets +0.5, thinning gets -0.5
    const trendBonus =
      window.bleCountTrend === 'filling' ? 0.5 :
      window.bleCountTrend === 'thinning' ? -0.5 : 0;
    densityScore = Math.max(0, Math.min(5.0, bleScore + trendBonus));
  }

  // ── Engagement score ─────────────────────────────────────────────
  // Minimal for now — screen-off ratio if available
  let engagementScore: number | null = null;
  if (window.screenOffRatio != null) {
    // High screen-off ratio = phone in pocket = having fun
    engagementScore = window.screenOffRatio * 5.0;
  }

  // ── Weight redistribution for missing signals ────────────────────
  const scoreMap: [keyof typeof weights, number | null][] = [
    ['energy', energyScore],
    ['music', musicScore],
    ['movement', movementScore],
    ['density', densityScore],
    ['engagement', engagementScore],
  ];

  const presentScores = scoreMap.filter(([, s]) => s != null) as [keyof typeof weights, number][];
  const missingWeight = scoreMap
    .filter(([, s]) => s == null)
    .reduce((sum, [k]) => sum + weights[k], 0);

  let totalPresentWeight = presentScores.reduce((s, [k]) => s + weights[k], 0);
  const redistributedWeights: Record<string, number> = {};

  if (totalPresentWeight > 0 && presentScores.length > 0) {
    for (const [k, ] of presentScores) {
      redistributedWeights[k] = weights[k] + (missingWeight * weights[k]) / totalPresentWeight;
    }
  }

  let composite = 0;
  for (const [k, score] of presentScores) {
    composite += score * (redistributedWeights[k] ?? weights[k]);
  }

  const confidence = presentScores.length / scoreMap.length;

  return {
    energyScore: energyScore ?? 0,
    musicScore: musicScore ?? 0,
    movementScore: movementScore ?? 0,
    densityScore: densityScore ?? 0,
    engagementScore: engagementScore ?? 0,
    compositeVibeScore: Math.min(5.0, Math.max(0, composite)),
    confidence,
  };
}
