# Handoff: continue ViibeMeter work

Updated 2 October 2026 at the end of a local (Mac) session, so the next session can continue without the chat history.
**How the owner works:** they want Claude to drive end to end and give only minimal direction and oversight. Do the work, verify it, and report outcomes plainly, including failures. Ask only when a decision is genuinely theirs.

## Goal
Decide whether ViibeMeter is worth building out. The question is whether passive phone-sensor data (mic, motion, BLE) predicts how people rate the vibe at parties and clubs. Beat sync and crowd sync are the owner's central hypothesis: moving in sync with the music, and with each other, signals a high vibe.

## State

### Distribution (new this session)
- **Apple Developer Program is active** (individual, team `APRS7H5DD6`). The owner's iPhone is company-managed: **Developer Mode is off and must stay off**, so the only install route is **TestFlight**, which the company allows.
- **Bundle ID is now `com.leogerasimov.vibemeter`.** `com.vibemeter.app` was unavailable to our team. Do not change it again: it is tied to the App Store Connect record, certificates and TestFlight group. Android package is still `com.vibemeter.app` (no Play listing yet).
- **App Store Connect app:** name **ViibeMeter** (renamed by the owner), ASC app id `6818585201` (pinned in `eas.json`). TestFlight internal group "Team (Expo)" contains the owner.
- **ShazamKit App Service is enabled** on the app ID (owner did it in the developer portal).
- **EAS:** Expo account `stoicslav`, project `@stoicslav/vibemeter`. Supabase URL and anon key are EAS env vars (preview and production). `EXPO_PUBLIC_AUDD_TOKEN` is local `.env` only, so cloud builds have no AudD (fine: iOS uses ShazamKit).
- **iOS build 1 (v0.2.0)** built on EAS (`05e8db2d-…`) and was queued for TestFlight submission (`dd503dd5-…`). It contains commits up to `6701245` (audio fix + ShazamKit) but not the rename to ViibeMeter or the on-screen anonymous ID.
- **Android preview APK** (`faa6cbd2-…`) was queued on the EAS free tier for over an hour. It was uploaded before `.npmrc` was committed, so if it fails at `npm install`, rerun `eas build -p android --profile preview`.

### Code changes this session
- **Critical iOS fix:** in Expo SDK 54, `readAsStringAsync` from the root `expo-file-system` import always throws, so iOS never read the PCM. Every iOS window had FFT metrics of 0, no beat grid, and no beat sync. `AudioAnalyzer.ts` now imports `expo-file-system/legacy`. A follow-up stack overflow (`push(...220k samples)`) was also fixed. Verified in the simulator: PCM BPM and dB now come through.
- **Old Supabase data is affected by this bug.** The ~150 May windows have no valid FFT or beat data from iOS.
- Temporary WAV clips are now deleted after each analysis (they used to pile up in the cache).
- **ShazamKit:** local Expo module `vibemeter-app/modules/shazam-match` (Swift) matches the recorded clip. Only the fingerprint leaves the device. Deezer `track/isrc:` lookup adds tempo and popularity rank. AudD remains the fallback on Android when a token is set. Simulator returned ShazamKit error 202 before the App Service was enabled; unverified on a device.
- New collect-only window columns: `song_isrc`, `song_genre`, `song_bpm`, `song_popularity`, `recognition_source` (SQLite migration + Supabase migration `20261002163648_song_descriptors.sql`, applied).
- `app.json`: `NSMotionUsageDescription`, `ITSAppUsesNonExemptEncryption=false`, version 0.2.0, name ViibeMeter, honest microphone prompt. `eas.json`: remote app versioning with auto-increment.
- Home screen shows the anonymous device ID (needed for deletion requests in the privacy policy).
- `analysis/fetch_data.py` paginates past the 1,000-row cap (verified against live data: 29 sessions, 164 windows, 16 ratings).
- `docs/PRIVACY.md` (privacy policy) and a rewritten `TESTER_GUIDE.md`.

