# VibeMeter — Sensor Fusion Validation Experiment (v2)

## PRD for the standalone vibe proof-of-concept

---

## 1. Purpose

Validate one hypothesis before building ViibeCheck:

**Can phone sensor data produce a "vibe score" that reliably matches how people subjectively experience a social gathering?**

If yes → you have a novel primitive worth building an app around, with a clear path to consumer product, venue analytics, and eventually an API business.

If no → you saved months of building the wrong product. ViibeCheck without validated sensor data is just another crowdsourced nightlife opinion app — and there are already many of those (VibeCheck, Vibez, Vibeo, Vibe, Roo). None of them use passive sensor fusion. That's the only gap worth pursuing.

---

## 2. Why this matters — competitive landscape

The nightlife "vibe" app space is crowded but shallow. Every existing app relies on user-generated reviews and manual check-ins. Nobody is doing passive sensor measurement.

**What exists today:**
- VibeCheck (Google Play) — manual live vibe updates, mood tags, community posts
- Vibe (iOS) — manual check-ins, crowd/line/vibe ratings, friend tracking
- Vibeo (iOS) — live venue videos, AI-curated picks by mood
- Vibez — venue ratings by atmosphere, music, crowd type
- Vibes (Ottawa) — crowdsourced wait times, crowd sizes, atmosphere

**What none of them do:**
- Passive ambient measurement from phone sensors
- Objective energy/density scoring without requiring user input
- Real-time trend detection (filling up, peaking, dying down)
- Sensor-derived BPM/music classification

**The difference:** "someone typed 'great vibe' at 11pm" vs "ambient sound, movement, and density data show this venue peaked at 11:15pm and is now declining" — that's the difference between a review and a measurement. This experiment determines whether the measurement is real.

---

## 3. What you're measuring

### Tier 1 — Must-have signals (Week 1 build)

| Signal | Source | What it proxies | Why it matters |
|--------|--------|-----------------|---------------|
| Ambient sound level (dB) | Microphone | Energy, crowd size, loudness | Core energy indicator, easy to collect |
| Audio classification (music y/n) | Microphone + spectral analysis | Whether music is playing vs just noise | Distinguishes loud party from loud restaurant |
| BPM detection | Microphone + FFT onset detection | Music tempo and energy level | 128 BPM house set vs 80 BPM background jazz tells you more than volume. Single most underrated signal |
| Accelerometer magnitude | IMU | User movement — dancing, walking, standing | Direct proxy for physical engagement |
| Gyroscope activity | IMU | Body movement patterns | Supplements accelerometer for dance detection |
| BLE device count + trend | Bluetooth scan | Crowd density proxy + filling/emptying | Rate of change matters more than absolute count |
| Dwell time | Location / session duration | How long user stays | 20 min = bad night, 3 hours = great night. High predictive value, trivially easy to collect |
| Micro-prompt rating | User input every 20-30 min | Ground truth / subjective calibration | Training label — the entire experiment hinges on this correlation |

### Tier 2 — Test in Week 3 (if Tier 1 looks promising)

| Signal | Source | What it proxies | Notes |
|--------|--------|-----------------|-------|
| Screen-off ratio | System state | Phone away = having fun | Weak individually, useful composite signal |
| Camera activation frequency | System event | People take photos when something good happens | Underexplored signal, needs permission |
| Sound variance over time | Microphone | Energy fluctuation, live vs dead room | Derived from Tier 1 audio stream |
| WiFi SSID count | WiFi scan | Crowd density fallback | OS restrictions make this unreliable on newer iOS/Android |

### Tier 3 — Out of scope for validation

| Signal | Why it's out |
|--------|-------------|
| Visual crowd density (camera CV) | Needs dedicated hardware, massive privacy issues |
| Air quality / temperature | Most modern phones dropped ambient temp sensors |
| Actual headcount | Impossible from phone alone |
| Facial expression / mood detection | Privacy nightmare, unreliable, not phone-feasible |
| Spending signals (payment activity) | Requires payment integration, way too early |
| Social media posting frequency | API access restrictions, privacy, not reliable |

