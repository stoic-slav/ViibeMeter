# Plan: build 29. Quiet card, best moments (audio clips), swipe to delete

Status: built 24 Oct 2026; simulator-checked, not yet on a device or in TestFlight. Owner decisions (24 Oct): drop the 5-minute buzz by default (the next day's 👍/👎 is better research data); keep the lock-screen card but quiet, showing the live song, without the three vibe buttons; keep short audio clips of the best moments on the phone and replay them; do **both** phone-only and upload-to-server and see which fits best; run separation off the phone (server/own computer) plus the phone's own light clean-up as a comparable layer; ship everything as one build (29).

## What changed
- **Card:** venue, timer, STOP, `♪ song` (live from the orchestrator). `RateVibeIntent` and the card's rating fields removed.
- **Buzz:** off by default (`PromptSettings.ts`); toggle in privacy & data. The Meter's rate button stays.
- **Recap entrainment:** tempo multiples weigh by distance from the beat (`HARMONIC_WEIGHTS`: ×1 1.0, ×½ and ×2 0.9, ×¼ and ×3 0.6, ×4 0.5).
- **Swipe a past session to delete it** (phone and server).
- **Best moments:** see AGENTS.md "Best moments". Two opt-ins; 15 s clips, max 5 per night; 14 days; private bucket; `analysis/clip_enhance.py` compares layers.

## Why two routes for multi-phone audio
Merging overlapping clips from phones that heard the same moment needs the audio in one place. The phone-only route keeps the old rule (audio never leaves the phone) and is the baseline. The upload route enables merging (rustle and nearby voices are independent between phones, so a per-time-frequency median across aligned phones removes them) and the heavy separation model. After a night with several phones in one group, `clip_enhance.py --run` shows which layer is best by objective measures, by ear, and optionally by Shazam recognition. Decide from that whether the upload route earns its privacy cost.

## Privacy and legal
Recording a night out records bystanders who haven't consented. Mitigations (opt-ins, music-dominance filter, 15 s, 14 days, private storage, deletion everywhere) are in `docs/DPIA.md` rows "Audio clips" and "Bystander voices in clips"; legal review is an open item before the "send" switch is offered beyond friends.

## To verify on a real night
- Whether top-fifth moments and the music filter keep sensible clips (and not walking or pocket-rustle).
- Pocket audio quality: can Shazam name the cleaned/merged clips? (`--shazam`)
- Battery and CPU effect of cleaning (runs after the session, chunked).
- The first upload from a phone, and server deletion from the app.
- Debug (dev-client) builds crash at launch with the scene-lifecycle fix (`ExpoDevLauncher ... Cannot find the keyWindow`); test with Release builds or EAS builds.
