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

Residual social sync (residual_sync, per group and 5-minute block, from the 10 s clips):
  Everyone who follows the beat looks "in sync" with everyone else, even total strangers. The
  residual measures only the coordination the shared music does not explain:
  residual_phase_sync       pairwise clock-phase agreement minus the same pair's agreement with
                            one phone shifted by 1–3 slots. Each phone's own lock to the beat
                            survives the shift; moment-to-moment coupling between the two does
                            not. ≈ 0 for people who only follow the beat; > 0 when they drift,
                            accent and recover together.
  residual_energy_coupling  correlation of two phones' movement energy across slots after
                            removing what the music's loudness (the group's bass envelope per
                            slot) explains. ≈ 0 when everyone just reacts to the drops; > 0 when
                            two people intensify and calm down together.

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


def clip_crowd_sync(clips: pd.DataFrame, windows: pd.DataFrame, sessions: pd.DataFrame,
                    group_by: str = 'event_code') -> pd.DataFrame:
    """Crowd sync every 10 s: per (group, clip_start) with ≥ MIN_DEVICES phones.

    Clips start on wall-clock multiples of 10 s on every phone, so they line up directly. Uses
    the clock-referenced beat phase (beat_phase_clock), which is only comparable between phones
    hearing the same song, so each slot keeps the devices on its most common song_isrc.
    The group is the session's group code, or with group_by='auto' the phone's automatic group
    in that minute (auto_groups.py).
    """
    if clips.empty:
        return pd.DataFrame()
    c = _clips_with_groups(clips, windows, sessions, group_by)
    if c.empty:
        return pd.DataFrame()
    if 'phone_context' in c.columns:
        c = c[c['phone_context'] != 'off_body']
    c = c.dropna(subset=['group', 'beat_phase_clock', 'beat_plv', 'song_isrc'])
    rows = []
    for (group, slot), g in c.groupby(['group', 'clip_start']):
        g = g[g['song_isrc'] == g['song_isrc'].mode().iloc[0]].drop_duplicates('device_id')
        n = len(g)
        row = {'group': group, 'clip_start': slot, 'n_devices': n,
               'crowd_phase_sync_clock': np.nan, 'crowd_sync_clock': np.nan}
        if n >= MIN_DEVICES:
            sync = float(np.abs(np.exp(1j * g['beat_phase_clock'].to_numpy()).mean()))
            row.update(crowd_phase_sync_clock=sync, crowd_sync_clock=sync * float(g['beat_plv'].mean()))
        rows.append(row)
    return pd.DataFrame(rows)


def peak_moments(crowd: pd.DataFrame, top_fraction: float = 0.1) -> pd.DataFrame:
    """Top-decile crowd_sync minutes per event — candidate 'memorable moments' (Martella 2015)."""
    valid = crowd.dropna(subset=['crowd_sync'])
    if valid.empty:
        return valid
    cut = valid.groupby('event_code')['crowd_sync'].transform(lambda s: s.quantile(1 - top_fraction))
    return valid[valid['crowd_sync'] >= cut].sort_values(['event_code', 'minute'])


# ── Residual social sync ──────────────────────────────────────────────────────

RESIDUAL_BLOCK = '5min'
RESIDUAL_SHIFTS = (1, 2, 3)      # slots (10 s each); both directions
RESIDUAL_MIN_SLOTS = 12          # shared slots a pair needs in a block (2 of 5 minutes)
SLOT_S = 10
FRAMES_PER_SLOT = 40             # 250 ms bass-envelope frames per 10 s slot


def _clips_with_groups(clips: pd.DataFrame, windows: pd.DataFrame, sessions: pd.DataFrame,
                       group_by: str) -> pd.DataFrame:
    """Clips with device_id, minute and their group (group code, or automatic group)."""
    c = clips.copy()
    c['clip_start'] = pd.to_datetime(c['clip_start'], utc=True, format='ISO8601')
    c['minute'] = c['clip_start'].dt.floor('min')
    c = c.merge(sessions[['id', 'device_id'] + (['event_code'] if group_by != 'auto' else [])]
                .rename(columns={'id': 'session_id'}), on='session_id', how='inner')
    if group_by == 'auto':
        from auto_groups import auto_groups
        groups = auto_groups(windows, sessions)
        if groups.empty:
            return pd.DataFrame()
        c = c.merge(groups[['session_id', 'minute', 'auto_group']], on=['session_id', 'minute'], how='inner')
        return c.rename(columns={'auto_group': 'group'})
    return c.rename(columns={'event_code': 'group'})


