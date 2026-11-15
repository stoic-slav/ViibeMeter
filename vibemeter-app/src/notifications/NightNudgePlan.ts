/**
 * The pure parts of the "going out tonight" plan (build 32), kept free of React Native so they can
 * be tested with `npx tsx scripts/night-plan-test.ts`.
 */

/** The night a moment belongs to: from 06:00 to 06:00, named by the date it started on (local time). */
export function nightKey(nowMs: number, endsHour = 6): string {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), endsHour);
  if (start.getTime() > nowMs) start.setDate(start.getDate() - 1);
  const mm = String(start.getMonth() + 1).padStart(2, '0');
  const dd = String(start.getDate()).padStart(2, '0');
  return `${start.getFullYear()}-${mm}-${dd}`;
}

/**
 * When the "Still out?" nudges go off for this night: each wall-clock time (hours below the
 * night's end belong to the next calendar day) that is still ahead of `now` and before the night
 * ends. Anchored on the night of `now`, so a Yes at 00:10 still gets the 01:00 nudge.
 */
export function lateNudgeDates(now: Date, times: readonly { hour: number; minute: number }[], endsHour = 6): Date[] {
  const key = nightKey(now.getTime(), endsHour);
  const [y, m, d] = key.split('-').map(Number);
  const out: Date[] = [];
  for (const t of times) {
    const after = t.hour < endsHour;                       // 01:00 is after midnight
    const at = new Date(y, m - 1, d + (after ? 1 : 0), t.hour, t.minute);
    if (at.getTime() > now.getTime() + 60_000) out.push(at);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** "At C12?" → "C12" (the express start's venue name when the notification data is missing). */
export function nameFromTitle(title: string | null | undefined): string | null {
  const m = /^At (.+)\?$/.exec((title ?? '').trim());
  return m ? m[1] : null;
}

/** The place ID inside an arrival notification's identifier ("arrival-<placeId>"). */
export function placeIdFromIdentifier(identifier: string): string | null {
  return identifier.startsWith('arrival-') ? identifier.slice('arrival-'.length) || null : null;
}
