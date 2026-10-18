# Plan: build 23. Rating buttons in a lock-screen Live Activity

Status: planned 18 Oct 2026, not started. Owner decisions (18 Oct): buttons always work, highlighted when a rating is due; the 5-minute vibrating notification stays; the Live Activity also shows session time + venue and a Stop button.

## Why
Rating from the lock screen today needs a long-press on the notification, which few people discover. Ratings per night are the scarcest data in Phase 1. A Live Activity (iOS 16.1+, interactive buttons on iOS 17+) keeps 💀 / 🙂 / 🔥 visible on the lock screen for the whole session: one tap, no unlock, no app opened.

## What the user sees
- **Session start:** a Live Activity appears on the lock screen (and in the Dynamic Island, compact: a dot + elapsed time).
- **Layout:** "Viibe Check · C12 · 1:24" (the time counts on its own, with no app updates) and three buttons 💀 Dead / 🙂 Decent / 🔥 Best.
- **Every 5 minutes:** the card switches to "How's the vibe right now?" with the buttons highlighted, and the existing notification still vibrates (unchanged).
- **After a tap:** "Thanks 🔥" for a few seconds, then back to normal; the notification is dismissed. A rating from the notification or the app updates the card the same way.
- **Stop:** a small "Stop" link opens the app (this needs Face ID or the passcode, which also guards against pocket taps) and asks "End this session?".
- **If the app was killed:** the card turns grey after 15 minutes without an update: "Not measuring. Open Viibe Check". People notice dead sessions instead of losing the night.
- **Session end** (Stop, auto-stop or deletion): the card disappears.
- **iOS 16.1–16.x:** the card shows without buttons; ratings use the notification. **Below 16.1, or Live Activities turned off:** nothing changes from build 22.

## Data
- **New `rating_source` value:** `live_activity`. There is no check constraint, so no change is needed.
- **New column `subjective_ratings.prompted`** (boolean): true when a prompt was waiting at the moment of the rating. Unprompted ratings (tapped any time) can then be analysed separately; they may be biased towards notable moments. Changes:
  - local SQLite migration;
  - `SubjectiveRating` type;
  - `SupabaseSync` payload;
  - `upload_ratings` RPC;
  - a Supabase migration.
- `response_time_ms` stays as today; it is 0 for unprompted ratings.
- **Every tap is recorded.** The analysis can drop a second tap within 15 s as a correction.

## Also in build 23: sessions that never end
If the app is killed during a session (swiped away, or closed by iOS), the session is never marked as ended. Five such sessions exist; one was deleted on 18 Oct at the owner's request.
- **Fix, on app launch:** if no session is running, every local session with no end is closed.
  - `ended_at` = the end of its last window, else its start;
  - `end_reason = 'interrupted'` (new; the `sessions_end_reason_check` constraint needs a migration);
  - then synced.
- Any Live Activity left over is ended.
- The four old open sessions on other phones close themselves when those phones next open a build-23 app.

## Technical design
1. **Widget extension target** with `@bacons/apple-targets` (v5, Expo ≥ 52).
   - Sources in `vibemeter-app/targets/live-activity/`; the plugin creates the target at prebuild time, which matches our local EAS builds (`ios/` is generated, not committed).
   - It also fills in EAS's `appExtensions`, so EAS creates the extension's bundle ID `com.leogerasimov.vibemeter.live-activity` and its provisioning profile.
   - No App Group is needed: the card gets everything through the activity's content state, and the button intent runs in the app's process.
2. **Info.plist:** `NSSupportsLiveActivities = true`. No push entitlement: the app updates the card locally, which works while the session's open microphone keeps the app running in the background.
3. **Local Expo module `modules/live-activity`** (iOS, Swift):
   - **JS functions:** `start({venue, startedAt})`, `update({venue, due, lastRating, thanksUntil})`, `end()`, `endAll()`, `getPendingRatings()`, and the event `onRating`.
   - **Shared types:** it defines `SessionActivityAttributes`; the widget has an identical copy, as the Expo Live Activity libraries do.
   - **Card lifetime:** `staleDate` is now + 15 min, renewed by a light update every 5 minutes, so a dead app shows the grey state.
4. **Button intent `RateVibeIntent: LiveActivityIntent`** (iOS 17). It needs a copy in the widget, to draw the buttons, and in the app, where the system runs it.
   - **What it does:** it saves the tap (value + time) in the app's UserDefaults queue and posts an in-process notification. The module then sends `onRating` to JS, or JS drains the queue when it starts.
   - **No session running** (the app was relaunched cold): the tap ends the card instead of recording.
   - **Risk to check first:** whether iOS finds an intent compiled into a CocoaPods module. If not, a config plugin (`plugins/withLiveActivityIntent.js`) adds the Swift file to the main app target, and the module listens for the notification.
5. **JS wiring:**
   - `SessionControl` / `SessionManager`: start the card at session start, end it in `stopEverything`.
   - `VibePrompt`: on prompt → `update({due: true})`; on any rating → `update({due: false, lastRating, thanksUntil})`; `onRating` → `recordRating(value, 'live_activity')`, with `prompted` taken from `pendingPrompt`.
   - The venue is updated when it is confirmed later (`setVenueIfMissing`).
6. **Stop link:** `vibemeter://stop` opens the app; `app/stop.tsx` (a hidden route like `join`) shows a confirm Alert, then `stopEverything('user')`.
7. **Platform:** Android has no equivalent; it keeps the notification buttons. Every call is a no-op off iOS or below 16.1.

## Steps
1. **Spike on the simulator** (iOS 26 runtime supports interactive Live Activities):
   - extension target + module + intent;
   - start a card, tap a button on the lock screen, see the event reach JS.
   - Decide the intent placement (risk above).
2. Card UI: the lock-screen layout, Dynamic Island compact/minimal/expanded, the due / thanks / stale states.
3. JS wiring, the `prompted` column, the `live_activity` source.
4. Orphan-session closing on launch + `interrupted` end reason.
5. **Migrations:**
   - `subjective_ratings.prompted`;
   - `upload_ratings` update;
   - `sessions_end_reason_check` + `interrupted`.
   - Apply them to the live project and commit them.
6. **Checks:**
   - `tsc`;
   - simulator: rate from the card (row in Supabase with `rating_source = live_activity`, correct `prompted`), the notification still fires, Stop link → confirm, kill the app → the card goes stale after 15 min, relaunch closes the session as `interrupted`.
7. Docs: AGENTS.md (module, extension, rating sources), TESTER_GUIDE.md, PRIVACY.md (nothing new is collected; mention the lock-screen card), HANDOFF.md.
8. **Owner, once:** sign in to Apple when EAS asks to create the extension's bundle ID and profile. Run `npx eas-cli credentials --platform ios` in a terminal, or answer the prompts of the first build run interactively. This is the only step that needs the owner.
9. **Build:** ask the owner before pushing, then the local build 23 → Transporter → add to the Public group.

## Not in build 23
- Live stats (dB, dancing) on the card: more updates and battery; maybe later.
- Push-started or server-updated Live Activities: not needed while the app runs all session.
- Android's equivalent (an ongoing notification with buttons already exists through the foreground service; buttons could be added later).
