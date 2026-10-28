"""
ViibeMeter: "Here is your set" report for a DJ (build 31).

A DJ registers nothing before the party. After the night this script turns what the phones in the
room measured into a small, aggregated report that the DJ opens INSIDE the app (screen
`app/set.tsx`, link vibemeter://set?code=XXXXXXXX), where it is interactive: scrub a crowd curve,
zoom, see what was playing, and read how each track and each transition worked.

What the report holds (all aggregated; minutes with fewer than MIN_PHONES phones are left out, and
nothing identifies a phone or a person):
  curve   per minute: phones measuring, share dancing, tempo (BPM), share locked on the beat
  tracks  recognised songs (title/artist from Deezer's public ISRC lookup) and unidentified music
          (possibly the DJ's own edit), each with: dancing share, on-the-beat share, tempo,
          lift (did the floor rise or fall when it started?) and keep (of the people dancing just
          before, how many kept dancing through the change)
  peaks   the strongest minutes
  jumps   the biggest surges of the floor within three minutes, with the track that caused them

Flow: build as a DRAFT (nothing is visible to anyone), review it, then release it:
  python3 dj_report.py --venue <place id> --dj "DJ Name" [--night 2026-10-31] --publish
  python3 dj_report.py --release CODE        # now the DJ can open it with the code or the link
The DJ can then approve it, claim an unidentified stretch as their edit, or decline (which empties
the report). Claims land in dj_report_claims; the owner turns them into approved dj_edits.

Other usage (from analysis/; SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment):
  python3 dj_report.py --venue <place id> --from 2026-10-31T22:00:00Z --to 2026-11-01T02:00:00Z   # print JSON
  python3 dj_report.py --selftest
"""

import argparse
import json
import os
import secrets
import sys
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

MIN_PHONES = 3            # never show a minute measured by fewer phones
MIN_RUN_MIN = 2           # a track or unidentified stretch needs this many minutes
GAP_MIN = 1               # a run may be interrupted by this many minutes (a missed recognition)
RHYTHMIC = 0.35           # same dancing rule as engagement.py
LOCKED_PLV = 0.4
PEAKS = 3
JUMPS = 3
JUMP_MIN_RISE = 0.15      # share of phones; smaller surges are noise
JUMP_SPAN_MIN = 3
SPACING_MIN = 5           # highlights and jumps at least this far apart
LIFT_SPAN_MIN = 3         # minutes compared before and after a track starts
CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


# ── preparing the minute table ───────────────────────────────────────────────

def prepare(windows: pd.DataFrame) -> pd.DataFrame:
    """One row per phone-minute that counts: on a body, with a dancing flag."""
    w = windows.copy()
    w['minute'] = pd.to_datetime(w['window_start'], utc=True, format='ISO8601').dt.floor('min')
    if 'phone_context' in w:
        w = w[w['phone_context'].fillna('') != 'off_body']
    if 'on_body_share' in w:
        w = w[(w['on_body_share'].isna()) | (w['on_body_share'] >= 0.5)]
    cls = w['movement_classification'] if 'movement_classification' in w else pd.Series(index=w.index, dtype=object)
    rhythm = pd.to_numeric(w['rhythmicity'], errors='coerce') if 'rhythmicity' in w else pd.Series(np.nan, index=w.index)
    w['dancing'] = cls.isin(['dancing', 'jumping']) | (rhythm >= RHYTHMIC)
    w['music'] = w['music_detected'].fillna(False).astype(bool) if 'music_detected' in w else False
    w['plv'] = pd.to_numeric(w['beat_plv'], errors='coerce') if 'beat_plv' in w else np.nan
    bpm = pd.to_numeric(w['song_bpm'], errors='coerce') if 'song_bpm' in w else pd.Series(np.nan, index=w.index)
    if 'estimated_bpm' in w:
        bpm = bpm.fillna(pd.to_numeric(w['estimated_bpm'], errors='coerce'))
    w['bpm'] = bpm
    return w


