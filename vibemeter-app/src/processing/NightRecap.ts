import { computeWeightedTempoMatch } from './BeatSync';

/**
 * "Your night in songs" (build 25, refined for build 26): the songs a person vibed with most,
 * ranked passively from the session's 10 s clips, with no rating needed. Pure (no React Native),
 * tested with `npx tsx scripts/night-recap-test.ts`.
 *
 * A song's score combines four signals, each 0–1 and each compared with the person's own night
 * (so a calm dancer's favourite still comes out on top). Research basis (docs/HANDOFF.md):
 * - intensity: how much they moved (movement energy percentile within the night). Movement
 *   predicted enjoyment in Martella et al. 2015; the urge to move tracks pleasure (Witek et al.
 *   2014, Janata et al. 2012).
 * - entrainment: how locked to the music the movement was: phase locking to the beat (PLV), else
 *   movement tempo agreeing with the song tempo or a multiple of it (half, double: 0.9; quarter,
 *   triple, four times: 0.5–0.6, because they are rarer and say less; HARMONIC_WEIGHTS). Sensorimotor coupling to the
 *   beat is the core of "groove" (Janata 2012; Burger et al. 2013; Swarbrick et al. 2019).
 * - persistence: the share of the song spent moving more than usual: sustained dancing rather than
 *   a burst (dancing through the song; analysis/engagement.py).
 * - lift: whether movement rose when the song started compared with the 2 minutes before:
 *   people step up (or return to the floor) for songs they like.
 * - groove (small, song-level): how groove-friendly the song's sound was compared with the rest of
 *   the night's music: clear pulse, strong bass, lively spectral flux (Burger et al. 2013, Ellamil
 *   et al. 2016) and a tempo in the 100-150 BPM range. A prior about the song, not about the
 *   person, so it carries little weight until the 👍/👎 show whether it helps.
 * - carry (small): the person was moving before the song and kept moving through the change
 *   (analysis/engagement.py: through_song_change). Missing when they weren't moving before it.
 * There is no walking filter (the movement label is not trusted yet; only relative movement and beat
 * lock count). The weights
 * are priors: every 👍/👎 is uploaded with these components so the analysis can fit them.
 */

export interface RecapClip {
  clipStart: number;              // ms
  movementEnergy: number | null;
  beatPlv: number | null;
  movementBpm: number | null;
  songBpm: number | null;         // the music's tempo for that minute: the recognised song's, the beat the phone heard, or the nearest measured one (carryTempo)
  pulseClarity: number | null;    // the minute's audio features (song-level groove)
  spectralFlux: number | null;
  subBass: number | null;
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
  djLink?: string | null;         // the DJ's SoundCloud / Instagram / Beatport
  startsAt: number;               // ms
  endsAt: number;
}

/** A known DJ edit heard during the night (matched in the downloaded DJ edit catalog). */
export interface HeardEdit {
  dj: string | null;
  title: string | null;           // set when the DJ registered the edit
  link?: string | null;           // the edit's link, when the DJ gave one
  firstHeardMs: number;
  lastHeardMs: number;
}

/** The signals behind a score (0–1; null when not measurable for that song). */
export interface ScoreParts {
  intensity: number;
  entrainment: number | null;
  persistence: number;
  lift: number | null;
  groove: number | null;
  carry: number | null;
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
  parts: ScoreParts;
  reason: string;
  djName: string | null;
  djLink: string | null;
  editLink: string | null;
}

/** A stretch of the night the person's movement followed the music's beat. */
export interface LockedStretch {
  startsAt: number;
  endsAt: number;
  minutes: number;               // locked minutes inside it
}

export interface LockedSummary {
  minutes: number;               // locked minutes in the whole night
  stretches: LockedStretch[];    // at least LOCKED_MIN_MIN minutes each, in time order
  longest: LockedStretch | null;
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
  locked?: LockedSummary;         // from build 34; older stored recaps don't have it
}