### Derived composite signals

| Signal | Derived from | Meaning |
|--------|-------------|---------|
| Energy score | Sound dB + BPM + music detection + accelerometer | How energetic is the environment |
| Density estimate | BLE device count + trend | How many people and are more arriving or leaving |
| Movement score | Accelerometer + gyro | Is the user (and crowd) physically active |
| Music quality score | Music detection + BPM + frequency spectrum | Is there real music, how energetic is it |
| Engagement score | Dwell time + screen-off ratio | Is the user actually enjoying this |
| Crowd trend | BLE count rate of change over 15-30 min windows | Filling up / peaking / thinning out / emptying |
| **Vibe score** | Weighted composite of all above | The single number |

### Ground truth (calibration)

Every 20–30 minutes, prompt the user:

> "How's the vibe right now?" → 1 (dead) to 5 (peak)

This is your training label. The entire experiment is about finding which sensor signals — and which weightings — correlate with this subjective rating across sessions, venues, and users.

---

## 4. Key audio processing detail

Raw dB is not enough. The microphone pipeline needs to distinguish:

| Audio state | dB | Music? | BPM | What it means |
|-------------|-----|--------|-----|---------------|
| Quiet bar | Low | No | — | Chill or dead |
| Loud restaurant | High | No | — | Noisy but not a party |
| Chill lounge | Medium | Yes | 80-100 | Relaxed atmosphere |
| Active party | High | Yes | 120-130 | Peak nightlife energy |
| Concert/club | Very high | Yes | 128+ | Maximum energy |

**On-device audio processing pipeline (per 5-second sample):**
1. Record 5-second audio buffer (never saved to disk)
2. Compute RMS amplitude → dB level
3. Run FFT → frequency band analysis (bass presence, mid/high ratio)
4. Detect rhythmic peaks → BPM estimation via onset detection
5. Classify: silent / talking / low music / high music / loud music
6. Discard buffer, store only: `{ db: 78, music: true, bpm: 126, classification: "high_music" }`
7. Wait 2–3 minutes, repeat

**Critical:** No audio is recorded, stored, or transmitted. Only computed metrics leave the device.

---

## 5. Architecture

### Stack

- **App**: React Native / Expo (same stack as ViibeCheck — zero context-switching cost)
- **Sensor access**: `expo-sensors` (accelerometer, gyroscope), `expo-av` (microphone amplitude + FFT), `react-native-ble-plx` (BLE scanning)
- **Backend**: Supabase — Postgres for sensor logs, Edge Functions for aggregation (stays consistent with ViibeCheck stack)
- **Analysis**: Python notebooks post-hoc (correlation analysis, weight tuning, signal evaluation)

### Data flow

```
Phone sensors → local sampling (1-5 sec intervals)
  → on-device processing (FFT, BPM, classification)
  → aggregate to 1-min windows
  → upload to Supabase (batched every 5 min)
  → periodic vibe prompt → user rates 1-5
  → rating stored with same timestamp window
```

### On-device vs cloud

- **On-device**: raw sampling, FFT/BPM computation, windowed aggregation, audio classification, local vibe score display
- **Cloud**: processed metric storage, cross-user aggregation per session, post-hoc correlation analysis

No raw audio, no raw GPS coordinates, no personal data ever leaves the device. Only computed scores and classifications.

### Session model

A "session" = one social outing. User taps "Start Session" when arriving, "End Session" when leaving. Optionally tag the venue/event name and type (bar, club, house party, concert, rooftop).

Dwell time = end_time - start_time. Automatically computed.

### Data schema (Supabase)

