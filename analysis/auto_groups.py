"""
ViibeMeter — automatic grouping (which phones are at the same party, from the music alone)

Phones in the same room hear the same playback of the same track. For every recognised song
the app uploads `song_started_at`: the wall-clock moment this playback of the track began
(from ShazamKit's match offset). Two phones that heard the same track (`song_isrc`) start
within START_TOLERANCE_S of each other heard the same playback, so they were together.
No GPS, no event code, nothing personal.

Why the start time and not just the song: on a Saturday night several bars play the same hit
in the same minute, but they almost never start it within the same second. Two different
shared playbacks in a row make a coincidence practically impossible, hence MIN_SHARED_PLAYBACKS.

Groups are recomputed for every minute from the evidence within ±EVIDENCE_WINDOW_MIN,
weighted towards the nearest minutes, so someone who moves from a bar to a club changes group.
Evidence that two phones were apart (in the same minute both recognised songs, but different
playbacks) counts against being together. A group is then only kept whole if its members are
not apart from each other: one phone with links to two venues (someone walking between them)
must not merge the venues.

Known limits:
- Only minutes near a recognised song count. DJ edits, live music and talk are often not
  recognised; long gaps leave phones ungrouped rather than wrongly grouped.
- A radio station or stream heard in two places at once looks like one room.
- It relies on phone clocks (network time, normally well within START_TOLERANCE_S).

Validation against group codes (QR / typed): a shared code is a definite "together" label, so
recall is measured on code pairs. Different codes do NOT mean apart (two friend groups can be
at the same club), so pairs linked across different codes are reported, not counted as errors.

Usage:
  python3 auto_groups.py               (run fetch_data.py first; writes output/auto_groups.csv)
  python3 auto_groups.py --selftest    (synthetic venues, no data needed)
"""

import base64
import sys
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).parent / 'data'
OUTPUT_DIR = Path(__file__).parent / 'output'

START_TOLERANCE_S = 1.5       # same playback if the start times agree within this
MIN_SHARED_PLAYBACKS = 2      # distinct shared playbacks needed to link two phones
EVIDENCE_WINDOW_MIN = 20      # evidence counts for minutes within this distance
EVIDENCE_DECAY_MIN = 4        # …weighted by exp(−Δt / this), so the nearest evidence dominates
REPEAT_WINDOW = pd.Timedelta(minutes=8)  # same-song estimate clusters this close are one playback

# Bass-envelope room fingerprint (see the module docstring)
ENV_FRAMES = 240              # 250 ms frames per minute window
ENV_RANGE_DB = 24             # encoded range around the window median (matches BassEnvelope.ts)
ENV_MIN_OVERLAP = 30          # valid frames both phones need at a lag
ENV_MIN_STD_DB = 1.0          # flatter envelopes carry no evidence
ENV_MAX_LAG = 8               # ±2 s: clock skew and sound travel
ENV_T_HI = 0.60               # peak correlation at or above: "together" (set from the self-test)
ENV_T_LO = 0.25               # at or below: "apart"
ENV_MIN_MINUTES = 3           # consistent "together" minutes needed to link a pair
ENV_LAG_AGREE = 1             # frames: a real pair keeps a stable clock offset


