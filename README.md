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

## Status

Build succeeds. App runs on personal iPhones. Data collection pipeline and Supabase integration complete. Analysis scripts ready.
