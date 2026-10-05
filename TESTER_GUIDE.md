# Viibe Check — Tester Guide

Thanks for helping test Viibe Check! This takes 2 minutes to read. Please read it.

---

## What this app does

Viibe Check measures the "vibe" of a venue using your phone's sensors:
- **Sound** (how loud it is, the tempo, how strong the bass is). Audio is analysed on the phone and never saved.
- **Song** playing (recognised on iPhone with Apple's ShazamKit)
- **Movement** (are you dancing, walking or standing still, and are you moving on the beat?)
- **Crowd density** (how many Bluetooth devices are nearby)

Every ~5 minutes it asks you "How's the vibe?" on a 1–5 scale.

The experiment tests whether the sensor measurements match your honest ratings, and whether people moving in sync with the music and with each other means a better vibe.

---

## Install

- **iPhone:** open the TestFlight invite link (or scan the QR code) → install **TestFlight** from the App Store if asked → tap **Install** next to Viibe Check.
- **Android:** open the APK download link on your phone → allow "install from unknown sources" when asked → install.

The first time you open it, allow **microphone, motion, Bluetooth and notifications**. Each one feeds a signal; the app still works if you refuse one, it just measures less.

---

## How to use it

**When you arrive:**
1. Open Viibe Check and tap **Start Session**.
2. The first time only, answer how much you enjoy dancing (1–5).
3. The app recognises the club or bar you're in (allow location when it asks). If it picked the wrong place, type the right name.
4. Where the phone will be: **Pocket** is preselected and best, so keep it there all night if you can.
5. With friends? One person starts a session and taps **GROUP** on the meter screen to show a QR code. Everyone else scans it, either with the phone's Camera app or with **Scan a friend's group QR** in Viibe Check. You can also scan after starting. If you forget, that's fine: the app can often work out who was together from the music.
6. Tap **Start Session** and put the phone in your pocket.

**While you're out:**
- Every 5 minutes a "How's the vibe right now?" notification appears. **You don't need to unlock:** press and hold it (iPhone) or use the buttons under it (Android), then tap 💀 Dead, 🙂 Decent or 🔥 Best. Done in 2 seconds.
- Missed one? It stays there until the next one. You can also open the app and tap **Rate the vibe now** whenever you like.
- Keep the app running. Locking the screen is fine; force-closing it stops the measurement.
- **Android:** a "Viibe Check is measuring" notification stays visible during the session. That's what keeps it measuring with the screen off, so leave it there. If your phone asks about battery optimisation for Viibe Check, choose **Don't optimise** / **Unrestricted**.

**Deciding where to go next:** the **Live** tab shows which venues are moving right now, from phones already there: how many are dancing, the energy, whether it's rising, the music and how crowded it is. Run a session at a venue for 10 minutes and the Live tab unlocks for the rest of the night. You also get 2 free Night Passes to try it.

**When you leave:**
1. Open Viibe Check and tap **Stop**. If you forget, the session stops by itself after about 20 minutes without music.
2. Look at the Summary to see how the sensors read your night.

---

## Rating guide

| Rating | Label | When to use |
|--------|-------|-------------|
| 💀 | Dead | Flat, empty or boring; nobody is really into it |
| 🙂 | Decent | Good atmosphere, you're enjoying it |
| 🔥 | Best | Really buzzing, the best moments of the night |

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

- **No audio is stored or uploaded.** Sound is analysed on the phone a few seconds at a time and then discarded. Song recognition sends Apple only an irreversible fingerprint. The app keeps a bass-loudness curve (4 values per second), which cannot reproduce speech or music; with the 10-second movement readings, it is deleted after 90 days.
- **Location is used only to recognise the venue**, while the app is open. Your coordinates are never stored; only the club or bar's name is. The camera is used only to scan a group QR code.
- **No Bluetooth device IDs are stored.** Only the number of nearby devices.
- You are identified by a **random anonymous ID**, shown at the bottom of the home screen. No name, email or phone number.

Full policy: [docs/PRIVACY.md](docs/PRIVACY.md). To delete your data, send us your anonymous ID.

---

## Troubleshooting

**"I forgot to stop my session"** — No problem: a session stops by itself after about 20 minutes without music (10 if you're walking home), after 8 hours, or when the battery reaches 10%.

**"I missed the rating notification"** — Another one comes in 5 minutes.

**"Battery drain"** — Target is under 5% per hour. If it's more, tell us.

**"The vibe score looks wrong"** — That's useful data! Rate honestly; the gap between your rating and the score is exactly what we study.

**"TestFlight says the build expired"** — Builds last 90 days. Open TestFlight and install the newest one.

---

Questions? Message the group chat.

Thanks, you're helping build something genuinely new.
