// Run: npx tsx scripts/night-plan-test.ts
import { nightKey, lateNudgeDates, nameFromTitle, placeIdFromIdentifier } from '../src/notifications/NightNudgePlan';

let failed = 0;
const expect = (name: string, ok: boolean, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const LATE = [{ hour: 23, minute: 30 }, { hour: 1, minute: 0 }] as const;
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

// A Friday night is named for Friday until 06:00 on Saturday
expect('Friday 19:00 belongs to Friday night', nightKey(at(2026, 11, 13, 19).getTime()) === '2026-11-13');
expect('Saturday 01:30 still belongs to Friday night', nightKey(at(2026, 11, 14, 1, 30).getTime()) === '2026-11-13');
expect('Saturday 05:59 is Friday night, 06:00 starts Saturday', nightKey(at(2026, 11, 14, 5, 59).getTime()) === '2026-11-13' && nightKey(at(2026, 11, 14, 6, 0).getTime()) === '2026-11-14');
expect('month and year boundaries work (31 Dec 23:00 → 1 Jan 02:00)', nightKey(at(2026, 12, 31, 23).getTime()) === '2026-12-31' && nightKey(at(2027, 1, 1, 2).getTime()) === '2026-12-31');

// Late nudges
const evening = lateNudgeDates(at(2026, 11, 13, 19), LATE);
expect('a Yes at 19:00 gets 23:30 tonight and 01:00 after midnight', evening.length === 2 && evening[0].getTime() === at(2026, 11, 13, 23, 30).getTime() && evening[1].getTime() === at(2026, 11, 14, 1, 0).getTime());
const late = lateNudgeDates(at(2026, 11, 13, 23, 45), LATE);
expect('a Yes at 23:45 only gets the 01:00 nudge', late.length === 1 && late[0].getTime() === at(2026, 11, 14, 1, 0).getTime());
const afterMidnight = lateNudgeDates(at(2026, 11, 14, 0, 10), LATE);
expect('a Yes at 00:10 still gets the 01:00 nudge (not the 23:30 one, it has passed)', afterMidnight.length === 1 && afterMidnight[0].getTime() === at(2026, 11, 14, 1, 0).getTime());
expect('a Yes at 02:00 gets no more nudges', lateNudgeDates(at(2026, 11, 14, 2, 0), LATE).length === 0);
expect('a Yes seconds before 23:30 skips it (needs a minute of margin)', lateNudgeDates(new Date(at(2026, 11, 13, 23, 30).getTime() - 30_000), LATE).length === 1);

// Names and place IDs
expect('the club name is read from "At C12?"', nameFromTitle('At C12?') === 'C12' && nameFromTitle('At Café de l\'Opéra?') === "Café de l'Opéra");
expect('other titles give no name', nameFromTitle('Still out?') === null && nameFromTitle(null) === null);
expect('the place ID is read from the identifier', placeIdFromIdentifier('arrival-ChIJabc') === 'ChIJabc' && placeIdFromIdentifier('start-nudge-0') === null && placeIdFromIdentifier('arrival-') === null);

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nAll checks passed.');
