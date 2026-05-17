# ViibeMeter

Validate one hypothesis before building ViibeCheck:

> **Can phone sensor data produce a "vibe score" that reliably matches how people subjectively experience a social gathering?**

If yes — there's a novel primitive here worth building a product around. If no — you've saved months building the wrong thing. Every existing nightlife app (VibeCheck, Vibez, Vibeo, Vibes) relies on manual reviews and check-ins. None do passive sensor measurement. That's the gap.

---

## Signals Collected

### Active

| Signal | Source | What it proxies | Vibe value |
|--------|--------|-----------------|------------|
| Ambient sound level (dB) | Microphone | Energy, crowd size, loudness | **High** — strongest single predictor; loud = energy |
| Audio classification | Microphone + spectral analysis | Silent / talking / low music / high music / loud music | **High** — distinguishes dead venue from live one instantly |
| Song recognition | Microphone + AudD API | Track identity for context | **Medium** — enables genre/BPM lookup; enriches context |
| Music genre | Apple Music metadata via AudD | Genre for vibe segmentation | **Medium** — separates venue types (techno club vs jazz bar) |
| BPM | Deezer metadata via AudD | Music tempo (when song recognized) | **High** — fast tempo strongly correlates with high energy |
| Crowd event detection | Microphone | Clapping, cheering, DJ drops | **High** — peak-moment signal; captures crowd reactions |
| Accelerometer magnitude | IMU | User movement / dancing | **High** — dancing = high vibe; stationary = low vibe |
| Gyroscope activity | IMU | Body movement patterns | **Medium** — adds dimensionality to movement type |
| Movement BPM | IMU + autocorrelation | Rhythmic movement frequency (30–240 BPM) | **Medium** — rhythmic sync with music suggests engagement |
| Rhythmicity score | IMU | How periodic/consistent the movement is (0–1) | **Medium** — dancing is periodic; random jostling is not |
| Step cadence | Pedometer | Walking vs dancing vs stationary | **Low** — redundant with accelerometer; useful as a tie-breaker |
| Phase coherence | Audio + motion fusion | Whether body movement matches music BPM | **High** — user moving in sync with music = strong engagement signal |
| BLE device count + trend | Bluetooth | Crowd density proxy — filling / stable / thinning | **Medium** — density matters but noisy in crowded venues |
| Dwell time | Session duration | How long user stays | **Medium** — people stay longer at good venues; useful for session-level scoring |
| Micro-prompt rating | User input every 5 min | Ground truth — the training label | **Critical** — the target variable everything else is trained against |

### Planned improvements

**ShazamKit** (when Apple Developer account purchased — $99/yr, needed for TestFlight anyway):
- Replace AudD with Apple's native recognition framework
- Free, no rate limits, ~99%+ accuracy, 40M+ song catalog
- Returns `title`, `artist`, `genres`, `isrc`, `appleMusicID`
- Does not return BPM — keep Deezer lookup via ISRC after migration
- Package: `expo-shazamkit` · Entitlement: `com.apple.developer.shazamkit`

| | ShazamKit | AudD (current) |
|---|---|---|
| Cost | Free (included in dev account) | $5 / 1,000 requests |
| Rate limits | None documented | Hard quota on trial |
| Genre | Native `genres` field | Via Apple Music metadata |
| BPM | Not included | Via Deezer metadata |
| Speed | Native, no HTTP round-trip | ~300ms API call |

**Native PCM BPM module** (longer term):
- AudD/ShazamKit BPM only works for recognized tracks — DJ blends and live music get nothing
- Install `react-native-audio-record` to stream raw 16-bit PCM, run autocorrelation on-device
- Gives real-time BPM for any music, recognized or not
- Requires: `pod install` + `xcodebuild clean && xcodebuild build`

> **Important:** Any `npm install` touching native packages requires `xcodebuild clean` before the next native rebuild. Incremental builds cache stale ExpoModulesCore objects and cause a `NativeJSLogger` crash on boot.

### Planned signals (multi-device, server-side)