```sql
create table public.sessions (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  venue_name text,
  venue_type text check (venue_type in ('bar', 'club', 'house_party', 'concert', 'rooftop', 'restaurant', 'other')),
  started_at timestamptz not null,
  ended_at timestamptz,
  dwell_minutes integer,
  created_at timestamptz default now()
);

create table public.sensor_windows (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references public.sessions(id) not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  -- Audio signals
  avg_db numeric(5,1),
  music_detected boolean,
  estimated_bpm integer,
  audio_classification text check (audio_classification in ('silent', 'talking', 'low_music', 'high_music', 'loud_music')),
  bass_presence numeric(3,2),
  -- Motion signals
  accel_magnitude numeric(6,3),
  gyro_activity numeric(6,3),
  movement_classification text check (movement_classification in ('stationary', 'walking', 'swaying', 'dancing', 'jumping')),
  -- Density signals
  ble_device_count integer,
  ble_count_delta integer,          -- change from previous window
  wifi_ssid_count integer,
  -- Engagement signals
  screen_off_ratio numeric(3,2),    -- 0.0 to 1.0
  camera_activations integer,
  -- Computed
  computed_vibe_score numeric(3,1),
  created_at timestamptz default now()
);

create table public.subjective_ratings (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references public.sessions(id) not null,
  rating integer check (rating between 1 and 5),
  rated_at timestamptz not null,
  -- Nearest sensor window for correlation
  nearest_window_id uuid references public.sensor_windows(id),
  created_at timestamptz default now()
);

create index idx_sensor_windows_session on public.sensor_windows(session_id, window_start);
create index idx_subjective_ratings_session on public.subjective_ratings(session_id);
```

---

## 6. App screens (4 total)

### Screen 1 — Home

- Big button: "Start Session"
- Optional: name the session ("Jake's party", "Bar Delirium Friday")
- Venue type picker (bar, club, house party, concert, rooftop, other)
- History of past sessions with avg vibe score and dwell time

### Screen 2 — Live Meter

- Large animated vibe score (1.0–5.0 scale)
- Small breakdowns: energy, density, movement, music
- BPM display when music is detected
- Crowd trend indicator: ↑ filling / → stable / ↓ thinning
- Subtle real-time animation that responds to sensor data
- Runs in background when phone is locked (critical — people pocket their phones at parties)

### Screen 3 — Vibe Check Prompt

- Notification every 20-30 min (if app backgrounded)
- "How's the vibe right now?"
- 5 tappable options: Dead / Meh / Decent / Great / Peak
- One tap, dismiss, back to pocket
- Must take < 3 seconds total interaction

### Screen 4 — Session Summary

- After ending session: timeline of computed vibe score vs subjective ratings
- Shows each signal's contribution over time (stacked area chart)
- Highlights where sensor score matched/diverged from user feel
- BPM timeline if music was detected
- Dwell time and crowd trend summary
- This is calibration feedback — and also genuinely fun for the user

---

## 7. Build order

### Week 1: Sensor pipeline + audio classification

- [ ] Expo project scaffold with Supabase backend
- [ ] Microphone access → ambient dB level sampling
- [ ] FFT implementation for frequency analysis
- [ ] BPM detection via onset detection algorithm
- [ ] Audio classification logic (silent/talking/low_music/high_music/loud_music)
- [ ] Accelerometer + gyroscope sampling and movement classification
- [ ] BLE scan for nearby device count + delta tracking
- [ ] Aggregate all signals to 1-min windows
- [ ] Store locally (SQLite via expo-sqlite)
- [ ] Supabase schema deployment
- [ ] Upload pipeline: batched writes every 5 min
- [ ] Background task setup (expo-task-manager) — **test on iOS immediately, this is make-or-break**

### Week 2: Score computation + UI + prompts

- [ ] Naive vibe score formula: weighted average of normalized inputs
- [ ] Live meter screen with animated score and signal breakdowns
- [ ] BPM display and crowd trend indicator
- [ ] Session start/stop flow with venue tagging
- [ ] Vibe check prompt system (local notification every 25 min)
- [ ] Store subjective ratings linked to nearest sensor window
- [ ] Session summary screen with timeline visualization
- [ ] Dwell time computation
- [ ] Screen-off ratio tracking (Tier 2 — add if time permits)

### Week 3: Deploy to friends + collect data

- [ ] TestFlight / Expo dev build to 5-10 friends
- [ ] Brief them: use it at 2-3 outings each over 2 weekends
- [ ] You use it at every outing
- [ ] Monitor data quality in Supabase
- [ ] Fix sensor bugs as they appear (they will)
- [ ] Test camera activation tracking (Tier 2) if Tier 1 signals look clean
- [ ] Log per-signal reliability notes: which signals are stable, which are noisy

