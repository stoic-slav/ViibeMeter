# Plan: build 24. Night reminder and "Going out" standby

Status: planned 18 Oct 2026, not started. Owner agreed (18 Oct): build the standby as an opt-in on top of a weekend-night reminder; no GPS for detection; measure battery and false alarms on the first real nights before going further. Venue beacons are a separate idea for partner venues (`docs/ideas/venue-beacons.md`).

## Why
People forget to start a session when they arrive somewhere. Every forgotten night is lost data. The owner's idea: the phone notices it's at a party and asks "Start measuring?", turning passive sensing into an intentional session.

## What iOS allows (checked 18 Oct)
- **No app can listen while closed or suspended.** iOS also blocks switching the microphone on from the background. Android 11+ has the same rule for starting a microphone service.
- **No sound-based detection from a closed app:** motion history is recorded, but it doesn't wake the app (and there's no "dancing" class).
- **iOS 18's `AudioRecordingIntent`** lets an intent start recording, with a Live Activity required. Developers report it fails when the app isn't already in the foreground ([Apple forums 815725](https://developer.apple.com/forums/thread/815725)), so we don't rely on it.
- **What does work (verified in build 23):** once the app is running with the microphone open, a lock-screen card button can start things without unlocking. So the user switches standby on once in the evening (one app open), and from then on it's hands-free.

## What the user sees
1. **Weekend-night reminder** (opt-in, asked once after a first session):
   - "Out tonight? 🎶 Turn on Going out mode and we'll ask when it sounds like a party."
   - Times: Thursday, Friday and Saturday at 22:30 (Thursday is the big student night in Brussels). Days and time can be changed in Privacy & data → Reminders.
   - Tapping it opens the app on the Going out sheet.
2. **Going out mode (standby)**, opt-in with its own explanation the first time:
   - **The promise:** "Viibe Check listens on your phone for loud music with a beat. Nothing is recorded, stored or uploaded until you say yes. The orange microphone dot stays on while it's on."
   - **Switching it on:** a button on Home ("Going out tonight") or the reminder. One tap, then the app can go to the pocket.
   - **Lock-screen card while on standby:** "Standing by · we'll ask when it sounds like a party" with **[Turn off]**.
3. **When it sounds like a party:**
   - The phone buzzes and the card switches to "Sounds like a party. Start measuring?" **[Yes, start] [Not now]**. A notification with the same two buttons comes too, as backup.
   - **Yes** starts a normal session right there, without unlocking. The card becomes the session card (rating buttons, timer, STOP).
   - **Not now** keeps standby but stays quiet for 45 minutes.
4. **Venue:** with no GPS in the background, the venue starts blank. When the person next opens the app, the existing "Are you at X?" check runs (foreground, While Using), or they scan the venue QR.
5. **Standby ends by itself** at 06:00, after 6 hours, at battery ≤ 20%, or when the session it started ends.

## Detection rule ("sounds like a party"), first guesses to tune with real nights
- **When it checks:** every 30 s, one 5-second analysis: dB, sub-bass share, beat clarity. No song recognition, no clips, no windows.
- **A party minute:**
  - dB ≥ 75 (calibrated iOS offset);
  - music detected (beat clarity ≥ 0.3 or sub-bass share ≥ 0.25);
  - local time 21:00–06:00;
  - the phone not in a vehicle (iOS motion activity `automotive` excludes; Motion & Fitness permission is already asked).
- **Prompt:** when 5 of the last 6 minutes are party minutes. Movement is optional (people stand at the bar); it's logged for tuning.
- **Limits:** at most one prompt per 45 minutes, at most 4 per night.
- **Where the numbers live:** `STANDBY_*` in `src/config/constants.ts`.

## Data (to judge battery and false alarms)
- **New `standby_nights` table**, one row per standby, uploaded through a `SECURITY DEFINER` RPC like the others:
  - `device_id`, `armed_at`, `ended_at`, `end_reason`;
  - `prompts`, `accepted`, `declined`, `ignored`;
  - `battery_start_pct`, `battery_end_pct`, `party_minutes`;
  - nothing else: no audio, no per-minute values, no location.
- **`sessions.start_source`:** `manual` | `standby` | `reminder`. The analysis can then check whether sessions started from standby differ.
- **Retention:** 24 months, like sessions; included in `delete_my_data`.

## Technical design
1. **Standby service** `src/session/Standby.ts` (singleton): `arm()`, `disarm(reason)`, state, listeners.
   - **Microphone:** `AudioCapture.start` with a short buffer (6 s). `AudioAnalyzer.analyze` gains a lightweight mode with no Shazam and no bass-envelope storage.
   - **Motion:** a few seconds of motion per check through `MotionTracker`.
   - **Vehicle check:** a small native addition to `audio-capture` (or the live-activity module), `CMMotionActivityManager` → `automotive` yes/no.
2. **Handover to a session:** `SessionControl.startFromStandby()` reuses the open microphone. `SensorOrchestrator.startSession` must accept an already-running capture. Venue lookup is skipped in the background.
3. **One Live Activity across standby and session.** iOS doesn't allow requesting a new card from the background, so the standby card is updated into the session card.
   - The card state gains `mode` (`standby` | `prompt` | `session`) and `sessionStartedAt` (the timer moves from attributes into the state).
   - New buttons: `StartSessionIntent` and `NotNowIntent` (LiveActivityIntents, compiled into the app like `RateVibeIntent`). The card-action queue gets generalised from ratings to actions.
   - The card prompt uses ActivityKit's alert option (screen lights up, sound) in addition to the notification.
4. **Notification backup:** category `standby-prompt` with [Yes, start] (runs in the background, app already running) and [Not now].
5. **Weekend reminder:** `expo-notifications` weekly triggers for the chosen days and time; settings in SecureStore; a category whose action opens the app on the Going out sheet.
6. **Consent:**
   - Standby is its own opt-in, stored as `standbyAcceptedAt` in `Consent.ts`; no `CONSENT_VERSION` bump, so nobody re-consents for features they don't use.
   - Privacy & data screen: toggles for reminders and Going out mode.
   - `docs/PRIVACY.md` and `docs/DPIA.md`: the listening-on-standby purpose, what is computed and discarded, the orange dot.
7. **Android:** later. A microphone foreground service can only start while the app is visible, so the same "switch on once" pattern works with the existing `session-service`. Out of scope for build 24 (no Android device tested yet).

## Steps
1. Native:
   - card state with `mode` and `sessionStartedAt` (module + widget);
   - Start / Not now intents;
   - generalised action queue;
   - vehicle check.
2. `Standby.ts`, the lightweight analysis mode, the detection rule, auto-end rules.
3. Handover into a session (`startFromStandby`, orchestrator with a running capture), `start_source`.
4. UI:
   - Home "Going out tonight" button;
   - Going out sheet (first-time explanation);
   - Privacy & data toggles;
   - reminder settings.
5. Weekend reminder notifications.
6. Database: migration for `standby_nights`, `upload_standby_nights` RPC, `sessions.start_source`, retention and deletion. Apply it and commit it.
7. **Simulator test.** The simulator uses the Mac's microphone, so play music from the Mac:
   - quiet room → no prompt; music → prompt after ~5 min (thresholds lowered for the test);
   - Yes from the lock-screen card starts a session without unlocking;
   - Not now → quiet 45 min;
   - turning it off, 06:00 / 6 h end;
   - reminder fires (shortened trigger).
8. Docs: AGENTS.md, TESTER_GUIDE.md, PRIVACY.md, DPIA.md, HANDOFF.md.
9. Ask the owner before pushing and building.

## Effort
About 3–4 days of work, plus the privacy texts and one build.

## What to look at after the first real nights
- **Battery per hour on standby:** `standby_nights` battery columns. Target: under ~4%/h. If higher, check less often (every 60 s), or stop the analysis while the phone sits still and quiet.
- **False alarms:** prompts declined or ignored vs accepted, and where (bars with music, restaurants, cars).
- **Missed parties:** sessions started by hand while standby was on and silent.
- **Did it help?** Sessions per user per weekend night, before and after.
