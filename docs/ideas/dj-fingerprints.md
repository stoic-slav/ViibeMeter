# Idea: recognising DJs (and their edits) from what phones hear

Status: idea (owner, 21 Oct 2026). Not planned. Builds on "Your night in songs" (build 25) and the venue lineups (`venue_sets`).

## The question
Can phones in a club recognise *who* is DJing, from a "mixing DNA", so unrecognised edits get credited automatically, without a lineup?

## What research says (checked 21 Oct 2026)
- **No published work identifies a specific DJ from the sound of their mix.** Research on DJ mixes covers:
  - **Aligning mixes to their source tracks:** Kim et al., ISMIR 2020, 1,557 mixes from 1001Tracklists, giving cue points and transition lengths ([paper](https://arxiv.org/abs/2008.10267v1), [ISMIR](https://program.ismir2020.net/poster_5-18.html)).
  - **Reverse-engineering transitions:** KAIST ([lab](https://mac.kaist.ac.kr/ai_dj.html)).
  - **Measuring transition length and smoothness with audio embeddings:** Williams, Barthet et al., AES 2024 ([paper](https://comma.eecs.qmul.ac.uk/assets/pdf/DJ_Timbre_Tool_AES_Paper.pdf)).
  - **EDM subgenre classification.**
- **Track ID in mixes is where industry is moving.** Beatport launched "Track ID" (May 2026), tuned for pitch-shifted edits and blends where Shazam fails ([EDMTunes](https://www.edmtunes.com/2026/05/beatport-launches-track-id-music-discovery-tool-for-djs/)). Unreleased "IDs" are still mostly identified by people (1001Tracklists, r/IDthisTrack) ([NME](https://www.nme.com/?p=1986191), [DJ TechTools/Thump](https://thump.vice.com/en_uk/article/6-ways-to-identify-tracks-without-ever-using-shazam)).

## Assessment
- **A pure "style DNA" is a long shot from a phone in a pocket.** Transition style, EQ habits and FX need clean audio; a muffled club recording keeps tempo, bass, loudness and structure. With enough data a style classifier might separate genres or DJ styles, but telling two techno DJs apart by style alone is unproven and needs a lot of labelled nights.
- **The DJ's *selection* is a much stronger DNA, especially their own edits.**
  - DJs replay their signature edits and IDs across many nights. If phones store a robust fingerprint of the music Shazam can't name (spectral landmark hashes, never audio), the same edit heard on several nights becomes recognisable.
  - The lineups we already record (`venue_sets`) label which DJ was playing. So: "this unknown edit was heard in 4 sets, all by DJ X" → credit DJ X automatically the next time, even at a venue with no lineup.
- **DJs could also register their own edits** (upload once → reference fingerprints → instant recognition and credit). DJs want credit, so this makes them promoters of the app, and it fits venue partnerships (`docs/ideas/venue-beacons.md`).

## What it would take
1. More nights with known lineups (partner venues).
2. An on-device landmark fingerprint for minutes without a Shazam match: an open algorithm in the style of Panako/Olaf. Only hashes are uploaded, and only for music minutes. This needs a privacy review, because hashes come from ambient sound, even if they are irreversible.
3. Server-side matching of hashes across nights, linked to lineups; a DJ edit catalogue; later a page for DJs to register their edits.
4. **Effort:** about 1–2 weeks for 2–3, and it is only useful after dozens of nights. Revisit when Phase 1 has data and a venue or DJ partners.
