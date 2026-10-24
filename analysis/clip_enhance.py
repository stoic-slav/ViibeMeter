"""
ViibeMeter: "best moment" clip enhancement and comparison (build 29).

Phones that opted in send ~15 s clips of the music at their strongest dancing moments to the
private `moments` bucket (raw as heard, and the phone's light clean-up). This script tries to make
them better and shows which route works best, layer by layer:

  1_raw             the clip as the phone heard it
  2_phone           the phone's own light clean-up (rustle bursts turned down)
  3_separated       voice/music separation (Demucs "no vocals" stem) of the raw clip   [needs demucs]
  4_phone_separated the same on the phone-cleaned clip                                 [needs demucs]
  5_merged_sum      phones that heard the same moment, aligned and averaged
  6_merged_median   the same, using the median across phones in every time-frequency cell
                    (cloth rustle and voices near one phone are not heard by the others)
  7_merged_separated the merged clip, then separated                                   [needs demucs]

Usage (from analysis/; SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment):
  python3 clip_enhance.py --fetch            download new clips into data/moments/
  python3 clip_enhance.py --run              build all layers for every clip and group
  python3 clip_enhance.py --run --shazam     also try to recognise each layer (pip install shazamio)
  python3 clip_enhance.py --sweep            delete expired clips from the server
  python3 clip_enhance.py --selftest         synthetic check of the alignment and merging

Only numpy and scipy are required; demucs (pip install demucs) and shazamio are optional.
Outputs go to output/moments/<group or clip id>/ with a layers.csv summary.
"""

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 44100
HERE = Path(__file__).parent
DATA = HERE / 'data' / 'moments'
OUT = HERE / 'output' / 'moments'

# ── audio helpers ────────────────────────────────────────────────────────────

def read_wav(path):
    sr, x = wavfile.read(str(path))
    if x.ndim > 1:
        x = x.mean(axis=1)
    if x.dtype == np.int16:
        x = x.astype(np.float64) / 32768.0
    else:
        x = x.astype(np.float64)
    if sr != SR:
        x = signal.resample_poly(x, SR, sr)
    return x


def write_wav(path, x):
    path.parent.mkdir(parents=True, exist_ok=True)
    x = np.asarray(x, dtype=np.float64)
    peak = np.max(np.abs(x)) if x.size else 0
    if peak > 0:
        x = x * (0.7 / peak)
    wavfile.write(str(path), SR, (np.clip(x, -1, 1) * 32767).astype(np.int16))


# ── alignment and merging ────────────────────────────────────────────────────

def gcc_phat_lag(ref, other, max_lag_s=8.0):
    """Samples by which `other` is later than `ref` (positive = other started later), by GCC-PHAT
    in the 100 Hz - 4 kHz band, plus the sharpness of the peak (peak / median)."""
    n = len(ref) + len(other)
    nfft = 1 << (n - 1).bit_length()
    A = np.fft.rfft(ref, nfft)
    B = np.fft.rfft(other, nfft)
    freqs = np.fft.rfftfreq(nfft, 1 / SR)
    R = np.conj(A) * B
    R /= np.maximum(np.abs(R), 1e-12)
    R[(freqs < 100) | (freqs > 4000)] = 0
    cc = np.fft.irfft(R, nfft)
    max_lag = int(max_lag_s * SR)
    cc = np.concatenate([cc[-max_lag:], cc[:max_lag + 1]])
    lags = np.arange(-max_lag, max_lag + 1)
    k = int(np.argmax(cc))
    sharp = cc[k] / (np.median(np.abs(cc)) + 1e-12)
    return int(lags[k]), float(sharp)


def align_to(ref, others, min_sharpness=20.0):
    """Cuts `ref` and each other clip to their common stretch. Returns (stack, lags, kept) where
    stack has one row per kept clip (ref first). Clips whose correlation peak is not sharp (a
    different place or song) are left out: white noise gives ~7, a real match 100+, so 20 is a
    first guess for noisy club recordings."""
    rows, lags, kept = [ref], [0], [0]
    for i, o in enumerate(others, start=1):
        lag, sharp = gcc_phat_lag(ref, o)
        if sharp < min_sharpness:
            continue
        rows.append(o)
        lags.append(lag)
        kept.append(i)
    if len(rows) == 1:
        return np.array([ref]), [0], [0]
    # lag > 0: the clip started later than ref, so its sample n matches ref sample n + lag
    starts = [max(0, l) for l in lags]       # where each clip's useful part starts (in its own samples)
    offs = [max(0, -l) for l in lags]        # how far the ref timeline must skip for it
    # common stretch on the reference timeline
    t0 = max(l for l in lags)                # latest start, in ref samples
    t0 = max(t0, 0)
    t1 = min(len(r) + l for r, l in zip(rows, lags))
    if t1 - t0 < SR * 3:
        return np.array([ref]), [0], [0]
    stack = np.stack([r[t0 - l:t1 - l] for r, l in zip(rows, lags)])
    return stack, lags, kept