export const RECAP = {
  MAX_ITEMS: 5,
  MIN_SCORE: 0.3,                 // below this the person didn't really move to it: not listed
  MIN_CLIPS: 3,                   // ≥ 30 s on a body for a song to be ranked
  MIN_UNKNOWN_CLIPS: 12,          // ≥ 2 min for an unrecognised stretch
  MAX_GAP_MS: 30_000,             // an unrecognised stretch breaks at a longer gap
  // Priors from research and judgement (groove and carry small until the 👍/👎 fit them)
  WEIGHTS: { intensity: 0.30, entrainment: 0.27, persistence: 0.17, lift: 0.12, groove: 0.08, carry: 0.06 },
  LOCKED_PLV: 0.4,                // a clip "on the beat"
  STRONG_PCT: 0.6,                // a clip of strong movement (top 40% of the night)
  ABOVE_USUAL_PCT: 0.5,           // persistence: moving more than the night's median
  LIFT_WINDOW_MS: 120_000,        // the 2 minutes before a song, for the lift
  MIN_LIFT_CLIPS: 3,
  CARRY_CLIPS: 3,                 // clips either side of the song change that are compared
  CARRY_MAX_GAP_MS: 30_000,       // the earlier clips must be right before the song
  TEMPO_FULL: [100, 150] as const, // tempo range with full groove credit (falls to 0 at 70 and 180)
  CLIP_MS: 10_000,
  // Locked to the beat (provisional, from the first real night): a clip is locked when its movement
  // peaks follow the beat (PLV >= LOCKED_PLV) or its movement tempo matches the music's (graded match
  // >= LOCKED_TEMPO_MATCH, half/double included); a minute is locked with at least LOCKED_CLIPS locked
  // clips (20 s); a stretch may skip LOCKED_GAP_MIN minute and needs LOCKED_MIN_MIN minutes
  LOCKED_TEMPO_MATCH: 0.5,
  LOCKED_CLIPS: 2,
  LOCKED_GAP_MIN: 1,
  LOCKED_MIN_MIN: 2,
  // A DJ set holds its tempo for tens of minutes, so a minute without a measured music tempo uses the
  // nearest measured one, up to this far away (the phone can't always hear the beat at club volume)
  TEMPO_CARRY_MS: 15 * 60_000,
} as const;


const ON_BODY = new Set(['on_body_moving', 'on_body_still']);

const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function percentileRanks(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (v: number) => {
    if (n <= 1) return 0.5;
    // Share of the night's clips with less movement (ties count half)
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    let eq = 0;
    for (let i = lo; i < n && sorted[i] === v; i++) eq++;
    return (lo + eq / 2) / n;
  };
}

function minutesText(clips: number): string {
  const min = Math.round((clips * RECAP.CLIP_MS) / 60_000);
  return min <= 1 ? '1 min' : `${min} min`;
}

function setAt(sets: DjSet[], ms: number): DjSet | null {
  return sets.find(s => ms >= s.startsAt && ms < s.endsAt) ?? null;
}

/** A minute's measured music tempo (the recognised song's, or the beat the phone heard); null = not measured. */
export interface TempoMinute { ms: number; bpm: number | null }

/**
 * Fills the minutes without a measured music tempo with the nearest measured one within `maxMs` (either
 * side). Keyed by the minute's start (ms). A minute with nothing measured nearby stays null.
 */
export function carryTempo(minutes: TempoMinute[], maxMs: number = RECAP.TEMPO_CARRY_MS): Map<number, number | null> {
  const measured = minutes.filter(m => m.bpm != null).sort((a, b) => a.ms - b.ms);
  const out = new Map<number, number | null>();
  for (const m of minutes) {
    if (m.bpm != null) { out.set(m.ms, m.bpm); continue; }
    let best: TempoMinute | null = null;
    for (const c of measured) {
      const d = Math.abs(c.ms - m.ms);
      if (d <= maxMs && (best == null || d < Math.abs(best.ms - m.ms))) best = c;
    }
    out.set(m.ms, best ? best.bpm : null);
  }
  return out;
}

/** Whether one clip's movement followed the beat: by phase locking, else by tempo (multiples count). */
export function clipLocked(c: RecapClip): boolean {
  if ((c.beatPlv ?? 0) >= RECAP.LOCKED_PLV) return true;
  return computeWeightedTempoMatch(c.movementBpm, c.songBpm).tempoMatch >= RECAP.LOCKED_TEMPO_MATCH;
}

/** The stretches of the night spent locked to the beat, found from the on-body clips. */
export function lockedToBeat(clips: RecapClip[]): LockedSummary {
  const perMinute = new Map<number, number>();            // minute start -> locked clips
  for (const c of clips) {
    const minute = Math.floor(c.clipStart / 60_000) * 60_000;
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + (clipLocked(c) ? 1 : 0));
  }
  const lockedMinutes = [...perMinute.entries()].filter(([, n]) => n >= RECAP.LOCKED_CLIPS).map(([m]) => m).sort((a, b) => a - b);
  const stretches: LockedStretch[] = [];
  let cur: { start: number; end: number; minutes: number } | null = null;
  for (const m of lockedMinutes) {
    if (cur && (m - cur.end) / 60_000 <= RECAP.LOCKED_GAP_MIN + 1) { cur.end = m; cur.minutes++; }
    else { if (cur) stretches.push({ startsAt: cur.start, endsAt: cur.end + 60_000, minutes: cur.minutes }); cur = { start: m, end: m, minutes: 1 }; }
  }
  if (cur) stretches.push({ startsAt: cur.start, endsAt: cur.end + 60_000, minutes: cur.minutes });
  const kept = stretches.filter(s => s.minutes >= RECAP.LOCKED_MIN_MIN);
  return {
    minutes: kept.reduce((s, k) => s + k.minutes, 0),
    stretches: kept,
    longest: kept.reduce<LockedStretch | null>((best, k) => (best == null || k.minutes > best.minutes ? k : best), null),
  };
}

