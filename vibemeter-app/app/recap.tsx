import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, Alert, Linking, Share, ActivityIndicator } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { captureRef } from 'react-native-view-shot';
import { getOrBuildRecap, buildRecap, answerRecapItem, StoredRecap } from '../src/session/NightRecapService';
import { createAppleMusicPlaylist, isMusicLibraryAvailable } from '../modules/music-library';
import { canShareToInstagram, shareToInstagramStory } from '../modules/story-share';
import { LinearGradient } from 'expo-linear-gradient';
import Constants from 'expo-constants';

const A = '#00E8A0';
const BG = '#060608';
const S1 = '#0d0d12';
const S2 = '#181824';
const TX = '#f0f0f5';
const TXM = '#c0c0d8';
const TXD = '#9898c0';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

type Item = StoredRecap['items'][number];

// The share card: Viibe green fading into a deep night purple (owner's choice, 21 Oct)
const CARD_TOP = '#0e5c49';
const CARD_MID = '#1f1550';
const CARD_BOTTOM = '#0b0418';
const INSTAGRAM_APP_ID: string | null = (Constants.expoConfig?.extra as any)?.instagramAppId ?? null;

function cardSubtitle(i: Item): string {
  return i.kind === 'song'
    ? [i.artist, i.djName].filter(Boolean).join(' · ')
    : (i.djName ?? `${time(i.startsAt)}–${time(i.endsAt)}`);
}

