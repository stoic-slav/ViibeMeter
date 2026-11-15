# Plan: build 32. Start without remembering

Status: built 15 Nov 2026; checked in the simulator where possible; the arrival nudge is **not yet verified on a device**. Owner decisions (15 Nov): plan-ahead question at 19:00; express start (one tap, no screens); location may be off and the club can be added afterwards.

## The problem
The owner forgot to start a session at a rave. A night nobody started produces no recap, the day-zero value. Many people will forget.

## What iOS allows
- The microphone can only be started with the app in the foreground (Apple forums: starting a recording from the background fails with `cannotStartRecording`). So no fully automatic start; the best is one tap at the right time.
- Location-triggered local notifications (`UNLocationNotificationTrigger`) are watched by the system, fire with the app closed and need "While Using" location (Apple docs and forum answers; a tutorial disagrees about "Always", so test on a device). The app learns of an arrival only if the notification is tapped. The system limits how many places an app can watch (we use at most 15).

## Design
1. Fri/Sat 19:00 "Going out tonight?" (Yes / Not tonight).
2. Yes arranges: arrival nudges at nearby clubs (if location allowed) and "Still out?" at 23:30 and 01:00.
3. Tapping a nudge = express start. No questions; club from the arrival notification or filled in later.
4. Going out mode (standby, mic open, auto-detect) stays for people who want it fully automatic, and for parties at no known club.

## Not done / later
- Starting from the lock screen without unlocking (Live Activity or Control Center with an audio-recording intent): reported to fail from the background; worth a device test.
- Apple Watch: a workout-style session can run in the background and has a better dancing signal; a bigger build.
- Filtering karaoke bars and casinos out of the club list.

## To verify on a real night
- Does the arrival nudge fire when walking into the club (and how late)? Does it fire early, on the way past?
- Does a tap on a nudge from the lock screen start measuring (and the lock-screen card)?
- Battery: Going out standby for a whole night (separate question).
