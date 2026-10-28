"""
ViibeMeter: "Here is your set" report for a DJ (draft, build 29+).

A DJ doesn't register anything before the party. After the night, this script builds a private
page from what the phones in the room measured:

  - the tracklist: recognised songs (title and artist from Deezer's public ISRC lookup) and
    unidentified stretches of music, which may be the DJ's own edits;
  - a crowd curve: how many phones and what share of them were dancing, minute by minute;
  - the moments people danced hardest to, with highlight clips when phones that opted in to
    "send my best moments" captured them (merged by clip_enhance.py when it has run).

Privacy rules built in: only minutes with at least MIN_PHONES phones are shown (never an
individual), the page carries no device, session or person identifiers, and it is a DRAFT for the
owner to review: nothing is sent to a DJ automatically. The DJ approves, claims or declines
afterwards (edit claims go through dj_edits, see AGENTS.md "DJ edits").

Usage (from analysis/; SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment):
  python3 dj_report.py --venue ChIJpzxaoX_Ew0cRDSgjKYR0C4U --dj "DJ Name" [--night 2026-10-31]
  python3 dj_report.py --venue <place id> --from 2026-10-31T22:00:00Z --to 2026-11-01T02:00:00Z
  python3 dj_report.py --selftest

Output: output/dj_reports/<name>/index.html (+ clip files), open it in a browser.
"""

import argparse
import html
import json
import os
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / 'output' / 'dj_reports'
MIN_PHONES = 3            # never show a minute measured by fewer phones
MIN_RUN_MIN = 2           # a track or unidentified stretch needs this many minutes
GAP_MIN = 1               # a run may be interrupted by this many minutes (a missed recognition)
RHYTHMIC = 0.35           # same dancing rule as engagement.py
LOCKED_PLV = 0.4
HIGHLIGHTS = 3
HIGHLIGHT_SPACING_MIN = 4


# ── preparing the minute table ───────────────────────────────────────────────

def prepare(windows: pd.DataFrame) -> pd.DataFrame:
    """One row per phone-minute that counts: on a body, with a dancing flag and an energy rank."""
    w = windows.copy()
    w['minute'] = pd.to_datetime(w['window_start'], utc=True, format='ISO8601').dt.floor('min')
    if 'phone_context' in w:
        w = w[w['phone_context'].fillna('') != 'off_body']
    if 'on_body_share' in w:
        w = w[(w['on_body_share'].isna()) | (w['on_body_share'] >= 0.5)]
    cls = w['movement_classification'] if 'movement_classification' in w else pd.Series(index=w.index, dtype=object)
    rhythm = pd.to_numeric(w.get('rhythmicity'), errors='coerce') if 'rhythmicity' in w else pd.Series(np.nan, index=w.index)
    w['dancing'] = cls.isin(['dancing', 'jumping']) | (rhythm >= RHYTHMIC)
    energy = pd.to_numeric(w.get('movement_energy'), errors='coerce') if 'movement_energy' in w else pd.Series(np.nan, index=w.index)
    # Each phone's energy against its own night (people move differently)
    w['energy_rank'] = energy.groupby(w['session_id']).rank(pct=True)
    w['music'] = w['music_detected'].fillna(False).astype(bool) if 'music_detected' in w else False
    return w


def crowd_curve(w: pd.DataFrame) -> pd.DataFrame:
    """Per minute: phones, dancing share and mean energy rank. Minutes with too few phones are hidden."""
    g = w.groupby('minute')
    curve = pd.DataFrame({
        'phones': g['session_id'].nunique(),
        'dancing': g['dancing'].mean(),
        'energy': g['energy_rank'].mean(),
    })
    curve['shown'] = curve['phones'] >= MIN_PHONES
    curve.loc[~curve['shown'], ['dancing', 'energy']] = np.nan
    full = pd.date_range(curve.index.min(), curve.index.max(), freq='min', tz='UTC')
    return curve.reindex(full)


# ── tracklist ────────────────────────────────────────────────────────────────

def minute_labels(w: pd.DataFrame) -> pd.Series:
    """The song heard in each minute (the most common ISRC among phones), 'unknown' for music
    without a recognised song, nothing for quiet minutes."""
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