### Week 4: Analysis + calibration + findings

- [ ] Pull all data to Python (pandas + scipy)
- [ ] Per-signal correlation with subjective ratings (Pearson/Spearman)
- [ ] Per-signal reliability analysis: variance, noise floor, device differences
- [ ] Signal importance ranking
- [ ] Test composite weightings: linear regression, ridge, simple random forest
- [ ] Compute per-signal and composite R² and rank correlation
- [ ] Segment analysis: does correlation hold across venue types? (bar vs club vs house party)
- [ ] BPM analysis: does tempo correlate with vibe independently?
- [ ] Dwell time analysis: does session length predict overall rating?
- [ ] Build session summary screen from real data
- [ ] Write up findings document: which signals work, which don't, what composite performs best
- [ ] Go/no-go decision on ViibeCheck sensor approach

---

## 8. Success criteria

### The experiment succeeds if:

- Composite sensor score correlates with subjective ratings at **r ≥ 0.5** across sessions
- At least 2-3 individual signals show meaningful independent correlation
- BPM + dB together outperform dB alone (validates that audio classification matters)
- Users can look at the session summary and say "yeah, that timeline matches what happened"
- You collect **30+ rated time windows** across **8+ sessions** across **3+ venue types** (minimum for credible signal)
- Background collection works reliably on iOS (data doesn't drop when phone is pocketed)

### The experiment fails if:

- Sensor data is too noisy to distinguish "dead bar" from "peak party"
- Subjective ratings don't correlate with any sensor combination
- Background collection doesn't work reliably (iOS kills it, permissions block it)
- BLE counts are so noisy they're useless in real venues
- Audio classification can't distinguish music from crowd noise
- Users find the prompts annoying and stop rating honestly

### Ambiguous result (still valuable):

- Some signals work (sound + BPM) but others don't (BLE counts)
- Correlation exists but only in certain venue types (clubs yes, bars no)
- Works with 5+ phones present but not with 1-2
- → Still valuable. Tells you which signals to keep, which to drop, and what minimum user density you need per venue

---

## 9. Known risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| iOS kills background audio/sensor access | Fatal — no data when phone pocketed | Use `expo-task-manager` background tasks; test on iOS day 1 of Week 1; consider foreground service notification on Android; if iOS kills it, the entire approach may need rethinking |
| BLE scan returns garbage in crowded venues | Density signal unreliable | Treat BLE as one input among many; use trend (delta) not absolute count; normalize per-venue; may need to drop entirely |
| Microphone captures noise not music | Audio classification fails | FFT + BPM detection should separate music from crowd noise; test in loud non-music environments (restaurants) to validate |
| BPM detection unreliable in real venues | Lose the most valuable audio signal | Test with known BPM tracks first; accept ±5 BPM accuracy; if unreliable, fall back to frequency band classification only |
| Friends don't actually use it | No data | Keep group small (5-8 people); make it a social game; go to the same events; buy them drinks |
| Subjective ratings are lazy/random | Bad training labels | 5 options max; one-tap dismiss; don't over-prompt; brief users that honest ratings are the whole point |
| Privacy concerns with mic/BLE | People won't install | Be transparent: show exactly what's collected, emphasize no audio recording, let them see raw data in session summary |
| Phone placement varies (pocket/hand/bag/table) | Signal inconsistency | Use accelerometer variance to estimate placement; establish per-session baseline in first 30 seconds; note placement in analysis |
| Battery drain from continuous sensing | Users kill the app | Intermittent sampling (5 sec on, 55 sec off for audio); stop motion sampling if stationary >5 min; target <5% battery per hour; show battery impact in briefing |
| Device differences (iPhone vs Android, model variations) | Sensor readings not comparable | Log device model with each session; normalize per-device in analysis; focus on relative changes not absolute values |

---

## 10. What Claude Code can autonomously iterate on

This is the key advantage over LedgerPilot and DDM — the entire pipeline is a closed feedback loop with no external stakeholders:

- **Sensor sampling logic** — write, test, refine sampling and aggregation
- **FFT / BPM detection** — iterate on audio processing algorithms
- **Audio classification model** — train and tune on collected data
- **Score formula** — run correlation analysis, propose new weightings, test composites
- **Movement classification** — tune thresholds for stationary/walking/dancing
- **UI/animation** — the live meter visualization is pure frontend iteration
- **Data pipeline** — Supabase schema, upload batching, error handling
- **Session summary charts** — timeline visualization from real data
- **Analysis notebooks** — correlation, regression, signal importance

What Claude Code *cannot* do: attend parties for you. The human-in-the-loop here is literally "go out and have fun with your phone in your pocket."

---

## 11. If the signal is real — three revenue layers

### Layer 1: Consumer app (ViibeCheck) — the discovery surface

**What it becomes:** A nightlife/social discovery app where every venue and event has a live, sensor-derived vibe score — not user opinions, but ambient measurement.

**Differentiation from existing apps:** Every competitor (VibeCheck, Vibez, Vibeo, Vibes) relies on manual user reviews. You'd be the only app showing objective real-time energy data.

**Monetization:** Freemium. Free to browse, premium for advanced features (vibe alerts, historical patterns, friend tracking). Revenue is modest here — the real value is user density feeding the other layers.

**Scaling challenge:** Sensor accuracy scales with user density per venue. A vibe score from 1 phone is noisy. From 15 phones it's meaningful. The consumer app needs density before the score is trustworthy, but the score needs to be trustworthy to drive adoption. Classic cold start.

**Mitigation:** Seed density city-by-city. Start with one neighborhood in Brussels. Partner with venues who promote the app to patrons. Don't launch broadly until you have reliable scores in at least 20-30 venues in one city.

### Layer 2: Venue analytics dashboard — the near-term B2B play

**What it is:** Sell aggregated, anonymized vibe data back to bar/club owners, event promoters, and concert organizers.

**What they'd see:**
- Real-time energy curve for their venue (tonight)
- Historical patterns: "Your venue peaks at 11:30pm Fridays, energy drops 40% after 1am"
- Comparative: "Saturday crowd is 2x more active than Thursday"
- Event-specific: "DJ set A produced 35% higher energy scores than DJ set B"
- Crowd flow: "Venue filled fastest between 10-11pm, started emptying at 1:30am"

**Why promoters would pay:** Right now they use ticket scans and bar revenue as lagging indicators. A real-time energy curve is a leading indicator. Concert organizers could use it for performance evaluation, setlist optimization, artist booking decisions.

**Pricing:** SaaS subscription per venue. €50-200/month depending on features and venue size.

**Scaling challenge:** This only works once you have enough users at a given venue to produce reliable data. Realistically need 10-15 active VibeMeter users at a venue for meaningful analytics.

**Most realistic near-term path:** Partner with 5-10 venues in Brussels. Offer free analytics dashboard in exchange for promoting ViibeCheck to patrons. This solves density and monetization simultaneously. Don't charge until the data is obviously valuable to them.

### Layer 3: Vibe API as primitive — the long-term moonshot

**What it is:** License the vibe score as a data layer to other platforms.

**Who would use it:**
- Maps (Google/Apple) — show "lively" pins on the map
- Ride-sharing (Uber/Bolt) — "take me somewhere fun" feature
- Travel apps — neighborhood liveliness scores for tourists
- Real estate — area vitality data
- City tourism boards — real-time nightlife activity heatmaps
- Smart city platforms — urban planning data

**Why it's a moonshot:** This requires massive geographic coverage and reliable scores across thousands of venues. It only becomes viable after Layer 1 achieves significant adoption in multiple cities.

**When to pursue:** Not before you have 50K+ active users across 3+ cities with validated score accuracy. Probably 2-3 years out minimum. Don't pitch this to anyone yet — it's a vision, not a plan.

**What makes it defensible if you get there:** The sensor fusion algorithm tuned on real-world party data across venue types, cities, and cultures. That's a dataset and model nobody else has. The app is the collection mechanism, the API is the monetization mechanism.

---

## 12. What's explicitly out of scope

### Out of scope for this validation experiment

- Event discovery features
- Ticketing / RSVP / payments
- Host tools / event creation
- Social features / friend lists
- QR code check-in
- Photo gallery
- Push notifications (beyond vibe prompts)
- Admin dashboard
- Any form of user accounts beyond anonymous device ID
- App Store submission (TestFlight/dev builds only)
- Multi-city anything
- Venue partnerships
- Revenue of any kind

### Out of scope for ViibeCheck V1 (even if signal validates)

- Vibe API / licensing
- Venue analytics dashboard (unless as free density-building tool)
- Automated sensor vibe (Phase 10 from original plan — too complex for V1)
- Passive background sensing as default (must be user-activated "Vibe Mode")
- BLE proximity / "people you vibed with" (Phase 10.5)
- Any form of audio recording or storage
- Computer vision / camera-based crowd analysis

---

## 13. Privacy posture

Even for a 5-10 person validation experiment, establish the right habits:

- **No audio recording.** Ever. Process on-device, transmit only computed metrics.
- **No GPS coordinates stored server-side.** Only session-level venue name and dwell time.
- **No personally identifiable data.** Users are anonymous device IDs during validation.
- **All raw sensor data stays on-device.** Only aggregated 1-minute windows uploaded.
- **BLE scans detect device count, not device identities.** No MAC addresses stored.
- **Users can delete their data.** Even in validation, respect this.
- **Be transparent with test users.** Show them exactly what data you collect. Let them see it in the session summary.

This isn't just ethics — it's practice for the consent infrastructure you'll need if you build the full product with passive sensing.

---

## 14. Post-validation decision tree

```
Signal validates (r ≥ 0.5, multiple signals correlate)
├── Which signals worked best?
│   ├── Audio (dB + BPM + classification) → Core of the product
│   ├── Motion (accelerometer) → Secondary signal, keep
│   ├── BLE density → If reliable: keep. If noisy: drop.
│   └── Dwell time → Almost certainly correlates. Keep.
├── Build ViibeCheck with validated sensor stack
├── Seed 5-10 Brussels venues with free analytics for density
└── Target: live beta in one Brussels neighborhood within 3 months

Signal partially validates (some signals work, composite weak)
├── Which venue types worked?
│   ├── Clubs/concerts only → Narrow to high-energy venues
│   └── Doesn't work for bars → May limit market
├── What minimum user density is needed?
│   ├── 5+ phones → Viable with venue partnerships
│   └── 15+ phones → Very hard cold start
├── Rebuild composite with only validated signals
└── Run a second 2-week validation with refined approach

Signal fails (no meaningful correlation)
├── Kill the sensor approach
├── ViibeCheck becomes a crowdsourced opinion app (weak moat)
├── Consider pivoting to:
│   ├── Manual vibe ratings with gamification (Roo model)
│   ├── Venue live video feeds (Vibeo model)
│   └── Friend-location social layer (Zenly/Find My model)
└── Or: focus entirely on DDM
```

---

## 15. Timeline summary

| Week | Focus | Exit criteria |
|------|-------|--------------|
| 1 | Sensor pipeline + audio classification + BPM detection | All Tier 1 signals sampling and storing correctly. Background mode works on iOS. |
| 2 | Vibe score computation + UI + prompt system | Live meter displays composite score. Prompts fire reliably. Session summary renders. |
| 3 | Deploy to 5-10 friends, collect data across 2 weekends | 8+ sessions across 3+ venue types. 30+ subjective ratings collected. Data quality verified. |
| 4 | Analysis, correlation, signal evaluation, go/no-go | Findings document complete. Per-signal and composite correlation computed. Decision made. |

**Total time:** 4 weeks
**Total cost:** $0 (Supabase free tier, Expo free, your time + friends' patience)
**What you learn:** Whether the core differentiator of ViibeCheck is real or imagined

---

*This document is the source of truth for the VibeMeter validation experiment. The full ViibeCheck implementation plan should not be started until this experiment produces a clear go signal.*