def playbacks(windows: pd.DataFrame, sessions: pd.DataFrame) -> pd.DataFrame:
    """One row per (session, playback): isrc, start time (s), and the minute it was heard."""
    need = {'song_isrc', 'song_started_at'}
    if not need.issubset(windows.columns):
        return pd.DataFrame(columns=['session_id', 'device_id', 'isrc', 'start_s', 'minute'])
    w = windows.dropna(subset=['song_isrc', 'song_started_at']).copy()
    if w.empty:
        return pd.DataFrame(columns=['session_id', 'device_id', 'isrc', 'start_s', 'minute'])
    # Supabase returns ISO timestamps with and without fractional seconds
    started = pd.to_datetime(w['song_started_at'], utc=True, format='ISO8601')
    w['start_s'] = (started - pd.Timestamp(0, tz='UTC')).dt.total_seconds()
    w['minute'] = pd.to_datetime(w['window_start'], utc=True, format='ISO8601').dt.floor('min')
    w = w.merge(sessions[['id', 'device_id']].rename(columns={'id': 'session_id'}), on='session_id', how='left')
    # A playback spans several windows: merge a session's estimates of the same isrc that agree
    rows = []
    for (sid, isrc), g in w.sort_values('start_s').groupby(['session_id', 'song_isrc']):
        clusters, cluster = [], [g.iloc[0]]
        for _, r in g.iloc[1:].iterrows():
            if r['start_s'] - cluster[-1]['start_s'] <= START_TOLERANCE_S:
                cluster.append(r)
            else:
                clusters.append(cluster); cluster = [r]
        clusters.append(cluster)
        # ShazamKit sometimes matches a repeated chorus, giving a start 30–80 s off. Such a
        # cluster overlaps a bigger one of the same song in time: keep only the bigger one.
        # (A song genuinely played again later is far away in time and is kept.)
        kept = []
        for c in sorted(clusters, key=lambda c: -len(c)):
            span = (min(r['minute'] for r in c), max(r['minute'] for r in c))
            clash = any(span[0] - REPEAT_WINDOW <= k_end and k_start <= span[1] + REPEAT_WINDOW
                        for k_start, k_end, _ in kept)
            if not clash:
                kept.append((span[0], span[1], c))
        rows.extend(_merge(c) for _, _, c in kept)
    return pd.DataFrame(rows)


def _merge(cluster):
    return {
        'session_id': cluster[0]['session_id'],
        'device_id': cluster[0]['device_id'],
        'isrc': cluster[0]['song_isrc'],
        'start_s': float(np.median([r['start_s'] for r in cluster])),
        'minute': min(r['minute'] for r in cluster),
    }


EVIDENCE_COLUMNS = ['a', 'b', 'minute', 'kind', 'source', 'lag']


def pair_evidence(pb: pd.DataFrame) -> pd.DataFrame:
    """Shared playbacks (together) and same-minute different playbacks (apart) per session pair."""
    out = []
    if pb.empty:
        return pd.DataFrame(columns=EVIDENCE_COLUMNS)
    # Together: same isrc, start within tolerance, different devices
    for isrc, g in pb.groupby('isrc'):
        recs = g.to_dict('records')
        for x, y in combinations(recs, 2):
            if x['device_id'] == y['device_id'] or x['session_id'] == y['session_id']:
                continue
            if abs(x['start_s'] - y['start_s']) <= START_TOLERANCE_S:
                a, b = sorted([x['session_id'], y['session_id']])
                out.append({'a': a, 'b': b, 'minute': min(x['minute'], y['minute']), 'kind': 'together',
                            'source': 'shazam', 'lag': np.nan})
    # Apart: in the same minute both recognised a song, and the songs differ. The same song with
    # different starts is not counted: it can be a mis-matched repeat on one phone.
    for minute, g in pb.groupby('minute'):
        recs = g.to_dict('records')
        for x, y in combinations(recs, 2):
            if x['device_id'] == y['device_id'] or x['session_id'] == y['session_id']:
                continue
            if x['isrc'] != y['isrc']:
                a, b = sorted([x['session_id'], y['session_id']])
                out.append({'a': a, 'b': b, 'minute': minute, 'kind': 'apart', 'source': 'shazam', 'lag': np.nan})
    return pd.DataFrame(out, columns=EVIDENCE_COLUMNS)


def decode_envelope(encoded) -> np.ndarray | None:
    """base64 bass envelope → 240 dB values relative to the window median (NaN = missing)."""
    if not isinstance(encoded, str) or not encoded:
        return None
    raw = np.frombuffer(base64.b64decode(encoded), dtype=np.uint8).astype(float)
    if raw.size != ENV_FRAMES:
        return None
    env = (raw - 1) / 254 * 2 * ENV_RANGE_DB - ENV_RANGE_DB
    env[raw == 0] = np.nan
    return env


