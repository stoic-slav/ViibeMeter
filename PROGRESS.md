# ViibeMeter — Build Progress

## Status: Build Complete, Install Blocked by MDM

---

## What's Done

### Environment Setup
- Xcode 26.4.1 installed and configured
- `xcode-select` pointed to `/Applications/Xcode.app/Contents/Developer`
- iOS 26.4 platform support installed in Xcode
- CocoaPods installed via Homebrew (v1.16.2)
- Developer Mode enabled on iPhone

### iOS Native Build
- `ios/` directory generated via `expo prebuild`
- CocoaPods installed (`pod install`) — 105 pods
- All compilation errors resolved (see Fixes Applied below)
- **BUILD SUCCEEDED** via:
  ```bash
  xcodebuild -workspace VibeMeter.xcworkspace -scheme VibeMeter -configuration Debug \
    -destination "id=CCC0C39E-81E7-58D6-805A-B7C3B154AB71" \
    ENABLE_USER_SCRIPT_SANDBOXING=NO \
    build
  ```

### Code Signing
- Apple ID: `leogerasimov@gmail.com` (Personal Team)
- Certificate: `Apple Development: leogerasimov@gmail.com (W6ML5Z2W9C)`
- Provisioning Profile: `iOS Team Provisioning Profile: com.vibemeter.app`
- Keychain access granted to codesign via:
  ```bash
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k YOUR_PASSWORD ~/Library/Keychains/login.keychain-db
  ```

### App Installation
- App successfully installed on iPhone (`com.vibemeter.app`)
- iPhone: `COPE-JK7K43C7YV` / `iPhone17,3` (iPhone 16)
- Device UDID: `CCC0C39E-81E7-58D6-805A-B7C3B154AB71`

---

## Current Blocker

iPhone is a **company MDM-managed device** — MDM policy prevents trusting personal developer certificates under Settings → General → VPN & Device Management. The app is installed but cannot be launched.

**Fix:** Use a non-MDM iPhone (personal device). Plug it in, run the build command above, trust the profile once → done.

---

## Fixes Applied to Codebase

These patches are already in place and should not need to be redone:

| File | Fix |
|------|-----|
| `ios/VibeMeter/VibeMeter.entitlements` | Removed `aps-environment` (Push Notifications) — not supported by free Personal Team |
| `ios/Pods/fmt/include/fmt/base.h` | Disabled `FMT_USE_CONSTEVAL` for all Apple Clang builds — broken in Clang 21 (Xcode 26) |
| `node_modules/react-native/scripts/react-native-xcode.sh` | Made `ip.txt` write non-fatal (`|| true`) — Xcode 26 sandbox blocks this write |
| `ios/Podfile` | Added `ENABLE_USER_SCRIPT_SANDBOXING=NO` post-install note — passed at build time |
| `node_modules/` | Cleared macOS quarantine attribute via `xattr -rd com.apple.quarantine` |

---

## Next Session: Picking Up

### If using a personal iPhone (fastest path)
1. Plug in personal iPhone via USB
2. Check device UDID:
   ```bash
   xcrun devicectl list devices
   ```
3. Run build (replace UDID if different):
   ```bash
   cd /Users/leogerasimov/Projects/ViibeMeter/vibemeter-app/ios
   xcodebuild -workspace VibeMeter.xcworkspace -scheme VibeMeter -configuration Debug \
     -destination "id=YOUR_DEVICE_UDID" \
     ENABLE_USER_SCRIPT_SANDBOXING=NO \
     build
   ```
4. On iPhone: Settings → General → VPN & Device Management → Trust "Leo Gerasimov"
5. App launches — done

### If keychain prompt appears again
```bash
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k YOUR_PASSWORD ~/Library/Keychains/login.keychain-db
```

---

## Suggested Next Steps (After App Launches)

1. **Verify sensors are collecting data** — check accelerometer, gyroscope, microphone (dB), BLE scan all fire on app open
2. **Check Supabase connection** — confirm sensor readings are being written to the DB (see `src/services/` and `.env` for credentials)
3. **Run a real session** — go somewhere with BLE devices nearby and let it collect for a few minutes
4. **Review analysis scripts** — `analysis/` folder has Python scripts (`correlations.py`, `fetch_data.py`) to process collected data
5. **Start iterating** — with hot reload working, JS/UI changes will reflect instantly without rebuilding

---

## Key Paths

| Thing | Path |
|-------|-------|
| App source | `vibemeter-app/src/` |
| Sensor code | `vibemeter-app/src/sensors/` |
| Xcode workspace | `vibemeter-app/ios/VibeMeter.xcworkspace` |
| Analysis scripts | `analysis/` |
| Build plan | `PLAN.md` |
| PRD | `PRD.md` |
