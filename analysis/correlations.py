"""
VibeMeter — Per-Signal Correlation Analysis
Computes Pearson and Spearman correlations between each sensor signal
and the subjective vibe ratings.

Usage:
  python3 correlations.py
  (run fetch_data.py first to populate data/)
"""

import pandas as pd
import numpy as np
from scipy import stats
from pathlib import Path
import warnings
from crowd_sync import attach_crowd_sync
warnings.filterwarnings('ignore')

DATA_DIR = Path(__file__).parent / 'data'
OUTPUT_DIR = Path(__file__).parent / 'output'
OUTPUT_DIR.mkdir(exist_ok=True)

# Signals correlated against ratings. Evidence-ranked additions (see README):
#   movement_energy — Martella 2015 (accelerometer predicts enjoyment), Witek 2014
#   crowd_*         — Ellamil 2016, Tarr 2016 (person ↔ person synchrony)
#   beat_plv / tempo_match — person ↔ music synchrony
#   pulse_clarity / bpm_in_100_150 / FFT features — music features linked to movement & sync
SIGNALS = [
    'avg_db', 'max_db', 'db_variance',
    'music_detected', 'estimated_bpm', 'bpm_in_100_150', 'bass_presence', 'mid_high_ratio',
    'sub_bass_energy', 'spectral_centroid', 'spectral_flux', 'crest_factor',
    'vocal_presence', 'harmonic_noise_ratio', 'pulse_clarity',
    'accel_magnitude_avg', 'accel_variance', 'gyro_activity_avg',
    'movement_energy', 'movement_bpm', 'rhythmicity',
    'beat_plv', 'tempo_match',
    'crowd_phase_sync', 'crowd_tempo_agreement', 'crowd_sync',
    'ble_device_count', 'ble_count_delta',
    'screen_off_ratio',
    'computed_energy_score', 'computed_density_score',
    'computed_movement_score', 'computed_music_score', 'computed_vibe_score',
]
SESSION_COVARIATES = ['phone_placement', 'dance_affinity', 'event_code', 'app_version', 'os_version']


def platform_of(os_version) -> str | float:
    """'ios' / 'android' from the session's os_version (e.g. 'ios 18.2', 'android 34')."""
    if not isinstance(os_version, str) or not os_version.strip():
        return np.nan
    return os_version.split()[0].lower()


def load_data():
    windows = pd.read_csv(DATA_DIR / 'sensor_windows.csv')
    ratings = pd.read_csv(DATA_DIR / 'ratings.csv')
    sessions = pd.read_csv(DATA_DIR / 'sessions.csv')

    # Parse timestamps
    windows['window_start'] = pd.to_datetime(windows['window_start'])
    ratings['rated_at'] = pd.to_datetime(ratings['rated_at'])

    return windows, ratings, sessions


def build_paired_dataset(windows: pd.DataFrame, ratings: pd.DataFrame,
                         sessions: pd.DataFrame | None = None) -> pd.DataFrame:
    """For each rating, find the nearest sensor window (with crowd metrics attached)."""
    if sessions is not None:
        windows = attach_crowd_sync(windows, sessions)
    if 'estimated_bpm' in windows.columns:
        bpm = pd.to_numeric(windows['estimated_bpm'], errors='coerce')
        windows = windows.assign(bpm_in_100_150=np.where(bpm.notna(), ((bpm >= 100) & (bpm <= 150)).astype(float), np.nan))
    paired = []

    for _, rating in ratings.iterrows():
        session_windows = windows[windows['session_id'] == rating['session_id']].copy()
        if len(session_windows) == 0:
            continue

        time_diffs = abs(session_windows['window_start'] - rating['rated_at'])
        nearest_idx = time_diffs.idxmin()
        nearest = session_windows.loc[nearest_idx]

        row = {
            'session_id': rating['session_id'],
            'device_id': rating.get('device_id', ''),
            'rating': rating['rating'],
            'response_time_ms': rating.get('response_time_ms', np.nan),
            'time_delta_sec': time_diffs.min().total_seconds(),
        }

        for col in SIGNALS:
            row[col] = nearest.get(col, np.nan)

        paired.append(row)

    df = pd.DataFrame(paired)
    if sessions is not None and len(df) > 0:
        covs = [c for c in SESSION_COVARIATES if c in sessions.columns]
        df = df.merge(sessions[['id'] + covs].rename(columns={'id': 'session_id'}), on='session_id', how='left')
        if 'os_version' in df.columns:
            # iPhones and Android phones have different mics/IMUs, so platform is a moderator
            df['platform'] = df['os_version'].map(platform_of)

    # Convert boolean music_detected to int
    if 'music_detected' in df.columns:
        df['music_detected'] = df['music_detected'].map({True: 1, False: 0, 'True': 1, 'False': 0})

    return df


