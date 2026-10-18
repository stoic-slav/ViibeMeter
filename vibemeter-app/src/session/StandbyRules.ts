import { STANDBY } from '../config/constants';
import type { StandbyCheck } from '../sensors/SensorOrchestrator';

/**
 * The Going out detection rule, kept free of React Native so it can be tested on its own
 * (`npx tsx scripts/standby-rules-test.ts`). "Sounds and moves like a party":
 * - a music minute: loud (≥ MUSIC_MIN_DB) with a beat (clear beat grid, or bass with music detected);
 * - a moving minute: on a body, swaying/dancing/jumping (not walking or still), with a rhythm
 *   (movement locked to the heard beat, matching its tempo, or clearly periodic at 60–180 BPM);
 * - enough of both in the last WINDOW_MINUTES, at night.
 */

export type Minute = { music: boolean; moving: boolean };

export function isMusicCheck(c: StandbyCheck): boolean {
  if (c.avgDb == null || c.avgDb < STANDBY.MUSIC_MIN_DB) return false;
  return (c.pulseClarity ?? 0) >= STANDBY.MUSIC_MIN_CLARITY
    || (c.musicDetected && (c.subBass ?? 0) >= STANDBY.MUSIC_MIN_SUB_BASS);
}

export function isMovingCheck(c: StandbyCheck): boolean {
  if (c.phoneContext !== 'on_body_moving') return false;
  if (c.movementClass !== 'swaying' && c.movementClass !== 'dancing' && c.movementClass !== 'jumping') return false;
  const periodic = (c.rhythmicity ?? 0) >= STANDBY.MOVE_MIN_RHYTHMICITY
    && c.movementBpm != null && c.movementBpm >= 60 && c.movementBpm <= 180;
  return (c.plv ?? 0) >= STANDBY.MOVE_MIN_PLV || (c.tempoMatch ?? 0) >= STANDBY.MOVE_MIN_TEMPO_MATCH || periodic;
}

/** Enough music and moving minutes among the last WINDOW_MINUTES ending at `minute`. */
export function partyInWindow(minutes: Map<number, Minute>, minute: number): boolean {
  let music = 0;
  let moving = 0;
  for (let k = minute - STANDBY.WINDOW_MINUTES + 1; k <= minute; k++) {
    const m = minutes.get(k);
    if (m?.music) music++;
    if (m?.moving) moving++;
  }
  return music >= STANDBY.MIN_MUSIC_MINUTES && moving >= STANDBY.MIN_MOVING_MINUTES;
}

export function isNight(ms: number): boolean {
  const h = new Date(ms).getHours();
  return h >= STANDBY.NIGHT_START_HOUR || h < STANDBY.NIGHT_END_HOUR;
}

/** The first NIGHT_END_HOUR (06:00) after `ms`: standby ends there. */
export function nextMorning(ms: number): number {
  const d = new Date(ms);
  d.setHours(STANDBY.NIGHT_END_HOUR, 0, 0, 0);
  if (d.getTime() <= ms) d.setDate(d.getDate() + 1);
  return d.getTime();
}