def envelope_xcorr(x: np.ndarray, y: np.ndarray):
    """Peak Pearson correlation of two envelopes over lags −ENV_MAX_LAG…+ENV_MAX_LAG (y shifted),
    on the frames both have at each lag. Returns (r, lag), or None without enough evidence."""
    for e in (x, y):
        v = e[~np.isnan(e)]
        if v.size < ENV_MIN_OVERLAP or v.std() < ENV_MIN_STD_DB:
            return None
    best = None
    n = len(x)
    for lag in range(-ENV_MAX_LAG, ENV_MAX_LAG + 1):
        xs = x[max(0, -lag): n - max(0, lag)]
        ys = y[max(0, lag): n - max(0, -lag)]
        ok = ~np.isnan(xs) & ~np.isnan(ys)
        if ok.sum() < ENV_MIN_OVERLAP:
            continue
        a, b = xs[ok], ys[ok]
        if a.std() < 1e-6 or b.std() < 1e-6:
            continue
        r = float(np.corrcoef(a, b)[0, 1])
        if best is None or r > best[0]:
            best = (r, lag)
    return best


def envelope_evidence(windows: pd.DataFrame, sessions: pd.DataFrame) -> pd.DataFrame:
    """Per minute and pair of phones: 'together' if their bass envelopes correlate at or above
    ENV_T_HI at some lag within ±2 s, 'apart' at or below ENV_T_LO, otherwise nothing."""
    if 'bass_envelope' not in windows.columns:
        return pd.DataFrame(columns=EVIDENCE_COLUMNS)
    w = windows.dropna(subset=['bass_envelope']).copy()
    if w.empty:
        return pd.DataFrame(columns=EVIDENCE_COLUMNS)
    w['minute'] = pd.to_datetime(w['window_start'], utc=True, format='ISO8601').dt.floor('min')
    w = w.merge(sessions[['id', 'device_id']].rename(columns={'id': 'session_id'}), on='session_id', how='left')
    w['env'] = w['bass_envelope'].map(decode_envelope)
    out = []
    for minute, g in w.groupby('minute'):
        recs = [r for r in g.to_dict('records') if r['env'] is not None]
        for x, y in combinations(recs, 2):
            if x['device_id'] == y['device_id'] or x['session_id'] == y['session_id']:
                continue
            a, b = sorted([x['session_id'], y['session_id']])
            ex, ey = (x['env'], y['env']) if x['session_id'] == a else (y['env'], x['env'])
            res = envelope_xcorr(ex, ey)
            if res is None:
                continue
            r, lag = res
            kind = 'together' if r >= ENV_T_HI else 'apart' if r <= ENV_T_LO else None
            if kind:
                out.append({'a': a, 'b': b, 'minute': minute, 'kind': kind, 'source': 'envelope', 'lag': lag})
    return pd.DataFrame(out, columns=EVIDENCE_COLUMNS)


def _consistent_envelope_minutes(g: pd.DataFrame) -> pd.Series:
    """Mask of envelope 'together' rows whose lag agrees (±ENV_LAG_AGREE) with the pair's median lag."""
    env_t = (g['source'] == 'envelope') & (g['kind'] == 'together')
    if not env_t.any():
        return env_t
    med = g.loc[env_t, 'lag'].median()
    return env_t & ((g['lag'] - med).abs() <= ENV_LAG_AGREE)


