# Data Protection Impact Assessment (draft)

*Draft v0.1, 17 October 2026. To be reviewed by a privacy lawyer or a university DPO/ethics board (see `docs/outreach/`) before the pilot scales beyond friends and the public TestFlight link is promoted.*

Why a DPIA: GDPR Art. 35 requires one when processing is likely to be high-risk. Viibe Check combines several sensors, systematic observation of people at nightlife venues, and venue-level location history linked to a pseudonymous ID; venue visits can reveal sensitive information (Art. 9: e.g. sexual orientation, religion, health). We therefore treat it as required.

## 1. Description of the processing

| Item | What |
|---|---|
| Controller | Leo Gerasimov (individual), Brussels. Contact in `docs/PRIVACY.md` |
| Purpose | Research: test whether phone sensors predict how people rate a night out; later, aggregated live venue indicators |
| Data subjects | Adult volunteers (18+) who install the app via TestFlight or APK |
| Legal basis | Consent, per sensor, in the app (Art. 6(1)(a)); explicit consent where venue visits could reveal special-category data (Art. 9(2)(a)). Option to add Art. 89 research safeguards with a university partner |
| Identifier | Random UUID created on the phone; not linked to name, Apple ID, phone number or email |
| Data per session | Start/end, dwell, optional venue name, confirmed venue (Google place ID) or none, group code, phone placement, dance affinity (1–5), battery level, consent version, sensors allowed |
| Data per minute | Loudness, tempo, spectral summaries, movement energy/tempo/rhythmicity, beat-sync scalars, phone context (on body/off body), BLE device count (no IDs), song ISRC/genre/tempo, bass-loudness curve (4 values/s), venue place ID |
| Data per 10 s | Beat sync, movement energy/tempo, song ISRC, phone context |
| Ratings | 💀/🙂/🔥 with time, response time, where given (notification, app, lock-screen card) and whether a prompt was waiting |
| Night recap (build 25) | On the phone only: recognised song titles/artists/Apple Music IDs per session and the computed recap. Uploaded only on 👍/👎: ISRC (or none for an unrecognised stretch), start/end, rank, score, liked, DJ name. Server-side public lineup (`venue_sets`: venue, DJ, set times) |
| Going out standby (build 24, opt-in, iPhone) | Per evening only: armed/ended time and reason, prompts asked/accepted/declined/ignored, number of checks, music/moving/party minutes, battery at start and end. Sessions record `start_source` (manual or standby). The standby checks themselves (5 s audio + motion every 30 s) are computed on the phone and discarded |
| Not collected | Audio, BLE identifiers, location coordinates or traces, contacts, names, accounts |
| Processors / recipients | Supabase (EU, Paris region: database, Edge Functions); Apple ShazamKit (audio fingerprint for song lookup); Apple MusicKit (playlist creation in the user's own library, on request); Deezer public API (ISRC lookup); Google Places API (rounded position → nearest venue, position not stored by us); Expo/EAS (build service, no user data) |
| Retention | 10 s clips, bass curves and live-view logs: 90 days. Sessions, minute data, ratings and standby evenings: 24 months. Automatic (`apply_retention`, daily) |

## 2. Necessity and proportionality

- **Minimisation:** all signal processing happens on the phone; only summary numbers are uploaded. Location is used "While Using" only, as one rounded reading sent to an Edge Function and discarded; only the place the user confirms is stored.
- **Granular consent:** microphone required (without it a session cannot measure on iPhone); motion, Bluetooth and location optional and switchable at any time.
- **Rights:** in-app "Delete my data" (erasure), consent changes in-app (withdrawal), anonymous ID shown for access/portability requests by email.
- **No profiling with effects:** no decisions about individuals; the live view shows only per-venue aggregates from several phones.

## 3. Risks and measures

| Risk | Likelihood / severity | Measures | Residual |
|---|---|---|---|
| Re-identification from venue history (who goes where, when) | Medium / high | Random ID; no coordinates; venue must be confirmed; deletion in-app; 24-month retention; no individual data exposed via the API (only aggregates through `live_venues`) | Medium: venue history is still personal data. Consider coarsening venue to area for some venue types |
| Sensitive inferences (Art. 9) from venue type | Low–medium / high | Explicit consent text; no venue categories used in analysis by default; option to hide/delete a venue (to build) | Medium until "hide venue" exists |
| Audio misuse | Low / high | Audio never stored or uploaded; in-memory ring buffer only; ShazamKit fingerprints only | Low |
| Bystanders (people near the phone) | Low / medium | Only loudness/music features and BLE counts without IDs; no speech content | Low |
| Listening outside a session (Going out standby) | Medium / medium | Separate opt-in with its own explanation; only loudness, beat and movement computed on the phone and discarded; no song recognition; only counts per evening stored; visible orange microphone dot and a lock-screen card with TURN OFF; ends at 06:00, after 6 h or at 20% battery; withdrawable in Privacy & data | Low |
| Minors using the app | Medium / high | 18+ confirmation at first start; TestFlight distribution only | Medium: self-declaration only |
| Data leak via the app's public key | Low / medium | Upload via `SECURITY DEFINER` functions, no deletes, venues/live_views not readable; step 2b (drop SELECT/UPDATE) pending once all testers are on build ≥14 | Low–medium until 2b |
| Deletion abuse with someone's ID | Low / medium | IDs are random and only shown to their owner | Low |
| Transfers outside the EU (Apple, Google, Deezer) | Medium / medium | Only fingerprints, ISRCs and one rounded position; disclosed in the privacy policy | To review with counsel (SCCs/DPF) |

## 4. Open items before scaling

1. Legal review of this DPIA and the privacy policy (lawyer or university DPO).
2. "Hide/delete one venue" control.
3. Lockdown step 2b (drop anon SELECT/UPDATE).
4. Record of processing activities (Art. 30) and a data-breach procedure.
5. Decide whether the pilot runs under a university's ethics approval (Art. 89 safeguards).
