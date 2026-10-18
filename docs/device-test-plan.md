# Device test checklist for builds 23–24 (TestFlight)

What the simulator could not check: motion, the dancing rule, buzzing in a pocket, battery, Face ID before STOP. All of it runs on any iPhone with build 24 from TestFlight (the owner's iPhone 16 or a tester's). iOS 17 or later is needed for the lock-screen buttons.

## 1. Quick checks (build 24 via TestFlight, at home, ~15 min)
- [ ] Start a session, lock the phone. Is the card there? Does tapping 🔥 work without unlocking? Does the next prompt buzz in a pocket?
- [ ] STOP on the card: does it need Face ID, and then ask "End this session?"?
- [ ] Swipe the app away during a session. Does the card turn grey after 15 min? Does the session show as `interrupted` after reopening?
- [ ] Privacy & data: toggles, Going out row. (Try a full "Delete my data" once, on a phone whose test data can go.)

## 2. Going out mode, the dancing rule (~45 min)
Play music loud from a speaker (≥ 75 dB at the phone; check with the Apple Watch Noise app if available), phone in a trouser pocket, Going out mode on. Note the time of each step; Claude reads the outcome from `standby_nights` (prompts, music and moving minutes) afterwards.
1. **Standing still**, 6 min, music on → expect **no prompt**: music minutes yes, moving minutes no.
2. **Walking around** the room, 6 min → **no prompt**.
3. **Dancing on the beat**, 3 min within 6 → **prompt**.
4. **Swaying or bobbing lightly** → note whether it counts as moving (the rule's edge).
5. **Phone on the table** while dancing → no prompt (expected; note it).
- Turn Going out mode off and on between steps, so each step is its own row in `standby_nights`. Thresholds (`STANDBY` in `constants.ts`) get adjusted from this if needed.
- **Yes, start** from the locked screen: does the session start and keep measuring with the screen off?

## 3. Battery (two evenings or one long run)
- [ ] Standby only, screen locked, 2 h at home: battery start/end (logged in `standby_nights`). Target under ~4%/h.
- [ ] Session only, 2 h: battery start/end (logged in `sessions`).
- [ ] Low Power Mode on vs off, if time allows.

## 4. Two phones (the owner's iPhone 16 + a friend's)
- [ ] Group: SHARE on one, SCAN on the other, both say "2 phones measuring".
- [ ] 10 min in the same room with the same music, both dancing: windows from both, bass envelopes correlate (`auto_groups.py`), crowd sync computed (needs ≥ 3 phones for the full metric, so 2 is a smoke test).
- [ ] One phone in another room with the same playlist 1 minute later: must **not** be grouped (`auto_groups.py --selftest` scenario, now for real).

## 5. On a real night out (ideally 3+ phones)
- [ ] Turn on Going out mode at home (or from the 22:30 reminder). Does the prompt come at the venue, and not on the way?
- [ ] Rate from the card every prompt; Stop when leaving.
- [ ] Next day: Claude runs the data-quality checks and the first analysis.
