"""
VibeMeter — Crowd Sync (person ↔ person synchrony)

For every event code and wall-clock minute with at least MIN_DEVICES phones, measures
whether people are moving on the same beat, in the same phase, as each other.

Inputs are per-window scalars uploaded by each phone (no raw sensor data):
  beat_phase_mean  where in the beat that phone's movement peaks land (radians)
  beat_plv         how consistently that phone's movement locks to the beat (0–1)
  movement_bpm     that phone's dominant movement tempo

Metrics per (event_code, minute):
  crowd_phase_sync       |mean e^{i·beat_phase_mean}| across devices — do people hit the beat
                         at the same moment? Privacy-safe analogue of the intersubject phase
                         synchronisation in Ellamil et al. 2016 (PLoS ONE). Device clock offsets
                         cancel because each phone measures phase against the beat it hears.
  crowd_tempo_agreement  share of devices whose movement tempo (folded to one octave) is within
                         ±5% of the median — works even when the audio beat is not detected.
  crowd_sync             crowd_phase_sync × mean(beat_plv): locked to the music AND to each other.
  crowd_phase_sync_clock same as crowd_phase_sync but from beat_phase_clock: movement phase
                         against a wall-clock grid at the recognised song tempo. Uses no
                         microphone timing, so a phone's own fabric rustle (which lands on the
                         wearer's steps) cannot pull it towards that phone's movement. Needs the
                         phones' clocks to agree (network time) and the same song_bpm; only
                         devices on the minute's most common song_bpm are used.
  crowd_sync_clock       crowd_phase_sync_clock × mean(beat_plv).

Usage:
  python3 crowd_sync.py              (run fetch_data.py first; groups by group code)
  python3 crowd_sync.py --auto       (groups by the music instead, see auto_groups.py)
  python3 crowd_sync.py --selftest   (synthetic checks, no data needed)
"""

import sys
import numpy as np
import pandas as pd
from pathlib import Path

DATA_DIR = Path(__file__).parent / 'data'
OUTPUT_DIR = Path(__file__).parent / 'output'

MIN_DEVICES = 3
TEMPO_TOLERANCE = 0.05


def fold_tempo(bpm: float) -> float:
    """Fold a tempo into [80, 160) BPM so half-time / double-time movers count as agreeing."""
    if not np.isfinite(bpm) or bpm <= 0:
        return np.nan
    while bpm < 80:
        bpm *= 2
    while bpm >= 160:
        bpm /= 2
    return bpm


def _crowd_metrics(group: pd.DataFrame) -> pd.Series:
    n_devices = group['device_id'].nunique()
    out = {
        'n_devices': n_devices,
        'crowd_phase_sync': np.nan,
        'crowd_tempo_agreement': np.nan,
        'crowd_sync': np.nan,
        'crowd_mean_plv': np.nan,
        'crowd_phase_sync_clock': np.nan,
        'crowd_sync_clock': np.nan,
    }
    if n_devices < MIN_DEVICES:
        return pd.Series(out)

    # One value per device (a device has at most one window per minute; average just in case)
    per_device = group.groupby('device_id').agg(
        phase_cos=('beat_phase_mean', lambda p: np.cos(p).mean()),
        phase_sin=('beat_phase_mean', lambda p: np.sin(p).mean()),
        beat_plv=('beat_plv', 'mean'),
        movement_bpm=('movement_bpm', 'mean'),
        clock_cos=('beat_phase_clock', lambda p: np.cos(p).mean()),
        clock_sin=('beat_phase_clock', lambda p: np.sin(p).mean()),
        song_bpm=('song_bpm', 'median'),
    )

    phased = per_device.dropna(subset=['phase_cos', 'phase_sin', 'beat_plv'])
    if len(phased) >= MIN_DEVICES:
        angles = np.arctan2(phased['phase_sin'], phased['phase_cos'])
        phase_sync = float(np.abs(np.exp(1j * angles).mean()))
        mean_plv = float(phased['beat_plv'].mean())
        out.update(crowd_phase_sync=phase_sync, crowd_mean_plv=mean_plv,
                   crowd_sync=phase_sync * mean_plv)

    clocked = per_device.dropna(subset=['clock_cos', 'clock_sin', 'beat_plv', 'song_bpm'])
    if len(clocked) >= MIN_DEVICES:
        clocked = clocked[clocked['song_bpm'] == clocked['song_bpm'].mode().iloc[0]]
    if len(clocked) >= MIN_DEVICES:
        angles = np.arctan2(clocked['clock_sin'], clocked['clock_cos'])
        clock_sync = float(np.abs(np.exp(1j * angles).mean()))
        out.update(crowd_phase_sync_clock=clock_sync,
                   crowd_sync_clock=clock_sync * float(clocked['beat_plv'].mean()))

    tempos = per_device['movement_bpm'].map(fold_tempo).dropna()
    if len(tempos) >= MIN_DEVICES:
        med = tempos.median()
        out['crowd_tempo_agreement'] = float((abs(tempos - med) / med <= TEMPO_TOLERANCE).mean())

    return pd.Series(out)


