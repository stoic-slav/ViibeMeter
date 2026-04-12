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
warnings.filterwarnings('ignore')

DATA_DIR = Path(__file__).parent / 'data'
OUTPUT_DIR = Path(__file__).parent / 'output'
OUTPUT_DIR.mkdir(exist_ok=True)


def load_data():
    windows = pd.read_csv(DATA_DIR / 'sensor_windows.csv')
    ratings = pd.read_csv(DATA_DIR / 'ratings.csv')
    sessions = pd.read_csv(DATA_DIR / 'sessions.csv')

    # Parse timestamps
    windows['window_start'] = pd.to_datetime(windows['window_start'])
    ratings['rated_at'] = pd.to_datetime(ratings['rated_at'])

    return windows, ratings, sessions


def build_paired_dataset(windows: pd.DataFrame, ratings: pd.DataFrame) -> pd.DataFrame:
    """For each rating, find the nearest sensor window."""
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

        for col in [
            'avg_db', 'max_db', 'db_variance',
            'music_detected', 'estimated_bpm', 'bass_presence', 'mid_high_ratio',
            'accel_magnitude_avg', 'accel_variance', 'gyro_activity_avg',
            'ble_device_count', 'ble_count_delta',
            'screen_off_ratio',
            'computed_energy_score', 'computed_density_score',
            'computed_movement_score', 'computed_music_score', 'computed_vibe_score',
        ]:
            row[col] = nearest.get(col, np.nan)

        paired.append(row)

    df = pd.DataFrame(paired)

    # Convert boolean music_detected to int
    if 'music_detected' in df.columns:
        df['music_detected'] = df['music_detected'].map({True: 1, False: 0, 'True': 1, 'False': 0})

    return df


def compute_correlations(paired: pd.DataFrame):
    """Compute per-signal Pearson and Spearman correlations with subjective rating."""
    signals = [
        'avg_db', 'max_db', 'db_variance',
        'music_detected', 'estimated_bpm', 'bass_presence', 'mid_high_ratio',
        'accel_magnitude_avg', 'accel_variance', 'gyro_activity_avg',
        'ble_device_count', 'ble_count_delta',
        'screen_off_ratio',
        'computed_energy_score', 'computed_density_score',
        'computed_movement_score', 'computed_music_score', 'computed_vibe_score',
    ]

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

    return pd.DataFrame(results).sort_values('spearman_r', ascending=False, key=abs)


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
    if len(with_bpm) >= 5 and 'computed_energy_score' in paired.columns:
        r_with, _ = stats.spearmanr(with_bpm['rating'], with_bpm['computed_energy_score'].dropna())
        print(f"\n2. Energy score (when BPM detected):  ρ={r_with:.3f} (n={len(with_bpm)})")
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

    paired = build_paired_dataset(windows, ratings)
    print(f"Paired dataset: {len(paired)} matched window-rating pairs")

    results = compute_correlations(paired)
    results.to_csv(OUTPUT_DIR / 'signal_correlations.csv', index=False)

    print_key_findings(paired, results)
    segment_by_venue_type(paired, sessions)
    go_no_go_summary(results, paired)

    print(f"\nResults saved to {OUTPUT_DIR}/signal_correlations.csv")


if __name__ == '__main__':
    main()
