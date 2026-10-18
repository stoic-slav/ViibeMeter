// Checks the Going out detection rule (src/session/StandbyRules.ts) with typical evenings.
// Run from vibemeter-app/: npx tsx scripts/standby-rules-test.ts
import { isMusicCheck, isMovingCheck, partyInWindow, isNight, nextMorning, Minute } from '../src/session/StandbyRules';
import type { StandbyCheck } from '../src/sensors/SensorOrchestrator';

const base: StandbyCheck = {
  atMs: 0, avgDb: null, musicDetected: false, pulseClarity: null, subBass: null,
  phoneContext: null, movementClass: null, rhythmicity: null, movementBpm: null, plv: null, tempoMatch: null,
};
const club = { avgDb: 92, musicDetected: true, pulseClarity: 0.45, subBass: 0.4 };
const muffledClub = { avgDb: 84, musicDetected: true, pulseClarity: 0.15, subBass: 0.35 }; // pocket, weak grid
const restaurant = { avgDb: 68, musicDetected: true, pulseClarity: 0.4, subBass: 0.1 };
const dancing = { phoneContext: 'on_body_moving' as const, movementClass: 'dancing' as const, rhythmicity: 0.5, movementBpm: 124, plv: 0.55, tempoMatch: 0.8 };
const swayLoose = { phoneContext: 'on_body_moving' as const, movementClass: 'swaying' as const, rhythmicity: 0.2, movementBpm: null, plv: 0.1, tempoMatch: 0.6 };
const walking = { phoneContext: 'on_body_moving' as const, movementClass: 'walking' as const, rhythmicity: 0.7, movementBpm: 110, plv: 0.2, tempoMatch: 0.9 };
const standingAtBar = { phoneContext: 'on_body_still' as const, movementClass: 'stationary' as const, rhythmicity: 0.1, movementBpm: null, plv: null, tempoMatch: 0 };
const onTable = { phoneContext: 'off_body' as const, movementClass: 'stationary' as const };

let failures = 0;
function expect(name: string, got: boolean, want: boolean) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}`);
}

// Single checks
expect('club music', isMusicCheck({ ...base, ...club }), true);
expect('club music, muffled in a pocket (bass + music detected)', isMusicCheck({ ...base, ...muffledClub }), true);
expect('restaurant music (68 dB)', isMusicCheck({ ...base, ...restaurant }), false);
expect('quiet room', isMusicCheck({ ...base, avgDb: 45, pulseClarity: 0.5 }), false);
expect('dancing on the beat', isMovingCheck({ ...base, ...dancing }), true);
expect('swaying with matching tempo', isMovingCheck({ ...base, ...swayLoose }), true);
expect('walking (rhythmic, but walking)', isMovingCheck({ ...base, ...walking }), false);
expect('standing at the bar', isMovingCheck({ ...base, ...standingAtBar }), false);
expect('phone on a table', isMovingCheck({ ...base, ...onTable }), false);
expect('swaying with no rhythm at all', isMovingCheck({ ...base, phoneContext: 'on_body_moving', movementClass: 'swaying', rhythmicity: 0.1, movementBpm: null, plv: 0.1, tempoMatch: 0.1 }), false);

// Windows of 6 minutes
function window(spec: string): Map<number, Minute> {
  // one char per minute: P = music + moving, M = music only, D = moving only, . = neither
  const m = new Map<number, Minute>();
  [...spec].forEach((c, i) => m.set(100 + i, { music: c === 'P' || c === 'M', moving: c === 'P' || c === 'D' }));
  return m;
}
expect('club, dancing 2 of 6 minutes', partyInWindow(window('MMPMPM'), 105), true);
expect('club, dancing the whole time', partyInWindow(window('PPPPPP'), 105), true);
expect('loud bar, nobody dancing', partyInWindow(window('MMMMMM'), 105), false);
expect('club, dancing only 1 minute', partyInWindow(window('MMMPMM'), 105), false);
expect('music only 4 of 6 minutes', partyInWindow(window('..PPPP'), 105), false);
expect('dancing at home, quiet', partyInWindow(window('DDDDDD'), 105), false);

// Night hours (local time)
const at = (h: number, m = 0) => new Date(2026, 9, 24, h, m).getTime();
expect('22:30 is night', isNight(at(22, 30)), true);
expect('03:00 is night', isNight(at(3)), true);
expect('18:00 is not night', isNight(at(18)), false);
expect('armed 22:00 ends at 06:00 next day', nextMorning(at(22)) === new Date(2026, 9, 25, 6).getTime(), true);
expect('armed 01:00 ends at 06:00 same day', nextMorning(at(1)) === at(6), true);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
