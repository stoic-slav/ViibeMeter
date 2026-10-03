# Public TestFlight link: setup

A public link lets anyone with an iPhone install ViibeMeter through TestFlight without being added by email. Apple must approve the build once (Beta App Review, usually within a day). Later builds of the same version often skip review.

Everything is in App Store Connect → **Apps → ViibeMeter → TestFlight**.

## 1. Test information (once)
Left sidebar → **Test Information**. Fill in and **Save**:

| Field | Value |
|---|---|
| Beta App Description | *(below)* |
| Feedback Email | `stoicslav@gmail.com` |
| Marketing URL | `https://github.com/stoic-slav/ViibeMeter` |
| Privacy Policy URL | `https://github.com/stoic-slav/ViibeMeter/blob/master/docs/PRIVACY.md` |

**Beta App Description:**
> ViibeMeter is a research app that measures the "vibe" at parties, bars and clubs from your phone's sensors. During a session it listens to the music (tempo, loudness, song recognition), measures how you move and whether you move on the beat, and asks you every 5 minutes to rate the vibe. No audio, location or Bluetooth identities are stored or uploaded; only summary numbers are. We use the data to test whether sensors can predict how people rate a night out.

**Beta App Review Information:**

| Field | Value |
|---|---|
| First name / Last name | your name |
| Phone number | your phone number (Apple only calls if something is unclear) |
| Email | `stoicslav@gmail.com` |
| Sign-in required | **No** (leave username and password empty) |

**Review Notes:**
> No account is needed. Tap Start Session, answer the one-time dance question, enter any venue name, choose where the phone is, and start. Play any music nearby.
>
> Background modes: a session measures continuously for the length of a night out, usually with the phone locked in a pocket. The microphone stays on during the session (audio background mode) to measure loudness, tempo and beat timing. Audio is analysed on the device in a few-second in-memory buffer and never stored or uploaded; song recognition uses ShazamKit, which sends only a fingerprint. Location (background) detects arrival and departure at the venue; coordinates never leave the phone. Bluetooth counts nearby devices to estimate crowd size; no identifiers are stored. The session ends when the user taps Stop, which turns all sensors off.

## 2. External group with a public link
1. Left sidebar → **External Testing** → **+** (Add group) → name it `Public`.
2. In the group → **Builds** → **+** → choose the latest build (7) → **What to Test**: *(below)* → **Submit for Review**.
3. Once Apple approves (email "Your submission was accepted"), open the group → **Public Link** → **Enable Public Link**. Optionally set a tester limit, e.g. 50.
4. Copy the link (`https://testflight.apple.com/join/…`) and send it to testers with `TESTER_GUIDE.md`.

**What to Test:**
> Start a session when you arrive somewhere with music, keep the phone in your pocket, and leave it running with the screen locked. Answer the "How's the vibe?" prompts (every 5 minutes). Tap Stop when you leave. If your group was given an event code, enter it at the start. Tell us if the session stops on its own, if a prompt never appears, or if the battery drain feels too high.

## Notes
- Internal testers (people added as App Store Connect users) get builds without review; external and public-link testers need the review above.
- A new **version number** (e.g. 0.3.0) goes through Beta App Review again; new build numbers of an approved version usually do not.
- Each tester needs iOS 15.1 or later and the TestFlight app.