def crowd_curve(w: pd.DataFrame) -> pd.DataFrame:
    """Per minute: phones, dancing share, locked-on-the-beat share, tempo. Thin minutes are hidden."""
    g = w.groupby('minute')
    curve = pd.DataFrame({
        'phones': g['session_id'].nunique(),
        'dancing': g['dancing'].mean(),
        'sync': g['plv'].apply(lambda s: float((s.dropna() >= LOCKED_PLV).mean()) if s.notna().any() else np.nan),
        'bpm': g['bpm'].median(),
    })
    curve['shown'] = curve['phones'] >= MIN_PHONES
    curve.loc[~curve['shown'], ['dancing', 'sync', 'bpm']] = np.nan
    full = pd.date_range(curve.index.min(), curve.index.max(), freq='min', tz='UTC')
    return curve.reindex(full)


# ── tracklist ────────────────────────────────────────────────────────────────

def minute_labels(w: pd.DataFrame) -> pd.Series:
    """The song heard in each minute (the most common ISRC among phones), 'unknown' for music
    without a recognised song, nothing for quiet or thin minutes."""
    labels = {}
    for minute, m in w.groupby('minute'):
        if m['session_id'].nunique() < MIN_PHONES:
            continue
        isrcs = m['song_isrc'].dropna() if 'song_isrc' in m else pd.Series(dtype=object)
        if len(isrcs) >= max(2, 0.3 * len(m)):
            labels[minute] = isrcs.mode().iloc[0]
        elif m['music'].mean() >= 0.5:
            labels[minute] = 'unknown'
    return pd.Series(labels, dtype=object)


def runs(labels: pd.Series) -> list[dict]:
    """Consecutive minutes with the same label, allowing GAP_MIN missed minutes inside a run."""
    out, cur = [], None
    for minute, label in labels.items():
        if cur and cur['label'] == label and (minute - cur['end']).total_seconds() / 60 <= GAP_MIN + 1:
            cur['end'] = minute
        else:
            if cur:
                out.append(cur)
            cur = {'label': label, 'start': minute, 'end': minute}
    if cur:
        out.append(cur)
    for r in out:
        r['minutes'] = int((r['end'] - r['start']).total_seconds() / 60) + 1
    return [r for r in out if r['minutes'] >= MIN_RUN_MIN]


def _mean(values) -> float | None:
    v = pd.Series(values).dropna()
    return float(v.mean()) if len(v) else None


def describe_runs(rs: list[dict], w: pd.DataFrame, curve: pd.DataFrame, lookup) -> list[dict]:
    """Per track: dancing, on-the-beat, tempo, lift and keep."""
    rows = []
    step = pd.Timedelta(minutes=1)
    for r in rs:
        c = curve.loc[r['start']:r['end']]
        before = curve.loc[r['start'] - LIFT_SPAN_MIN * step: r['start'] - step]['dancing'].dropna()
        after = c['dancing'].dropna().iloc[:LIFT_SPAN_MIN]
        lift = float(after.mean() - before.mean()) if len(before) >= 2 and len(after) >= 2 else None

        # Keep: of the phones dancing in the minute before, the share still dancing in the first minutes
        prev = w[w['minute'] == r['start'] - step]
        was = set(prev[prev['dancing']]['session_id'])
        keep = None
        if len(was) >= MIN_PHONES:
            first = w[(w['minute'] >= r['start']) & (w['minute'] < r['start'] + 2 * step) & (w['session_id'].isin(was))]
            if len(first):
                keep = float(first.groupby('session_id')['dancing'].mean().mean())

        info = lookup(r['label']) if r['label'] != 'unknown' else None
        rows.append({
            'start': r['start'], 'end': r['end'] + step, 'minutes': r['minutes'], 'unknown': r['label'] == 'unknown',
            'title': (info or {}).get('title'), 'artist': (info or {}).get('artist'),
            'dancing': _mean(c['dancing']), 'sync': _mean(c['sync']), 'bpm': _mean(c['bpm']), 'lift': lift, 'keep': keep,
        })
    return rows


def deezer_lookup(isrc: str, _cache={}):
    """Title and artist for an ISRC from Deezer's public API (None when offline or unknown)."""
    if isrc in _cache:
        return _cache[isrc]
    try:
        with urllib.request.urlopen(f'https://api.deezer.com/track/isrc:{urllib.parse.quote(isrc)}', timeout=8) as r:
            d = json.loads(r.read())
        _cache[isrc] = {'title': d['title'], 'artist': d['artist']['name']} if 'title' in d else None
    except Exception:
        _cache[isrc] = None
    return _cache[isrc]