def auto_groups(windows: pd.DataFrame, sessions: pd.DataFrame,
                sources: tuple = ('shazam', 'envelope')) -> pd.DataFrame:
    """One row per (session, minute) with an automatic group id and its size.

    sources: which evidence to use ('shazam' playbacks, 'envelope' bass fingerprint).
    """
    w = windows.copy()
    w['minute'] = pd.to_datetime(w['window_start'], utc=True, format='ISO8601').dt.floor('min')
    active = w.groupby('minute')['session_id'].apply(lambda s: sorted(set(s))).to_dict()
    parts = []
    if 'shazam' in sources:
        parts.append(pair_evidence(playbacks(windows, sessions)))
    if 'envelope' in sources:
        parts.append(envelope_evidence(windows, sessions))
    parts = [p for p in parts if not p.empty]
    ev = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=EVIDENCE_COLUMNS)
    window = pd.Timedelta(minutes=EVIDENCE_WINDOW_MIN)

    rows = []
    for minute, sids in sorted(active.items()):
        parent = {s: s for s in sids}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        if not ev.empty:
            near = ev[(ev['minute'] >= minute - window) & (ev['minute'] <= minute + window)]
            near = near[near['a'].isin(sids) & near['b'].isin(sids)]
            score = {}
            for (a, b), g in near.groupby(['a', 'b']):
                # Envelope 'together' minutes only count if their lags agree: a real pair keeps a
                # stable clock offset, chance matches do not
                env_ok = _consistent_envelope_minutes(g)
                shazam_t = (g['source'] == 'shazam') & (g['kind'] == 'together')
                use = shazam_t | env_ok | (g['kind'] == 'apart')
                gu = g[use]
                wts = np.exp(-np.abs((gu['minute'] - minute).dt.total_seconds() / 60) / EVIDENCE_DECAY_MIN)
                sign = np.where(gu['kind'] == 'together', 1.0, -1.0)
                enough = int(shazam_t.sum()) >= MIN_SHARED_PLAYBACKS or int(env_ok.sum()) >= ENV_MIN_MINUTES
                score[(a, b)] = (enough, float((wts * sign).sum()))
            # Strongest links first; refuse a merge that would put two phones that are apart
            # (negative score) into one group
            members = {s: {s} for s in sids}
            for (a, b), (enough, sc) in sorted(score.items(), key=lambda kv: -kv[1][1]):
                if not enough or sc <= 0:
                    continue
                ra, rb = find(a), find(b)
                if ra == rb:
                    continue
                if any(score.get(tuple(sorted((x, y))), (0, 0.0))[1] < 0
                       for x in members[ra] for y in members[rb]):
                    continue
                parent[ra] = rb
                members[rb] |= members.pop(ra)
        comps = {}
        for s in sids:
            comps.setdefault(find(s), []).append(s)
        for members in comps.values():
            gid = 'A-' + min(members)[:8]
            for s in members:
                rows.append({'session_id': s, 'minute': minute, 'auto_group': gid, 'group_size': len(members)})
    return pd.DataFrame(rows)


def validate_against_codes(groups: pd.DataFrame, sessions: pd.DataFrame) -> dict:
    """Recall on same-code pairs; count of pairs linked across different codes (not errors)."""
    if groups.empty or 'event_code' not in sessions.columns:
        return {}
    codes = sessions.set_index('id')['event_code']
    shared = codes[codes.notna()].value_counts()
    shared = set(shared[shared > 1].index)  # codes someone actually joined
    same_code_pairs = linked_same = linked_cross = linked_total = 0
    for minute, g in groups.groupby('minute'):
        sids = list(g['session_id'])
        gid = dict(zip(g['session_id'], g['auto_group']))
        for a, b in combinations(sids, 2):
            ca, cb = codes.get(a), codes.get(b)
            linked = gid[a] == gid[b]
            linked_total += linked
            if ca is not None and ca == cb and ca in shared:
                same_code_pairs += 1
                linked_same += linked
            elif linked and ca in shared and cb in shared:
                linked_cross += 1
    return {
        'same_code_pair_minutes': same_code_pairs,
        'recall_on_code_pairs': (linked_same / same_code_pairs) if same_code_pairs else float('nan'),
        'linked_pair_minutes': linked_total,
        'linked_across_different_codes': linked_cross,
    }