def merge_sum(stack):
    """Average of the aligned clips, each scaled to the same RMS first (weights by how much each
    resembles the others on the bass band, where rustle doesn't reach)."""
    low = signal.sosfiltfilt(signal.butter(4, 300, 'low', fs=SR, output='sos'), stack, axis=1)
    mean_low = low.mean(axis=0)
    weights = []
    for row in low:
        c = np.corrcoef(row, mean_low)[0, 1]
        weights.append(max(c, 0.05) ** 2)
    weights = np.array(weights) / np.sum(weights)
    norm = stack / (np.sqrt(np.mean(stack ** 2, axis=1, keepdims=True)) + 1e-9)
    return np.sum(norm * weights[:, None], axis=0)


def merge_median(stack, nfft=2048):
    """Per time-frequency cell, the median magnitude across phones with the phase of the phones'
    average. A burst of rustle (or a voice) near one phone is an outlier in that cell and drops out."""
    norm = stack / (np.sqrt(np.mean(stack ** 2, axis=1, keepdims=True)) + 1e-9)
    f, t, Z = signal.stft(norm, fs=SR, nperseg=nfft, noverlap=nfft // 2, axis=1)   # (phones, f, t)
    med = np.median(np.abs(Z), axis=0)
    mean = Z.mean(axis=0)
    phase = mean / np.maximum(np.abs(mean), 1e-12)
    _, y = signal.istft(med * phase, fs=SR, nperseg=nfft, noverlap=nfft // 2)
    return y


# ── separation and recognition ───────────────────────────────────────────────

def have_demucs():
    try:
        import demucs  # noqa: F401
        return True
    except ImportError:
        return False


def separate_music(x):
    """Music-only stem of a clip with Demucs (voices removed). Returns None without demucs."""
    if not have_demucs():
        return None
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / 'in.wav'
        write_wav(src, x)
        out = Path(tmp) / 'out'
        subprocess.run([sys.executable, '-m', 'demucs', '--two-stems=vocals', '-o', str(out), str(src)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        stem = next(out.rglob('no_vocals.wav'))
        return read_wav(stem)


def recognise(path):
    """Track Shazam recognises in a file ('' if none), via shazamio. None if shazamio is missing."""
    try:
        import asyncio
        from shazamio import Shazam
    except ImportError:
        return None
    try:
        res = asyncio.run(Shazam().recognize(str(path)))
        track = res.get('track') or {}
        return track.get('key', '') and f"{track.get('subtitle', '?')} - {track.get('title', '?')}"
    except Exception:
        return ''


# ── objective measures per layer ─────────────────────────────────────────────

def measures(x):
    """Bass share (higher = more music-like) and share of treble bursts (lower = less rustle)."""
    f, t, Z = signal.stft(x, fs=SR, nperseg=2048, noverlap=1024)
    p = np.abs(Z) ** 2
    band = lambda lo, hi: p[(f >= lo) & (f < hi)].sum(axis=0)
    bass, hf, lf = band(40, 200), band(1500, 8000), band(0, 250)
    all_ = band(40, 8000).sum()
    n = len(hf)
    bursts = 0
    for i in range(n):
        lo, hi = max(0, i - 65), min(n, i + 66)
        base = np.percentile(hf[lo:hi], 85)
        if hf[i] > 6 * base and lf[i] < 1.5 * np.percentile(lf[lo:hi], 85):
            bursts += 1
    return {'bass_share': float(bass.sum() / all_) if all_ > 0 else 0.0, 'burst_share': bursts / max(n, 1)}


# ── server access ────────────────────────────────────────────────────────────

def api(path, method='GET', body=None, raw=False):
    base = os.environ['SUPABASE_URL'].rstrip('/')
    key = os.environ['SUPABASE_SERVICE_KEY']
    req = urllib.request.Request(base + path, method=method, data=body,
                                 headers={'Authorization': f'Bearer {key}', 'apikey': key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as r:
        data = r.read()
    return data if raw else json.loads(data or b'null')


def fetch():
    DATA.mkdir(parents=True, exist_ok=True)
    rows = api('/rest/v1/moment_clips?select=*&order=started_at')
    new = 0
    for r in rows:
        d = DATA / r['id']
        if (d / 'raw.wav').exists():
            continue
        d.mkdir(parents=True, exist_ok=True)
        for layer, name in (('raw', 'raw.wav'), ('clean', 'phone.wav')):
            try:
                data = api(f"/storage/v1/object/moments/{r['device_id']}/{r['id']}-{layer}.wav", raw=True)
                (d / name).write_bytes(data)
            except Exception as e:
                print(f"  {r['id']} {layer}: {e}")
        (d / 'meta.json').write_text(json.dumps(r))
        new += 1
    print(f'{len(rows)} clips on the server, {new} downloaded to {DATA}')


def sweep():
    now = np.datetime64('now')
    rows = api('/rest/v1/moment_clips?select=id,device_id,expires_at&expires_at=lt.' + urllib.parse.quote(str(now) + 'Z'))
    for r in rows:
        paths = [f"{r['device_id']}/{r['id']}-raw.wav", f"{r['device_id']}/{r['id']}-clean.wav"]
        api('/storage/v1/object/moments', method='DELETE', body=json.dumps({'prefixes': paths}).encode())
        api(f"/rest/v1/moment_clips?id=eq.{r['id']}", method='DELETE')
    print(f'{len(rows)} expired clips removed')


# ── grouping: clips of one moment heard by several phones ────────────────────

def load_clips():
    clips = []
    for d in sorted(DATA.glob('*/meta.json')):
        m = json.loads(d.read_text())
        base = d.parent
        m['dir'] = base
        m['t0'] = np.datetime64(m['started_at'].replace('Z', '')).astype('datetime64[ms]').astype(np.int64)
        m['t1'] = m['t0'] + m['duration_ms']
        clips.append(m)
    return clips


def group_clips(clips):
    """Clips from different devices, the same event code or venue, overlapping by 5 s or more."""
    groups, used = [], set()
    for i, a in enumerate(clips):
        if a['id'] in used:
            continue
        g = [a]
        for b in clips[i + 1:]:
            if b['id'] in used or b['device_id'] == a['device_id'] or any(b['device_id'] == x['device_id'] for x in g):
                continue
            same_place = (a.get('event_code') and a.get('event_code') == b.get('event_code')) or \
                         (a.get('venue_place_id') and a.get('venue_place_id') == b.get('venue_place_id'))
            if same_place and min(a['t1'], b['t1']) - max(a['t0'], b['t0']) >= 5000:
                g.append(b)
        if len(g) > 1:
            used.update(x['id'] for x in g)
            groups.append(g)
    return groups


# ── the run ──────────────────────────────────────────────────────────────────

def process_layers(layers, outdir, shazam, expected_isrc=None):
    """layers: ordered {name: samples or None}. Writes each, measures it, optionally recognises it."""
    rows = []
    for name, x in layers.items():
        if x is None:
            rows.append({'layer': name, 'status': 'skipped (demucs not installed)'})
            continue
        p = outdir / f'{name}.wav'
        write_wav(p, x)
        row = {'layer': name, 'status': 'ok', **measures(x)}
        if shazam:
            row['recognised'] = recognise(p)
        rows.append(row)
    outdir.mkdir(parents=True, exist_ok=True)
    keys = sorted({k for r in rows for k in r}, key=lambda k: (k != 'layer', k))
    with open(outdir / 'layers.csv', 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
    return rows


def show(title, rows):
    print(f'\n{title}')
    for r in rows:
        if r.get('status') != 'ok':
            print(f"  {r['layer']:<20} {r['status']}")
            continue
        extra = f"  recognised: {r['recognised']!r}" if 'recognised' in r else ''
        print(f"  {r['layer']:<20} bass share {r['bass_share']:.2f}   treble bursts {r['burst_share']:.2f}{extra}")


def run(shazam):
    clips = load_clips()
    if not clips:
        print('No clips yet: run --fetch first.')
        return
    OUT.mkdir(parents=True, exist_ok=True)
    for c in clips:
        raw = read_wav(c['dir'] / 'raw.wav')
        phone = read_wav(c['dir'] / 'phone.wav') if (c['dir'] / 'phone.wav').exists() else None
        layers = {
            '1_raw': raw, '2_phone': phone,
            '3_separated': separate_music(raw),
            '4_phone_separated': separate_music(phone) if phone is not None else None,
        }
        show(f"clip {c['id'][:8]} ({c.get('song_isrc') or 'song unknown'})", process_layers(layers, OUT / c['id'], shazam))
    for g in group_clips(clips):
        ref = read_wav(g[0]['dir'] / 'raw.wav')
        others = [read_wav(m['dir'] / 'raw.wav') for m in g[1:]]
        stack, lags, kept = align_to(ref, others)
        gid = 'group-' + g[0]['id'][:8]
        if len(stack) < 2:
            print(f'\n{gid}: the clips do not line up (different song or place); not merged')
            continue
        merged_sum, merged_med = merge_sum(stack), merge_median(stack)
        layers = {'1_best_single_raw': ref, '5_merged_sum': merged_sum, '6_merged_median': merged_med,
                  '7_merged_separated': separate_music(merged_med)}
        show(f'{gid}: {len(stack)} phones, lags {[round(l / SR * 1000, 1) for l in lags]} ms', process_layers(layers, OUT / gid, shazam))
    print(f'\nFiles are in {OUT}. Listen to them side by side; layers.csv has the numbers.')


# ── self-test ────────────────────────────────────────────────────────────────

def selftest():
    rng = np.random.default_rng(7)
    secs = 12
    t = np.arange(SR * secs) / SR
    beat = 60 / 124
    ph = (t % beat) / beat
    music = 0.6 * np.sin(2 * np.pi * (55 + 80 * np.exp(-ph * 30)) * t) * np.exp(-ph * 9) + 0.25 * np.sin(2 * np.pi * 48 * t)
    music += 0.08 * rng.standard_normal(len(t)) * np.exp(-((t % (beat / 2)) / (beat / 2)) * 25)
    music += 0.15 * np.sin(2 * np.pi * 440 * t) * (np.sin(2 * np.pi * 0.5 * t) > 0)     # a tonal part for alignment

    def phone(delay_ms, rustle, seed):
        r = np.random.default_rng(seed)
        x = np.roll(music, int(delay_ms / 1000 * SR)) * r.uniform(0.6, 1.2)
        x = signal.sosfilt(signal.butter(2, 3000, 'low', fs=SR, output='sos'), x)         # muffled by a pocket
        for b in range(rustle):
            s0 = r.integers(0, len(x) - SR // 8)
            n = SR // 12
            x[s0:s0 + n] += r.standard_normal(n) * 1.5 * np.exp(-np.arange(n) / (n / 3))
        return x + 0.02 * r.standard_normal(len(x))

    failed = 0

    def check(name, ok, detail=''):
        nonlocal failed
        print(('ok   ' if ok else 'FAIL ') + name + (f' ({detail})' if detail else ''))
        failed += 0 if ok else 1

    delays = [0, 23.5, -41.0, 77.0]
    phones = [phone(d, 10, 100 + i) for i, d in enumerate(delays)]
    stack, lags, kept = align_to(phones[0], phones[1:])
    est_ms = [l / SR * 1000 for l in lags]
    check('all four phones are aligned', len(stack) == 4, f'kept {kept}')
    # lag > 0 means the clip started later than the reference; our "delay" rolls the music later
    errs = [abs(est_ms[i] - (delays[i] - delays[0])) for i in range(1, len(est_ms))]
    check('delays found to within 1 ms', max(errs) < 1.0, f'errors {[round(e, 2) for e in errs]} ms')

    ref_low = signal.sosfiltfilt(signal.butter(4, 3000, 'low', fs=SR, output='sos'), music)

    def quality(x):
        n = min(len(x), len(ref_low))
        a = x[:n] / (np.std(x[:n]) + 1e-9)
        # compare after removing small offsets: best correlation over +-60 ms
        b = ref_low[:n] / np.std(ref_low[:n])
        cc = signal.correlate(a, b, mode='full', method='fft')
        mid = n - 1
        return float(np.max(cc[mid - 2646:mid + 2646]) / n)

    singles = [quality(p) for p in phones]
    msum, mmed = quality(merge_sum(stack)), quality(merge_median(stack))
    check('the median merge beats every single phone', mmed > max(singles), f'best single {max(singles):.3f}, median {mmed:.3f}')
    check('the plain sum is no worse than the average phone', msum > float(np.mean(singles)) - 0.02, f'average single {np.mean(singles):.3f}, sum {msum:.3f}')
    check('median merge beats the plain sum on burst noise', mmed > msum, f'sum {msum:.3f}, median {mmed:.3f}')
    check('median merge has fewer treble bursts than a single phone',
          measures(merge_median(stack))['burst_share'] <= measures(phones[0])['burst_share'])

    other_song = np.random.default_rng(3).standard_normal(len(t)) * 0.3
    stack2, _, kept2 = align_to(phones[0], [phones[1], other_song])
    check('a clip of a different sound is not merged in', kept2 == [0, 1], f'kept {kept2}')

    if failed:
        print(f'\n{failed} check(s) failed')
        sys.exit(1)
    print('\nAll checks passed.')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--fetch', action='store_true')
    ap.add_argument('--run', action='store_true')
    ap.add_argument('--shazam', action='store_true')
    ap.add_argument('--sweep', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if (a.fetch or a.sweep) and not (os.environ.get('SUPABASE_URL') and os.environ.get('SUPABASE_SERVICE_KEY')):
        sys.exit('ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY')
    if a.fetch:
        fetch()
    if a.run:
        run(a.shazam)
    if a.sweep:
        sweep()
    if not (a.fetch or a.run or a.sweep):
        ap.print_help()


if __name__ == '__main__':
    main()
