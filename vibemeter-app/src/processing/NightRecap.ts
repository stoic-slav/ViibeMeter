/**
 * "Your night in songs" (build 25): the songs a person moved to most, ranked passively from the
 * session's 10 s clips, with no rating needed. Pure (no React Native) so it can be tested with
 * `npx tsx scripts/night-recap-test.ts`.
 *
 * Each person is compared with their own night: movement energy becomes a percentile among the
 * night's on-body clips, so a calm dancer's favourite still comes out on top. A song's score mixes
 * that with how well movement locked to the beat (PLV). Stretches of music with no recognised
 * song (edits, mixes, unreleased tracks) are ranked the same way and credited to the DJ playing.
 */

export interface RecapClip {
  clipStart: number;              // ms
  movementEnergy: number | null;
  beatPlv: number | null;
  songIsrc: string | null;
  phoneContext: string | null;
}

export interface RecapSong {
  isrc: string;
  title: string | null;
  artist: string | null;
  appleMusicId: string | null;
}

export interface DjSet {
  djName: string;
  startsAt: number;               // ms
  endsAt: number;
}

/** A known DJ edit heard during the night (matched in the downloaded DJ edit catalog). */
export interface HeardEdit {
  dj: string | null;
  title: string | null;          // set when the DJ registered the edit
  firstHeardMs: number;
  lastHeardMs: number;
}

export interface RecapItem {
  kind: 'song' | 'unknown';
  isrc: string | null;
  title: string | null;
  artist: string | null;
  appleMusicId: string | null;
  startsAt: number;               // first and last clip of the song (or stretch)
  endsAt: number;
  score: number;                  // 0–1
  reason: string;
  djName: string | null;
}

export interface NightRecap {
  sessionId: string;
  venueName: string | null;
  startedAt: number;
  endedAt: number;
  dancingMinutes: number;         // on-body minutes with strong movement (top 40% of the night)
  recognisedSongs: number;
  coverage: number | null;        // share of music clips that had a recognised song
  items: RecapItem[];             // best first, at most MAX_ITEMS
}

export const RECAP = {
  MAX_ITEMS: 5,
  MIN_SCORE: 0.3,                 // below this the person didn't really move to it: not listed
  MIN_CLIPS: 3,                   // ≥ 30 s on a body for a song to be ranked
  MIN_UNKNOWN_CLIPS: 12,          // ≥ 2 min for an unrecognised stretch
  MAX_GAP_MS: 30_000,             // an unrecognised stretch breaks at a longer gap
  ENERGY_WEIGHT: 0.65,
  PLV_WEIGHT: 0.35,
  LOCKED_PLV: 0.4,                // a clip "on the beat"
  STRONG_PCT: 0.6,                // a clip of strong movement (top 40% of the night)
  CLIP_MS: 10_000,
} as const;

const ON_BODY = new Set(['on_body_moving', 'on_body_still']);

function percentileRanks(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (v: number) => {
    if (n <= 1) return 0.5;
    // Share of the night's clips with less movement (ties count half)
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    const below = lo;
    let eq = 0;
    for (let i = lo; i < n && sorted[i] === v; i++) eq++;
    return (below + eq / 2) / n;
  };
}

function minutesText(clips: number): string {
  const min = Math.round((clips * RECAP.CLIP_MS) / 60_000);
  return min <= 1 ? '1 min' : `${min} min`;
}

function djAt(sets: DjSet[], ms: number): string | null {
  return sets.find(s => ms >= s.startsAt && ms < s.endsAt)?.djName ?? null;
}

function scoreGroup(clips: RecapClip[], pct: (v: number) => number): { score: number; reason: string } {
  const pcts = clips.map(c => pct(c.movementEnergy ?? 0));
  const energy = pcts.reduce((s, v) => s + v, 0) / pcts.length;
  const plvs = clips.map(c => c.beatPlv).filter((v): v is number => v != null);
  const plv = plvs.length >= 2 ? plvs.reduce((s, v) => s + v, 0) / plvs.length : null;
  const score = plv != null ? RECAP.ENERGY_WEIGHT * energy + RECAP.PLV_WEIGHT * plv : energy;
  const locked = clips.filter(c => (c.beatPlv ?? 0) >= RECAP.LOCKED_PLV).length;
  const strong = pcts.filter(p => p >= RECAP.STRONG_PCT).length;
  const reason = locked * RECAP.CLIP_MS >= 60_000
    ? `On the beat for ${minutesText(locked)}`
    : strong * RECAP.CLIP_MS >= 60_000
      ? `Danced hard for ${minutesText(strong)}`
      : energy >= 0.6 ? 'You moved more than usual' : 'You moved to this one';
  return { score: Math.round(score * 1000) / 1000, reason };
}

