"""
VibeMeter — Weight Optimization
Runs Ridge regression and Random Forest to find optimal signal weights.

Usage:
  python3 optimize_weights.py
"""

import pandas as pd
import numpy as np
from pathlib import Path
import warnings
warnings.filterwarnings('ignore')

DATA_DIR = Path(__file__).parent / 'data'
OUTPUT_DIR = Path(__file__).parent / 'output'
OUTPUT_DIR.mkdir(exist_ok=True)


def main():
    from sklearn.linear_model import Ridge
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.model_selection import cross_val_score
    from sklearn.preprocessing import StandardScaler
    from sklearn.metrics import r2_score
    from scipy import stats

    print("VibeMeter Weight Optimization")

    try:
        windows = pd.read_csv(DATA_DIR / 'sensor_windows.csv')
        ratings = pd.read_csv(DATA_DIR / 'ratings.csv')
        sessions = pd.read_csv(DATA_DIR / 'sessions.csv')
    except FileNotFoundError:
        print("ERROR: Run fetch_data.py first")
        return

    # Build paired dataset
    windows['window_start'] = pd.to_datetime(windows['window_start'])
    ratings['rated_at'] = pd.to_datetime(ratings['rated_at'])

    paired = []
    for _, rating in ratings.iterrows():
        sw = windows[windows['session_id'] == rating['session_id']].copy()
        if len(sw) == 0:
            continue
        diff = abs(sw['window_start'] - rating['rated_at'])
        nearest = sw.loc[diff.idxmin()]
        row = {'rating': rating['rating'], 'session_id': rating['session_id']}
        for col in ['avg_db', 'estimated_bpm', 'bass_presence', 'accel_magnitude_avg',
                    'accel_variance', 'ble_device_count', 'music_detected']:
            row[col] = nearest.get(col, np.nan)
        paired.append(row)

    df = pd.DataFrame(paired)
    df['music_detected'] = df['music_detected'].map({True: 1, False: 0, 'True': 1, 'False': 0, 1: 1, 0: 0})
    df['estimated_bpm'] = df['estimated_bpm'].fillna(0)

    FEATURES = ['avg_db', 'estimated_bpm', 'bass_presence', 'accel_magnitude_avg',
                'accel_variance', 'ble_device_count', 'music_detected']

    X_raw = df[FEATURES].fillna(0)
    y = df['rating']

    print(f"\nDataset: {len(df)} samples, {X_raw.shape[1]} features")

    if len(df) < 10:
        print("WARNING: Very few samples — results will be unreliable")

    # Scale features
    scaler = StandardScaler()
    X = scaler.fit_transform(X_raw)

    # ── Ridge Regression ──────────────────────────────────────────────────────
    print("\n=== Ridge Regression (interpretable weights) ===")
    ridge = Ridge(alpha=1.0)
    ridge.fit(X, y)

    print(f"{'Feature':<30} {'Coefficient':>12}")
    print("-" * 44)
    for feat, coef in sorted(zip(FEATURES, ridge.coef_), key=lambda x: abs(x[1]), reverse=True):
        print(f"{feat:<30} {coef:>12.4f}")

    y_pred = ridge.predict(X)
    r2 = r2_score(y, y_pred)
    print(f"\nIn-sample R²: {r2:.4f}")

    # Cross-validated R² (if enough data)
    if len(df) >= 10:
        cv_scores = cross_val_score(ridge, X, y, cv=min(5, len(df) // 2), scoring='r2')
        print(f"Cross-validated R²: {cv_scores.mean():.4f} (±{cv_scores.std():.4f})")

    # ── Random Forest ─────────────────────────────────────────────────────────
    print("\n=== Random Forest Feature Importance ===")
    rf = RandomForestRegressor(n_estimators=100, max_depth=4, random_state=42)
    rf.fit(X_raw, y)

    print(f"{'Feature':<30} {'Importance':>10}")
    print("-" * 42)
    for feat, imp in sorted(zip(FEATURES, rf.feature_importances_), key=lambda x: x[1], reverse=True):
        print(f"{feat:<30} {imp:>10.4f}")

    # ── Suggested vibe score weights ──────────────────────────────────────────
    print("\n=== Suggested Weights for VibeScoreEngine ===")
    # Map raw signal importance to composite sub-score weights
    importance = dict(zip(FEATURES, rf.feature_importances_))

    energy_signals = ['avg_db', 'estimated_bpm', 'bass_presence']
    music_signals = ['music_detected', 'estimated_bpm', 'bass_presence']
    movement_signals = ['accel_magnitude_avg', 'accel_variance']
    density_signals = ['ble_device_count']

    def group_importance(signals):
        return sum(importance.get(s, 0) for s in signals) / len(signals)

    weights = {
        'energy': group_importance(energy_signals),
        'music': group_importance(music_signals),
        'movement': group_importance(movement_signals),
        'density': group_importance(density_signals),
    }
    total = sum(weights.values())
    weights = {k: v / total for k, v in weights.items()}

    # Engagement has no direct feature — give it remaining weight
    for k, v in weights.items():
        print(f"  {k}: {v:.3f}")

    # Save results
    results = pd.DataFrame({
        'feature': FEATURES,
        'ridge_coef': ridge.coef_,
        'rf_importance': rf.feature_importances_,
    })
    results.to_csv(OUTPUT_DIR / 'weight_optimization.csv', index=False)
    print(f"\nResults saved to {OUTPUT_DIR}/weight_optimization.csv")


if __name__ == '__main__':
    main()