def spaced(candidates: list, key_minutes: list) -> list:
    """Candidates (best first) whose minutes are at least SPACING_MIN apart."""
    picked, minutes = [], []
    for item, minute in zip(candidates, key_minutes):
        if all(abs((minute - p).total_seconds()) / 60 >= SPACING_MIN for p in minutes):
            picked.append(item)
            minutes.append(minute)
    return picked


def peaks(curve: pd.DataFrame) -> list[pd.Timestamp]:
    """The strongest minutes (dancing share, then phones), at least SPACING_MIN apart."""
    d = curve['dancing'].dropna()
    order = (d + curve['phones'].reindex(d.index) * 1e-6).sort_values(ascending=False)
    return sorted(spaced(list(order.index), list(order.index))[:PEAKS])


def jumps(curve: pd.DataFrame) -> list[dict]:
    """The biggest rises of the (two-minute smoothed) dancing share within JUMP_SPAN_MIN minutes,
    biggest first. Smoothing keeps one lucky minute from looking like a surge."""
    d = curve['dancing'].rolling(2, min_periods=1).mean().where(curve['dancing'].notna())
    before = d.shift(JUMP_SPAN_MIN)
    rise = (d - before).dropna()
    rise = rise[rise >= JUMP_MIN_RISE].sort_values(ascending=False)
    picked = spaced(list(rise.index), list(rise.index))[:JUMPS]
    return [{'t': t, 'from': float(before.loc[t]), 'to': float(d.loc[t])} for t in picked]


# ── the report ───────────────────────────────────────────────────────────────

def ms(ts) -> int:
    return int(pd.Timestamp(ts).value // 1_000_000)


def num(x, digits=3):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), digits)


def build_report(w: pd.DataFrame, lookup=deezer_lookup) -> dict:
    """The aggregated report for the phone-minute rows of one set (see the module docstring)."""
    w = prepare(w)
    curve = crowd_curve(w)
    labels = minute_labels(w)
    tracks = describe_runs(runs(labels), w, curve, lookup) if len(labels) else []

    def track_at(minute):
        for i, t in enumerate(tracks):
            if t['start'] <= minute < t['end']:
                return i
        return None

    return {
        'v': 1,
        'curve': [{'t': ms(t), 'p': int(r.phones), 'd': num(r.dancing), 's': num(r.sync), 'b': num(r.bpm, 1)}
                  for t, r in curve.iterrows() if not np.isnan(r.phones)],
        'tracks': [{'start': ms(t['start']), 'end': ms(t['end']), 'unknown': t['unknown'], 'title': t['title'], 'artist': t['artist'],
                    'd': num(t['dancing']), 's': num(t['sync']), 'b': num(t['bpm'], 1), 'lift': num(t['lift']), 'keep': num(t['keep'])}
                   for t in tracks],
        'peaks': [{'t': ms(m), 'd': num(curve.loc[m, 'dancing']), 'track': track_at(m)} for m in peaks(curve)],
        'jumps': [{'t': ms(j['t']), 'from': num(j['from']), 'to': num(j['to']), 'track': track_at(j['t'])} for j in jumps(curve)],
    }


def new_code() -> str:
    return ''.join(secrets.choice(CODE_ALPHABET) for _ in range(8))


# ── data ─────────────────────────────────────────────────────────────────────

def rest(path: str, method='GET', body=None, prefer=None) -> list[dict]:
    base, key = os.environ['SUPABASE_URL'].rstrip('/'), os.environ['SUPABASE_SERVICE_KEY']
    headers = {'Authorization': f'Bearer {key}', 'apikey': key, 'Content-Type': 'application/json'}
    if prefer:
        headers['Prefer'] = prefer
    rows, start = [], 0
    while True:
        if method == 'GET':
            headers['Range'] = f'{start}-{start + 999}'
        req = urllib.request.Request(f'{base}/rest/v1/{path}', method=method, data=body, headers=headers)
        with urllib.request.urlopen(req) as r:
            raw = r.read()
        if method != 'GET' or not raw:
            return json.loads(raw) if raw else []
        page = json.loads(raw)
        rows += page
        if len(page) < 1000:
            return rows
        start += 1000