### Local build notes
- `pod install` needs `LANG=en_US.UTF-8` on this Mac (Ruby 4 encoding error otherwise).
- The pinned TypeScript 5.3.3 cannot parse Expo's `module: preserve`. Type-check with `npx -p typescript@5.9 tsc --noEmit`.
- The simulator build lives in `ios/build/sim`. The simulator uses the Mac's microphone, so the audio pipeline can be tested there; motion and BLE cannot.

## Supabase
- Project `VibeMeter`, id `fjbqyoulfihewafdkkvt`, eu-west-3. Free tier, pauses when idle.
- Schema matches every field the app uploads (checked this session).
- Rows to clean up: the May test data (owner wants it purged) and two simulator sessions from 2 Oct (`SIM TEST`, event code `SIMTEST`, and an "Unknown venue" one). **Ask before deleting.** The owner can run `truncate table public.subjective_ratings, public.sensor_windows, public.sessions;` in the SQL editor.

## Do next, in order
1. **Install from TestFlight** on the owner's iPhone once Apple finishes processing build 1.
2. **Run the four device tests** (steady ~120 BPM song from a speaker, phone in pocket, event code `TEST1`): on beat 2–3 min → Beat Sync above ~0.65; off beat → ~0.3 or below; standing still → low movement energy; keep going ~6 min so data reaches Supabase. Also check the song shows on the Music tab (ShazamKit).
3. **Verify uploads in Supabase:** `movement_energy`, `beat_plv`, `beat_phase_mean`, `tempo_match`, `pulse_clarity`, FFT columns and song columns non-null; sessions carry `event_code`, `phone_placement`, `dance_affinity`.
4. **Ship build 2** (`eas build -p ios --profile production --auto-submit`) with the rename and anonymous ID once the tests pass, plus any fixes.
5. **Publish the privacy policy:** use the GitHub URL in App Store Connect. Needed before external TestFlight (public link) testing, which also needs a feedback email and Apple beta review (~1 day).
6. **Android** on a friend's phone: same tests, BLE counts on Android 12+, and whether long screen-off sessions get killed (may need a foreground service).
7. **Big-event data collection:** 10–20 pre-recruited testers on one event code (crowd sync needs ≥3 devices; target ~150 labelled ratings).
8. **Analysis:** `fetch_data.py`, then `correlations.py` and `crowd_sync.py`.

## Known caveats
- Motion runs 6.5 s alongside every audio recording, so battery use is a bit higher.
- Android is untested in the field.
- `expo-av` and `expo-background-fetch` are deprecated in SDK 54 (warnings only). Migrating to `expo-audio` / `expo-background-task` is future work.

## Research basis (why these signals)
Ranked by how directly each is tied to enjoyment. No paper proves any signal predicts a vibe rating, which is the gap this app tests.
- **Movement energy:** Martella et al. 2015 (accelerometer predicted enjoyment at ~90% balanced accuracy, 32 people). Witek et al. 2014 (wanting to move ≈ pleasure, r = .96).
- **Crowd sync:** Tarr et al. 2016 (synchronised dancing raises closeness). Ellamil et al. 2016 (club group synchrony measured with phones). Dotov et al. 2021. Bonding effect is small (Mogan 2017, r ≈ .17). Tschacher 2023 found no link to affect in seated classical concerts.
- **Beat lock:** Swarbrick et al. 2019 (indirect). It is also the input to crowd sync.
- **Music features:** Burger et al. 2013 and Ellamil et al. 2016 (pulse clarity, 100–150 BPM, spectral flux).
- **Only Witek 2014 and Ellamil 2016 were read in full.** The rest come from abstracts and summaries.
- **Not building:** audio entropy (poor predictor in Witek 2014), raw 3-axis magnitude as a rhythm source (worst in Ellamil 2016), syncopation estimation.

## Phase 2 backlog (lower evidence)
Hi-hat spectral flux (6.4–12.8 kHz) in `FFTProcessor.ts`, whether track popularity (now collected) relates to ratings, and whether to add beat sync to the composite score after validation.