def compute_correlations(paired: pd.DataFrame):
    """Compute per-signal Pearson and Spearman correlations with subjective rating."""
    signals = SIGNALS

    print("\n" + "=" * 90)
    print("PER-SIGNAL CORRELATION WITH SUBJECTIVE RATING")
    print("=" * 90)
    print(f"{'Signal':<32} {'Pearson r':>10} {'p-value':>10} {'Spearman ρ':>10} {'p-value':>10} {'N':>5}")
    print("-" * 90)

    results = []
    for signal in signals:
        if signal not in paired.columns:
            continue
        valid = paired[['rating', signal]].dropna()
        n = len(valid)

        if n < 5:
            print(f"{signal:<32} {'N/A':>10} {'N/A':>10} {'N/A':>10} {'N/A':>10} {n:>5}")
            continue

        try:
            pearson_r, pearson_p = stats.pearsonr(valid['rating'], valid[signal].astype(float))
            spearman_r, spearman_p = stats.spearmanr(valid['rating'], valid[signal].astype(float))
        except Exception as e:
            print(f"{signal:<32} ERROR: {e}")
            continue

        results.append({
            'signal': signal,
            'pearson_r': pearson_r, 'pearson_p': pearson_p,
            'spearman_r': spearman_r, 'spearman_p': spearman_p,
            'n': n,
        })

        sig_marker = '***' if spearman_p < 0.001 else ('**' if spearman_p < 0.01 else ('*' if spearman_p < 0.05 else ''))
        print(f"{signal:<32} {pearson_r:>10.3f} {pearson_p:>10.4f} {spearman_r:>10.3f} {spearman_p:>10.4f} {n:>5} {sig_marker}")

    if not results:
        return pd.DataFrame(columns=['signal', 'pearson_r', 'pearson_p', 'spearman_r', 'spearman_p', 'n'])
    return pd.DataFrame(results).sort_values('spearman_r', ascending=False, key=abs)