/** Wrapped-style card for Stories: big #1, the rest of the top 5, and the night's numbers. */
function WrappedCard({ recap, duration }: { recap: StoredRecap; duration: string }) {
  const [top, ...rest] = recap.items;
  const hours = ((recap.endedAt - recap.startedAt) / 3_600_000).toFixed(1);
  return (
    <LinearGradient colors={[CARD_TOP, CARD_MID, CARD_BOTTOM]} locations={[0, 0.55, 1]} start={{ x: 0, y: 0 }} end={{ x: 0.7, y: 1 }} style={st.shareCard}>
      <Text style={st.shareKicker}>MY NIGHT IN SONGS</Text>
      <Text style={st.shareTitle} numberOfLines={1}>{recap.venueName ?? 'Night out'}</Text>
      <Text style={st.shareMeta}>{day(recap.startedAt)} · {duration}</Text>

      <View style={{ marginTop: 26 }}>
        <Text style={st.shareBigRank}>#1</Text>
        <Text style={st.shareTopTitle} numberOfLines={2}>{itemTitle(top)}</Text>
        <Text style={st.shareTopSub} numberOfLines={1}>{cardSubtitle(top)}</Text>
      </View>

      <View style={{ gap: 12, marginTop: 24 }}>
        {rest.map((item, n) => (
          <View key={item.id} style={{ flexDirection: 'row', gap: 12, alignItems: 'baseline' }}>
            <Text style={st.shareRank}>{n + 2}</Text>
            <View style={{ flex: 1 }}>
              <Text style={st.shareItem} numberOfLines={1}>{itemTitle(item)}</Text>
              <Text style={st.shareSub} numberOfLines={1}>{cardSubtitle(item)}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={{ flex: 1 }} />
      <View style={st.shareStats}>
        <View style={st.shareStat}><Text style={st.shareStatNum}>{recap.dancingMinutes}</Text><Text style={st.shareStatLabel}>MIN DANCING</Text></View>
        <View style={st.shareStat}><Text style={st.shareStatNum}>{recap.recognisedSongs}</Text><Text style={st.shareStatLabel}>SONGS</Text></View>
        <View style={st.shareStat}><Text style={st.shareStatNum}>{hours}</Text><Text style={st.shareStatLabel}>HOURS OUT</Text></View>
      </View>
      <Text style={st.shareFooter}>✓ VIIBE CHECK</Text>
    </LinearGradient>
  );
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (ms: number) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });

// Music Shazam couldn't name (edits, mixes, unreleased tracks) is shown as the DJ's edits
function itemTitle(i: Item): string {
  return i.kind === 'song' ? (i.title ?? 'Unknown title') : (i.title ?? 'DJ edits');
}

function itemSubtitle(i: Item): string {
  if (i.kind === 'song') return [i.artist, i.djName && `played by ${i.djName}`].filter(Boolean).join(' · ');
  return [i.djName, `${time(i.startsAt)}–${time(i.endsAt)}`].filter(Boolean).join(' · ');
}

function spotifyUrl(i: Item): string {
  return `https://open.spotify.com/search/${encodeURIComponent([i.title, i.artist].filter(Boolean).join(' '))}`;
}

function appleMusicUrl(i: Item): string {
  return i.appleMusicId
    ? `https://music.apple.com/song/${i.appleMusicId}`
    : `https://music.apple.com/search?term=${encodeURIComponent([i.title, i.artist].filter(Boolean).join(' '))}`;
}

/**
 * "Your night in songs" (build 25): the songs a person moved to most, ranked from movement with
 * no rating needed, with 👍/👎, Spotify and Apple Music links, an Apple Music playlist and a
 * share card. Opened from the session summary and from the 12:00 notification.
 */
export default function RecapScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>();
  const [recap, setRecap] = useState<StoredRecap | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const cardRef = useRef<View>(null);
  const [igReady, setIgReady] = useState(false);

  useEffect(() => {
    if (INSTAGRAM_APP_ID) canShareToInstagram().then(setIgReady);
  }, []);

  useFocusEffect(useCallback(() => {
    if (!sessionId) { setLoading(false); return; }
    setLoading(true);
    getOrBuildRecap(sessionId).then(setRecap).finally(() => setLoading(false));
  }, [sessionId]));

  const answer = async (item: Item, liked: boolean) => {
    if (!recap) return;
    setRecap(await answerRecapItem(recap, item.id, liked));
  };

  const songs = recap?.items.filter(i => i.kind === 'song') ?? [];
  const place = recap?.venueName ?? 'tonight';
  const playlistName = recap ? `Viibe Check · ${recap.venueName ?? 'Night out'} · ${day(recap.startedAt)}` : '';

  const addToAppleMusic = async () => {
    if (!recap || songs.length === 0) return;
    setSaving(true);
    try {
      // Never leave the button spinning (e.g. no Apple Music account on the phone)
      const r = await Promise.race([
        createAppleMusicPlaylist(playlistName, 'The songs you moved to most, ranked by Viibe Check.', songs),
        new Promise<{ ok: false; reason: 'error'; message: string }>(resolve =>
          setTimeout(() => resolve({ ok: false, reason: 'error', message: 'timeout' }), 25_000)),
      ]);
      console.log('[Recap] Apple Music:', JSON.stringify(r));
      if (r.ok) {
        Alert.alert('Playlist created 🎶', `"${playlistName}" with ${r.added} song${r.added === 1 ? '' : 's'} is in your Apple Music library.`, [
          { text: 'OK' }, { text: 'Open Music', onPress: () => Linking.openURL('music://') },
        ]);
      } else if (r.reason === 'no_subscription') {
        Alert.alert('Apple Music subscription needed', 'Playlists need Apple Music. Use the Spotify or Apple Music button next to each song instead.');
      } else if (r.reason === 'denied') {
        Alert.alert('Apple Music access needed', 'Allow Viibe Check to use Apple Music in Settings.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]);
      } else {
        Alert.alert("Couldn't create the playlist", 'Use the Spotify or Apple Music button next to each song instead.');
      }
    } finally {
      setSaving(false);
    }
  };

  const capture = () => captureRef(cardRef, { format: 'jpg', quality: 0.9, result: 'tmpfile', width: 1080, height: 1920 });

  const share = async () => {
    try {
      await Share.share({ url: await capture(), message: `My night at ${place} in songs 🎶 (Viibe Check)` });
    } catch (err) {
      console.warn('[Recap] Share failed:', err);
    }
  };

  // Straight into a new Instagram Story (needs the Meta App ID in app.json extra.instagramAppId)
  const shareToStory = async () => {
    try {
      const ok = await shareToInstagramStory(await capture(), INSTAGRAM_APP_ID!, CARD_TOP, CARD_BOTTOM);
      if (!ok) await share();
    } catch (err) {
      console.warn('[Recap] Instagram share failed:', err);
    }
  };

  if (loading) {
    return <View style={[st.container, st.center]}><ActivityIndicator color={A} /></View>;
  }
  if (!recap) {
    return <View style={[st.container, st.center]}><Text style={st.body}>No recap for this session.</Text></View>;
  }

  const minutes = Math.round((recap.endedAt - recap.startedAt) / 60_000);
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`;

  return (
    <ScrollView style={st.container} contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 120 }}>
      <View>
        <Text style={st.kicker}>YOUR NIGHT IN SONGS</Text>
        <Text style={st.title}>{recap.venueName ?? 'Your night'} · {day(recap.startedAt)}</Text>
        <Text style={st.meta}>
          {duration} · {recap.dancingMinutes} min dancing · {recap.recognisedSongs} song{recap.recognisedSongs === 1 ? '' : 's'} recognised
        </Text>
      </View>

      {recap.items.length === 0 ? (
        <View style={st.card}>
          <Text style={st.body}>
            Not enough to rank this time. Keep the phone in your pocket while you dance, and the songs you move to most will show up here.
          </Text>
          <TouchableOpacity style={st.secondaryBtn} onPress={() => sessionId && buildRecap(sessionId).then(setRecap)}>
            <Text style={st.secondaryText}>TRY AGAIN</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {recap.items.map((item, n) => (
            <View key={item.id} style={st.card}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <Text style={st.rank}>{n + 1}</Text>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={st.itemTitle} numberOfLines={2}>{itemTitle(item)}</Text>
                  <Text style={st.meta} numberOfLines={1}>{itemSubtitle(item)}</Text>
                  <Text style={[st.meta, { color: A }]}>{item.reason}</Text>
                </View>
              </View>
              <View style={st.row}>
                <TouchableOpacity style={[st.chip, item.liked === true && st.chipOn]} onPress={() => answer(item, true)}>
                  <Text style={st.chipText}>👍</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[st.chip, item.liked === false && st.chipOn]} onPress={() => answer(item, false)}>
                  <Text style={st.chipText}>👎</Text>
                </TouchableOpacity>
                {item.kind === 'song' && (
                  <>
                    <View style={{ flex: 1 }} />
                    <TouchableOpacity style={st.chip} onPress={() => Linking.openURL(spotifyUrl(item))}>
                      <Text style={st.chipLabel}>SPOTIFY</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={st.chip} onPress={() => Linking.openURL(appleMusicUrl(item))}>
                      <Text style={st.chipLabel}>APPLE MUSIC</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
          ))}
          <Text style={[st.meta, { textAlign: 'center' }]}>Did we get it right? 👍 or 👎 helps the app learn.</Text>

          {Platform.OS === 'ios' && isMusicLibraryAvailable && songs.length > 0 && (
            <TouchableOpacity style={[st.primaryBtn, saving && { opacity: 0.5 }]} onPress={addToAppleMusic} disabled={saving}>
              {saving ? <ActivityIndicator color="#030904" /> : <Text style={st.primaryText}>ADD TO APPLE MUSIC</Text>}
            </TouchableOpacity>
          )}

          {/* The share card (also the preview), captured at Story size (1080×1920) */}
          <View ref={cardRef} collapsable={false} style={st.shareFrame}>
            <WrappedCard recap={recap} duration={duration} />
          </View>
          {igReady ? (
            <>
              <TouchableOpacity style={st.igBtn} onPress={shareToStory}>
                <Text style={st.igText}>SHARE TO INSTAGRAM STORY</Text>
              </TouchableOpacity>
              <TouchableOpacity style={st.secondaryBtn} onPress={share}>
                <Text style={st.secondaryText}>MORE WAYS TO SHARE</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity style={st.secondaryBtn} onPress={share}>
              <Text style={st.secondaryText}>SHARE</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  center: { alignItems: 'center', justifyContent: 'center', padding: 30 },
  kicker: { fontFamily: MONO, fontSize: 11, color: A, letterSpacing: 3, marginBottom: 6 },
  title: { fontSize: 26, fontWeight: '700', color: TX },
  meta: { fontFamily: MONO, fontSize: 11, color: TXD },
  body: { color: TXM, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  card: { backgroundColor: S1, borderWidth: 1, borderColor: S2, borderRadius: 16, padding: 14, gap: 12 },
  rank: { fontFamily: MONO, fontSize: 22, fontWeight: '700', color: A, width: 24 },
  itemTitle: { color: TX, fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: { borderWidth: 1, borderColor: S2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: BG },
  chipOn: { borderColor: A, backgroundColor: A + '22' },
  chipText: { fontSize: 15 },
  chipLabel: { fontFamily: MONO, fontSize: 10, fontWeight: '700', color: TXM, letterSpacing: 1 },
  primaryBtn: { height: 52, borderRadius: 14, backgroundColor: A, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontFamily: MONO, fontSize: 13, fontWeight: '700', color: '#030904', letterSpacing: 2 },
  secondaryBtn: { height: 48, borderRadius: 14, borderWidth: 1, borderColor: TXD + '66', alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: TXM, letterSpacing: 2 },
  shareFrame: { aspectRatio: 9 / 16, borderRadius: 20, overflow: 'hidden' },
  shareCard: { flex: 1, padding: 26 },
  shareKicker: { fontFamily: MONO, fontSize: 11, fontWeight: '700', color: A, letterSpacing: 3 },
  shareTitle: { fontSize: 32, fontWeight: '800', color: '#ffffff', marginTop: 8 },
  shareMeta: { fontFamily: MONO, fontSize: 11, color: '#d6d0f0', marginTop: 4 },
  shareBigRank: { fontSize: 84, lineHeight: 88, fontWeight: '900', color: A, letterSpacing: -2 },
  shareTopTitle: { fontSize: 28, lineHeight: 33, fontWeight: '800', color: '#ffffff' },
  shareTopSub: { fontSize: 14, color: '#d6d0f0', marginTop: 4 },
  shareRank: { fontFamily: MONO, fontSize: 18, fontWeight: '700', color: A, width: 22 },
  shareItem: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  shareSub: { color: '#b9b2dd', fontSize: 12, marginTop: 2 },
  shareStats: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#ffffff22', paddingTop: 14, marginBottom: 14 },
  shareStat: { flex: 1 },
  shareStatNum: { fontSize: 30, fontWeight: '900', color: '#ffffff' },
  shareStatLabel: { fontFamily: MONO, fontSize: 9, fontWeight: '700', color: A, letterSpacing: 1.5, marginTop: 2 },
  shareFooter: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: A, letterSpacing: 3, textAlign: 'center' },
  igBtn: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#e1306c' },
  igText: { fontFamily: MONO, fontSize: 13, fontWeight: '700', color: '#ffffff', letterSpacing: 1.5 },
});
