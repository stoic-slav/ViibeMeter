// Checks the "Your night in songs" ranking (src/processing/NightRecap.ts) on synthetic nights.
// Run from vibemeter-app/: npx tsx scripts/night-recap-test.ts
import { buildNightRecap, RecapClip } from '../src/processing/NightRecap';
import { computeWeightedTempoMatch } from '../src/processing/BeatSync';
import { tempoFit, RECAP } from '../src/processing/NightRecap';

const T0 = new Date(2026, 9, 24, 23, 0).getTime();

type Step = {
  isrc: string | null; min: number; energy: number; plv?: number | null; ctx?: string;
  moveBpm?: number | null; songBpm?: number | null; walking?: boolean;
  pulse?: number; bass?: number; flux?: number;   // the song's sound features (0-1)
};

function night(plan: Step[]) {
  const clips: RecapClip[] = [];
  const musicMinutes = new Set<number>();
  let t = T0;
  for (const s of plan) {
    const n = Math.round(s.min * 6);
    for (let i = 0; i < n; i++) {
      clips.push({
        clipStart: t, movementEnergy: s.energy + (i % 3) * 0.1, beatPlv: s.plv ?? null,
        movementBpm: s.moveBpm ?? null, songBpm: s.songBpm ?? null, songIsrc: s.isrc,
        pulseClarity: s.pulse ?? null, spectralFlux: s.flux ?? null, subBass: s.bass ?? null,
        phoneContext: s.ctx ?? 'on_body_moving', walking: s.walking ?? false,
      });
      musicMinutes.add(Math.floor(t / 60_000) * 60_000);
      t += 10_000;
    }
  }
  return { clips, musicMinutes, end: t };
}

// The parts of a song even when its score is too low to be listed (a song danced to for 0 min)
function scoreOnly(n: ReturnType<typeof night>, ids: string[]) {
  const loose = buildNightRecap({ sessionId: 'X', venueName: null, startedAt: T0, endedAt: n.end, clips: n.clips, musicMinutes: n.musicMinutes, songs: songs(ids), sets: [], minScore: 0 });
  return loose.items.find(i => ids.includes(i.isrc ?? ''));
}

let failures = 0;
const expect = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const songs = (ids: string[]) => ids.map(isrc => ({ isrc, title: isrc.toLowerCase(), artist: 'Artist', appleMusicId: null }));

// 1. A typical night
const a = night([
  { isrc: 'WARMUP', min: 4, energy: 1.0, ctx: 'on_body_still' },     // standing, chatting
  { isrc: 'BANGER', min: 4, energy: 5.0, plv: 0.7 },                 // dancing on the beat → #1
  { isrc: 'OKSONG', min: 3, energy: 2.5, plv: 0.2 },                 // light moving, off beat
  { isrc: null, min: 5, energy: 4.5, plv: 0.5 },                     // unrecognised edit, danced
  { isrc: 'BARTRIP', min: 4, energy: 4.8, plv: 0.1, ctx: 'off_body' }, // phone on the bar
  { isrc: 'SECOND', min: 4, energy: 4.0, plv: 0.55 },                // strong, on the beat
  { isrc: 'SHORT', min: 0.25, energy: 6.0, plv: 0.9 },               // 15 s: too short
  { isrc: null, min: 1, energy: 3.0 },                               // 1 min unknown: too short
]);
const recap = buildNightRecap({
  sessionId: 'TEST', venueName: 'C12', startedAt: T0, endedAt: a.end, clips: a.clips, musicMinutes: a.musicMinutes,
  songs: songs(['WARMUP', 'BANGER', 'OKSONG', 'BARTRIP', 'SECOND', 'SHORT']),
  sets: [
    { djName: 'DJ One', djLink: 'https://soundcloud.com/djone', startsAt: T0, endsAt: T0 + 12 * 60_000 },
    { djName: 'DJ Two', startsAt: T0 + 12 * 60_000, endsAt: T0 + 60 * 60_000 },
  ],
});
console.log(recap.items.map((i, n) => `${n + 1}. ${i.kind === 'song' ? i.title : 'DJ edits'} score=${i.score} ${JSON.stringify(i.parts)} dj=${i.djName} · ${i.reason}`).join('\n'));
expect('the banger danced on the beat is #1', recap.items[0]?.isrc === 'BANGER');
expect('the danced-to unrecognised edit is ranked', recap.items.some(i => i.kind === 'unknown'));
expect('the unrecognised edit is credited to DJ Two', recap.items.find(i => i.kind === 'unknown')?.djName === 'DJ Two');
expect('the song heard with the phone on the bar is not ranked', !recap.items.some(i => i.isrc === 'BARTRIP'));
expect('a 15 s song is not ranked', !recap.items.some(i => i.isrc === 'SHORT'));
expect('the warm-up song stood through is not listed', !recap.items.some(i => i.isrc === 'WARMUP'));
expect('at most 5 items', recap.items.length <= 5);
expect('the banger is credited to DJ One with a link', recap.items[0]?.djName === 'DJ One' && recap.items[0]?.djLink === 'https://soundcloud.com/djone');
expect('the reason mentions the beat for the banger', /beat/i.test(recap.items[0]?.reason ?? ''));
expect('the banger has a strong lift (it came after standing)', (recap.items[0]?.parts.lift ?? 0) > 0.7);
expect('6 songs recognised (incl. the bar trip)', recap.recognisedSongs === 6);