def compute_crowd_sync(windows: pd.DataFrame, sessions: pd.DataFrame, group_by: str = 'event_code') -> pd.DataFrame:
    """Return one row per (group, minute) with crowd metrics (NaN below MIN_DEVICES).

    group_by='event_code' groups by the shared group code (QR or typed); group_by='auto' groups
    by the automatic music-based grouping (auto_groups.py), which needs no code at all. The
    group id is reported in the event_code column either way.
    """
    if group_by == 'auto':
        from auto_groups import auto_groups
        groups = auto_groups(windows, sessions)
        if groups.empty:
            return pd.DataFrame()
        sessions = sessions.drop(columns=['event_code'], errors='ignore')
        windows = windows.copy()
        windows['minute'] = pd.to_datetime(windows['window_start'], utc=True, format='ISO8601').dt.floor('min')
        windows = windows.merge(groups[['session_id', 'minute', 'auto_group']], on=['session_id', 'minute'], how='left')
        windows = windows.rename(columns={'auto_group': 'event_code'}).drop(columns=['minute'])
        cols = ['id', 'device_id']
    else:
        cols = ['id', 'device_id', 'event_code']
        if 'event_code' not in sessions.columns:
            return pd.DataFrame()
    w = windows.merge(sessions[cols].rename(columns={'id': 'session_id'}), on='session_id', how='inner')
    w = w[w['event_code'].notna() & (w['event_code'].astype(str).str.len() > 0)].copy()
    if w.empty:
        return pd.DataFrame()
    for col in ['beat_phase_mean', 'beat_phase_clock', 'beat_plv', 'movement_bpm', 'song_bpm']:
        if col not in w.columns:
            w[col] = np.nan
    w['minute'] = pd.to_datetime(w['window_start'], utc=True, format='ISO8601').dt.floor('min')
    crowd = (w.groupby(['event_code', 'minute'])
               .apply(_crowd_metrics, include_groups=False)
               .reset_index())
    crowd['n_devices'] = crowd['n_devices'].astype(int)
    return crowd


def attach_crowd_sync(windows: pd.DataFrame, sessions: pd.DataFrame) -> pd.DataFrame:
    """Add crowd metrics to every window row (NaN when the window has no qualifying crowd)."""
    crowd = compute_crowd_sync(windows, sessions)
    out = windows.copy()
    crowd_cols = ['crowd_phase_sync', 'crowd_tempo_agreement', 'crowd_sync',
                  'crowd_phase_sync_clock', 'crowd_sync_clock', 'n_devices']
    if crowd.empty or 'event_code' not in sessions.columns:
        for c in crowd_cols:
            out[c] = np.nan
        return out
    out = out.merge(sessions[['id', 'event_code']].rename(columns={'id': 'session_id'}),
                    on='session_id', how='left')
    out['minute'] = pd.to_datetime(out['window_start'], utc=True, format='ISO8601').dt.floor('min')
    out = out.merge(crowd[['event_code', 'minute'] + crowd_cols], on=['event_code', 'minute'], how='left')
    return out.drop(columns=['minute'])


def peak_moments(crowd: pd.DataFrame, top_fraction: float = 0.1) -> pd.DataFrame:
    """Top-decile crowd_sync minutes per event — candidate 'memorable moments' (Martella 2015)."""
    valid = crowd.dropna(subset=['crowd_sync'])
    if valid.empty:
        return valid
    cut = valid.groupby('event_code')['crowd_sync'].transform(lambda s: s.quantile(1 - top_fraction))
    return valid[valid['crowd_sync'] >= cut].sort_values(['event_code', 'minute'])


# ── Synthetic self-test ───────────────────────────────────────────────────────

def _synthetic(phases, plvs, bpms, event='TEST', minute='2026-10-02T21:00:00Z', clock=None, song_bpm=None):
    sessions = pd.DataFrame({
        'id': [f's{i}' for i in range(len(phases))],
        'device_id': [f'd{i}' for i in range(len(phases))],
        'event_code': event,
    })
    windows = pd.DataFrame({
        'id': [f'w{i}' for i in range(len(phases))],
        'session_id': sessions['id'],
        'window_start': minute,
        'beat_phase_mean': phases,
        'beat_plv': plvs,
        'movement_bpm': bpms,
        'beat_phase_clock': clock if clock is not None else [np.nan] * len(phases),
        'song_bpm': song_bpm if song_bpm is not None else [np.nan] * len(phases),
    })
    return windows, sessions


