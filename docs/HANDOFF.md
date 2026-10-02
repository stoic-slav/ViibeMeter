# Handoff: continue ViibeMeter work in a local session

Written at the end of a cloud session so a local (Mac) session can continue without the chat history.
**How the owner works:** they want Claude to drive end to end and give only minimal direction and oversight. Do the work, verify it, and report outcomes plainly, including failures. Ask only when a decision is genuinely theirs.

## Goal
Decide whether ViibeMeter is worth building out. The question is whether passive phone-sensor data (mic, motion, BLE) predicts how people rate the vibe at parties and clubs. Beat sync and crowd sync are the owner's central hypothesis: moving in sync with the music, and with each other, signals a high vibe.

## State
- **Merged:** PR https://github.com/stoic-slav/ViibeMeter/pull/1 was squash-merged into `master` (commit `70ce6ac`). Work from `master`; the old feature branch is finished.
- **Built and merged (not yet run on a real phone):**
  - gravity-free motion (`DeviceMotion`, vertical/horizontal split) and `movement_energy`;
  - audio and motion captured together each cycle, with `src/processing/BeatSync.ts` producing `beat_plv`, `beat_phase_mean` and `tempo_match`;
  - windows aligned to wall-clock minutes, an optional event code, one-time dance affinity, and per-session phone placement;
  - fixes for uploads that dropped the 6 FFT metrics and for SQLite column migrations that never applied;
  - Android 12+ Bluetooth runtime permission, and a failed BLE scan now recorded as missing rather than 0 devices;
  - `analysis/crowd_sync.py`, within-person correlations, headline tests and moderators by platform, placement and dance affinity.
- **Beat sync, movement energy and crowd sync are collect-only.** They are not in the composite score until real data validates them.
- **Checks that passed:** `npx tsc --noEmit`, BeatSync and `crowd_sync.py --selftest` on synthetic data, and the analysis end to end on synthetic data.
- **Not verified:** anything on a real iPhone or Android phone. The first job is to run the four tests below.

## Supabase
- **Project `VibeMeter`, id `fjbqyoulfihewafdkkvt`, region eu-west-3.** It was paused and has been restored. Free-tier projects pause again when idle.
- The sync_signals migration (`20261002000000_sync_signals.sql`) is applied. The two earlier dashboard-only migrations are now committed to the repo.
- **Existing rows are probably not real field data** (27 sessions, 149 windows, 16 ratings from 3 iPhones, May 17–23). The owner said purging is wanted. Deletes through the MCP SQL tool timed out repeatedly (probably an approval prompt). The owner can run `truncate table public.subjective_ratings, public.sensor_windows, public.sessions;` in the Supabase SQL editor. Do not spend long on it. A pre-purge backup exists only in the old cloud container.
- The old data has no FFT, movement-energy or beat-sync values.

## Do next, in order
1. **Get the code on the Mac and onto the phone.**
   - `git checkout master && git pull`
   - `cd vibemeter-app && npm install`
   - From the repo root, run `bash deploy.sh`. It swaps the JS bundle into the existing Xcode build and needs `ios-deploy`, `idevicedebug` and a native Xcode build already in DerivedData. If `VibeMeter.app` isn't found, do the full `xcodebuild` build from the README first.
   - **Never run `npx expo prebuild --clean`.** It wipes the local iOS build patches (Podfile, `fmt/base.h`, entitlements).
2. **Run the four device tests** (steady ~120 BPM track played aloud from a speaker, phone in pocket, event code `TEST1`):
   - on beat for 2–3 min → Beat Sync should go above ~0.65;
   - off beat → about 0.3 or below;
   - standing still → low movement energy, "NO BEAT" or low sync;
   - keep the session going about 6 min → data reaches Supabase.
3. **Verify uploads in Supabase** (`execute_sql`): `movement_energy`, `beat_plv`, `beat_phase_mean`, `tempo_match`, `pulse_clarity` and the FFT columns are non-null, and sessions carry `event_code`, `phone_placement` and `dance_affinity`. Fix whatever is off.
4. **Check Android** on one phone with the same tests (`eas build --platform android --profile preview`). Check that Bluetooth crowd counts appear on Android 12+, and whether long screen-off sessions get killed (it may need a foreground service).
5. **Apple Developer account** ($99/yr) is the owner's step: it enables TestFlight public links. After step 2 passes, walk them through `eas build --platform ios`, `eas submit`, a TestFlight group, and the Apple review (first build, ~1 day). Add a feedback email and a short privacy page.
6. **Big-event data collection:** 10–20 pre-recruited testers on iPhone and Android, all entering the same event code. That is the only way to get crowd sync (≥3 devices) and most of the ~150 labelled ratings needed.
7. **Analysis:** `fetch_data.py` reads at most 1,000 rows per table (needs pagination once data grows). Then run `correlations.py` and `crowd_sync.py`.

## Known caveats
- Motion now runs 6.5 s alongside every audio recording, so battery use is a bit higher.
- `app.json` has no `NSMotionUsageDescription`. The pedometer call is wrapped in try/catch, so it fails quietly if iOS denies it. This is unchecked.
- Android is untested in the field. All existing data is from iPhones.
- `app_version` is `0.2.0`, so data from the new motion pipeline can be told apart from old data.

## Research basis (why these signals)
Ranked by how directly each is tied to enjoyment. No paper proves any signal predicts a vibe rating, which is the gap this app tests.
- **Movement energy:** Martella et al. 2015 (accelerometer predicted enjoyment at ~90% balanced accuracy, 32 people). Witek et al. 2014 (wanting to move ≈ pleasure, r = .96).
- **Crowd sync:** Tarr et al. 2016 (synchronised dancing raises closeness). Ellamil et al. 2016 (club group synchrony measured with phones). Dotov et al. 2021. Bonding effect is small (Mogan 2017, r ≈ .17). Tschacher 2023 found no link to affect in seated classical concerts.
- **Beat lock:** Swarbrick et al. 2019 (indirect). It is also the input to crowd sync.
- **Music features:** Burger et al. 2013 and Ellamil et al. 2016 (pulse clarity, 100–150 BPM, spectral flux).
- **Only Witek 2014 and Ellamil 2016 were read in full.** The rest come from abstracts and summaries.
- **Not building:** audio entropy (poor predictor in Witek 2014), raw 3-axis magnitude as a rhythm source (worst in Ellamil 2016), syncopation estimation.

## Phase 2 backlog (lower evidence)
Hi-hat spectral flux (6.4–12.8 kHz) in `FFTProcessor.ts`, song popularity from Deezer rank via AudD (if AudD returns it), and whether to add beat sync to the composite score after validation.