| Signal | Source | What it proxies | Vibe value |
|--------|--------|-----------------|------------|
| Crowd rhythmic alignment | Movement BPM across co-located devices | Fraction of nearby users moving at the same BPM as the music | **Critical** — the most novel signal in the stack |

**How it works:** Each device independently reports its movement BPM to Supabase. The analysis layer groups devices by venue and 1-minute window, then computes what fraction of them converge within ±5 BPM of each other (and of the recognized music BPM). A venue where 8 out of 10 devices are all moving at 128 BPM — the same as the DJ set — is objectively in a high-energy collective state. No single device can see this; it only emerges from multi-user data.

**Why it matters:** Single-device phase coherence (already collected) tells you whether *you* are dancing in sync with the music. Crowd alignment tells you whether *everyone around you* is. The latter is a fundamentally stronger vibe signal — and one that no competitor measuring individual behavior can replicate without a crowd of simultaneous users. It also gets more reliable as tester count grows, which creates a direct incentive to recruit more users.

**Implementation:** No app changes needed — movement BPM is already uploaded per window. Add a `crowd_alignment_score` column to the analysis output in `correlations.py`, computed as:
```
alignment = fraction of devices in window within ±5 BPM of median movement BPM
coherence = 1 if median movement BPM within ±8 BPM of music BPM, else 0
crowd_sync_score = alignment × coherence
```
Requires ≥3 simultaneous devices at the same venue to be meaningful.

---

## Scoring System

Each signal produces a 0–5 component score via piecewise linear curves defined in `src/config/constants.ts`. Composite = weighted sum:

| Component | Weight | Input signals |
|-----------|--------|--------------|
| Energy | 30% | Audio dB |
| Music | 25% | BPM + music detection |
| Movement | 20% | Accelerometer magnitude |
| Density | 15% | BLE device count |
| Engagement | 10% | Location transitions |

If a signal is unavailable its weight redistributes proportionally to present signals. A `confidence` field (0–1) tracks the fraction of signals used.

---

## Architecture

### Stack

- **App:** React Native + Expo (bare workflow after `expo prebuild`)
- **Sensors:** `expo-sensors` (IMU, pedometer), `expo-av` (microphone), `react-native-ble-plx` (BLE)
- **Backend:** Supabase (PostgreSQL)
- **Analysis:** Python scripts in `/analysis/`

### Data Flow

```
Session start → SensorOrchestrator (staggered: audio 2s, motion 5s, BLE 8s, GPS 10s)
  → 4 parallel collectors on timers
  → every 60s: SensorWindow aggregated + scored by VibeScoreEngine
  → written to SQLite (LocalBuffer, synced=0)
  → every 5 min: SupabaseSync batches unsynced rows → Supabase, marks synced=1
  → UI (meter.tsx) receives live updates via callback
  → every 5 min: VibePrompt fires micro-rating notification
  → Session end: SessionManager finalizes, final sync triggered
```

### Per-user Data Storage

Each device generates a random anonymous UUID on first launch (stored in iOS SecureStore). Every session and sensor window uploaded to Supabase is tagged with that `device_id`. No login, no name, no email — fully anonymous. Data queues locally when offline and uploads automatically when connectivity returns.

### Key Singleton Services

| Service | Purpose |
|---------|---------|
| `SensorOrchestrator` | Coordinates all sensors; exposes `setVibeUpdateCallback()` for UI |
| `SessionManager` | Session lifecycle: start, end, dwell-time |
| `LocalBuffer` | SQLite CRUD (sessions, windows, ratings — all with `synced` flag) |
| `SupabaseSync` | Retry-aware batch upload (3 attempts, exponential backoff) |
| `DeviceIdentity` | Persistent anonymous UUID via SecureStore |
| `VibePrompt` | Notification scheduling + rating recording |

---

## Privacy

- No audio ever recorded or stored — only computed metrics (dB level, BPM, classification)
- No GPS coordinates stored server-side — only session-level venue name and dwell time
- No Bluetooth device identities — only device count
- All raw sensor data stays on-device; only aggregated 1-minute windows are uploaded
- Users identified by anonymous device ID only