// 2. Walking to the bar to a rhythmic song must not count as dancing
const b = night([
  { isrc: 'DANCE', min: 4, energy: 3.5, plv: 0.5 },
  { isrc: 'WALK', min: 4, energy: 5.5, moveBpm: 116, songBpm: 116, walking: true },
  { isrc: 'CHILL', min: 4, energy: 1.5 },
]);
const rb = buildNightRecap({ sessionId: 'B', venueName: null, startedAt: T0, endedAt: b.end, clips: b.clips, musicMinutes: b.musicMinutes, songs: songs(['DANCE', 'WALK', 'CHILL']), sets: [] });
expect('a song walked through is not ranked', !rb.items.some(i => i.isrc === 'WALK'));
expect('the danced song is #1', rb.items[0]?.isrc === 'DANCE');

// 3. Without a beat grid, movement tempo matching the song (or half/double) counts as in sync
const c = night([
  { isrc: 'INTIME', min: 4, energy: 3.0, moveBpm: 62, songBpm: 124 },  // bobbing at half tempo
  { isrc: 'OFFTIME', min: 4, energy: 3.0, moveBpm: 97, songBpm: 124 }, // same energy, not in time
  { isrc: 'REST', min: 4, energy: 1.0 },
]);
const rc = buildNightRecap({ sessionId: 'C', venueName: null, startedAt: T0, endedAt: c.end, clips: c.clips, musicMinutes: c.musicMinutes, songs: songs(['INTIME', 'OFFTIME', 'REST']), sets: [] });
const inTime = rc.items.find(i => i.isrc === 'INTIME');
const offTime = rc.items.find(i => i.isrc === 'OFFTIME');
expect('moving in time (half tempo) scores higher than the same energy off tempo', (inTime?.score ?? 0) > (offTime?.score ?? 1));
expect('entrainment is measured from tempo when there is no beat lock', (inTime?.parts.entrainment ?? 0) > 0.85);

// 3b. Multiples of the beat count, the further from the beat the less: 1x > half/double > quarter
const tm = (move: number) => computeWeightedTempoMatch(move, 120).tempoMatch;
expect('full beat 1.0, half 0.9, double 0.9', tm(120) === 1 && Math.abs(tm(60) - 0.9) < 1e-9 && Math.abs(tm(240) - 0.9) < 1e-9);
expect('triple (360) and quarter (30) score lower than half/double', tm(360) < tm(60) && tm(30) < tm(60) && tm(360) > 0);
expect('four times the beat counts least', tm(480) < tm(360));
expect('an unrelated tempo scores 0', tm(97) === 0);