/** The night's own spread of each song-level sound feature, to compare a song with its night. */
export interface GrooveContext {
  pulse: (v: number) => number;
  flux: (v: number) => number;
  bass: (v: number) => number;
}

/** 1 inside the tempo range people dance to most (100–150 BPM), falling to 0 at 70 and 180. */
export function tempoFit(bpm: number): number {
  const [lo, hi] = RECAP.TEMPO_FULL;
  if (bpm >= lo && bpm <= hi) return 1;
  return bpm < lo ? clamp01((bpm - 70) / (lo - 70)) : clamp01((180 - bpm) / (180 - hi));
}

const meanOf = (xs: number[]): number | null => (xs.length ? mean(xs) : null);

/** The signals for a group of clips, and the weighted score over the measurable ones. */
export function scoreParts(
  clips: RecapClip[], pct: (v: number) => number, before: RecapClip[], groove?: GrooveContext,
): { score: number; parts: ScoreParts } {
  const pcts = clips.map(c => pct(c.movementEnergy ?? 0));
  const intensity = mean(pcts);

  // Entrainment: phase locking when the beat grid was measured, else tempo agreement
  const plvs = clips.map(c => c.beatPlv).filter((v): v is number => v != null);
  const matches = clips
    .filter(c => c.movementBpm != null && c.songBpm != null)
    .map(c => computeWeightedTempoMatch(c.movementBpm, c.songBpm).tempoMatch);
  const entrainment = plvs.length >= 2 ? mean(plvs) : matches.length >= 2 ? mean(matches) : null;

  const persistence = pcts.filter(p => p > RECAP.ABOVE_USUAL_PCT).length / pcts.length;

  const lift = before.length >= RECAP.MIN_LIFT_CLIPS
    ? clamp01(0.5 + intensity - mean(before.map(c => pct(c.movementEnergy ?? 0))))
    : null;

  // Groove: song-level sound features against the rest of the night's music (at least two measured)
  let grooveValue: number | null = null;
  if (groove) {
    const part = (get: (c: RecapClip) => number | null, rank: (v: number) => number) =>
      meanOf(clips.map(get).filter((v): v is number => v != null).map(rank));
    const bpms = clips.map(c => c.songBpm).filter((v): v is number => v != null);
    const bits = [
      part(c => c.pulseClarity, groove.pulse), part(c => c.subBass, groove.bass), part(c => c.spectralFlux, groove.flux),
      bpms.length ? tempoFit(mean(bpms)) : null,
    ].filter((v): v is number => v != null);
    grooveValue = bits.length >= 2 ? mean(bits) : null;
  }

  // Carry: moving right before the song, and still moving through its first clips
  let carry: number | null = null;
  const recent = before.slice(-RECAP.CARRY_CLIPS);
  const startsAt = clips[0].clipStart;
  if (recent.length >= RECAP.CARRY_CLIPS && startsAt - recent[recent.length - 1].clipStart <= RECAP.CARRY_MAX_GAP_MS + RECAP.CLIP_MS
      && mean(recent.map(c => pct(c.movementEnergy ?? 0))) > RECAP.ABOVE_USUAL_PCT) {
    carry = clamp01(mean(pcts.slice(0, RECAP.CARRY_CLIPS)));
  }

  const parts: ScoreParts = { intensity, entrainment, persistence, lift, groove: grooveValue, carry };
  let sum = 0, weight = 0;
  for (const k of Object.keys(RECAP.WEIGHTS) as (keyof ScoreParts)[]) {
    const v = parts[k];
    if (v == null) continue;
    sum += RECAP.WEIGHTS[k] * v;
    weight += RECAP.WEIGHTS[k];
  }
  const round = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);
  return {
    score: Math.round((sum / weight) * 1000) / 1000,
    parts: {
      intensity: round(intensity)!, entrainment: round(entrainment), persistence: round(persistence)!, lift: round(lift),
      groove: round(grooveValue), carry: round(carry),
    },
  };
}