def within_person(paired: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Centre rating and signals per device, so people who rate everything high (or dance
    a lot) don't drive the correlation. Witek 2014 shows large individual differences."""
    out = paired.copy()
    for c in ['rating'] + cols:
        if c in out.columns:
            vals = pd.to_numeric(out[c], errors='coerce')
            out[c] = vals - vals.groupby(out['device_id']).transform('mean')
    return out


def _r2(y: np.ndarray, X: np.ndarray) -> float:
    X1 = np.column_stack([np.ones(len(y)), X])
    beta, *_ = np.linalg.lstsq(X1, y, rcond=None)
    resid = y - X1 @ beta
    ss_tot = ((y - y.mean()) ** 2).sum()
    return 1 - (resid ** 2).sum() / ss_tot if ss_tot > 0 else np.nan


def headline_tests(paired: pd.DataFrame):
    """The research questions, in evidence order, on within-person centred data:
    1. movement energy → rating
    2. crowd sync → rating beyond movement energy (person ↔ person)
    3. beat locking → rating beyond movement energy (person ↔ music)"""
    print("\n" + "=" * 60)
    print("HEADLINE TESTS (within-person)")
    print("=" * 60)
    if 'device_id' not in paired.columns or len(paired) == 0:
        print("  No paired data.")
        return
    wp = within_person(paired, ['movement_energy', 'crowd_sync', 'beat_plv'])

    sub = wp[['rating', 'movement_energy']].dropna()
    if len(sub) >= 5:
        r, p = stats.spearmanr(sub['rating'], sub['movement_energy'])
        print(f"\n1. movement_energy → rating:  ρ={r:.3f} (p={p:.4f}, n={len(sub)})")
    else:
        print(f"\n1. movement_energy → rating:  insufficient data (n={len(sub)})")

    for i, extra in [(2, 'crowd_sync'), (3, 'beat_plv')]:
        sub = wp[['rating', 'movement_energy', extra]].dropna()
        if len(sub) < 8:
            print(f"{i}. {extra} beyond movement_energy: insufficient data (n={len(sub)})")
            continue
        y = sub['rating'].to_numpy(float)
        base = _r2(y, sub[['movement_energy']].to_numpy(float))
        full = _r2(y, sub[['movement_energy', extra]].to_numpy(float))
        r, p = stats.spearmanr(sub['rating'], sub[extra])
        print(f"{i}. {extra} beyond movement_energy: ΔR²={full - base:+.3f}  "
              f"(alone ρ={r:.3f}, p={p:.4f}, n={len(sub)})")


def moderators(paired: pd.DataFrame):
    """Does the signal work differently by platform, phone placement or dance affinity?"""
    print("\n5. Moderators (Spearman ρ with rating):")
    if 'platform' in paired.columns:
        counts = paired['platform'].value_counts().to_dict()
        print(f"   ratings by platform: {counts}")
    for col in ['movement_energy', 'beat_plv', 'avg_db', 'computed_vibe_score']:
        if col not in paired.columns:
            continue
        for group_col, label in [('platform', 'platform'), ('phone_placement', 'placement')]:
            if group_col not in paired.columns:
                continue
            for value, g in paired.groupby(group_col):
                sub = g[['rating', col]].dropna()
                if len(sub) >= 5:
                    r, _ = stats.spearmanr(sub['rating'], sub[col])
                    print(f"   {col:<20} {label}={value:<8} ρ={r:.3f} (n={len(sub)})")
        if col in ('movement_energy', 'beat_plv') and 'dance_affinity' in paired.columns:
            aff = pd.to_numeric(paired['dance_affinity'], errors='coerce')
            for label, mask in [('dancers (4–5)', aff >= 4), ('non-dancers (1–3)', aff <= 3)]:
                sub = paired.loc[mask, ['rating', col]].dropna()
                if len(sub) >= 5:
                    r, _ = stats.spearmanr(sub['rating'], sub[col])
                    print(f"   {col:<20} {label:<18} ρ={r:.3f} (n={len(sub)})")


def print_key_findings(paired: pd.DataFrame, results: pd.DataFrame):
    print("\n" + "=" * 60)
    print("KEY FINDINGS")
    print("=" * 60)

    # 1. Composite score
    composite = paired[['rating', 'computed_vibe_score']].dropna()
    if len(composite) >= 5:
        r, p = stats.spearmanr(composite['rating'], composite['computed_vibe_score'])
        passed = "✓ PASS" if abs(r) >= 0.5 else "✗ FAIL"
        print(f"\n1. Composite vibe score correlation: ρ={r:.3f} (p={p:.4f}, n={len(composite)})")
        print(f"   {passed} — threshold r ≥ 0.5")

    # 2. BPM value add
    with_bpm = paired[paired['estimated_bpm'].notna()]
    without_bpm = paired[paired['estimated_bpm'].isna()]
    if 'computed_energy_score' in paired.columns:
        valid = with_bpm[['rating', 'computed_energy_score']].dropna()
        if len(valid) >= 5:
            r_with, _ = stats.spearmanr(valid['rating'], valid['computed_energy_score'])
            print(f"\n2. Energy score (when BPM detected):  ρ={r_with:.3f} (n={len(valid)})")
    if len(without_bpm) >= 5 and 'avg_db' in paired.columns:
        valid = without_bpm[['rating', 'avg_db']].dropna()
        if len(valid) >= 5:
            r_without, _ = stats.spearmanr(valid['rating'], valid['avg_db'])
            print(f"   dB alone (no BPM):                ρ={r_without:.3f} (n={len(valid)})")

    # 3. Top signals
    if len(results) > 0:
        print(f"\n3. Top 5 signals by |Spearman ρ|:")
        for _, row in results.head(5).iterrows():
            sig = '***' if row['spearman_p'] < 0.001 else ('**' if row['spearman_p'] < 0.01 else ('*' if row['spearman_p'] < 0.05 else ''))
            print(f"   {row['signal']:<32} ρ={row['spearman_r']:.3f} {sig}")


def segment_by_venue_type(paired: pd.DataFrame, sessions: pd.DataFrame):
    if 'session_id' not in paired.columns or 'venue_type' not in sessions.columns:
        return

    merged = paired.merge(sessions[['id', 'venue_type']], left_on='session_id', right_on='id', how='left')

    print(f"\n4. Correlation by venue type:")
    for vtype in merged['venue_type'].dropna().unique():
        subset = merged[merged['venue_type'] == vtype][['rating', 'computed_vibe_score']].dropna()
        if len(subset) >= 3:
            r, p = stats.spearmanr(subset['rating'], subset['computed_vibe_score'])
            print(f"   {str(vtype):<20} ρ={r:.3f}  (n={len(subset)})")


def go_no_go_summary(results: pd.DataFrame, paired: pd.DataFrame):
    print("\n" + "=" * 60)
    print("GO / NO-GO SUMMARY")
    print("=" * 60)

    composite = paired[['rating', 'computed_vibe_score']].dropna()
    if len(composite) >= 5:
        r, _ = stats.spearmanr(composite['rating'], composite['computed_vibe_score'])
        sig_signals = results[abs(results['spearman_r']) >= 0.3]['signal'].tolist() if len(results) > 0 else []

        if abs(r) >= 0.5:
            print(f"\n→ GO: Composite r={r:.3f} exceeds threshold")
        elif abs(r) >= 0.3:
            print(f"\n→ PARTIAL: Composite r={r:.3f} — some signals work, needs refinement")
        else:
            print(f"\n→ NO-GO: Composite r={r:.3f} — no meaningful correlation detected")

        print(f"\nSignals with |ρ| ≥ 0.3: {sig_signals}")
    else:
        print(f"\n→ INSUFFICIENT DATA: Need at least 5 paired windows+ratings")
        print(f"   Current count: {len(composite)}")


def main():
    print("VibeMeter Correlation Analysis")
    print("Loading data...")

    try:
        windows, ratings, sessions = load_data()
    except FileNotFoundError as e:
        print(f"ERROR: Data files not found. Run fetch_data.py first.\n{e}")
        return

    print(f"Loaded: {len(windows)} windows, {len(ratings)} ratings, {len(sessions)} sessions")

    if len(ratings) < 5:
        print(f"\nWARNING: Only {len(ratings)} ratings — need at least 5 for meaningful analysis")

    paired = build_paired_dataset(windows, ratings, sessions)
    print(f"Paired dataset: {len(paired)} matched window-rating pairs")

    results = compute_correlations(paired)
    results.to_csv(OUTPUT_DIR / 'signal_correlations.csv', index=False)

    print_key_findings(paired, results)
    segment_by_venue_type(paired, sessions)
    headline_tests(paired)
    moderators(paired)
    go_no_go_summary(results, paired)

    print(f"\nResults saved to {OUTPUT_DIR}/signal_correlations.csv")


if __name__ == '__main__':
    main()