// 3c. Groove: with the same movement, the song with a clear pulse, strong bass and lively mix at a
// danceable tempo gets a higher groove value (and a slightly higher score) than a muddy, slow one
const g = night([
  { isrc: 'FILL1', min: 4, energy: 1.0, pulse: 0.5, bass: 0.5, flux: 0.5, songBpm: 120 },
  { isrc: 'CLEAR', min: 4, energy: 4.0, pulse: 0.9, bass: 0.9, flux: 0.8, songBpm: 128 },
  { isrc: 'FILL2', min: 4, energy: 1.0, pulse: 0.5, bass: 0.5, flux: 0.5, songBpm: 120 },
  { isrc: 'MUDDY', min: 4, energy: 4.0, pulse: 0.15, bass: 0.2, flux: 0.2, songBpm: 85 },
  { isrc: 'FILL3', min: 4, energy: 1.0 },
  { isrc: 'NOFEAT', min: 4, energy: 4.0 },
]);
const rg = buildNightRecap({ sessionId: 'G', venueName: null, startedAt: T0, endedAt: g.end, clips: g.clips, musicMinutes: g.musicMinutes, songs: songs(['FILL1', 'CLEAR', 'FILL2', 'MUDDY', 'FILL3', 'NOFEAT']), sets: [] });
const gClear = rg.items.find(i => i.isrc === 'CLEAR'), gMuddy = rg.items.find(i => i.isrc === 'MUDDY'), gNone = rg.items.find(i => i.isrc === 'NOFEAT');
expect('groove is higher for the clear, bassy, danceable-tempo song', (gClear?.parts.groove ?? 0) > (gMuddy?.parts.groove ?? 1) + 0.3);
expect('the clear song scores a little higher than the muddy one at equal movement and lift', (gClear?.score ?? 0) > (gMuddy?.score ?? 1));
expect('the score gap from groove stays small (it is a prior)', (gClear?.score ?? 0) - (gMuddy?.score ?? 0) < 0.1);
expect('groove and carry together weigh at most 15% and all weights sum to 1',
  RECAP.WEIGHTS.groove + RECAP.WEIGHTS.carry <= 0.15 && Math.abs(Object.values(RECAP.WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
expect('a song with no sound features has no groove and still ranks', gNone?.parts.groove == null && gNone != null);
expect('tempo fit: 128 full, 85 partial, 60 none, 200 none', tempoFit(128) === 1 && tempoFit(85) > 0 && tempoFit(85) < 1 && tempoFit(60) === 0 && tempoFit(200) === 0);

// 3d. Carry: moving before a song and still moving through the change counts; stopping at the change
// or standing before it does not
const k = night([
  { isrc: 'REST1', min: 4, energy: 1.0 },
  { isrc: 'PRE1', min: 3, energy: 4.0 },
  { isrc: 'KEEP', min: 3, energy: 4.0 },     // moved before, kept moving
  { isrc: 'REST2', min: 3, energy: 1.0 },
  { isrc: 'PRE2', min: 3, energy: 4.0 },
  { isrc: 'DROP', min: 3, energy: 1.1 },     // moved before, stopped at the change
]);
const rk = buildNightRecap({ sessionId: 'K', venueName: null, startedAt: T0, endedAt: k.end, clips: k.clips, musicMinutes: k.musicMinutes, songs: songs(['REST1', 'PRE1', 'KEEP', 'REST2', 'PRE2', 'DROP']), sets: [] });
const kKeep = rk.items.find(i => i.isrc === 'KEEP'), kPre = rk.items.find(i => i.isrc === 'PRE1');
const allK = scoreOnly(k, ['DROP']);
expect('kept moving through the change: carry is high', (kKeep?.parts.carry ?? 0) > 0.7);
expect('standing before the song: no carry (it drops out)', kPre?.parts.carry == null);
expect('stopping at the change: carry is low', (allK?.parts.carry ?? 1) < 0.4);

// 4. A known DJ edit at a night with no lineup: its DJ, title and link
const unknownStart = recap.items.find(i => i.kind === 'unknown')!.startsAt;
const noLineup = buildNightRecap({
  sessionId: 'D', venueName: null, startedAt: T0, endedAt: a.end, clips: a.clips, musicMinutes: a.musicMinutes, sets: [], songs: [],
  edits: [{ dj: 'DJ Edit Maker', title: 'Levitating (DJ Edit Maker rework)', link: 'https://soundcloud.com/editmaker/levitating', firstHeardMs: unknownStart + 60_000, lastHeardMs: unknownStart + 120_000 }],
});
const credited = noLineup.items.find(i => i.kind === 'unknown');
expect('without a lineup, a matched edit credits its DJ', credited?.djName === 'DJ Edit Maker');
expect('a registered edit shows its title and link', credited?.title === 'Levitating (DJ Edit Maker rework)' && credited?.editLink === 'https://soundcloud.com/editmaker/levitating');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
