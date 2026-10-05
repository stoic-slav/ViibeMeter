import * as SecureStore from 'expo-secure-store';
import { LIVE_ACCESS } from '../config/constants';
import { countValidContributionMinutes } from './LocalBuffer';

/**
 * Give-to-get for the live view. Contributing at a venue tonight (LIVE_ACCESS.UNLOCK_MINUTES
 * valid minutes: an identified venue, phone mostly on a body, audio present) unlocks the view
 * for the rest of the night; new users get a few free Night Passes to try it first. A night
 * runs until 06:00 local time.
 *
 * Kept on the phone for now (soft gating): enough while the view is young. Server-side checks
 * and a paid Night Pass come once the view is worth protecting.
 */

const PASSES_KEY = 'live_free_passes';
const PASS_UNTIL_KEY = 'live_pass_until';

export interface LiveAccessStatus {
  unlocked: boolean;
  reason: 'contribution' | 'pass' | null;
  unlockedUntil: number | null;     // ms
  minutesTonight: number;           // valid contribution minutes since the night began
  minutesNeeded: number;            // still needed to unlock by contributing (0 when done)
  freePasses: number;
}

/** Start and end of the current night: the last 06:00 to the next 06:00. */
export function nightBounds(now = Date.now()): { start: number; end: number } {
  const d = new Date(now);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), LIVE_ACCESS.NIGHT_ENDS_HOUR);
  if (end.getTime() <= now) end.setDate(end.getDate() + 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  return { start: start.getTime(), end: end.getTime() };
}

async function readNumber(key: string): Promise<number | null> {
  try {
    const v = await SecureStore.getItemAsync(key);
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

async function freePasses(): Promise<number> {
  const n = await readNumber(PASSES_KEY);
  if (n == null || !Number.isFinite(n)) {
    await SecureStore.setItemAsync(PASSES_KEY, String(LIVE_ACCESS.FREE_NIGHT_PASSES)).catch(() => {});
    return LIVE_ACCESS.FREE_NIGHT_PASSES;
  }
  return n;
}

export async function getLiveAccess(now = Date.now()): Promise<LiveAccessStatus> {
  const { start, end } = nightBounds(now);
  const [minutes, passes, passUntil] = await Promise.all([
    countValidContributionMinutes(start, LIVE_ACCESS.MIN_ON_BODY_SHARE),
    freePasses(),
    readNumber(PASS_UNTIL_KEY),
  ]);
  const needed = Math.max(0, LIVE_ACCESS.UNLOCK_MINUTES - minutes);
  if (needed === 0) {
    return { unlocked: true, reason: 'contribution', unlockedUntil: end, minutesTonight: minutes, minutesNeeded: 0, freePasses: passes };
  }
  if (passUntil != null && passUntil > now) {
    return { unlocked: true, reason: 'pass', unlockedUntil: passUntil, minutesTonight: minutes, minutesNeeded: needed, freePasses: passes };
  }
  return { unlocked: false, reason: null, unlockedUntil: null, minutesTonight: minutes, minutesNeeded: needed, freePasses: passes };
}

/** Spend one free Night Pass: the view stays unlocked until the night ends. */
export async function spendNightPass(now = Date.now()): Promise<boolean> {
  const passes = await freePasses();
  if (passes <= 0) return false;
  await SecureStore.setItemAsync(PASSES_KEY, String(passes - 1));
  await SecureStore.setItemAsync(PASS_UNTIL_KEY, String(nightBounds(now).end));
  return true;
}
