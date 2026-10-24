# Viibe Check — Tester Guide

Thanks for helping test Viibe Check! This takes 2 minutes to read. Please read it.

---

## What this app does

Viibe Check measures the "vibe" of a venue using your phone's sensors:
- **Sound** (how loud it is, the tempo, how strong the bass is). Audio is analysed on the phone and never saved.
- **Song** playing (recognised on iPhone with Apple's ShazamKit)
- **Movement** (are you dancing, walking or standing still, and are you moving on the beat?)
- **Crowd density** (how many Bluetooth devices are nearby)

The day after, it asks you to give each of your top songs a thumbs up or down. If you like, it can also buzz every ~5 minutes to ask "How's the vibe?" (off by default; turn it on in privacy & data).

The experiment tests whether the sensor measurements match your honest ratings, and whether people moving in sync with the music and with each other means a better vibe.

---

## Install

- **iPhone:** open https://testflight.apple.com/join/arweYPp8 → install **TestFlight** from the App Store if asked → tap **Accept**, then **Install**. It's the same link for every update; new versions arrive through the TestFlight app.
- **Android:** open the APK download link on your phone → allow "install from unknown sources" when asked → install.

The first time you open it, allow **microphone, motion, Bluetooth and notifications**. Each one feeds a signal; the app still works if you refuse one, it just measures less.

---

## How to use it

**When you arrive:**
1. Open Viibe Check and tap **Start Session**.
2. The first time only, answer how much you enjoy dancing (1–5).
3. The app looks up the club or bar you're in (allow location when it asks) and asks **"Are you at …?"**. Tap **Yes** if it's right; **No** leaves it blank, and you can type the name yourself.
4. Where the phone will be: **Pocket** is preselected and best, so keep it there all night if you can.
5. With friends? Tap **GROUP** (on the start screen or the meter screen). One person shows their QR code with **SHARE**; everyone else taps **SCAN** (or uses the phone's Camera app). The screen shows how many phones are measuring in the group. If the venue has a Viibe Check code on a poster, scan that instead: it confirms the venue and puts you in tonight's crowd there (your friends' group is kept if you already joined one). If you forget, that's fine: the app can often work out who was together from the music.
6. Tap **Start Session** and put the phone in your pocket.

**While you're out:**
- **iPhone (iOS 16.2 or later):** while you measure, a quiet Viibe Check card sits on your lock screen with the venue, a timer, the song that is playing right now, and a **STOP** button (it asks you to unlock and confirm). The first time, your iPhone asks "Allow Live Activities from Viibe Check?": tap **Allow**.
- **Rating the vibe:** the main answer is the next day's thumbs up or down on your recap. If you want to rate during the night, tap the rate button on the Meter screen (💀 Dead, 🙂 Decent, 🔥 Best), or turn on **Buzz every 5 minutes** in privacy & data and answer from the notification.
- Missed one? It stays there until the next one. You can also open the app and tap **Rate the vibe now** whenever you like.
- If the card turns grey and says "Not measuring", the app was closed: open Viibe Check and start again.
- **Your night in songs:** after you press Stop (and again at 12:00 the next day), the app shows the songs you moved to most, with the DJ when we know the lineup. Tap 👍 or 👎 to tell us if we got it right, save them with **Add to Apple Music** or the **Spotify** button, and share the card to your Story.
- **Going out mode (iPhone, optional):** before you leave home, tap **Going out tonight?** on the Home screen and turn it on. Put your phone away. When it hears loud music with a beat *and* feels you dancing for a few minutes, it buzzes and the lock-screen card asks **"Sounds like a party. Start measuring?"**. Tap **Yes, start** without unlocking. On standby it records nothing; the orange microphone dot shows it's listening. You can also get an **"Out tonight?"** reminder on the nights you pick (Thursday, Friday and Saturday at 22:30 unless you change them).
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

**"I never get a rating notification"** — It is off by default now. Turn on **Buzz every 5 minutes** in privacy & data, or use the rate button on the Meter.

**"Battery drain"** — Target is under 5% per hour. If it's more, tell us.

**"The vibe score looks wrong"** — That's useful data! Rate honestly; the gap between your rating and the score is exactly what we study.

**"TestFlight says the build expired"** — Builds last 90 days. Open TestFlight and install the newest one.

---

Questions? Message the group chat.

Thanks, you're helping build something genuinely new.
