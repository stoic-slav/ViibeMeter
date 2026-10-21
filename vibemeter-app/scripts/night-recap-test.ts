// Checks the "Your night in songs" ranking (src/processing/NightRecap.ts) on a synthetic night.
// Run from vibemeter-app/: npx tsx scripts/night-recap-test.ts
import { buildNightRecap, RecapClip } from '../src/processing/NightRecap';

const T0 = new Date(2026, 9, 24, 23, 0).getTime();
const clips: RecapClip[] = [];
const musicMinutes = new Set<number>();
let t = T0;
// [isrc or null, minutes, movement energy, beat PLV, phone context]
const plan: [string | null, number, number, number | null, string][] = [
  ['WARMUP', 4, 1.0, null, 'on_body_still'],        // standing, chatting
  ['BANGER', 4, 5.0, 0.7, 'on_body_moving'],        // dancing on the beat → #1
  ['OKSONG', 3, 2.5, 0.2, 'on_body_moving'],        // light moving, off beat
  [null, 5, 4.5, 0.5, 'on_body_moving'],            // unrecognised edit, danced → should rank
  ['BARTRIP', 4, 4.8, 0.1, 'off_body'],             // phone on the bar: must not count
  ['SECOND', 4, 4.0, 0.55, 'on_body_moving'],       // strong, on the beat → top 3
  ['SHORT', 0.25, 6.0, 0.9, 'on_body_moving'],      // only 15 s: too short to rank
  [null, 1, 3.0, null, 'on_body_moving'],           // 1 min unknown: too short
];
for (const [isrc, min, energy, plv, ctx] of plan) {
  const n = Math.round(min * 6);
  for (let i = 0; i < n; i++) {
    clips.push({ clipStart: t, movementEnergy: energy + (i % 3) * 0.1, beatPlv: plv, songIsrc: isrc, phoneContext: ctx });
    musicMinutes.add(Math.floor(t / 60_000) * 60_000);
    t += 10_000;
  }
}
const recap = buildNightRecap({
  sessionId: 'TEST', venueName: 'C12', startedAt: T0, endedAt: t, clips, musicMinutes,
  songs: ['WARMUP', 'BANGER', 'OKSONG', 'BARTRIP', 'SECOND', 'SHORT'].map(isrc => ({ isrc, title: isrc.toLowerCase(), artist: 'Artist', appleMusicId: null })),
  sets: [{ djName: 'DJ One', startsAt: T0, endsAt: T0 + 12 * 60_000 }, { djName: 'DJ Two', startsAt: T0 + 12 * 60_000, endsAt: T0 + 60 * 60_000 }],
});

let failures = 0;
const expect = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
console.log(recap.items.map((i, n) => `${n + 1}. ${i.kind === 'song' ? i.title : 'unrecognised'} score=${i.score} dj=${i.djName} · ${i.reason}`).join('\n'));
expect('the banger danced on the beat is #1', recap.items[0]?.isrc === 'BANGER');
expect('the danced-to unrecognised edit is ranked', recap.items.some(i => i.kind === 'unknown'));
expect('the unrecognised edit is credited to DJ Two', recap.items.find(i => i.kind === 'unknown')?.djName === 'DJ Two');
expect('the song heard with the phone on the bar is not ranked', !recap.items.some(i => i.isrc === 'BARTRIP'));
expect('a 15 s song is not ranked', !recap.items.some(i => i.isrc === 'SHORT'));
expect('the warm-up song stood through is not listed', !recap.items.some(i => i.isrc === 'WARMUP'));
expect('at most 5 items', recap.items.length <= 5);
expect('the banger is credited to DJ One', recap.items[0]?.djName === 'DJ One');
expect('a reason mentions the beat for the banger', /beat/i.test(recap.items[0]?.reason ?? ''));
expect('6 songs recognised (incl. the bar trip)', recap.recognisedSongs === 6);
// A known DJ edit heard in the unrecognised stretch, at a night with no lineup
const unknownStart = recap.items.find(i => i.kind === 'unknown')!.startsAt;
const noLineup = buildNightRecap({
  sessionId: 'TEST2', venueName: null, startedAt: T0, endedAt: t, clips, musicMinutes, sets: [],
  songs: [], edits: [{ dj: 'DJ Edit Maker', title: 'Levitating (DJ Edit Maker rework)', firstHeardMs: unknownStart + 60_000, lastHeardMs: unknownStart + 120_000 }],
});
const credited = noLineup.items.find(i => i.kind === 'unknown');
expect('without a lineup, a matched edit credits its DJ', credited?.djName === 'DJ Edit Maker');
expect('a registered edit shows its title', credited?.title === 'Levitating (DJ Edit Maker rework)');
console.log(`dancing minutes ${recap.dancingMinutes}, coverage ${recap.coverage?.toFixed(2)}`);
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