def validate_by_source(windows: pd.DataFrame, sessions: pd.DataFrame) -> dict:
    """Recall on same-code pairs with Shazam evidence only, envelope evidence only, and both."""
    out = {}
    for label, src in [('shazam_only', ('shazam',)), ('envelope_only', ('envelope',)), ('both', ('shazam', 'envelope'))]:
        v = validate_against_codes(auto_groups(windows, sessions, sources=src), sessions)
        out[label] = v.get('recall_on_code_pairs', float('nan'))
    return out


# ── Synthetic self-test ───────────────────────────────────────────────────────

OUTLIER_RATE = 0.15  # share of start estimates off by a chorus (4 Oct device test: 3 of ~15)


def _simulate(seed=1):
    """Three venues; A and B share part of a playlist (same hits, different start times);
    one phone walks from venue A to venue B halfway through; 40% of minutes unrecognised."""
    rng = np.random.default_rng(seed)
    t0 = pd.Timestamp('2026-10-10T22:00:00Z')
    hits = [f'HIT{i:02d}' for i in range(30)]
    venues = {}
    for v in 'ABC':
        tracks, t = [], t0 - pd.Timedelta(seconds=float(rng.uniform(0, 200)))
        while t < t0 + pd.Timedelta(minutes=70):
            dur = float(rng.uniform(150, 260))
            isrc = rng.choice(hits) if (v in 'AB' and rng.random() < 0.6) else f'{v}{len(tracks):03d}'
            tracks.append((isrc, t, dur))
            t += pd.Timedelta(seconds=dur)
        venues[v] = tracks
    plan = {'a1': 'A', 'a2': 'A', 'a3': 'A', 'b1': 'B', 'b2': 'B', 'c1': 'C', 'c2': 'C', 'mover': 'AB'}
    windows, sessions, truth = [], [], []
    for sid, v in plan.items():
        sessions.append({'id': sid, 'device_id': 'dev-' + sid,
                         'event_code': {'a1': 'G-AAA', 'a2': 'G-AAA', 'b1': 'G-BBB', 'b2': 'G-BBB'}.get(sid, 'G-' + sid)})
        for m in range(60):
            minute = t0 + pd.Timedelta(minutes=m)
            venue = v if len(v) == 1 else (v[0] if m < 30 else v[1])
            truth.append({'session_id': sid, 'minute': minute, 'venue': venue})
            row = {'id': f'{sid}-{m}', 'session_id': sid, 'window_start': minute.isoformat(),
                   'song_isrc': None, 'song_started_at': None}
            if rng.random() > 0.4:
                for isrc, start, dur in venues[venue]:
                    if start <= minute + pd.Timedelta(seconds=30) < start + pd.Timedelta(seconds=dur):
                        row['song_isrc'] = isrc
                        jitter = float(rng.normal(0, 0.3))
                        if rng.random() < OUTLIER_RATE:  # matched a repeated chorus
                            jitter += float(rng.choice([-1, 1]) * rng.uniform(30, 80))
                        row['song_started_at'] = (start + pd.Timedelta(seconds=jitter)).isoformat()
            windows.append(row)
    return pd.DataFrame(windows), pd.DataFrame(sessions), pd.DataFrame(truth)


# ── Synthetic bass envelopes (DJ sets) ──

FINE_HZ = 20  # simulation grid: 50 ms


