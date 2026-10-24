"""
Learn how to weigh the recap's signals from people's 👍/👎 (build 26+).

Every 👍/👎 on "Your night in songs" is uploaded with the signals that ranked the entry
(intensity, entrainment, persistence, lift, and from build 29 groove and carry; see
vibemeter-app/src/processing/NightRecap.ts). Answers from older builds have no groove/carry: they
are treated as not measured.
This script asks: which signals actually predict a 👍? It reports, per signal, how well it alone
separates 👍 from 👎, then fits a logistic regression that suggests new weights, with honest
uncertainty (cross-validation, per-person split). docs/feedback-learning.md explains what to do
with the result.

Usage (after fetch_data.py):
  python3 fit_recap_weights.py            # uses data/song_feedback.csv
  python3 fit_recap_weights.py --selftest # synthetic answers, checks the method
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

SIGNALS = ['intensity', 'entrainment', 'persistence', 'lift', 'groove', 'carry']   # groove, carry: build 29+
CURRENT = {'intensity': 0.30, 'entrainment': 0.27, 'persistence': 0.17, 'lift': 0.12, 'groove': 0.08, 'carry': 0.06}
MIN_ANSWERS = 100      # below this, report only; don't change the app's weights
MIN_PEOPLE = 10


def auc(y: np.ndarray, x: np.ndarray) -> float:
    """Probability that a random 👍 entry has a higher value than a random 👎 entry."""
    pos, neg = x[y == 1], x[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float('nan')
    greater = (pos[:, None] > neg[None, :]).mean()
    ties = (pos[:, None] == neg[None, :]).mean()
    return float(greater + 0.5 * ties)


def analyse(df: pd.DataFrame) -> dict:
    df = df.dropna(subset=['liked']).copy()
    df['y'] = df['liked'].astype(bool).astype(int)
    n, people = len(df), df['device_id'].nunique()
    print(f"{n} answers from {people} people · {df['y'].mean():.0%} 👍 · kinds: {df['kind'].value_counts().to_dict()}")

    print("\nEach signal alone (AUC: 0.5 = no better than chance, 1.0 = perfect):")
    single = {}
    for s in SIGNALS + ['score']:
        sub = df.dropna(subset=[s])
        a = auc(sub['y'].to_numpy(), sub[s].to_numpy()) if len(sub) else float('nan')
        single[s] = a
        print(f"  {s:12s} AUC {a:.2f}  (n={len(sub)}, missing {1 - len(sub) / n:.0%})")

    # Missing signals: fill with the mean and add a 'measured' flag, as the app renormalises
    X = pd.DataFrame(index=df.index)
    for s in SIGNALS:
        X[s] = df[s].fillna(df[s].mean() if df[s].notna().any() else 0.5)
        if df[s].isna().any():
            X[f'{s}_measured'] = df[s].notna().astype(int)
    y = df['y'].to_numpy()

    result = {'n': n, 'people': people, 'single_auc': single}
    if n < 20 or y.min() == y.max():
        print("\nNot enough varied answers to fit weights yet.")
        return result

    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import GroupKFold, cross_val_predict

    model = LogisticRegression(C=1.0, max_iter=1000)
    groups = df['device_id'].to_numpy()
    folds = min(5, people) if people >= 2 else 2
    # Split by person: the weights must work for people the model hasn't seen
    proba = cross_val_predict(model, X, y, cv=GroupKFold(n_splits=folds), groups=groups, method='predict_proba')[:, 1] \
        if people >= 2 else cross_val_predict(model, X, y, cv=folds, method='predict_proba')[:, 1]
    result['cv_auc'] = auc(y, proba)
    result['current_auc'] = single['score']
    model.fit(X, y)
    coefs = dict(zip(X.columns, model.coef_[0]))
    positive = {s: max(coefs[s], 0.0) for s in SIGNALS}
    total = sum(positive.values()) or 1.0
    suggested = {s: round(v / total, 2) for s, v in positive.items()}
    result['suggested'] = suggested

    print(f"\nCurrent score (app weights)      AUC {result['current_auc']:.2f}")
    print(f"Fitted model, new people (CV)     AUC {result['cv_auc']:.2f}")
    print("\nSignal        now   suggested   (logistic coefficient)")
    for s in SIGNALS:
        print(f"  {s:12s} {CURRENT[s]:.2f}   {suggested[s]:.2f}        ({coefs[s]:+.2f})")
    negatives = [s for s in SIGNALS if coefs[s] < 0]
    if negatives:
        print(f"\n⚠ Negative relation for {', '.join(negatives)}: higher values went with 👎. Look at these before trusting them.")
    ready = n >= MIN_ANSWERS and people >= MIN_PEOPLE and result['cv_auc'] > (result['current_auc'] or 0) + 0.02
    print("\n" + ("✓ Enough data and a clear gain: update RECAP.WEIGHTS in NightRecap.ts (see docs/feedback-learning.md)."
                  if ready else f"Keep the current weights for now (need ≥{MIN_ANSWERS} answers from ≥{MIN_PEOPLE} people and a clear gain)."))
    if max(single[s] for s in SIGNALS if not np.isnan(single[s])) < 0.6:
        print("No single signal separates 👍 from 👎 well (all AUC < 0.6): consider new measures (docs/feedback-learning.md).")
    return result


def selftest():
    rng = np.random.default_rng(1)
    rows = []
    for person in range(30):
        for _ in range(8):
            parts = {s: rng.uniform(0, 1) for s in SIGNALS}
            if person < 10:
                parts['groove'] = parts['carry'] = None   # answers from builds before 29
            # Ground truth for the test: entrainment matters most, lift not at all
            logit = 4 * (parts['entrainment'] - 0.5) + 2 * (parts['intensity'] - 0.5) + 1 * (parts['persistence'] - 0.5)
            liked = rng.uniform() < 1 / (1 + np.exp(-logit))
            if rng.uniform() < 0.2:
                parts['lift'] = None
            score = sum(CURRENT[s] * (parts[s] if parts[s] is not None else 0.5) for s in SIGNALS)
            rows.append({'device_id': f'p{person}', 'kind': 'song', 'liked': liked, 'score': score, **parts})
    r = analyse(pd.DataFrame(rows))
    ok = r['suggested']['entrainment'] > r['suggested']['lift'] and r['suggested']['entrainment'] >= r['suggested']['persistence']
    print('\nSelftest', 'passed' if ok else 'FAILED')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    path = Path(__file__).parent / 'data' / 'song_feedback.csv'
    if not path.exists():
        print(f"{path} not found: run fetch_data.py first.")
        sys.exit(1)
    analyse(pd.read_csv(path))