COLS = 'session_id,window_start,venue_place_id,music_detected,movement_classification,rhythmicity,beat_plv,song_isrc,song_bpm,estimated_bpm,phone_context,on_body_share'


def load_windows(place: str, t0: pd.Timestamp, t1: pd.Timestamp) -> pd.DataFrame:
    q = (f"sensor_windows?select={COLS}&venue_place_id=eq.{urllib.parse.quote(place)}"
         f"&window_start=gte.{urllib.parse.quote(t0.isoformat())}&window_start=lt.{urllib.parse.quote(t1.isoformat())}&order=window_start")
    return pd.DataFrame(rest(q))


def find_set(place: str, dj: str, night: str | None) -> tuple[pd.Timestamp, pd.Timestamp, str]:
    rows = rest(f"venue_sets?select=dj_name,starts_at,ends_at&place_id=eq.{urllib.parse.quote(place)}&dj_name=ilike.{urllib.parse.quote(dj)}&order=starts_at.desc")
    if night:
        rows = [r for r in rows if r['starts_at'][:10] in (night, str(pd.Timestamp(night) + pd.Timedelta(days=1))[:10])]
    if not rows:
        sys.exit(f'No set for "{dj}" at that venue{" on " + night if night else ""} in venue_sets. Add the lineup first, or pass --from and --to.')
    r = rows[0]
    return pd.Timestamp(r['starts_at']), pd.Timestamp(r['ends_at']), r['dj_name']


# ── self-test ────────────────────────────────────────────────────────────────

def synthetic_night() -> pd.DataFrame:
    rng = np.random.default_rng(5)
    t0 = pd.Timestamp('2026-10-31T22:00:00Z')
    recs = []
    for p in range(8):
        for m in range(60):
            minute = t0 + pd.Timedelta(minutes=m)
            if m >= 50 and p >= 2:
                continue                                  # only 2 phones from 22:50: those minutes stay hidden
            isrc = 'AAA' if m < 20 else (None if m < 30 else 'BBB')
            dancing_p = 0.2 if m < 20 else 0.35 if m < 30 else 0.9
            recs.append({'session_id': f's{p}', 'window_start': minute.isoformat(), 'venue_place_id': 'V', 'music_detected': True,
                         'movement_classification': 'dancing' if (rng.uniform() < dancing_p or m == 29) else 'stationary', 'rhythmicity': 0.1,
                         'beat_plv': 0.6 if isrc == 'BBB' else 0.2, 'song_isrc': isrc, 'song_bpm': 124.0 if isrc == 'BBB' else (118.0 if isrc else None),
                         'estimated_bpm': 120.0, 'phone_context': 'on_body_moving', 'on_body_share': 1.0})
    for m in range(60):                                   # a phone lying on a table must not count
        recs.append({'session_id': 'table', 'window_start': (t0 + pd.Timedelta(minutes=m)).isoformat(), 'venue_place_id': 'V', 'music_detected': True,
                     'movement_classification': 'stationary', 'rhythmicity': 0.0, 'beat_plv': None, 'song_isrc': None, 'song_bpm': None,
                     'estimated_bpm': None, 'phone_context': 'off_body', 'on_body_share': 0.0})
    return pd.DataFrame(recs)