def _dj_mix(rng, seconds, tempo=124.0):
    """Bass level (dB) of a DJ set on a 50 ms grid: a slow random walk with sections, drops,
    breakdowns, transitions between tracks, and the kick drum's modulation at the given tempo."""
    n = int(seconds * FINE_HZ)
    level = np.zeros(n)
    x, target, i = 0.0, 0.0, 0
    while i < n:
        sec = int(rng.uniform(16, 64) * FINE_HZ)        # a musical section
        target = float(rng.normal(0, 4))
        for j in range(i, min(n, i + sec)):
            x += 0.02 * (target - x) + rng.normal(0, 0.15)
            level[j] = x
        i += sec
    t = 0
    while t < n:                                          # drops and breakdowns
        t += int(rng.uniform(20, 70) * FINE_HZ)
        if t >= n:
            break
        if rng.random() < 0.5:
            dur, depth = int(rng.uniform(3, 8) * FINE_HZ), rng.uniform(10, 18)   # drop
        else:
            dur, depth = int(rng.uniform(15, 30) * FINE_HZ), rng.uniform(6, 10)  # breakdown
        level[t:t + dur] -= depth
        t += dur
    t = int(rng.uniform(150, 260) * FINE_HZ)
    while t < n:                                          # track transitions (crossfades)
        dur = int(rng.uniform(8, 20) * FINE_HZ)
        dip = rng.uniform(2, 6)
        ramp = np.sin(np.linspace(0, np.pi, min(dur, n - t))) * dip
        level[t:t + len(ramp)] -= ramp
        t += dur + int(rng.uniform(150, 260) * FINE_HZ)
    beat = np.arange(n) / FINE_HZ * tempo / 60
    level += 3 * np.maximum(0, np.cos(2 * np.pi * beat)) ** 4  # kick drum
    return level


def _phone_envelope(rng, mix_db, minute_s, clock_offset_s, android=False, noise_db=1.5, chatter=3):
    """What one phone stores for the minute starting minute_s seconds into the mix: 250 ms
    frames averaged on its own (slightly wrong) clock, pocket damping, noise and chatter."""
    per = FINE_HZ // 4
    start = int(round((minute_s + clock_offset_s) * FINE_HZ))
    seg = mix_db[start:start + ENV_FRAMES * per]
    if len(seg) < ENV_FRAMES * per:
        return None
    power = 10 ** (seg / 10)
    frames = 10 * np.log10(power.reshape(ENV_FRAMES, per).mean(axis=1))
    frames = np.convolve(frames, [0.25, 0.5, 0.25], mode='same') - 6       # pocket damping
    frames += rng.normal(0, noise_db, ENV_FRAMES)                          # sensor noise
    for _ in range(rng.poisson(chatter)):                                   # chatter bursts
        k, d = rng.integers(0, ENV_FRAMES), rng.integers(4, 12)
        frames[k:k + d] += rng.uniform(5, 10)
    if android:  # only the clock-aligned 5 s clips of every 10 s are recorded
        k = np.arange(ENV_FRAMES)
        frames[(k % 40) >= 20] = np.nan
    # Encode exactly as the app does (median-relative, ±24 dB, 1 byte)
    valid = frames[~np.isnan(frames)]
    rel = np.clip(frames - np.median(valid), -ENV_RANGE_DB, ENV_RANGE_DB)
    b = np.where(np.isnan(frames), 0, 1 + np.round((rel + ENV_RANGE_DB) / (2 * ENV_RANGE_DB) * 254)).astype(np.uint8)
    return base64.b64encode(b.tobytes()).decode()


