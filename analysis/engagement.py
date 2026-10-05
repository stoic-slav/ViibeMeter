"""
VibeMeter — Engagement: sustained dancing, staying and coming back

Per-minute windows say whether a phone's owner was dancing. Over time that gives behaviour that
says more about enjoyment than one burst of movement:
  dancing_share        share of on-body minutes spent dancing
  longest_streak_min   longest run of consecutive dancing minutes
  returns              times dancing resumed after a break of ≥ BREAK_MIN minutes
  through_song_change  share of song changes during which the person kept dancing (a crowd that
                       stays on the floor across the transition is engaged with the set, not
                       one song)

A minute counts as dancing when the phone is on a body (not lying still on a table) and its
movement is classified dancing or jumping, or is rhythmic (rhythmicity ≥ RHYTHMIC). Minutes with
the phone off the body are left out rather than counted as "not dancing".

Reported per session and per session × 15-minute block (output/engagement_*.csv).

Usage:
  python3 engagement.py              (run fetch_data.py first)
  python3 engagement.py --selftest
"""

import sys
import numpy as np
import pandas as pd
from pathlib import Path

DATA_DIR = Path(__file__).parent / 'data'
OUTPUT_DIR = Path(__file__).parent / 'output'

RHYTHMIC = 0.35          # matches the app's MOVEMENT_MIN_RHYTHMICITY
BREAK_MIN = 3            # minutes off the floor before a return counts
BLOCK = '15min'


def dancing_minutes(windows: pd.DataFrame) -> pd.DataFrame:
    """One row per session-minute: minute, dancing (bool), song_isrc; off-body minutes dropped."""
    w = windows.copy()
    w['minute'] = pd.to_datetime(w['window_start'], utc=True, format='ISO8601').dt.floor('min')
    if 'phone_context' in w.columns:
        w = w[w['phone_context'] != 'off_body']
    cls = w['movement_classification'] if 'movement_classification' in w.columns else pd.Series(index=w.index, dtype=object)
    rhythm = pd.to_numeric(w['rhythmicity'], errors='coerce') if 'rhythmicity' in w.columns else pd.Series(np.nan, index=w.index)
    w['dancing'] = cls.isin(['dancing', 'jumping']) | (rhythm >= RHYTHMIC)
    if 'song_isrc' not in w.columns:
        w['song_isrc'] = np.nan
    return w[['session_id', 'minute', 'dancing', 'song_isrc']].sort_values(['session_id', 'minute'])


def _summary(m: pd.DataFrame) -> pd.Series:
    m = m.sort_values('minute')
    d = m['dancing'].to_numpy(dtype=bool)
    gaps = m['minute'].diff().dt.total_seconds().fillna(60).to_numpy() / 60
    # Streaks and breaks follow consecutive minutes; a gap in the data ends a streak
    longest = streak = 0
    returns = 0
    off_run = 0
    seen_dancing = False
    for i, dancing in enumerate(d):
        contiguous = gaps[i] <= 1.5
        if dancing:
            if seen_dancing and off_run >= BREAK_MIN:
                returns += 1
            streak = streak + 1 if (contiguous and i > 0 and d[i - 1]) else 1
            longest = max(longest, streak)
            off_run = 0
            seen_dancing = True
        else:
            streak = 0
            off_run = off_run + 1 if contiguous else BREAK_MIN  # a data gap counts as a break
    # Song changes: the recognised song differs from the last one heard, one minute apart
    songs = m['song_isrc'].ffill().to_numpy(dtype=object)
    kept = changes = 0
    for i in range(1, len(m)):
        if gaps[i] <= 1.5 and isinstance(songs[i], str) and isinstance(songs[i - 1], str) and songs[i] != songs[i - 1]:
            if d[i - 1]:
                changes += 1
                kept += int(d[i])
    return pd.Series({
        'minutes': len(m),
        'dancing_share': float(d.mean()) if len(d) else np.nan,
        'longest_streak_min': longest,
        'returns': returns,
        'song_changes_while_dancing': changes,
        'through_song_change': kept / changes if changes else np.nan,
    })


def engagement(windows: pd.DataFrame):
    """Per-session and per-15-minute-block engagement."""
    m = dancing_minutes(windows)
    if m.empty:
        return pd.DataFrame(), pd.DataFrame()
    per_session = m.groupby('session_id').apply(_summary, include_groups=False).reset_index()
    m['block_start'] = m['minute'].dt.floor(BLOCK)
    per_block = m.groupby(['session_id', 'block_start']).apply(_summary, include_groups=False).reset_index()
    return per_session, per_block


def selftest():
    t0 = pd.Timestamp('2026-10-10T22:00:00Z')

    def windows(pattern, songs=None, context=None):
        rows = []
        for i, ch in enumerate(pattern):
            rows.append({'session_id': 's1', 'window_start': (t0 + pd.Timedelta(minutes=i)).isoformat(),
                         'movement_classification': 'dancing' if ch == 'D' else 'stationary',
                         'rhythmicity': 0.6 if ch == 'D' else 0.1,
                         'song_isrc': songs[i] if songs else None,
                         'phone_context': (context[i] if context else 'on_body_moving')})
        return pd.DataFrame(rows)

    # 5 dancing, 4 off, 3 dancing: one return, longest streak 5
    s, _ = engagement(windows('DDDDD....DDD'))
    r = s.iloc[0]
    assert r['longest_streak_min'] == 5 and r['returns'] == 1 and abs(r['dancing_share'] - 8 / 12) < 1e-9, r
    print(f"streaks and returns → longest {r['longest_streak_min']} min, returns {r['returns']}, share {r['dancing_share']:.2f}")

    # A short 2-minute pause is not a return
    s, _ = engagement(windows('DDD..DDD'))
    assert s.iloc[0]['returns'] == 0
    print("short pause         → not counted as a return")

    # Song changes: A→B while dancing (kept), B→C while dancing then stopped (lost)
    s, _ = engagement(windows('DDDDD.', songs=['A', 'A', 'B', 'B', 'B', 'C']))
    r = s.iloc[0]
    assert r['song_changes_while_dancing'] == 2 and r['through_song_change'] == 0.5, r
    print(f"song changes        → kept dancing through {r['through_song_change']:.0%} of them")

    # Off-body minutes are left out, not counted as "not dancing"
    s, _ = engagement(windows('DD..', context=['on_body_moving'] * 2 + ['off_body'] * 2))
    assert s.iloc[0]['minutes'] == 2 and s.iloc[0]['dancing_share'] == 1.0
    print("phone on a table    → those minutes are left out")
    print("selftest OK")


def main():
    try:
        windows = pd.read_csv(DATA_DIR / 'sensor_windows.csv')
    except FileNotFoundError as e:
        print(f"ERROR: Data files not found. Run fetch_data.py first.\n{e}")
        return
    OUTPUT_DIR.mkdir(exist_ok=True)
    per_session, per_block = engagement(windows)
    if per_session.empty:
        print("No windows yet.")
        return
    per_session.to_csv(OUTPUT_DIR / 'engagement_sessions.csv', index=False)
    per_block.to_csv(OUTPUT_DIR / 'engagement_blocks.csv', index=False)
    print(per_session.to_string(index=False))
    print(f"\nSaved {OUTPUT_DIR}/engagement_sessions.csv and engagement_blocks.csv")


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    else:
        main()