/** A short, honest reason: the signal that stood out most for this song. */
function reasonFor(clips: RecapClip[], pct: (v: number) => number, parts: ScoreParts): string {
  const locked = clips.filter(c => (c.beatPlv ?? 0) >= RECAP.LOCKED_PLV).length;
  const strong = clips.filter(c => pct(c.movementEnergy ?? 0) >= RECAP.STRONG_PCT).length;
  if (locked * RECAP.CLIP_MS >= 60_000) return `In sync with the beat for ${minutesText(locked)}`;
  if (parts.entrainment != null && parts.entrainment >= 0.6) return 'You moved in time with this one';
  if (parts.lift != null && parts.lift >= 0.75) return 'You stepped it up when this dropped';
  if (parts.carry != null && parts.carry >= 0.8) return 'You kept dancing straight through the change';
  if (strong * RECAP.CLIP_MS >= 60_000) return `Danced hard for ${minutesText(strong)}`;
  if (parts.persistence >= 0.7) return 'You kept moving all the way through';
  return parts.intensity >= 0.6 ? 'You moved more than usual' : 'You moved to this one';
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
  minScore?: number;              // below this an entry isn't listed (default RECAP.MIN_SCORE; tests lower it)
}): NightRecap {
  // Clips that tell us about dancing: on a body, with a motion reading. There is deliberately no
  // "walking" filter: the stored label can't tell walking from dancing with the phone in a pocket (the
  // 21 Nov night), and everything here is relative to the person's own night.
  const onBody = input.clips.filter(c => c.movementEnergy != null && ON_BODY.has(c.phoneContext ?? ''));
  const pct = percentileRanks(onBody.map(c => c.movementEnergy!));
  const isMusic = (c: RecapClip) => input.musicMinutes.has(Math.floor(c.clipStart / 60_000) * 60_000);
  // Song-level sound features of the night's music, to rank each song against the rest of its night
  const musicOnBody = onBody.filter(isMusic);
  const grooveCtx: GrooveContext = {
    pulse: percentileRanks(musicOnBody.map(c => c.pulseClarity).filter((v): v is number => v != null)),
    flux: percentileRanks(musicOnBody.map(c => c.spectralFlux).filter((v): v is number => v != null)),
    bass: percentileRanks(musicOnBody.map(c => c.subBass).filter((v): v is number => v != null)),
  };
  const beforeOf = (startsAt: number) =>
    onBody.filter(c => c.clipStart < startsAt && c.clipStart >= startsAt - RECAP.LIFT_WINDOW_MS);

  const items: RecapItem[] = [];
  const addItem = (
    base: Pick<RecapItem, 'kind' | 'isrc' | 'title' | 'artist' | 'appleMusicId' | 'editLink'>,
    clips: RecapClip[],
    fallbackDj: { name: string | null; link: string | null } = { name: null, link: null },
  ) => {
    const startsAt = clips[0].clipStart;
    const endsAt = clips[clips.length - 1].clipStart + RECAP.CLIP_MS;
    const { score, parts } = scoreParts(clips, pct, beforeOf(startsAt), grooveCtx);
    const set = setAt(input.sets, (startsAt + endsAt) / 2);
    items.push({
      ...base, startsAt, endsAt, score, parts, reason: reasonFor(clips, pct, parts),
      djName: set?.djName ?? fallbackDj.name, djLink: set ? (set.djLink ?? null) : fallbackDj.link,
    });
  };

  // Recognised songs
  const songInfo = new Map(input.songs.map(s => [s.isrc, s]));
  const bySong = new Map<string, RecapClip[]>();
  for (const c of onBody) if (c.songIsrc) bySong.set(c.songIsrc, [...(bySong.get(c.songIsrc) ?? []), c]);
  for (const [isrc, clips] of bySong) {
    if (clips.length < RECAP.MIN_CLIPS) continue;
    const info = songInfo.get(isrc);
    addItem({ kind: 'song', isrc, title: info?.title ?? null, artist: info?.artist ?? null, appleMusicId: info?.appleMusicId ?? null, editLink: null }, clips);
  }

  // Unrecognised stretches of music (edits, mixes, unreleased tracks). A known DJ edit heard in
  // the stretch credits its DJ (when no lineup says otherwise) and gives its title and link.
  let run: RecapClip[] = [];
  const flush = () => {
    if (run.length >= RECAP.MIN_UNKNOWN_CLIPS) {
      const startsAt = run[0].clipStart;
      const endsAt = run[run.length - 1].clipStart + RECAP.CLIP_MS;
      const heard = (input.edits ?? []).find(e => e.lastHeardMs >= startsAt && e.firstHeardMs < endsAt) ?? null;
      addItem(
        { kind: 'unknown', isrc: null, title: heard?.title ?? null, artist: null, appleMusicId: null, editLink: heard?.link ?? null },
        run, { name: heard?.dj ?? null, link: null },
      );
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
  const listed = items.filter(i => i.score >= (input.minScore ?? RECAP.MIN_SCORE));

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
    locked: lockedToBeat(onBody),
  };
}