def slot_music(windows: pd.DataFrame) -> pd.DataFrame:
    """Music loudness per session and 10 s slot: mean bass-envelope dB (relative to the minute)."""
    from auto_groups import decode_envelope
    rows = []
    if 'bass_envelope' not in windows.columns:
        return pd.DataFrame(columns=['session_id', 'clip_start', 'music_db'])
    for _, w in windows.dropna(subset=['bass_envelope']).iterrows():
        env = decode_envelope(w['bass_envelope'])
        if env is None:
            continue
        minute = pd.to_datetime(w['window_start'], utc=True, format='ISO8601').floor('min')
        for k in range(len(env) // FRAMES_PER_SLOT):
            seg = env[k * FRAMES_PER_SLOT:(k + 1) * FRAMES_PER_SLOT]
            if np.isfinite(seg).sum() >= FRAMES_PER_SLOT // 4:
                rows.append({'session_id': w['session_id'], 'clip_start': minute + pd.Timedelta(seconds=SLOT_S * k),
                             'music_db': float(np.nanmean(seg))})
    return pd.DataFrame(rows, columns=['session_id', 'clip_start', 'music_db'])


def _phase_agreement(a: np.ndarray, b: np.ndarray) -> tuple[float, int]:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < RESIDUAL_MIN_SLOTS:
        return np.nan, int(ok.sum())
    return float(np.abs(np.exp(1j * (a[ok] - b[ok])).mean())), int(ok.sum())


def residual_phase(a: np.ndarray, b: np.ndarray) -> float:
    """Pair agreement minus its mean agreement with b shifted by ±RESIDUAL_SHIFTS slots."""
    obs, _ = _phase_agreement(a, b)
    if not np.isfinite(obs):
        return np.nan
    surrogates = []
    for k in RESIDUAL_SHIFTS:
        for shifted_a, shifted_b in ((a[k:], b[:-k]), (a[:-k], b[k:])):
            r, _ = _phase_agreement(shifted_a, shifted_b)
            if np.isfinite(r):
                surrogates.append(r)
    return obs - float(np.mean(surrogates)) if surrogates else np.nan


def residual_energy(a: np.ndarray, b: np.ndarray, music: np.ndarray) -> float:
    """Correlation of two energy series after regressing each on the music loudness."""
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < RESIDUAL_MIN_SLOTS:
        return np.nan
    have_music = ok & np.isfinite(music)
    if have_music.sum() >= RESIDUAL_MIN_SLOTS and np.nanstd(music[have_music]) > 0:
        ok = have_music
        X = np.column_stack([np.ones(ok.sum()), music[ok]])
        ra = a[ok] - X @ np.linalg.lstsq(X, a[ok], rcond=None)[0]
        rb = b[ok] - X @ np.linalg.lstsq(X, b[ok], rcond=None)[0]
    else:  # no envelope: only the mean is removed
        ra, rb = a[ok] - a[ok].mean(), b[ok] - b[ok].mean()
    if ra.std() == 0 or rb.std() == 0:
        return np.nan
    return float(np.corrcoef(ra, rb)[0, 1])


def residual_sync(clips: pd.DataFrame, windows: pd.DataFrame, sessions: pd.DataFrame,
                  group_by: str = 'event_code') -> pd.DataFrame:
    """Residual social sync per (group, 5-minute block), averaged over the group's phone pairs."""
    if clips.empty:
        return pd.DataFrame()
    c = _clips_with_groups(clips, windows, sessions, group_by)
    if c.empty:
        return pd.DataFrame()
    c = c.dropna(subset=['group'])
    if 'phone_context' in c.columns:
        c = c[c['phone_context'] != 'off_body']  # a phone on a table is not a dancer
    for col in ['beat_phase_clock', 'movement_energy', 'song_isrc']:
        if col not in c.columns:
            c[col] = np.nan
    music = slot_music(windows) if not windows.empty else pd.DataFrame(columns=['session_id', 'clip_start', 'music_db'])
    if not music.empty:
        c = c.merge(music, on=['session_id', 'clip_start'], how='left')
    else:
        c['music_db'] = np.nan
    c['block'] = c['clip_start'].dt.floor(RESIDUAL_BLOCK)

    rows = []
    for (group, block), g in c.groupby(['group', 'block']):
        slots = pd.date_range(block, periods=int(pd.Timedelta(RESIDUAL_BLOCK).total_seconds() // SLOT_S),
                              freq=f'{SLOT_S}s')
        g = g.drop_duplicates(['device_id', 'clip_start'])
        phase = g.pivot(index='device_id', columns='clip_start', values='beat_phase_clock').reindex(columns=slots)
        song = g.pivot(index='device_id', columns='clip_start', values='song_isrc').reindex(columns=slots)
        energy = g.pivot(index='device_id', columns='clip_start', values='movement_energy').reindex(columns=slots)
        group_music = g.groupby('clip_start')['music_db'].mean().reindex(slots).to_numpy(dtype=float)
        devices = list(energy.index)
        phases, energies = [], []
        for i in range(len(devices)):
            for j in range(i + 1, len(devices)):
                a, b = devices[i], devices[j]
                # Clock phases compare only while both hear the same song
                same = (song.loc[a] == song.loc[b]).to_numpy() & song.loc[a].notna().to_numpy()
                pa = np.where(same, phase.loc[a].to_numpy(dtype=float), np.nan)
                pb = np.where(same, phase.loc[b].to_numpy(dtype=float), np.nan)
                phases.append(residual_phase(pa, pb))
                energies.append(residual_energy(energy.loc[a].to_numpy(dtype=float),
                                                energy.loc[b].to_numpy(dtype=float), group_music))
        rows.append({'group': group, 'block_start': block, 'n_devices': len(devices),
                     'n_pairs': len(phases),
                     'residual_phase_sync': float(np.nanmean(phases)) if np.isfinite(phases).any() else np.nan,
                     'residual_energy_coupling': float(np.nanmean(energies)) if np.isfinite(energies).any() else np.nan})
    return pd.DataFrame(rows)


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

    # 10 s clips: 4 phones in one group; slot 1 aligned, slot 2 spread, slot 3 one phone on
    # another song (left out, 3 remain)
    slot = pd.Timestamp('2026-10-10T22:00:00Z')
    rows = []
    for k, (phases, songs) in enumerate([([1.0, 1.1, 0.9, 1.05], ['S'] * 4),
                                         ([0.0, 1.6, 3.1, -1.6], ['S'] * 4),
                                         ([2.0, 2.1, 1.9, -1.0], ['S', 'S', 'S', 'X'])]):
        for i in range(4):
            rows.append({'id': f'c{k}{i}', 'session_id': f's{i}', 'clip_start': (slot + pd.Timedelta(seconds=10 * k)).isoformat(),
                         'beat_plv': 0.8, 'beat_phase_clock': phases[i], 'song_isrc': songs[i]})
    s = pd.DataFrame({'id': [f's{i}' for i in range(4)], 'device_id': [f'd{i}' for i in range(4)], 'event_code': 'G-X'})
    cc = clip_crowd_sync(pd.DataFrame(rows), pd.DataFrame(), s).sort_values('clip_start').reset_index(drop=True)
    assert cc.loc[0, 'crowd_phase_sync_clock'] > 0.99 and cc.loc[1, 'crowd_phase_sync_clock'] < 0.05, cc
    assert cc.loc[2, 'n_devices'] == 3 and cc.loc[2, 'crowd_phase_sync_clock'] > 0.99, cc
    print(f"clip_crowd_sync     → 10 s slots: aligned {cc.loc[0, 'crowd_phase_sync_clock']:.2f}, spread "
          f"{cc.loc[1, 'crowd_phase_sync_clock']:.2f}, other-song phone left out ({cc.loc[2, 'n_devices']} devices)")

    # Residual social sync: 4 phones over one 5-minute block (30 slots), same song throughout
    def residual_case(coupled: bool, seed: int):
        r = np.random.default_rng(seed)
        n_slots = 30
        music = r.normal(0, 3, n_slots)                        # drops and breakdowns (dB)
        drift = np.cumsum(r.normal(0, 0.6, n_slots))           # a shared wander off the beat
        shared_energy = r.normal(0, 1.0, n_slots)              # intensifying together
        rows, wrows = [], []
        for i in range(4):
            phase = 1.0 + r.normal(0, 0.6, n_slots) + (drift if coupled else 0)
            energy = 2.0 + 0.3 * music + r.normal(0, 1.0, n_slots) + (shared_energy if coupled else 0)
            for k in range(n_slots):
                rows.append({'id': f'c{i}-{k}', 'session_id': f's{i}',
                             'clip_start': (slot + pd.Timedelta(seconds=10 * k)).isoformat(),
                             'beat_plv': 0.7, 'beat_phase_clock': phase[k], 'movement_energy': energy[k],
                             'song_isrc': 'S', 'phone_context': 'on_body_moving'})
            for m in range(5):  # the room's bass envelope: each slot's frames at that slot's level
                env = np.repeat(music[m * 6:(m + 1) * 6], FRAMES_PER_SLOT)
                raw = np.clip(np.round((env + 24) / 48 * 254) + 1, 1, 255).astype(np.uint8)
                import base64
                wrows.append({'id': f'w{i}-{m}', 'session_id': f's{i}',
                              'window_start': (slot + pd.Timedelta(minutes=m)).isoformat(),
                              'bass_envelope': base64.b64encode(raw.tobytes()).decode()})
        sess = pd.DataFrame({'id': [f's{i}' for i in range(4)], 'device_id': [f'd{i}' for i in range(4)], 'event_code': 'G-R'})
        return residual_sync(pd.DataFrame(rows), pd.DataFrame(wrows), sess).iloc[0]

    beat_only = [residual_case(False, k) for k in range(20)]
    coupled = [residual_case(True, 100 + k) for k in range(20)]
    bp = np.mean([r['residual_phase_sync'] for r in beat_only]); cp = np.mean([r['residual_phase_sync'] for r in coupled])
    be = np.mean([r['residual_energy_coupling'] for r in beat_only]); ce = np.mean([r['residual_energy_coupling'] for r in coupled])
    print(f"residual_sync       → beat-only crowd: phase {bp:+.3f}, energy {be:+.3f}; "
          f"coupled crowd: phase {cp:+.3f}, energy {ce:+.3f}")
    assert abs(bp) < 0.08 and abs(be) < 0.1, (bp, be)
    assert cp > 0.12 and ce > 0.3, (cp, ce)
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

    clips_path = DATA_DIR / 'sensor_clips.csv'
    if clips_path.exists():
        clips = pd.read_csv(clips_path)
        cc = clip_crowd_sync(clips, windows, sessions, group_by=group_by)
        if not cc.empty:
            cc.to_csv(OUTPUT_DIR / 'clip_crowd_sync.csv', index=False)
            print(f"10 s slots with ≥{MIN_DEVICES} devices: {int(cc['crowd_sync_clock'].notna().sum())} "
                  f"→ saved {OUTPUT_DIR}/clip_crowd_sync.csv")
        rs = residual_sync(clips, windows, sessions, group_by=group_by)
        if not rs.empty:
            rs.to_csv(OUTPUT_DIR / 'residual_sync.csv', index=False)
            print(f"Residual social sync: {int(rs['residual_phase_sync'].notna().sum())} group-blocks with phase, "
                  f"{int(rs['residual_energy_coupling'].notna().sum())} with energy → saved {OUTPUT_DIR}/residual_sync.csv")


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    else:
        main()