---

## Building & Running

```bash
cd vibemeter-app
npm install
npx expo prebuild          # generates ios/ and android/ (required once)
cd ios && pod install      # install native pods

# Build for device
xcodebuild -workspace ios/VibeMeter.xcworkspace -scheme VibeMeter \
  -configuration Debug \
  -destination "id=YOUR_DEVICE_UDID" \
  ENABLE_USER_SCRIPT_SANDBOXING=NO build

# JS-only changes (fast deploy without full rebuild)
bash ../deploy.sh
```

### Environment

Create `vibemeter-app/.env`:
```
EXPO_PUBLIC_SUPABASE_URL=<project>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
EXPO_PUBLIC_AUDD_TOKEN=<token>
```

### iOS Build Quirks

These patches are already applied — do not revert:

| File | Fix |
|------|-----|
| `ios/Podfile` | `ENABLE_USER_SCRIPT_SANDBOXING=NO` required |
| `ios/Pods/fmt/base.h` | `FMT_USE_CONSTEVAL` disabled for Xcode 26 / Clang compatibility |
| `ios/VibeMeter/VibeMeter.entitlements` | APS push removed (Personal Team signing) |
| `react-native/scripts/react-native-xcode.sh` | `ip.txt` write made non-fatal |

### Cloud Build (for TestFlight)

```bash
eas build --platform ios
```

---

## Distributing to Testers

This app uses native modules (BLE, raw microphone, IMU) and cannot run in Expo Go. It must be distributed as a compiled binary.

### TestFlight + QR Code (recommended)

Requires Apple Developer account ($99/yr — also needed for ShazamKit).

1. Build with EAS: `eas build --platform ios`
2. Submit to TestFlight via App Store Connect
3. Create a Public Link under TestFlight → your app → Public Link
4. Turn that URL into a QR code (any free generator)

**Tester flow:** scan QR → Safari opens TestFlight link → install TestFlight (free, ~30s) → tap "Start Testing" → app installs. No account creation required from testers. Up to 10,000 testers, builds valid for 90 days.

### Direct install via Xcode (free, no developer account)

For 1–3 testers you can physically reach. Signs with your personal Apple ID (free tier). App re-signs itself every 7 days — requires reconnecting to reinstall.

### Android

```bash
eas build --platform android --profile preview
```
Host the APK on Google Drive or use Firebase App Distribution (free). Testers enable "Install from unknown sources" and tap the link.

---

## Data Collection Strategy

### Where to collect

Start at **DJ bars and clubs** — best signal, clearest labels, most pronounced energy arc.

- BPM detection works best with electronic music (constant 120–140 BPM)
- Energy arc is pronounced: quiet at 10pm → packed at midnight → declining at 2am
- BLE density swings sharply as crowd fills and empties

Avoid restaurants and casual bars first — vibe variance is low, audio environment is messy.

### Session length

Prioritize **2–3 hour sessions** over many short ones. The most valuable thing to capture is the arc — filling, peaking, declining. At 5-min prompt intervals, a 3-hour session generates ~36 labeled data points.

### Minimum data targets

| Target | What you need |
|--------|--------------|
| First correlation signal | ~50 labeled samples |
| Publishable correlation | ~150–200 labeled samples |
| Simple regression model | ~200+ samples, 5+ testers |

At 5-min prompts, 2 testers doing one 3-hour session = ~72 labels. You can hit 150 in a single good weekend.

### The fast path — one big event

One multi-DJ night with 10–20 pre-recruited testers can hit the entire 150-sample target in one evening. Each DJ set is a controlled experiment: different BPM, different energy, different crowd response. Set transitions = natural energy dips and rebuilds — exactly the dynamics to model.

**Recruit testers 48 hours before, not at the door.** Getting strangers to install an app at a loud venue has ~10% success rate. Pre-recruited testers have 80%+. Pitch: "Help us build an app that measures venue energy — install the app, rate the vibe every 5 min, free entry / drink ticket."

