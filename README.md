# ViibeMeter

A sensor fusion experiment to validate whether passive phone sensor data can produce a reliable "vibe score" for social gatherings — without requiring any user input.

## What It Does

ViibeMeter is an iOS app (React Native / Expo) that silently collects ambient sensor data at venues and correlates it against subjective ratings to answer one question:

> Can phone sensor data objectively measure "vibe"?

If yes — there's a novel primitive here worth building a product around. If no — you've saved months of building the wrong thing.

## Signals Collected

| Signal | Source | What it proxies |
|--------|--------|-----------------|
| Ambient sound level (dB) | Microphone | Energy, crowd size, loudness |
| Audio classification (music y/n) | Microphone + spectral analysis | Music vs noise |
| BPM detection | Microphone + FFT | Music tempo and energy |
| Accelerometer magnitude | IMU | User movement / dancing |
| Gyroscope activity | IMU | Body movement patterns |
| BLE device count + trend | Bluetooth | Crowd density proxy |
| Dwell time | Session duration | How long user stays |
| Micro-prompt rating | User input (every 20-30 min) | Ground truth / training label |

## Why This Matters

Every existing nightlife app (VibeCheck, Vibe, Vibeo, Vibez) relies on manual check-ins and user-generated reviews. Nobody does passive sensor measurement. The difference between "someone typed 'great vibe' at 11pm" and "ambient data shows this venue peaked at 11:15pm and is now declining" is the difference between a review and a measurement.

## Stack

- **App:** React Native + Expo (managed → bare workflow)
- **Backend:** Supabase (PostgreSQL + real-time)
- **Analysis:** Python scripts (`analysis/` folder)
- **Platform:** iOS (iPhone)

## Project Structure

```
vibemeter-app/     # React Native app
  src/
    sensors/       # Sensor collection modules
    services/      # Supabase integration
analysis/          # Python data analysis scripts
PRD.md             # Full product requirements and hypothesis
PLAN.md            # Implementation plan
TESTER_GUIDE.md    # Guide for test participants
PROGRESS.md        # Build progress and known issues
```

## Building & Running

### Prerequisites
- Xcode 26+ with iOS 26 platform support
- CocoaPods (`brew install cocoapods`)
- Node.js + npm

### Build

```bash
cd vibemeter-app
npm install
npx expo prebuild
cd ios && pod install && cd ..
xcodebuild -workspace ios/VibeMeter.xcworkspace -scheme VibeMeter -configuration Debug \
  -destination "id=YOUR_DEVICE_UDID" \
  ENABLE_USER_SCRIPT_SANDBOXING=NO \
  build
```

### Known Issue: MDM-managed devices
If your iPhone is company MDM-managed, you won't be able to trust the personal developer certificate. Use a personal (non-MDM) iPhone and trust the profile under Settings → General → VPN & Device Management.

## Distributing to Testers

Because this app uses custom native modules (BLE scanning, raw audio, IMU), it cannot run in **Expo Go** — Expo's instant-share app only works with pure JavaScript apps that have no native code. Once `expo prebuild` is run, the app must be compiled into a real binary and distributed like any other app.

### Why `expo prebuild` matters
`expo prebuild` generates native `ios/` and `android/` project folders with actual native code (Swift, C++, Java). This is required to access low-level sensors like Bluetooth, raw microphone audio, and the IMU at the fidelity this experiment needs. The tradeoff: you lose Expo Go's instant QR-code distribution and must distribute a compiled binary instead.

---

### iOS — TestFlight (recommended, up to 10,000 testers)

1. Get an **Apple Developer account** ($99/year at developer.apple.com)
2. Install EAS CLI and build in the cloud (no Xcode required on tester machines):
   ```bash
   npm install -g eas-cli
   eas build --platform ios
   ```
3. Submit the build to TestFlight via App Store Connect
4. Share the public TestFlight link — testers tap it, install the TestFlight app, and install ViibeMeter. No cables, no certificate trust prompts, no MDM issues.

> **MDM note:** TestFlight bypasses the personal developer certificate issue entirely. MDM-managed iPhones can install TestFlight builds without any restrictions.

---

### Android — APK direct install (easiest path)

Android doesn't require a developer account for sideloading:

1. Build an APK:
   ```bash
   eas build --platform android --profile preview
   ```
2. Host the APK anywhere (Google Drive, Dropbox, direct link)
3. Testers enable "Install from unknown sources" on their phone and tap the link — done

Or use **Firebase App Distribution** (free) for a managed install link with version tracking.

---

### Summary

| Platform | Method | Requires |
|----------|--------|----------|
| iOS | TestFlight | Apple Developer account ($99/yr) |
| Android | APK link | Nothing — just enable unknown sources |
| Both | EAS Build | Free Expo account |

---

## Data Collection Strategy

### Start with DJ Bars / Nightclubs

Best signal, highest value, clearest labels.

- **BPM detection works best here** — electronic music is constant tempo (120-140 BPM), loud, dominant. Live bands and ambient crowd noise are much harder to extract BPM from.
- **Energy arc is pronounced** — venues go from quiet (10pm) to packed (midnight) to declining (2am). That arc is exactly what you want to model.
- **BLE density swings sharply** — you'll see the crowd filling up and emptying in the data.
- **Commercial value is highest** — this is where the "what's the vibe right now" question is worth the most.

Avoid starting with restaurants or casual bars — vibe variance is low and the audio environment is messy (multiple conversations, no dominant music source). Good as contrast later, not as primary signal.

