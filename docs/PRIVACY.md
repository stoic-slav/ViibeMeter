# Viibe Check privacy policy

*Last updated: 17 October 2026*

Viibe Check is a research app. It tests whether phone sensors can measure the atmosphere ("vibe") at bars, clubs and parties, by comparing sensor readings with the ratings you give in the app. This page explains what it collects and what it never collects.

**Who can use it:** people aged 18 or over. Before your first session the app asks you to confirm your age and to choose which sensors it may use.

**Legal basis:** your consent (GDPR Art. 6(1)(a)), given per sensor in the app and withdrawable at any time. The microphone is required for a session; motion, Bluetooth and location are optional.

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
| Location (only while the app is open) | Which club or bar you are in: its Google Maps place ID and name, and roughly how far away it was | Your coordinates or any location history |
| Motion, again | Whether the phone is on your body or lying still (for example on a table), so a phone left behind doesn't count as you | Raw motion traces |
| Battery | The battery level at the start and end of a session | Nothing else |

**How the venue is recognised.** When you start a session, and when you open the app during one, the app takes one location reading, rounds it to about 11 metres, and sends it to our server, which asks Google Maps for the closest night club within 150 m (or else the closest bar or pub). The app then asks you whether you are there; only if you tap **Yes** is the place kept. **No** leaves the venue blank. If you scan a venue's Viibe Check code instead, that venue is used without a location lookup, and your session joins that night's group of phones at the venue. The Group screen shows only how many phones are measuring in your group, never who they are. Your coordinates are not stored, logged or uploaded to our database. Location is used only while the app is open ("While Using"), never in the background. You can refuse location and type the venue name yourself. See [Google's privacy policy](https://policies.google.com/privacy).

You also give us:
- your **vibe ratings** (💀 Dead, 🙂 Decent or 🔥 Best) during a session, where you gave them (notification, app, or the lock-screen card on iPhone) and whether the app had just asked;
- the **venue name**, recognised automatically or typed by you;
- a **group code**: each session gets a random one, and friends who scan your QR code share it;
- where you carry the phone (pocket, hand or bag);
- a one-time answer about how much you enjoy dancing.

Each install has a **random anonymous ID**. We never ask for your name, email address or phone number.

## How audio is handled

During a session the app listens continuously and analyses the sound on the phone. On iPhone it keeps only the last few seconds in memory, overwriting them as it goes; on Android it records short clips (about 5 seconds) and **deletes each clip immediately** after analysis. Audio is never uploaded or saved, and it is gone when the session ends.

To recognise songs on iPhone, the app uses Apple's ShazamKit. A clip is turned into an irreversible fingerprint on the phone, and only that fingerprint is sent to Apple to look up the song. Audio cannot be reconstructed from it. If a song is recognised, its ISRC code is sent to Deezer's public API to look up its tempo and popularity. See [Apple's privacy policy](https://www.apple.com/legal/privacy/) and [Deezer's privacy policy](https://www.deezer.com/legal/personal-datas).

## Your night in songs

After a session, the app shows the songs you moved to most, ranked on your phone from your movement and how it matched the beat. The titles and artists of recognised songs are kept **only on your phone** for this recap; they are never uploaded. If you tap 👍 or 👎 on an entry, we store that answer with the song's ISRC code (no title), when it played, its rank, and the DJ who played it if the venue's lineup is known, to learn whether movement predicts which songs people enjoy. **Add to Apple Music** asks for Apple Music access and creates the playlist in your own library; we don't see your library. The **Spotify** and **Apple Music** buttons open those apps on the song. Venue lineups (which DJ plays when) are public information we add for partner venues.

**DJ edits.** When Shazam can't name the music during a session, the iPhone app uploads a ShazamKit fingerprint of the last 30 seconds: an irreversible code from which no audio can be rebuilt, linked to your session. Fingerprints taken during a set we know (from the venue's lineup) help recognise that DJ's edits on later nights. They are deleted after 90 days. DJs who register their own edits give their DJ name, the edit's title, an optional contact and a fingerprint of the edit; we check each registration before it is used.

## Going out mode (iPhone, optional)

If you turn on **Going out mode**, which is off unless you switch it on and asks for your agreement the first time, the app listens on your phone *before* a session, to notice when you're at a party. Every 30 seconds it analyses 5 seconds of sound (how loud it is, whether there is a beat and bass) and a few seconds of movement (whether you're dancing), on the phone. When both happen for a few minutes at night, it asks "Start measuring?" on your lock screen. Nothing it hears or feels on standby is recorded, stored or uploaded; no song recognition runs. We keep only counts per evening: when it was on and off, how often it asked and what you answered, how many minutes had music or movement, and your battery level at the start and end, so we can check that it doesn't ask at the wrong moments or drain your battery. The orange microphone dot stays on while it listens. It turns itself off at 06:00, after 6 hours or at 20% battery. You can turn it off on the lock screen, in the app, or withdraw it in **privacy & data**. Optional reminders ("Out tonight?") are local notifications on the days you choose.

## Being grouped with other phones

To measure whether a crowd moves in sync, we need to know which phones were at the same event. This comes from the group code, and from the music itself: phones that heard the same playback of the same song at the same moment were very likely in the same place. Phones in the same room also hear the bass get louder and quieter at the same moments, so their bass-loudness curves match. So the data can show that two **anonymous** phones were at the same event at the same time, and which club or bar that was. It cannot show who you are or where you went outside the venues.

## How long we keep data

Besides the per-minute summaries, the app saves a few numbers for every 10 seconds (how well your movement matches the beat, how much you move, your movement tempo, and the song's ISRC code). These 10-second readings and the bass-loudness curves are **deleted automatically after 90 days**. Everything else (sessions, per-minute summaries, ratings and Going out counts) is **deleted automatically after 24 months**.

## Where data goes

Summary numbers and ratings are stored in a database hosted by Supabase in the EU (Paris region). They are used only for this research, are not sold, and are not shared with advertisers. Aggregated, anonymous results may be published.

## The live view

Viibe Check can show which venues are lively right now. It is built only from **summaries across several phones** at a venue (how many people are dancing, the energy, the music, how many phones contributed). No individual phone, person or rating is ever shown. When you open the live view, the app records which venues it showed you and when, so we can study whether the view helps people decide where to go.

## Your choices

- Sensors run only while you have a session open. Stop the session and collection stops. A session also **stops by itself** after about 20 minutes without music (10 if you're walking, for example on your way home), after 8 hours, or when your battery drops to 10%.
- You can refuse any permission in iOS or Android settings. The app then works with fewer signals.
- **Change what the app may use** at any time under **privacy & data** on the home screen: switch motion, Bluetooth or location off and they are no longer used from the next measurement.
- **Delete one session:** on Home, swipe a past session to the left and tap the red **Delete**. It removes that session with its measurements, ratings and song answers from the phone and from our database.
- **Delete your data yourself:** **privacy & data → Delete my data** removes every session, rating and measurement uploaded from your phone, wipes the phone's copy and gives you a new anonymous ID. You can also contact us with the anonymous ID shown in the app.
- Uninstalling the app deletes everything stored on the phone (data already uploaded stays until you delete it or it expires).

## Contact

Leo Gerasimov — stoicslav@gmail.com
