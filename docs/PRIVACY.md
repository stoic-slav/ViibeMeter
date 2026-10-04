# ViibeMeter privacy policy

*Last updated: 2 October 2026*

ViibeMeter is a research app. It tests whether phone sensors can measure the atmosphere ("vibe") at bars, clubs and parties, by comparing sensor readings with the ratings you give in the app. This page explains what it collects and what it never collects.

## What the app collects

While a session is running, the app turns sensor readings into **summary numbers** for each minute and uploads only those numbers:

| Sensor | What is kept | What is never kept |
|---|---|---|
| Microphone | Loudness (dB), tempo (BPM), how clear the beat is, and frequency-balance measures such as bass energy | Audio recordings |
| Motion (accelerometer, gyroscope) | How much you move, your movement tempo, and how well your movement matches the beat | Raw motion traces |
| Bluetooth | How many Bluetooth devices are nearby | Device names, addresses or identifiers |
| Song recognition | The track's ISRC code, genre, tempo and popularity rank, and when that playback of the track started | Song audio |
| Bass loudness | How loud the bass is, 4 values per second, as a curve for each minute. A loudness curve this coarse cannot reproduce speech or music | Audio recordings |
| Camera | Nothing. It is used only to scan a friend's group QR code, and only when you tap Scan | Photos or video |

The app does **not** use your location (GPS).

You also give us:
- your **vibe ratings** (1–5) during a session;
- an optional **venue name**;
- a **group code**: each session gets a random one, and friends who scan your QR code share it;
- where you carry the phone (pocket, hand or bag);
- a one-time answer about how much you enjoy dancing.

Each install has a **random anonymous ID**. We never ask for your name, email address or phone number.

## How audio is handled

During a session the app listens continuously and analyses the sound on the phone. On iPhone it keeps only the last few seconds in memory, overwriting them as it goes; on Android it records short clips (about 5 seconds) and **deletes each clip immediately** after analysis. Audio is never uploaded or saved, and it is gone when the session ends.

To recognise songs on iPhone, the app uses Apple's ShazamKit. A clip is turned into an irreversible fingerprint on the phone, and only that fingerprint is sent to Apple to look up the song. Audio cannot be reconstructed from it. If a song is recognised, its ISRC code is sent to Deezer's public API to look up its tempo and popularity. See [Apple's privacy policy](https://www.apple.com/legal/privacy/) and [Deezer's privacy policy](https://www.deezer.com/legal/personal-datas).

## Being grouped with other phones

To measure whether a crowd moves in sync, we need to know which phones were at the same event. This comes from the group code, and from the music itself: phones that heard the same playback of the same song at the same moment were very likely in the same place. Phones in the same room also hear the bass get louder and quieter at the same moments, so their bass-loudness curves match. So the data can show that two **anonymous** phones were at the same event at the same time. It cannot show where that was, or who you are.

## How long we keep data

Besides the per-minute summaries, the app saves a few numbers for every 10 seconds (how well your movement matches the beat, how much you move, your movement tempo, and the song's ISRC code). These 10-second readings and the bass-loudness curves are **deleted automatically after 90 days**. The per-minute summaries and ratings are kept for the research.

## Where data goes

Summary numbers and ratings are stored in a database hosted by Supabase in the EU (Paris region). They are used only for this research, are not sold, and are not shared with advertisers. Aggregated, anonymous results may be published.

## Your choices

- Sensors run only while you have a session open. Stop the session and collection stops.
- You can refuse any permission in iOS or Android settings. The app then works with fewer signals.
- To have your data deleted, contact us and give the anonymous ID shown in the app. Uninstalling the app also deletes everything stored on the phone.

## Contact

Leo Gerasimov — stoicslav@gmail.com
