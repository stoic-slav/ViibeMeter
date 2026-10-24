import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import { MomentRow, getSessionMoments } from '../storage/LocalBuffer';
import { getMomentSettings } from '../storage/MomentSettings';
import { momentKeeper } from '../session/MomentKeeper';
import { isCapturing } from '../../modules/audio-capture';
import { MOMENTS } from '../config/constants';

const A = '#00E8A0';
const S1 = '#0d0d12';
const S2 = '#181824';
const TX = '#f0f0f5';
const TXM = '#c0c0d8';
const TXD = '#9898c0';
const DNG = '#e84560';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

type Layer = 'clean' | 'raw';

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * "Your best moments" on the recap: the clips kept from the night's strongest dancing (opt-in).
 * Play the cleaned version or the clip as it was heard, delete any of them. Shows a quiet hint
 * about the option when it is off and nothing was kept.
 */
export function MomentsSection({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [moments, setMoments] = useState<MomentRow[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [playing, setPlaying] = useState<{ id: string; layer: Layer } | null>(null);
  const sound = useRef<Audio.Sound | null>(null);

  const load = useCallback(async () => {
    setEnabled((await getMomentSettings()).keepAcceptedAt != null);
    setMoments(await getSessionMoments(sessionId));
  }, [sessionId]);

  useEffect(() => {
    load();
    // Clips from tonight may still be waiting to be cleaned
    momentKeeper.processPending().then(load).catch(() => {});
    return () => { sound.current?.unloadAsync().catch(() => {}); };
  }, [load]);

  // While a clip is being cleaned, look again every few seconds
  const waiting = moments?.some(m => !m.cleanPath) ?? false;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [waiting, load]);

  const stop = async () => {
    const s = sound.current;
    sound.current = null;
    setPlaying(null);
    if (s) await s.unloadAsync().catch(() => {});
  };

  const play = async (m: MomentRow, layer: Layer) => {
    const same = playing?.id === m.id && playing.layer === layer;
    await stop();
    if (same) return;
    const path = layer === 'clean' && m.cleanPath ? m.cleanPath : m.rawPath;
    try {
      // Don't touch the audio mode while the microphone is open for a session or standby
      if (!isCapturing()) await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: false });
      const { sound: s } = await Audio.Sound.createAsync({ uri: path }, { shouldPlay: true }, status => {
        if (status.isLoaded && status.didJustFinish) stop();
      });
      sound.current = s;
      setPlaying({ id: m.id, layer });
    } catch {
      Alert.alert("Couldn't play it", 'The clip may have been removed.');
      load();
    }
  };

  const remove = (m: MomentRow) => {
    Alert.alert(
      'Delete this moment?',
      m.sharedAt != null ? 'It is removed from your phone and from our storage. This can\'t be undone.' : 'It is removed from your phone. This can\'t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            await stop();
            try {
              await momentKeeper.deleteMoment(m.id);
              load();
            } catch {
              Alert.alert("Couldn't delete", 'Check your internet connection and try again. Nothing was deleted.');
            }
          },
        },
      ],
    );
  };

  if (Platform.OS !== 'ios' || moments == null) return null;
  if (moments.length === 0) {
    if (enabled) {
      return (
        <View style={st.card}>
          <Text style={st.kicker}>YOUR BEST MOMENTS</Text>
          <Text style={st.hint}>No moment was kept this night. A clip is kept when you dance harder than usual to loud music.</Text>
        </View>
      );
    }
    return (
      <TouchableOpacity style={st.card} onPress={() => router.push('/privacy')} activeOpacity={0.8}>
        <Text style={st.kicker}>YOUR BEST MOMENTS</Text>
        <Text style={st.hint}>Want to replay the moments you danced hardest? Turn on "Keep my best moments" in privacy & data. Off by default.</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={st.kicker}>YOUR BEST MOMENTS</Text>
      {moments.map(m => (
        <View key={m.id} style={st.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={st.title} numberOfLines={1}>{m.songTitle ? `${m.songTitle}${m.songArtist ? ` · ${m.songArtist}` : ''}` : 'Music Shazam could not name'}</Text>
              <Text style={st.hint}>
                {clock(m.startedAt)} · {Math.round(m.durationMs / 1000)} s{m.sharedAt != null ? ' · sent to us' : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={() => remove(m)} hitSlop={10}><Text style={[st.hint, { color: DNG }]}>DELETE</Text></TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {m.cleanPath ? (
              <TouchableOpacity style={[st.btn, playing?.id === m.id && playing.layer === 'clean' && st.btnOn]} onPress={() => play(m, 'clean')}>
                <Text style={st.btnText}>{playing?.id === m.id && playing.layer === 'clean' ? '■ STOP' : '▶ CLEANED'}</Text>
              </TouchableOpacity>
            ) : (
              <View style={st.btn}><Text style={[st.btnText, { color: TXD }]}>CLEANING…</Text></View>
            )}
            <TouchableOpacity style={[st.btn, playing?.id === m.id && playing.layer === 'raw' && st.btnOn]} onPress={() => play(m, 'raw')}>
              <Text style={st.btnText}>{playing?.id === m.id && playing.layer === 'raw' ? '■ STOP' : '▶ AS HEARD'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
      <Text style={st.hint}>Kept for {MOMENTS.RETAIN_DAYS} days, then deleted. Clips can pick up nearby voices.</Text>
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: S1, borderWidth: 1, borderColor: S2, borderRadius: 16, padding: 14, gap: 10 },
  kicker: { fontFamily: MONO, fontSize: 11, color: A, letterSpacing: 3 },
  title: { color: TX, fontSize: 15, fontWeight: '600' },
  hint: { fontFamily: MONO, fontSize: 11, color: TXD, lineHeight: 16 },
  btn: { flex: 1, height: 42, borderRadius: 12, borderWidth: 1, borderColor: TXD + '66', alignItems: 'center', justifyContent: 'center' },
  btnOn: { borderColor: A, backgroundColor: A + '22' },
  btnText: { fontFamily: MONO, fontSize: 11, fontWeight: '700', color: TXM, letterSpacing: 1.5 },
});
