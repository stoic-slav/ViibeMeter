# ViibeMeter — Tester Guide

Thanks for helping test ViibeMeter! This takes 2 minutes to read. Please read it.

---

## What this app does

ViibeMeter measures the "vibe" of a venue using your phone's sensors:
- **Sound** (how loud it is, the tempo, how strong the bass is). Audio is analysed on the phone and never saved.
- **Song** playing (recognised on iPhone with Apple's ShazamKit)
- **Movement** (are you dancing, walking or standing still, and are you moving on the beat?)
- **Crowd density** (how many Bluetooth devices are nearby)

Every ~5 minutes it asks you "How's the vibe?" on a 1–5 scale.

The experiment tests whether the sensor measurements match your honest ratings, and whether people moving in sync with the music and with each other means a better vibe.

---

## Install

- **iPhone:** open the TestFlight invite link (or scan the QR code) → install **TestFlight** from the App Store if asked → tap **Install** next to ViibeMeter.
- **Android:** open the APK download link on your phone → allow "install from unknown sources" when asked → install.

The first time you open it, allow **microphone, motion, Bluetooth, location and notifications**. Each one feeds a signal; the app still works if you refuse one, it just measures less.

---

## How to use it

**When you arrive:**
1. Open ViibeMeter and tap **Start Session**.
2. The first time only, answer how much you enjoy dancing (1–5).
3. Type the venue name.
4. Pick where the phone will be: **Pocket** is best, so keep it there all night if you can.
5. Enter the **event code** if the organiser gave you one (e.g. `DISCO42`). Everyone at the same event must use the same code; that is what lets us measure crowd sync.
6. Tap **Start Session** and put the phone in your pocket.

**While you're out:**
- When "How's the vibe?" appears, tap your honest answer (2 seconds).
- Missed one? No problem, the next comes in 5 minutes.
- Keep the app running. Locking the screen is fine; force-closing it stops the measurement.

**When you leave:**
1. Open ViibeMeter and tap **Stop**.
2. Look at the Summary to see how the sensors read your night.

---

## Rating guide

| Rating | Label | When to use |
|--------|-------|-------------|
| 💀 | Dead | Empty, quiet, nobody is having fun |
| 😐 | Meh | A bit flat, nothing special |
| 🙂 | Decent | Good atmosphere, enjoying it |
| 🔥 | Great | Really buzzing |
| 🤯 | Peak | Best-night-out energy |

**Be honest.** Rate what you actually feel, not what you think the app wants. Bad honest ratings are worth more than good fake ones.

---

## Where to test

| Venue type | Examples |
|------------|---------|
| Clubs | Anything with a DJ (best signal) |
| Bars | Quiet pub, loud bar, cocktail bar |
| House parties | Friend's place, garden party |
| Concerts | Any live music |
| Restaurants | Should score low, useful as a control |

---

## Privacy

- **No audio is stored or uploaded.** Each ~5-second clip is analysed on the phone and deleted. Song recognition sends Apple only an irreversible fingerprint.
- **No GPS coordinates are stored.** Location is only used on the phone to check you are still at the venue.
- **No Bluetooth device IDs are stored.** Only the number of nearby devices.
- You are identified by a **random anonymous ID**, shown at the bottom of the home screen. No name, email or phone number.

Full policy: [docs/PRIVACY.md](docs/PRIVACY.md). To delete your data, send us your anonymous ID.

---

## Troubleshooting

**"I forgot to stop my session"** — Open the app and stop it. Dwell time will still be roughly right.

**"I missed the rating notification"** — Another one comes in 5 minutes.

**"Battery drain"** — Target is under 5% per hour. If it's more, tell us.

**"The vibe score looks wrong"** — That's useful data! Rate honestly; the gap between your rating and the score is exactly what we study.

**"TestFlight says the build expired"** — Builds last 90 days. Open TestFlight and install the newest one.

---

Questions? Message the group chat.

Thanks, you're helping build something genuinely new.
