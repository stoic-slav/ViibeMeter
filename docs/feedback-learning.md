# Learning from 👍/👎: how the app finds out what "vibing" really looks like

**Principle (owner, 21 Oct 2026):** the 👍/👎 answers on "Your night in songs" are the ground truth that decides how the sensors' measurements are weighed. They are also the signal that tells us when the current measurements aren't enough and new analysis has to be developed. Treat this loop as a core part of the product, not an add-on.

## Why
The recap ranks songs from four signals with weights chosen from research (Martella 2015, Witek 2014, Janata 2012, Burger 2013, Swarbrick 2019; table in `docs/plans/build-26-dj-venue-recap.md`):

| Signal | Starting weight |
|---|---|
| Intensity: movement compared with the person's own night | 0.30 |
| Entrainment: movement locked to the beat, or matching its tempo or a multiple of it (half and double count 0.9, quarter and triple 0.6, four times 0.5; `HARMONIC_WEIGHTS` in `BeatSync.ts`) | 0.27 |
| Persistence: share of the song spent moving more than usual | 0.17 |
| Lift: movement during the song vs the 2 minutes before | 0.12 |
| Groove (build 29, song-level): pulse clarity, sub-bass and spectral flux against the rest of the night's music, and tempo in 100-150 BPM | 0.08 |
| Carry (build 29): moving before the song and kept moving through the change | 0.06 |

No study has tested these on phones in pockets in clubs. So the weights are guesses until our own users say which songs they really loved. Every 👍/👎 is uploaded with the values that produced the ranking (`song_feedback`: `intensity`, `entrainment`, `persistence`, `lift`, `groove`, `carry`, `score`, `rank`, `kind`, `dj_name`).

## The loop
1. **Collect.** Real nights; people answer 👍/👎 on their recap.
2. **Measure.** `python3 analysis/fetch_data.py`, then `python3 analysis/fit_recap_weights.py`. It reports:
   - how well each signal alone separates 👍 from 👎 (AUC: 0.5 = chance, 1.0 = perfect);
   - how well the current score does;
   - a fitted model's suggested weights, cross-validated on people it hasn't seen.

   `--selftest` checks the method on synthetic answers.
3. **Decide.**
   - **Update the weights:** with at least 100 answers from 10 or more people, and the fitted model clearly better than the current score (AUC gain over about 0.02), update `RECAP.WEIGHTS` in `vibemeter-app/src/processing/NightRecap.ts`. Note the date, the numbers and the build in `docs/HANDOFF.md`.
   - **Investigate first:** a signal with a negative relation (higher values go with 👎). It may be measuring the wrong thing, for example walking slipping through.
   - **Develop new analysis:** if every signal stays weak (all AUC under 0.6), the current measurements aren't capturing enjoyment. See below.
4. **Repeat** each month or after each batch of nights. Re-run after any change to the sensors or the signals.

## Where this may push us: new analysis to develop
If the feedback shows the four signals aren't enough, these are the next candidates, roughly by expected value:
- **Crowd sync:** whether the people around you moved together to that song. It's computed server-side from phones in the same group or room (`analysis/crowd_sync.py`) and needs 3 or more phones. It's the owner's central hypothesis and is backed by Tarr 2016 and Ellamil 2016.
- **Song-level context:**
  - the song's position in the set (peak hour vs warm-up);
  - its popularity (Deezer rank, already collected);
  - whether the person stayed through the end of the song.
- **Better movement measures:**
  - a fuller, more reliable beat-lock measure across the 10 s clips (not only clips with a measured beat grid);
  - vertical vs horizontal movement (bouncing vs swaying);
  - movement smoothness.
- **Response timing:** how quickly movement rises after the song starts or after the drop.
- **Personal models:** with many answers per person, weights that adapt to each person, since people dance differently.
- **Sensor quality checks:** whether 👎 answers cluster where the phone was in a bag or the room was quiet (measurement failure rather than dislike).

Add a column to `song_feedback` for any new signal before shipping it, so its value is stored with every answer from day one.

## Guardrails
- **Watch for bias:** people only answer for songs we showed them (the top 5). Compare 👍 rates by rank, and occasionally show one lower-ranked song so the model also sees songs we'd have missed.
- **Keep the ranking simple** while the data is thin: a few transparent weights, not a black box.
- **Privacy is unchanged:** answers carry no song titles, only ISRCs and the four numbers.
