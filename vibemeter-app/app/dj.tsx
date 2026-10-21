import { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator, Linking } from 'react-native';
import { Audio } from 'expo-av';
import { supabase } from '../src/config/supabase';
import { getDeviceId } from '../src/storage/DeviceIdentity';
import { startCapture, stopCapture, isCapturing, beginReferenceSignature, endReferenceSignature } from '../modules/audio-capture';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';

const A = '#00E8A0';
const BG = '#060608';
const S1 = '#0d0d12';
const S2 = '#181824';
const TX = '#f0f0f5';
const TXM = '#c0c0d8';
const TXD = '#9898c0';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

const LISTEN_S = 60;        // one continuous fingerprint of a minute of the edit

/**
 * "Register your edits" for DJs (build 25), opened from a link we give them (vibemeter://dj).
 * The DJ plays their edit from a speaker; the phone takes one continuous ShazamKit fingerprint
 * of a minute (no audio is kept) and uploads them with their name and the edit's title. The edit is credited
 * at nights once we approve it (dj_edits.status). iPhone only.
 */
export default function DjScreen() {
  const [djName, setDjName] = useState('');
  const [title, setTitle] = useState('');
  const [contact, setContact] = useState('');
  const [link, setLink] = useState('');
  const [owns, setOwns] = useState(false);
  const [parts, setParts] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => () => { cancelled.current = true; }, []);

  const record = async () => {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) {
      Alert.alert('Microphone needed', 'Allow the microphone in Settings to register an edit.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    // Reuse the microphone if a session or Going out mode has it open; otherwise open it just for this
    const ownMic = !isCapturing();
    if (ownMic) await startCapture(12);
    setParts([]);
    setSeconds(0);
    setRecording(true);
    cancelled.current = false;
    beginReferenceSignature();
    try {
      for (let s = 1; s <= LISTEN_S && !cancelled.current; s++) {
        await new Promise(r => setTimeout(r, 1000));
        setSeconds(s);
      }
      const sig = await endReferenceSignature();
      if (sig && !cancelled.current) setParts([sig]);
    } finally {
      if (ownMic && !sensorOrchestrator.isRunning && !sensorOrchestrator.isStandby) await stopCapture();
      setRecording(false);
    }
  };

  // A public page for the edit (SoundCloud, Beatport, Instagram …); https:// is added if missing
  const normalizedLink = link.trim() ? (/^https?:\/\//i.test(link.trim()) ? link.trim().replace(/^http:/i, 'https:') : `https://${link.trim()}`) : null;

  const submit = async () => {
    setSending(true);
    try {
      const { error } = await supabase.rpc('register_dj_edit', {
        p_device_id: await getDeviceId(), p_dj_name: djName.trim(), p_title: title.trim(),
        p_contact: contact.trim() || null, p_signatures: parts, p_link: normalizedLink,
      });
      if (error) throw new Error(error.message);
      Alert.alert('Thanks! 🎧', `"${title.trim()}" is registered. We check every edit; once approved, Viibe Check credits you whenever it plays.`);
      setTitle('');
      setLink('');
      setParts([]);
      setOwns(false);
    } catch {
      Alert.alert("Couldn't send it", 'Check your internet connection and try again.');
    } finally {
      setSending(false);
    }
  };

  const ready = djName.trim().length > 0 && title.trim().length > 0 && owns && parts.length > 0 && !recording;

  return (
    <ScrollView style={st.container} contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 120 }} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
      <Text style={st.kicker}>FOR DJS</Text>
      <Text style={st.title}>Register your edits</Text>
      <Text style={st.body}>
        Play your edit loud from a speaker and hold this phone near it for one minute. Viibe Check keeps a fingerprint of it
        (no audio) and, once we've checked it, credits you in people's "night in songs" whenever it plays.
      </Text>

      <View style={st.card}>
        <Text style={st.label}>DJ NAME</Text>
        <TextInput style={st.input} value={djName} onChangeText={setDjName} placeholder="As shown on lineups" placeholderTextColor={TXD} maxLength={80} />
        <Text style={st.label}>EDIT TITLE</Text>
        <TextInput style={st.input} value={title} onChangeText={setTitle} placeholder="e.g. Levitating (your name edit)" placeholderTextColor={TXD} maxLength={120} />
        <Text style={st.label}>LINK TO THE EDIT (OPTIONAL)</Text>
        <TextInput style={st.input} value={link} onChangeText={setLink} placeholder="SoundCloud, Beatport or Instagram" placeholderTextColor={TXD} autoCapitalize="none" keyboardType="url" maxLength={300} />
        <Text style={st.label}>CONTACT (OPTIONAL)</Text>
        <TextInput style={st.input} value={contact} onChangeText={setContact} placeholder="Email or Instagram, so we can verify" placeholderTextColor={TXD} autoCapitalize="none" maxLength={200} />
      </View>

      <TouchableOpacity style={st.agreeRow} onPress={() => setOwns(o => !o)} activeOpacity={0.8}>
        <View style={[st.checkbox, owns && { backgroundColor: A, borderColor: A }]}>
          {owns && <Text style={{ color: '#030904', fontWeight: '700' }}>✓</Text>}
        </View>
        <Text style={[st.body, { flex: 1 }]}>I made this edit (or may register it), and agree that Viibe Check stores its fingerprint and my details above.</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[st.secondaryBtn, recording && { borderColor: A }]} onPress={record} disabled={recording}>
        {recording
          ? <Text style={[st.secondaryText, { color: A }]}>LISTENING… {seconds}/{LISTEN_S} S</Text>
          : <Text style={st.secondaryText}>{parts.length > 0 ? 'RECORDED ✓ · LISTEN AGAIN' : '🎧  LISTEN FOR 1 MINUTE'}</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={[st.primaryBtn, (!ready || sending) && { opacity: 0.4 }]} disabled={!ready || sending} onPress={submit}>
        {sending ? <ActivityIndicator color="#030904" /> : <Text style={st.primaryText}>REGISTER EDIT</Text>}
      </TouchableOpacity>
      <Text style={st.hint}>Tip: start from the part people know best (the drop), and keep the room quiet.</Text>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  kicker: { fontFamily: MONO, fontSize: 11, color: A, letterSpacing: 3 },
  title: { fontSize: 26, fontWeight: '700', color: TX },
  body: { color: TXM, fontSize: 14, lineHeight: 20 },
  hint: { fontFamily: MONO, fontSize: 11, color: TXD, textAlign: 'center' },
  card: { backgroundColor: S1, borderWidth: 1, borderColor: S2, borderRadius: 16, padding: 14, gap: 8 },
  label: { fontFamily: MONO, fontSize: 11, color: TXM, letterSpacing: 2, marginTop: 4 },
  input: { height: 48, borderRadius: 12, backgroundColor: BG, borderWidth: 1, borderColor: S2, color: TX, fontSize: 15, paddingHorizontal: 14 },
  agreeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: TXD, alignItems: 'center', justifyContent: 'center' },
  primaryBtn: { height: 52, borderRadius: 14, backgroundColor: A, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontFamily: MONO, fontSize: 13, fontWeight: '700', color: '#030904', letterSpacing: 2 },
  secondaryBtn: { height: 50, borderRadius: 14, borderWidth: 1, borderColor: TXD + '66', alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: TXM, letterSpacing: 2 },
});