/**
 * `musicMinutes`: start times (ms, minute-aligned) of the session's minutes with music detected,
 * used for unrecognised stretches and coverage.
 */
export function buildNightRecap(input: {
  sessionId: string;
  venueName: string | null;
  startedAt: number;
  endedAt: number;
  clips: RecapClip[];
  songs: RecapSong[];
  musicMinutes: Set<number>;
  sets: DjSet[];
  edits?: HeardEdit[];
}): NightRecap {
  const onBody = input.clips.filter(c => c.movementEnergy != null && ON_BODY.has(c.phoneContext ?? ''));
  const pct = percentileRanks(onBody.map(c => c.movementEnergy!));
  const isMusic = (c: RecapClip) => input.musicMinutes.has(Math.floor(c.clipStart / 60_000) * 60_000);

  const items: RecapItem[] = [];

  // Recognised songs
  const songInfo = new Map(input.songs.map(s => [s.isrc, s]));
  const bySong = new Map<string, RecapClip[]>();
  for (const c of onBody) if (c.songIsrc) bySong.set(c.songIsrc, [...(bySong.get(c.songIsrc) ?? []), c]);
  for (const [isrc, clips] of bySong) {
    if (clips.length < RECAP.MIN_CLIPS) continue;
    const info = songInfo.get(isrc);
    const { score, reason } = scoreGroup(clips, pct);
    const startsAt = clips[0].clipStart;
    const endsAt = clips[clips.length - 1].clipStart + RECAP.CLIP_MS;
    items.push({
      kind: 'song', isrc, title: info?.title ?? null, artist: info?.artist ?? null, appleMusicId: info?.appleMusicId ?? null,
      startsAt, endsAt, score, reason, djName: djAt(input.sets, (startsAt + endsAt) / 2),
    });
  }

  // Unrecognised stretches of music (edits, mixes, unreleased tracks)
  let run: RecapClip[] = [];
  const flush = () => {
    if (run.length >= RECAP.MIN_UNKNOWN_CLIPS) {
      const { score, reason } = scoreGroup(run, pct);
      const startsAt = run[0].clipStart;
      const endsAt = run[run.length - 1].clipStart + RECAP.CLIP_MS;
      // A known DJ edit heard in this stretch credits its DJ (when no lineup says otherwise) and,
      // if the DJ registered it, gives its title
      const heard = (input.edits ?? []).find(e => e.lastHeardMs >= startsAt && e.firstHeardMs < endsAt) ?? null;
      items.push({
        kind: 'unknown', isrc: null, title: heard?.title ?? null, artist: null, appleMusicId: null,
        startsAt, endsAt, score, reason, djName: djAt(input.sets, (startsAt + endsAt) / 2) ?? heard?.dj ?? null,
      });
    }
    run = [];
  };
  for (const c of onBody) {
    if (c.songIsrc || !isMusic(c)) { flush(); continue; }
    if (run.length > 0 && c.clipStart - run[run.length - 1].clipStart > RECAP.MAX_GAP_MS) flush();
    run.push(c);
  }
  flush();

  items.sort((a, b) => b.score - a.score);
  const listed = items.filter(i => i.score >= RECAP.MIN_SCORE);

  const musicClips = input.clips.filter(isMusic);
  return {
    sessionId: input.sessionId,
    venueName: input.venueName,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    dancingMinutes: Math.round((onBody.filter(c => pct(c.movementEnergy!) >= RECAP.STRONG_PCT && c.phoneContext === 'on_body_moving').length * RECAP.CLIP_MS) / 60_000),
    recognisedSongs: new Set(input.clips.map(c => c.songIsrc).filter(Boolean)).size,
    coverage: musicClips.length > 0 ? musicClips.filter(c => c.songIsrc).length / musicClips.length : null,
    items: listed.slice(0, RECAP.MAX_ITEMS),
  };
}