def _simulate_envelopes(seed=1, minutes=60, with_shazam=False, noise_db=1.5, chatter=3):
    """Room A: 3 phones + 1 Android-style phone; room B: the same mix 90 s later (2 phones);
    room C: a different mix at the same tempo (2 phones); one phone moves from A to B at
    minute 30. Clock offsets up to ±300 ms."""
    rng = np.random.default_rng(seed)
    t0 = pd.Timestamp('2026-10-10T22:00:00Z')
    total = (minutes + 5) * 60
    mix_ab = _dj_mix(rng, total + 120)
    mix_c = _dj_mix(rng, total + 120)
    rooms = {'A': (mix_ab, 90.0), 'B': (mix_ab, 0.0), 'C': (mix_c, 90.0)}  # B plays A's mix 90 s later
    plan = {'a1': 'A', 'a2': 'A', 'a3': 'A', 'aA': 'A', 'b1': 'B', 'b2': 'B', 'c1': 'C', 'c2': 'C', 'mover': 'AB'}
    # Shazam (optional): tracks change every 150–260 s; room B hears the same tracks 90 s later
    tracks, t = [], -200.0
    while t < total:
        d = float(rng.uniform(150, 260)); tracks.append((f'T{len(tracks):03d}', t, d)); t += d
    windows, sessions, truth = [], [], []
    for sid, v in plan.items():
        offset = float(rng.uniform(-0.3, 0.3))
        sessions.append({'id': sid, 'device_id': 'dev-' + sid,
                         'event_code': {'a1': 'G-AAA', 'a2': 'G-AAA', 'b1': 'G-BBB', 'b2': 'G-BBB'}.get(sid, 'G-' + sid)})
        for m in range(minutes):
            room = v if len(v) == 1 else (v[0] if m < minutes // 2 else v[1])
            mix, shift = rooms[room]
            minute = t0 + pd.Timedelta(minutes=m)
            truth.append({'session_id': sid, 'minute': minute, 'venue': room})
            row = {'id': f'{sid}-{m}', 'session_id': sid, 'window_start': minute.isoformat(),
                   'bass_envelope': _phone_envelope(rng, mix, m * 60 + shift, offset, android=(sid == 'aA'), noise_db=noise_db, chatter=chatter),
                   'song_isrc': None, 'song_started_at': None}
            if with_shazam and room != 'C' and rng.random() > 0.6:
                playlist_t = m * 60 + 30 + shift   # position in the A/B playlist
                for isrc, start, dur in tracks:
                    if start <= playlist_t < start + dur:
                        row['song_isrc'] = isrc
                        row['song_started_at'] = (minute + pd.Timedelta(seconds=30 - (playlist_t - start) + float(rng.normal(0, 0.3)))).isoformat()
            windows.append(row)
    return pd.DataFrame(windows), pd.DataFrame(sessions), pd.DataFrame(truth)


def _pairwise_scores(groups, truth):
    g = groups.merge(truth, on=['session_id', 'minute'])
    tp = fp = fn = 0
    for _, gm in g.groupby('minute'):
        for x, y in combinations(gm.to_dict('records'), 2):
            st, sa = x['venue'] == y['venue'], x['auto_group'] == y['auto_group']
            tp += st and sa; fp += (not st) and sa; fn += st and not sa
    return (tp / (tp + fp) if tp + fp else float('nan')), (tp / (tp + fn) if tp + fn else float('nan')), g


def selftest():
    windows, sessions, truth = _simulate()
    groups = auto_groups(windows, sessions)
    g = groups.merge(truth, on=['session_id', 'minute'])
    tp = fp = fn = 0
    for minute, gm in g.groupby('minute'):
        for x, y in combinations(gm.to_dict('records'), 2):
            same_truth = x['venue'] == y['venue']
            same_auto = x['auto_group'] == y['auto_group']
            tp += same_truth and same_auto
            fp += (not same_truth) and same_auto
            fn += same_truth and not same_auto
    precision = tp / (tp + fp) if tp + fp else float('nan')
    recall = tp / (tp + fn) if tp + fn else float('nan')
    print(f"pairwise vs true venue → precision={precision:.3f}  recall={recall:.3f}  (tp={tp} fp={fp} fn={fn})")
    assert precision > 0.97, precision
    assert recall > 0.7, recall

    mover = g[g['session_id'] == 'mover'].set_index('minute')
    a1 = g[g['session_id'] == 'a1'].set_index('minute')['auto_group']
    b1 = g[g['session_id'] == 'b1'].set_index('minute')['auto_group']
    early = (mover['auto_group'] == a1.reindex(mover.index)).iloc[5:25].mean()
    late = (mover['auto_group'] == b1.reindex(mover.index)).iloc[40:58].mean()
    print(f"mover: with venue A {early:.0%} of minutes 5–25, with venue B {late:.0%} of minutes 40–58")
    assert early > 0.7 and late > 0.7

    v = validate_against_codes(groups, sessions)
    print(f"code validation → recall on same-code pairs={v['recall_on_code_pairs']:.3f}, "
          f"linked across different shared codes={v['linked_across_different_codes']}")
    assert v['recall_on_code_pairs'] > 0.7

    # Bass envelopes, no Shazam at all: DJ set in room A (3 phones + an Android-style phone with
    # half coverage), the same set 90 s later in room B, another set at the same tempo in room C,
    # one phone walking from A to B, clock offsets up to ±300 ms
    for seed in (1, 2, 3):
        w, s_, t = _simulate_envelopes(seed)
        p, r, gg = _pairwise_scores(auto_groups(w, s_, sources=('envelope',)), t)
        mover = gg[gg['session_id'] == 'mover'].set_index('minute')['auto_group']
        a1 = gg[gg['session_id'] == 'a1'].set_index('minute')['auto_group']
        b1 = gg[gg['session_id'] == 'b1'].set_index('minute')['auto_group']
        aA = gg[gg['session_id'] == 'aA'].set_index('minute')['auto_group']
        early = (mover == a1.reindex(mover.index)).iloc[5:25].mean()
        late = (mover == b1.reindex(mover.index)).iloc[35:55].mean()
        android = (aA == a1.reindex(aA.index)).mean()
        print(f"envelope only, seed {seed} → precision={p:.3f} recall={r:.3f}; mover with A {early:.0%} / B {late:.0%}; "
              f"Android-style phone with A {android:.0%}")
        assert p > 0.97 and r > 0.8, (p, r)
        assert early > 0.7 and late > 0.7, (early, late)
    # Noisier phones: recall falls, precision must hold (fails safe)
    w, s_, t = _simulate_envelopes(1, noise_db=4.5, chatter=6)
    p, r, _ = _pairwise_scores(auto_groups(w, s_, sources=('envelope',)), t)
    print(f"envelope only, noisy (4.5 dB, double chatter) → precision={p:.3f} recall={r:.3f}")
    assert np.isnan(p) or p > 0.97, p
    # Both sources together, with Shazam in 40% of minutes for rooms A and B
    w, s_, t = _simulate_envelopes(4, with_shazam=True)
    p, r, _ = _pairwise_scores(auto_groups(w, s_), t)
    print(f"Shazam + envelope → precision={p:.3f} recall={r:.3f}; recall on code pairs by source: "
          + ', '.join(f"{k}={v:.2f}" for k, v in validate_by_source(w, s_).items()))
    assert p > 0.97
    print("selftest OK")


def main():
    try:
        windows = pd.read_csv(DATA_DIR / 'sensor_windows.csv')
        sessions = pd.read_csv(DATA_DIR / 'sessions.csv')
    except FileNotFoundError as e:
        print(f"ERROR: Data files not found. Run fetch_data.py first.\n{e}")
        return
    has_songs = 'song_started_at' in windows.columns and windows['song_started_at'].notna().any()
    has_env = 'bass_envelope' in windows.columns and windows['bass_envelope'].notna().any()
    if not (has_songs or has_env):
        print("No song start times or bass envelopes yet (needs app build 8+ / the bass-envelope build).")
        return
    OUTPUT_DIR.mkdir(exist_ok=True)
    groups = auto_groups(windows, sessions)
    groups.to_csv(OUTPUT_DIR / 'auto_groups.csv', index=False)
    multi = groups[groups['group_size'] > 1]
    print(f"session-minutes: {len(groups)}, in a group of ≥2: {len(multi)}, "
          f"largest group: {groups['group_size'].max() if len(groups) else 0}")
    print("validation against group codes:", validate_against_codes(groups, sessions))
    print("recall on code pairs by evidence source:", validate_by_source(windows, sessions))
    print(f"Saved {OUTPUT_DIR}/auto_groups.csv")


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    else:
        main()