def describe_runs(rs: list[dict], w: pd.DataFrame, curve: pd.DataFrame, lookup) -> list[dict]:
    rows = []
    for r in rs:
        span = w[(w['minute'] >= r['start']) & (w['minute'] <= r['end'])]
        c = curve.loc[r['start']:r['end']]
        shown = c[c['shown'] == True]  # noqa: E712
        plv = pd.to_numeric(span.get('beat_plv'), errors='coerce').dropna() if 'beat_plv' in span else pd.Series(dtype=float)
        info = lookup(r['label']) if r['label'] != 'unknown' else None
        rows.append({
            **r,
            'title': (info or {}).get('title'), 'artist': (info or {}).get('artist'),
            'phones': int(span['session_id'].nunique()),
            'dancing': float(shown['dancing'].mean()) if len(shown) else None,
            'in_sync': float((plv >= LOCKED_PLV).mean()) if len(plv) else None,
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


def highlights(curve: pd.DataFrame, k: int = HIGHLIGHTS) -> list[pd.Timestamp]:
    """The k strongest minutes (dancing share × energy), at least HIGHLIGHT_SPACING_MIN apart."""
    score = (curve['dancing'] * curve['energy']).dropna().sort_values(ascending=False)
    picked: list[pd.Timestamp] = []
    for minute in score.index:
        if all(abs((minute - p).total_seconds()) / 60 >= HIGHLIGHT_SPACING_MIN for p in picked):
            picked.append(minute)
        if len(picked) == k:
            break
    return sorted(picked)


# ── highlight clips from phones that opted in ────────────────────────────────

def find_clips(minute: pd.Timestamp, window_s: int = 90) -> list[Path]:
    """Cleaned or merged clip files (from clip_enhance.py) captured near this minute, best first."""
    data, out = HERE / 'data' / 'moments', HERE / 'output' / 'moments'
    found = []
    for meta in data.glob('*/meta.json') if data.exists() else []:
        m = json.loads(meta.read_text())
        t0 = pd.Timestamp(m['started_at']).tz_convert('UTC') if pd.Timestamp(m['started_at']).tzinfo else pd.Timestamp(m['started_at'], tz='UTC')
        if abs((t0 - minute).total_seconds()) > window_s:
            continue
        cid = m['id']
        for cand in (out / f'group-{cid[:8]}' / '6_merged_median.wav', out / cid / '4_phone_separated.wav',
                     out / cid / '2_phone.wav', out / cid / '1_raw.wav'):
            if cand.exists():
                found.append(cand)
                break
    return found


# ── the page ─────────────────────────────────────────────────────────────────

def clock(ts) -> str:
    return pd.Timestamp(ts).strftime('%H:%M')


def pct(x) -> str:
    return '–' if x is None or (isinstance(x, float) and np.isnan(x)) else f'{round(x * 100)}%'


def curve_svg(curve: pd.DataFrame, rows: list[dict]) -> str:
    W, H, pad = 760, 180, 24
    n = len(curve)
    if n < 2:
        return ''
    xs = lambda i: pad + (W - 2 * pad) * i / (n - 1)
    ys = lambda v: H - pad - (H - 2 * pad) * v
    bands, labels = [], []
    for r in rows:
        i0 = max(0, curve.index.searchsorted(r['start'])); i1 = min(n - 1, curve.index.searchsorted(r['end']))
        color = '#9898c0' if r['label'] == 'unknown' else '#00E8A0'
        bands.append(f'<rect x="{xs(i0):.1f}" y="{pad}" width="{max(2, xs(i1) - xs(i0)):.1f}" height="{H - 2 * pad}" fill="{color}" opacity="0.10"/>')
    # one polyline per continuous shown stretch
    segs, cur = [], []
    for i, v in enumerate(curve['dancing'].to_numpy()):
        if np.isnan(v):
            if cur:
                segs.append(cur); cur = []
        else:
            cur.append(f'{xs(i):.1f},{ys(v):.1f}')
    if cur:
        segs.append(cur)
    lines = ''.join(f'<polyline fill="none" stroke="#00E8A0" stroke-width="2.5" points="{" ".join(s)}"/>' for s in segs if len(s) > 1)
    ticks = ''.join(
        f'<text x="{xs(i):.1f}" y="{H - 6}" fill="#9898c0" font-size="11" text-anchor="middle">{clock(curve.index[i])}</text>'
        for i in range(0, n, max(1, n // 8)))
    grid = ''.join(f'<line x1="{pad}" x2="{W - pad}" y1="{ys(v):.1f}" y2="{ys(v):.1f}" stroke="#181824"/>'
                   f'<text x="2" y="{ys(v) + 4:.1f}" fill="#9898c0" font-size="10">{int(v * 100)}%</text>' for v in (0, 0.5, 1))
    return f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="Share of phones dancing, by minute">{grid}{"".join(bands)}{lines}{ticks}</svg>'


def build_html(venue: str, dj: str | None, span: tuple, curve: pd.DataFrame, rows: list[dict],
               peaks: list[dict], phones: int) -> str:
    e = html.escape
    tl = ''
    for r in rows:
        if r['label'] == 'unknown':
            name, sub = 'Unidentified music', 'Not in the catalogue yet: possibly your own edit or an unreleased track'
        else:
            name = e(r['title'] or r['label']); sub = e(r['artist'] or 'title not found for this recording code')
        tl += (f'<tr><td class="t">{clock(r["start"])}</td><td><b>{name}</b><br><span class="m">{sub}</span></td>'
               f'<td>{r["minutes"]} min</td><td>{pct(r["dancing"])}</td><td>{pct(r["in_sync"])}</td></tr>')
    pk = ''
    for p in peaks:
        clips = ''.join(f'<audio controls preload="none" src="{e(c)}"></audio>' for c in p['clips'])
        pk += (f'<div class="card"><b>{clock(p["minute"])}</b> · {pct(p["dancing"])} of {p["phones"]} phones dancing'
               f'{"<br>" + clips if clips else "<br><span class=m>No clip captured for this moment.</span>"}</div>')
    note = ''
    if dj:
        note = f'<p>Hi {e(dj)}, this is what the phones in the room measured during your set. Nothing here is public. Tell us what you want to do with it.</p>'
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your set at {e(venue)}</title><style>
:root{{--bg:#060608;--s:#0d0d12;--b:#181824;--tx:#f0f0f5;--m:#9898c0;--a:#00E8A0}}
@media (prefers-color-scheme: light){{:root{{--bg:#f6f6fa;--s:#fff;--b:#e2e2ee;--tx:#14141c;--m:#5a5a78;--a:#00916a}}}}
body{{margin:0;background:var(--bg);color:var(--tx);font:16px/1.5 -apple-system,system-ui,sans-serif}}
main{{max-width:820px;margin:0 auto;padding:20px 16px 60px}}h1{{font-size:26px;margin:.2em 0}}h2{{font-size:13px;letter-spacing:.18em;color:var(--a);margin:32px 0 10px}}
.k{{color:var(--a);letter-spacing:.2em;font-size:12px}}.m{{color:var(--m);font-size:13px}}table{{width:100%;border-collapse:collapse}}
td,th{{padding:8px 6px;border-bottom:1px solid var(--b);text-align:left;vertical-align:top}}th{{color:var(--m);font-size:12px;font-weight:600}}.t{{color:var(--m);white-space:nowrap}}
.card{{background:var(--s);border:1px solid var(--b);border-radius:14px;padding:12px 14px;margin:8px 0}}audio{{width:100%;margin-top:8px}}
.draft{{border:1px dashed var(--m);border-radius:10px;padding:8px 12px;color:var(--m);font-size:13px}}svg{{background:var(--s);border:1px solid var(--b);border-radius:14px}}
</style></head><body><main>
<div class="k">VIIBE CHECK · YOUR SET</div><h1>{e(venue)} · {clock(span[0])}–{clock(span[1])}</h1>
<p class="draft">Draft for review. Built from {phones} phones; minutes measured by fewer than {MIN_PHONES} phones are left out, and nothing here identifies a person.</p>
{note}
<h2>CROWD, MINUTE BY MINUTE</h2>{curve_svg(curve, rows)}
<p class="m">Share of phones that were dancing. Green bands are tracks we recognised; grey bands are unidentified music.</p>
<h2>TRACKLIST</h2><table><tr><th>From</th><th>Track</th><th>Length</th><th>Dancing</th><th>On the beat</th></tr>{tl}</table>
<h2>THE MOMENTS PEOPLE DANCED HARDEST TO</h2>{pk or '<p class="m">Not enough phones for a highlight yet.</p>'}
<h2>YOUR CALL</h2><p>You can <b>claim</b> an unidentified stretch as your edit (it then credits you whenever it plays), <b>approve</b> a highlight to share, or <b>decline</b> and we delete everything about your set.</p>
</main></body></html>'''


# ── data ─────────────────────────────────────────────────────────────────────

def rest(path: str) -> list[dict]:
    base, key = os.environ['SUPABASE_URL'].rstrip('/'), os.environ['SUPABASE_SERVICE_KEY']
    rows, start = [], 0
    while True:
        req = urllib.request.Request(f'{base}/rest/v1/{path}', headers={'Authorization': f'Bearer {key}', 'apikey': key, 'Range': f'{start}-{start + 999}'})
        with urllib.request.urlopen(req) as r:
            page = json.loads(r.read())
        rows += page
        if len(page) < 1000:
            return rows
        start += 1000


COLS = 'session_id,window_start,venue_place_id,music_detected,movement_classification,movement_energy,rhythmicity,beat_plv,song_isrc,phone_context,on_body_share'


def load_windows(place: str, t0: pd.Timestamp, t1: pd.Timestamp) -> pd.DataFrame:
    q = f"sensor_windows?select={COLS}&venue_place_id=eq.{urllib.parse.quote(place)}&window_start=gte.{t0.isoformat()}&window_start=lt.{t1.isoformat()}&order=window_start"
    return pd.DataFrame(rest(q.replace('+', '%2B')))


def find_set(place: str, dj: str, night: str | None) -> tuple[pd.Timestamp, pd.Timestamp, str]:
    rows = rest(f"venue_sets?select=dj_name,starts_at,ends_at&place_id=eq.{urllib.parse.quote(place)}&dj_name=ilike.{urllib.parse.quote(dj)}&order=starts_at.desc")
    if night:
        rows = [r for r in rows if r['starts_at'][:10] in (night, str(pd.Timestamp(night) + pd.Timedelta(days=1))[:10])]
    if not rows:
        sys.exit(f'No set for "{dj}" at that venue{" on " + night if night else ""} in venue_sets. Add the lineup first, or pass --from and --to.')
    r = rows[0]
    return pd.Timestamp(r['starts_at']), pd.Timestamp(r['ends_at']), r['dj_name']


def make_report(w: pd.DataFrame, venue: str, dj: str | None, outdir: Path, lookup=deezer_lookup, clip_finder=find_clips) -> Path:
    w = prepare(w)
    curve = crowd_curve(w)
    labels = minute_labels(w)
    rows = describe_runs(runs(labels), w, curve, lookup) if len(labels) else []
    peaks = []
    outdir.mkdir(parents=True, exist_ok=True)
    for i, minute in enumerate(highlights(curve) if curve['dancing'].notna().any() else [], start=1):
        files = []
        for j, src in enumerate(clip_finder(minute), start=1):
            name = f'highlight{i}_{j}.wav'
            shutil.copy(src, outdir / name)
            files.append(name)
        peaks.append({'minute': minute, 'dancing': float(curve.loc[minute, 'dancing']), 'phones': int(curve.loc[minute, 'phones']), 'clips': files})
    span = (curve.index.min(), curve.index.max())
    page = outdir / 'index.html'
    page.write_text(build_html(venue, dj, span, curve, rows, peaks, int(w['session_id'].nunique())), encoding='utf-8')
    return page


# ── self-test ────────────────────────────────────────────────────────────────

def selftest():
    rng = np.random.default_rng(5)
    t0 = pd.Timestamp('2026-10-31T22:00:00Z')
    recs = []
    for p in range(5):
        for m in range(60):
            minute = t0 + pd.Timedelta(minutes=m)
            if m >= 50 and p >= 2:
                continue                                  # only 2 phones from 22:50: those minutes stay hidden
            isrc = 'AAA' if m < 20 else (None if m < 30 else 'BBB')
            dancing_p = 0.2 if m < 20 else 0.35 if m < 30 else 0.9
            recs.append({'session_id': f's{p}', 'window_start': minute.isoformat(), 'venue_place_id': 'V', 'music_detected': True,
                         'movement_classification': 'dancing' if rng.uniform() < dancing_p else 'stationary',
                         'movement_energy': float(rng.uniform(1, 3) + (2 if dancing_p > 0.5 else 0)), 'rhythmicity': 0.1,
                         'beat_plv': 0.6 if isrc == 'BBB' else 0.2, 'song_isrc': isrc, 'phone_context': 'on_body_moving', 'on_body_share': 1.0})
    # a phone lying on a table must not count
    for m in range(60):
        recs.append({'session_id': 'table', 'window_start': (t0 + pd.Timedelta(minutes=m)).isoformat(), 'venue_place_id': 'V', 'music_detected': True,
                     'movement_classification': 'stationary', 'movement_energy': 0.0, 'rhythmicity': 0.0, 'beat_plv': None, 'song_isrc': None,
                     'phone_context': 'off_body', 'on_body_share': 0.0})
    w = pd.DataFrame(recs)

    names = {'AAA': {'title': 'Opener <b>', 'artist': 'Artist One'}, 'BBB': {'title': 'The Banger', 'artist': 'Artist Two'}}
    tmp = Path(__file__).parent / 'output' / 'dj_reports' / '_selftest'
    if tmp.exists():
        shutil.rmtree(tmp)
    page = make_report(w, 'Test Club', 'DJ Test', tmp, lookup=names.get, clip_finder=lambda minute: [])
    text = page.read_text(encoding='utf-8')

    failed = 0

    def check(name, ok, detail=''):
        nonlocal failed
        print(('ok   ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
        failed += 0 if ok else 1

    pw = prepare(w)
    curve = crowd_curve(pw)
    check('the phone on the table is left out', pw['session_id'].nunique() == 5)
    check('minutes with fewer than 3 phones are hidden', curve.loc[t0 + pd.Timedelta(minutes=55), 'dancing'] != curve.loc[t0 + pd.Timedelta(minutes=55), 'dancing'])
    check('minutes with enough phones are shown', bool(curve.loc[t0 + pd.Timedelta(minutes=40), 'shown']))
    rs = describe_runs(runs(minute_labels(pw)), pw, curve, names.get)
    check('tracklist: AAA, then unidentified music, then BBB', [r['label'] for r in rs] == ['AAA', 'unknown', 'BBB'], str([r['label'] for r in rs]))
    check('the banger has the highest dancing share', rs[2]['dancing'] > rs[0]['dancing'] + 0.3)
    check('the banger is on the beat', (rs[2]['in_sync'] or 0) > 0.8)
    peaks = highlights(curve)
    check('highlights fall inside the banger (22:30-22:49), at least 4 min apart',
          len(peaks) == 3 and all(t0 + pd.Timedelta(minutes=30) <= p < t0 + pd.Timedelta(minutes=50) for p in peaks)
          and all(abs((b - a).total_seconds()) >= 240 for a, b in zip(peaks, peaks[1:])))
    check('titles are HTML-escaped', 'Opener &lt;b&gt;' in text and 'Opener <b>' not in text)
    check('the page names the track and artist', 'The Banger' in text and 'Artist Two' in text)
    check('no session or device identifiers in the page', all(f'"s{p}"' not in text for p in range(5)) and 'session_id' not in text and 'device_id' not in text and 'deviceId' not in text)
    check('the page says it is a draft and states the minimum phones', 'Draft for review' in text and 'fewer than 3 phones' in text)
    if not os.environ.get('KEEP'):
        shutil.rmtree(tmp)
    if failed:
        print(f'\n{failed} check(s) failed')
        sys.exit(1)
    print('\nAll checks passed.')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--venue'); ap.add_argument('--dj'); ap.add_argument('--night')
    ap.add_argument('--from', dest='t0'); ap.add_argument('--to', dest='t1'); ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.venue or not (os.environ.get('SUPABASE_URL') and os.environ.get('SUPABASE_SERVICE_KEY')):
        ap.print_help()
        sys.exit('\nNeed --venue and SUPABASE_URL / SUPABASE_SERVICE_KEY in the environment.')
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
    venues = rest(f"venues?select=name&place_id=eq.{urllib.parse.quote(a.venue)}")
    name = venues[0]['name'] if venues else a.venue
    slug = ''.join(ch if ch.isalnum() else '-' for ch in f'{name}-{dj or ""}-{t0.date()}').strip('-').lower()
    page = make_report(w, name, dj, OUT / slug)
    print(f'Draft report written: {page}')


if __name__ == '__main__':
    main()