---

### Session Length: Long Sessions Win

Prioritize **2-3 hour sessions** over many short ones.

The most valuable thing to capture is the **arc** — a venue filling up, peaking, and declining. A 20-minute session gives you a snapshot. A 3-hour session gives you a time series with real dynamics.

The micro-prompt ratings every 20-30 minutes are the training labels. A 3-hour session = ~6-8 labeled data points that are temporally correlated and capture *change* — far more informative than 6 snapshots from 6 different venues on 6 different nights.

Once you have 3-4 long sessions at the same venue type, start adding variety (different venues, different nights).

---

### Minimum Data for First Interesting Results

| Target | What you need |
|--------|--------------|
| First correlation signal | ~50 labeled samples |
| Publishable correlation | ~150-200 labeled samples |
| Simple regression model | ~200+ samples, 5+ testers |

A labeled sample = one micro-prompt rating with its associated sensor window.

**Rough math:**
- 3-hour session × rating every 25 min = ~7 labels per session
- 50 labels = ~7-8 sessions
- 150 labels = ~20-22 sessions

You can reach 50 labels in **2-3 weekends** with 3-4 active testers each doing one session per weekend night.

---

### Testers: At Least 5, Ideally 8-10

- Fewer than 5 testers = you're modeling individuals, not venues. One person's rating scale dominates.
- 5-8 testers = enough to average out personal rating bias and phone placement differences.
- **Critical:** testers at the **same venue at the same time** is the most powerful validation — if sensor readings match and three different people all rate it 8/10, that's real signal.

**Biggest confounders to control:**
- **Time of night** — almost all venues peak 11pm-1am regardless of actual vibe. Always log timestamps.
- **Phone placement** — pocket vs. table vs. hand kills accelerometer comparability. Standardize: always in pocket.
- **Tester state** — subjective ratings drift as people drink. Note session start time.

---

### Recommended Collection Plan

**Weeks 1-2:** 2-3 testers, same DJ bar/club, Friday and Saturday nights, full 2-3 hour sessions. Establish baseline. Check if BPM and dB correlate with ratings at all.

**Weeks 3-4:** Add 2-3 more testers. Try a second venue type (live music or busy cocktail bar). Start seeing cross-venue patterns.

**Weeks 5-6:** Run first correlation analysis. If dB + BLE count alone predict ratings at r > 0.5, you have something real. If not, look at which signals are flat.

**Decision point at ~100 samples:** Either the correlations are there and you build the model, or they're not and you've learned that cheaply. Either outcome is a win.

---

## The Fast Path: One Big Event

One well-organized multi-DJ night with pre-recruited testers can hit the entire 150-sample target in a single evening — weeks of casual collection compressed into one night.

### Why Multiple DJs Is Ideal

Each DJ set is a built-in controlled experiment:

- Different BPM range, different energy level, different crowd response per set
- Set transitions = natural energy dips then rebuilds — exactly the dynamics to model
- B2B sets or genre shifts give you 4-6 distinct labeled conditions in one night
- If 3 different DJs produce measurably different sensor readings that match ratings, that's strong validation

### Realistic Data Yield

| Testers | Session length | Ratings per tester | Total labeled samples |
|---------|---------------|-------------------|----------------------|
| 10 | 5 hrs | ~10 | 100 |
| 15 | 5 hrs | ~10 | 150 |
| 20 | 5 hrs | ~10 | 200 |

### The Key: Recruit Testers 48 Hours Before, Not at the Door

Getting strangers to install an app at a loud venue while drinking has ~10% success rate. Pre-recruited testers have 80%+. They install at home, show up, open the app. That's the entire ask.

- Post in local nightlife / music Facebook groups, Resident Advisor, Discord servers
- Pitch: "Help us build an app that measures venue energy — come to [event], install the app, rate the vibe every 30 min, free entry / drink ticket"
- Send a short voice note briefing the day before — less friction than written instructions
- Target people who are going out anyway. You're not changing their plans, just adding an app.

### Best Event Formats

**1. Piggyback on an existing warehouse or club night (easiest)**
Approach a promoter running a multi-DJ event. Pitch: *"We're running a tech experiment measuring crowd energy — we'll give you a full report showing exactly when your crowd peaked, which DJ set had the highest energy, how the night arc looked."* They get free analytics, you get a venue full of people and a reason to recruit testers. Promoters love this — makes them look innovative.

**2. Host your own small event (most control)**
Rent a small venue, 3-4 DJs, 50-100 people, recruit 15-20 as sensors. You control the schedule, DJ changeovers, and prompt timing. More effort to organize but maximum experimental control.

**3. Music festival (highest volume, hardest to execute)**
Multiple stages = multiple simultaneous BPM/energy readings. Testers moving between stages = cross-venue comparison within one event. Hard to partner with organizers but worth pursuing if you have the connections.

### What to Give the Venue/Promoter Afterward

A one-page report showing:
- Energy arc across the night (dB + movement over time)
- Which DJ set scored highest
- When the crowd peaked vs. when people started leaving (BLE count decline)
- Subjective ratings overlaid on sensor data

This is genuinely valuable to them and costs nothing to produce from the analysis scripts. It's also a live demo of what the product can eventually do commercially.

---

## Status

Build succeeds. App runs on personal iPhones. Data collection pipeline and Supabase integration complete. Analysis scripts ready.
