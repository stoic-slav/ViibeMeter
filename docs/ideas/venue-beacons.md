# Idea: Bluetooth beacons at partner venues

Status: idea for venue partnerships (owner liked it, 18 Oct 2026). Not planned for a build yet. Raise it in partner talks, starting with C12 / Deep in House (`docs/outreach/drafts-2026-10.md`).

## What it is
A partner venue sticks a small Bluetooth beacon (about €10–25, coin battery lasting 1–3 years) behind the bar or near the DJ booth. When a Viibe Check user walks in, their phone notices the beacon even if the app is closed and shows:

> **You're at C12. Start measuring?**

One tap opens the app and starts a session with the venue already confirmed.

## Why it's good
- **No GPS and no listening:** the phone doesn't need location permission, and nothing is recorded before the person says yes.
- **Nobody has to remember to start.** This is the biggest gap in the data so far.
- **Exact venue, even room:** better than a Google Maps guess or a poster QR code. Two beacons (main room, second room) could tell rooms apart, which helps crowd sync (phones in the same room).
- **Automatic crowd group:** it joins that night's venue group (`V-…`, the same as scanning the venue's QR code), so crowd sync works without anyone sharing codes.
- **A concrete ask for a partner:** "put this €20 beacon behind the bar", in exchange for anonymous crowd-energy insights for their nights.

## How it would work technically
- **The beacon** advertises a fixed Viibe Check Bluetooth service ID plus a short venue number (programmable beacons based on Nordic nRF52 chips can do this). It only broadcasts; it collects nothing.
- **iPhone:**
  - The app asks iOS to watch for that service ID in the background (Core Bluetooth). We already have the `bluetooth-central` background mode.
  - With Core Bluetooth state restoration, iOS relaunches the app in the background when the beacon is seen, even after iOS closed the app.
  - The app then posts a local notification. Push is not needed.
- **Use a custom service ID, not Apple's iBeacon format:** iBeacon detection needs location permission on iOS, which is what we want to avoid.
- **Android:** a background Bluetooth scan filtered by the same service ID (`BLUETOOTH_SCAN` with `neverForLocation`, which we already declare) can wake the app the same way.
- **Venue lookup:** a small server table maps venue number → Google place ID (the `venues` table). Sessions get `venue_source = 'beacon'`.
- **In or out:** signal strength tells "inside" from "walking past". The first threshold is a guess, to tune at the venue. The prompt fires only at night, once per venue per night.

## Limits
- **Only partner venues.** It needs a beacon installed and its battery checked now and then.
- **Force-quitting turns it off.** If someone swipes the app away, iOS doesn't relaunch it until they open it again.
- **Background scanning is slower** on iPhone, so the prompt may come a minute or two after arrival. That's fine for this use.
- **Privacy is light but should still be written down.** The phone learns only "beacon of venue X seen", which is the same as scanning the venue's QR code. This needs a line in `docs/PRIVACY.md` and the DPIA.

## Effort when a venue says yes
- About 2–3 days: native background scan + state restoration (`react-native-ble-plx` supports a restore identifier), notification, `beacon` venue source, venue-number table.
- One or two beacons, a test night at the venue to set the signal threshold, and a new build.