**What to give the venue afterward:** a one-page report — energy arc across the night, which DJ set scored highest, when the crowd peaked vs. when people started leaving (BLE decline), subjective ratings overlaid on sensor data. Genuinely valuable to promoters and costs nothing to produce from the analysis scripts.

---

## Success Criteria

**Experiment succeeds if:**
- Composite sensor score correlates with subjective ratings at **r ≥ 0.5** across sessions
- At least 2–3 individual signals show meaningful independent correlation
- BPM + dB together outperform dB alone
- Users can look at the session summary and say "yeah, that timeline matches what happened"
- Background collection works reliably on iOS (data doesn't drop when phone is pocketed)

**Experiment fails if:**
- Sensor data is too noisy to distinguish dead bar from peak party
- No sensor combination correlates with subjective ratings
- iOS background collection doesn't work reliably

**Ambiguous result (still valuable):**
- Some signals work (dB + BPM) but others don't (BLE)
- Correlation holds in clubs but not bars
- → Still tells you which signals to keep, which to drop, what minimum user density you need

---

## Known Risks

| Risk | Mitigation |
|------|------------|
| iOS kills background audio/sensor access | `expo-task-manager` background tasks; tested and working |
| BLE scan unreliable in crowded venues | Use trend (delta) not absolute count; treat as one signal among many |
| BPM detection unreliable for unrecognized tracks | Current: Deezer metadata. Step 2: ShazamKit. Step 3: native PCM autocorrelation |
| AudD trial quota exhausted | Migrate to ShazamKit once Apple Developer account purchased — free, no limits |
| Phone placement varies (pocket/hand/table) | Standardize: always in pocket; note in tester briefing |
| Battery drain | Intermittent sampling; motion sampling stops after 5 min stationary; target <5%/hr |
| Subjective ratings are lazy/random | 5 options max, one-tap, brief testers that honest ratings are the whole point |

---

## Analysis

Python scripts in `/analysis/`:

| Script | What it does |
|--------|-------------|
| `fetch_data.py` | Pulls sensor windows + ratings from Supabase |
| `correlations.py` | Pearson/Spearman between each signal and user ratings |
| `optimize_weights.py` | Gradient-descent weight optimization for scoring |
| `monitoring_queries.sql` | Data quality checks |

**Analysis checklist (run after collecting 50+ labeled samples):**
- Per-signal correlation with subjective ratings
- Which signals are stable vs noisy across devices
- Does correlation hold across venue types?
- Does BPM independently predict ratings beyond dB?
- Does dwell time correlate with overall session rating?
- Composite model: linear regression, then ridge if overfitting

---

## If the Signal Validates — Revenue Layers

**Layer 1 — Consumer app (ViibeCheck):** Nightlife discovery where every venue has a live sensor-derived vibe score, not user opinions. Freemium. The app is the data collection mechanism.

**Layer 2 — Venue analytics dashboard:** Sell aggregated, anonymized vibe data to bar/club owners and promoters. "Your venue peaks at 11:30pm Fridays, energy drops 40% after 1am." €50–200/month per venue. Partner with 5–10 Brussels venues for free analytics in exchange for promoting the app — solves density and monetization simultaneously.

**Layer 3 — Vibe API:** License the score as a data layer to maps, ride-sharing, travel apps, real estate. Only viable after 50K+ users across 3+ cities. 2–3 years out minimum.

---

## Post-Validation Decision Tree

```
Signal validates (r ≥ 0.5)
  → Build ViibeCheck with validated sensor stack
  → Seed 5-10 Brussels venues with free analytics for density
  → Target: live beta in one Brussels neighbourhood within 3 months

Signal partially validates
  → Which venue types worked? Narrow scope accordingly
  → What minimum user density is needed?
  → Rebuild composite with only validated signals, run second validation

Signal fails
  → Kill the sensor approach
  → ViibeCheck becomes a crowdsourced opinion app (weak moat)
  → Consider: manual vibe ratings with gamification, venue video feeds, or friend-location social layer
```
