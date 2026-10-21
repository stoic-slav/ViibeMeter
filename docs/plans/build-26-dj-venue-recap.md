# Plan: build 26. Refined vibe ranking, DJ links, venue lineup page

Status: built 21 Oct 2026, checked in tests and the simulator; not yet built for TestFlight. Owner decisions (21 Oct): rank by more than movement (research-based); DJ link field; venue self-service lineup page with a code; triangle strategy in the strategy doc ("Cold start and the triangle"). The DJ-side view with anonymous totals is liked; next build.

## Refined ranking (`src/processing/NightRecap.ts`)
Each song gets four signals (0–1), always relative to the person's own night, ignoring off-body and walking minutes:

| Signal | What | Weight | Basis |
|---|---|---|---|
| Intensity | Movement energy percentile within the night | 0.35 | Martella 2015 (accelerometer → enjoyment); Witek 2014, Janata 2012 (urge to move ≈ pleasure) |
| Entrainment | Phase locking of movement to the beat (PLV), else movement tempo matching the song tempo or half/double | 0.30 | Janata 2012 (groove = sensorimotor coupling); Burger 2013; Swarbrick 2019 |
| Persistence | Share of the song spent moving more than usual | 0.20 | Sustained dancing vs a burst (analysis/engagement.py) |
| Lift | Movement during the song vs the 2 minutes before | 0.15 | Stepping up / returning to the floor for a song you like |

Missing signals drop out and the weights renormalise. The reason shown is the strongest signal ("In sync with the beat for 4 min", "You stepped it up when this dropped"…). The weights are priors: each 👍/👎 now uploads the four values (`song_feedback.intensity/entrainment/persistence/lift`), so after ~100 answers a logistic regression in the analysis can fit them. Crowd sync (other phones moving together to the same song) is a later, server-side fifth signal.

Test: `npx tsx scripts/night-recap-test.ts` (17 checks: on-beat banger first, walking excluded, half-tempo bobbing beats the same energy off tempo, edit credit and links).

## DJ links
- `dj_edits.link` (DJ registration, `app/dj.tsx`) and `venue_sets.dj_link` (lineup page): https only.
- `edit_catalog()` and `venue_sets_for()` return them.
- The recap shows **LISTEN ↗** (the edit) and **FOLLOW DJ ↗** (the DJ).

## Venue lineup page (`app/lineup.tsx`, `vibemeter://lineup`)
- **Flow:** find the venue (Google, `find-venue`), enter the venue code, pick the night (tonight + 6 days), then add sets (DJ, from–to in 24 h time; times after midnight belong to the night) and an optional DJ link. Save replaces that night's sets (`save_venue_lineup`).
- **Codes:** only the SHA-256 is stored (`venue_editors`). To create one: `insert into venue_editors (place_id, venue_name, code_hash) values ('<place id>', '<name>', encode(extensions.digest('<CODE>', 'sha256'), 'hex'));`.
- **Checked in the simulator:** C12 found; a test code unlocked it; a set of 23:00–02:00 with a link was saved as 21 Oct 23:00 → 22 Oct 02:00 local, with `https://` added. The test code and set were deleted.

## Next
- DJ-side view: anonymous totals per set and per edit (phones, dancing share, in-sync share).
- Fit the weights once enough 👍/👎 exist.