def selftest():
    names = {'AAA': {'title': 'Opener', 'artist': 'Artist One'}, 'BBB': {'title': 'The Banger', 'artist': 'Artist Two'}}
    w = synthetic_night()
    rep = build_report(w, lookup=names.get)
    text = json.dumps(rep)
    t0 = ms('2026-10-31T22:00:00Z')
    MIN = 60_000
    failed = 0

    def check(name, ok, detail=''):
        nonlocal failed
        print(('ok   ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
        failed += 0 if ok else 1

    curve = {c['t']: c for c in rep['curve']}
    check('the phone on the table is left out (8 phones)', max(c['p'] for c in rep['curve']) == 8)
    check('minutes with fewer than 3 phones carry no values', all(curve[t0 + m * MIN]['d'] is None for m in (52, 55)))
    check('minutes with enough phones are shown', curve[t0 + 40 * MIN]['d'] is not None)
    tr = rep['tracks']
    check('tracklist: Opener, unidentified music, The Banger', [(t['title'], t['unknown']) for t in tr] == [('Opener', False), (None, True), ('The Banger', False)],
          str([(t['title'], t['unknown']) for t in tr]))
    check('the banger has the highest dancing share', tr[2]['d'] > tr[0]['d'] + 0.3)
    check('the banger is on the beat (and has a tempo)', (tr[2]['s'] or 0) > 0.8 and tr[2]['b'] is not None)
    check('lift: the floor rises when the banger starts, not for the opener', (tr[2]['lift'] or 0) > 0.2 and tr[0]['lift'] is None)
    check('keep: most of those dancing just before the banger kept dancing', (tr[2]['keep'] or 0) > 0.6, str(tr[2]['keep']))
    check('peaks fall inside the banger, at least 5 min apart',
          len(rep['peaks']) == 3 and all(t0 + 30 * MIN <= p['t'] < t0 + 50 * MIN for p in rep['peaks'])
          and all(abs(b['t'] - a['t']) >= 5 * MIN for a, b in zip(rep['peaks'], rep['peaks'][1:])))
    check('a jump is found at the change to the banger and points at that track',
          len(rep['jumps']) >= 1 and rep['jumps'][0]['track'] == 2 and rep['jumps'][0]['to'] > rep['jumps'][0]['from'] + 0.15,
          str(rep['jumps']))
    check('no session or device identifiers in the report', all(f's{p}"' not in text for p in range(8)) and 'session' not in text and 'device' not in text)
    check('report is small enough to store (under 100 kB for this hour)', len(text) < 100_000, f'{len(text)} bytes')
    if failed:
        print(f'\n{failed} check(s) failed')
        sys.exit(1)
    print('\nAll checks passed.')


# ── command line ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--venue'); ap.add_argument('--dj'); ap.add_argument('--night')
    ap.add_argument('--from', dest='t0'); ap.add_argument('--to', dest='t1')
    ap.add_argument('--publish', action='store_true', help='store the report as a DRAFT and print its code')
    ap.add_argument('--release', metavar='CODE', help='let the DJ open the draft report with CODE')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not (os.environ.get('SUPABASE_URL') and os.environ.get('SUPABASE_SERVICE_KEY')):
        ap.print_help()
        sys.exit('\nSet SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.')
    if a.release:
        code = a.release.strip().upper()
        done = rest(f'dj_reports?code=eq.{urllib.parse.quote(code)}&status=eq.draft', method='PATCH',
                    body=json.dumps({'status': 'sent'}).encode(), prefer='return=representation')
        sys.exit(f'Released {code}: the DJ can open vibemeter://set?code={code}' if done else f'No draft report with code {code}.')
    if not a.venue:
        ap.print_help()
        sys.exit('\nNeed --venue.')
    dj = a.dj
    if a.t0 and a.t1:
        t0, t1 = pd.Timestamp(a.t0), pd.Timestamp(a.t1)
    elif dj:
        t0, t1, dj = find_set(a.venue, dj, a.night)
    else:
        sys.exit('Give --dj (to use the lineup) or --from and --to.')
    w = load_windows(a.venue, t0, t1)
    if w.empty:
        sys.exit('No phone data at that venue in that time span.')
    report = build_report(w)
    phones = int(prepare(w)['session_id'].nunique())
    if not a.publish:
        print(json.dumps(report, indent=1))
        return
    venues = rest(f"venues?select=name&place_id=eq.{urllib.parse.quote(a.venue)}")
    code = new_code()
    rest('dj_reports', method='POST', prefer='return=minimal', body=json.dumps({
        'code': code, 'venue_name': venues[0]['name'] if venues else None, 'dj_name': dj,
        'starts_at': t0.isoformat(), 'ends_at': t1.isoformat(), 'phones': phones, 'report': report, 'status': 'draft'}).encode())
    print(f'Draft report stored. Code {code}  ({len(report["tracks"])} tracks, {phones} phones).')
    print(f'When you are happy: python3 dj_report.py --release {code}')
    print(f'Then the DJ opens it in the app with the code, or vibemeter://set?code={code}')


if __name__ == '__main__':
    main()
