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
        cluster = [g.iloc[0]]
        for _, r in g.iloc[1:].iterrows():
            if r['start_s'] - cluster[-1]['start_s'] <= START_TOLERANCE_S:
                cluster.append(r)
            else:
                rows.append(_merge(cluster)); cluster = [r]
        rows.append(_merge(cluster))
    return pd.DataFrame(rows)


def _merge(cluster):
    return {
        'session_id': cluster[0]['session_id'],
        'device_id': cluster[0]['device_id'],
        'isrc': cluster[0]['song_isrc'],
        'start_s': float(np.median([r['start_s'] for r in cluster])),
        'minute': min(r['minute'] for r in cluster),
    }


def pair_evidence(pb: pd.DataFrame) -> pd.DataFrame:
    """Shared playbacks (together) and same-minute different playbacks (apart) per session pair."""
    out = []
    if pb.empty:
        return pd.DataFrame(columns=['a', 'b', 'minute', 'kind'])
    # Together: same isrc, start within tolerance, different devices
    for isrc, g in pb.groupby('isrc'):
        recs = g.to_dict('records')
        for x, y in combinations(recs, 2):
            if x['device_id'] == y['device_id'] or x['session_id'] == y['session_id']:
                continue
            if abs(x['start_s'] - y['start_s']) <= START_TOLERANCE_S:
                a, b = sorted([x['session_id'], y['session_id']])
                out.append({'a': a, 'b': b, 'minute': min(x['minute'], y['minute']), 'kind': 'together'})
    # Apart: both recognised something in the same minute, but not the same playback
    for minute, g in pb.groupby('minute'):
        recs = g.to_dict('records')
        for x, y in combinations(recs, 2):
            if x['device_id'] == y['device_id'] or x['session_id'] == y['session_id']:
                continue
            same = x['isrc'] == y['isrc'] and abs(x['start_s'] - y['start_s']) <= START_TOLERANCE_S
            if not same:
                a, b = sorted([x['session_id'], y['session_id']])
                out.append({'a': a, 'b': b, 'minute': minute, 'kind': 'apart'})
    return pd.DataFrame(out)


def auto_groups(windows: pd.DataFrame, sessions: pd.DataFrame) -> pd.DataFrame:
    """One row per (session, minute) with an automatic group id and its size."""
    w = windows.copy()
    w['minute'] = pd.to_datetime(w['window_start'], utc=True, format='ISO8601').dt.floor('min')
    active = w.groupby('minute')['session_id'].apply(lambda s: sorted(set(s))).to_dict()
    pb = playbacks(windows, sessions)
    ev = pair_evidence(pb)
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
                wts = np.exp(-np.abs((g['minute'] - minute).dt.total_seconds() / 60) / EVIDENCE_DECAY_MIN)
                sign = np.where(g['kind'] == 'together', 1.0, -1.0)
                score[(a, b)] = (int((g['kind'] == 'together').sum()), float((wts * sign).sum()))
            # Strongest links first; refuse a merge that would put two phones that are apart
            # (negative score) into one group
            members = {s: {s} for s in sids}
            for (a, b), (together, sc) in sorted(score.items(), key=lambda kv: -kv[1][1]):
                if together < MIN_SHARED_PLAYBACKS or sc <= 0:
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


# ── Synthetic self-test ───────────────────────────────────────────────────────

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
                        row['song_started_at'] = (start + pd.Timedelta(seconds=float(rng.normal(0, 0.3)))).isoformat()
            windows.append(row)
    return pd.DataFrame(windows), pd.DataFrame(sessions), pd.DataFrame(truth)


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
    print("selftest OK")


def main():
    try:
        windows = pd.read_csv(DATA_DIR / 'sensor_windows.csv')
        sessions = pd.read_csv(DATA_DIR / 'sessions.csv')
    except FileNotFoundError as e:
        print(f"ERROR: Data files not found. Run fetch_data.py first.\n{e}")
        return
    if 'song_started_at' not in windows.columns or windows['song_started_at'].notna().sum() == 0:
        print("No song start times yet (needs app build 8 or later with ShazamKit matches).")
        return
    OUTPUT_DIR.mkdir(exist_ok=True)
    groups = auto_groups(windows, sessions)
    groups.to_csv(OUTPUT_DIR / 'auto_groups.csv', index=False)
    multi = groups[groups['group_size'] > 1]
    print(f"session-minutes: {len(groups)}, in a group of ≥2: {len(multi)}, "
          f"largest group: {groups['group_size'].max() if len(groups) else 0}")
    print("validation against group codes:", validate_against_codes(groups, sessions))
    print(f"Saved {OUTPUT_DIR}/auto_groups.csv")


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    else:
        main()