def selftest():
    rng = np.random.default_rng(7)

    w, s = _synthetic([1.0, 1.05, 0.95, 1.02], [0.9] * 4, [120, 121, 60, 240])
    r = compute_crowd_sync(w, s).iloc[0]
    assert r['crowd_phase_sync'] > 0.99, r
    assert r['crowd_tempo_agreement'] == 1.0, r  # half/double time fold to 120
    assert abs(r['crowd_sync'] - r['crowd_phase_sync'] * 0.9) < 1e-9
    print(f"aligned phases      → crowd_phase_sync={r['crowd_phase_sync']:.3f}  tempo_agreement={r['crowd_tempo_agreement']:.2f}")

    sims = []
    for _ in range(200):
        w, s = _synthetic(list(rng.uniform(-np.pi, np.pi, 4)), [0.9] * 4, [120, 135, 100, 150])
        sims.append(compute_crowd_sync(w, s).iloc[0]['crowd_phase_sync'])
    print(f"random phases (n=4) → mean crowd_phase_sync={np.mean(sims):.3f}  (chance level for 4 devices ≈ 0.44)")
    assert np.mean(sims) < 0.6

    # Clock phase: aligned devices on the same song sync; a device on another song is left out
    w, s = _synthetic([0.0] * 4, [0.8] * 4, [117] * 4,
                      clock=[2.0, 2.1, 1.9, -1.0], song_bpm=[117, 117, 117, 128])
    r = compute_crowd_sync(w, s).iloc[0]
    assert r['crowd_phase_sync_clock'] > 0.99, r
    assert abs(r['crowd_sync_clock'] - r['crowd_phase_sync_clock'] * 0.8) < 1e-9
    print(f"clock phases        → crowd_phase_sync_clock={r['crowd_phase_sync_clock']:.3f} (other-song device excluded)")
    w, s = _synthetic([0.0] * 4, [0.8] * 4, [117] * 4, clock=[0.0, 1.6, 3.1, -1.6], song_bpm=[117] * 4)
    assert compute_crowd_sync(w, s).iloc[0]['crowd_phase_sync_clock'] < 0.05
    print("spread clock phases → crowd_phase_sync_clock≈0")

    w, s = _synthetic([1.0, 1.0], [0.9, 0.9], [120, 120])
    r = compute_crowd_sync(w, s).iloc[0]
    assert np.isnan(r['crowd_sync']) and r['n_devices'] == 2
    print("2 devices           → NaN (below MIN_DEVICES)")

    w, s = _synthetic([1.0, 1.1, 0.9], [0.8] * 3, [120] * 3)
    attached = attach_crowd_sync(w, s)
    assert attached['crowd_sync'].notna().all()
    print("attach_crowd_sync   → crowd metrics joined to every window")

    # Automatic grouping end to end: 3 phones hearing the same two playbacks, no shared code
    t0 = pd.Timestamp('2026-10-10T22:00:00Z')
    rows = []
    for i in range(3):
        for m, (isrc, start) in enumerate([('X1', t0), ('X1', t0), ('X2', t0 + pd.Timedelta(minutes=2))] * 2):
            rows.append({'id': f'w{i}-{m}', 'session_id': f's{i}', 'window_start': (t0 + pd.Timedelta(minutes=m)).isoformat(),
                         'song_isrc': isrc, 'song_started_at': (start + pd.Timedelta(seconds=0.2 * i)).isoformat(),
                         'beat_phase_mean': 1.0, 'beat_plv': 0.8, 'movement_bpm': 120})
    w = pd.DataFrame(rows)
    s = pd.DataFrame({'id': ['s0', 's1', 's2'], 'device_id': ['d0', 'd1', 'd2'], 'event_code': ['G-A', 'G-B', 'G-C']})
    assert compute_crowd_sync(w, s).dropna(subset=['crowd_sync']).empty  # codes differ: no crowd
    auto = compute_crowd_sync(w, s, group_by='auto').dropna(subset=['crowd_sync'])
    assert len(auto) > 0 and (auto['n_devices'] == 3).all(), auto
    print(f"group_by='auto'     → {len(auto)} crowd minutes from the music alone (codes all differ)")
    print("selftest OK")


def main():
    try:
        windows = pd.read_csv(DATA_DIR / 'sensor_windows.csv')
        sessions = pd.read_csv(DATA_DIR / 'sessions.csv')
    except FileNotFoundError as e:
        print(f"ERROR: Data files not found. Run fetch_data.py first.\n{e}")
        return

    OUTPUT_DIR.mkdir(exist_ok=True)
    group_by = 'auto' if '--auto' in sys.argv else 'event_code'
    crowd = compute_crowd_sync(windows, sessions, group_by=group_by)
    print(f"Grouping phones by: {'music (automatic)' if group_by == 'auto' else 'group code'}")
    if crowd.empty:
        print("No sessions with an event code yet — crowd sync needs ≥3 testers entering the same code.")
        return

    valid = crowd.dropna(subset=['crowd_sync'])
    print(f"Event-minutes: {len(crowd)}  (with ≥{MIN_DEVICES} devices and beat data: {len(valid)})")
    for event, g in crowd.groupby('event_code'):
        v = g.dropna(subset=['crowd_sync'])
        print(f"  {event:<16} minutes={len(g):>4}  max devices={g['n_devices'].max():>3}  "
              f"mean crowd_sync={v['crowd_sync'].mean() if len(v) else float('nan'):.3f}")

    crowd.to_csv(OUTPUT_DIR / 'crowd_sync.csv', index=False)
    peak_moments(crowd).to_csv(OUTPUT_DIR / 'crowd_peak_moments.csv', index=False)
    print(f"\nSaved {OUTPUT_DIR}/crowd_sync.csv and crowd_peak_moments.csv")


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    else:
        main()
