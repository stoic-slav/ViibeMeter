import { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, Alert, Linking, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { getConsent, saveConsent, Consent } from '../src/storage/Consent';
import { getDeviceId } from '../src/storage/DeviceIdentity';
import { deleteMyData } from '../src/storage/DataDeletion';
import { SensorRow, SENSOR_TEXT, PRIVACY_URL } from '../src/components/SensorConsent';
import { getStandbySettings, saveStandbySettings } from '../src/storage/StandbySettings';
import { standby } from '../src/session/Standby';
import { getMomentSettings, saveMomentSettings, MomentSettings } from '../src/storage/MomentSettings';
import { getBuzzPrompts, setBuzzPrompts } from '../src/storage/PromptSettings';
import { momentKeeper } from '../src/session/MomentKeeper';
import { MOMENTS } from '../src/config/constants';

const A = '#00E8A0';
const DNG = '#e84560';
const TXM = '#c0c0d8';
const TXD = '#9898c0';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

/**
 * Settings: change which sensors are allowed (takes effect from the next measurement),
 * see the anonymous ID, read the policy, and delete everything (GDPR rights to withdraw consent
 * and to erasure).
 */
export default function PrivacyScreen() {
  const router = useRouter();
  const [consent, setConsent] = useState<Consent | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [standbyAllowed, setStandbyAllowed] = useState(false);
  const [moments, setMoments] = useState<MomentSettings>({ keepAcceptedAt: null, shareAcceptedAt: null });
  const [buzz, setBuzz] = useState(false);

  useFocusEffect(useCallback(() => {
    getConsent().then(setConsent);
    getDeviceId().then(setDeviceId).catch(() => {});
    getStandbySettings().then(st => setStandbyAllowed(st.acceptedAt != null));
    getMomentSettings().then(setMoments);
    getBuzzPrompts().then(setBuzz);
  }, []));

  // Withdrawing the Going out opt-in also turns standby off; it is asked again on the next use
  const withdrawStandby = async () => {
    await standby.disarm('user');
    await saveStandbySettings({ acceptedAt: null });
    setStandbyAllowed(false);
  };

  const toggle = async (sensor: 'motion' | 'bluetooth' | 'location', value: boolean) => {
    if (!consent) return;
    setConsent(await saveConsent({ motion: consent.motion, bluetooth: consent.bluetooth, location: consent.location, [sensor]: value }));
  };

  // "Best moments": two separate opt-ins, each explained before it is turned on
  const toggleKeep = (on: boolean) => {
    if (on) {
      Alert.alert(
        'Keep your best moments?',
        `While you dance, Viibe Check keeps about ${MOMENTS.CLIP_SECONDS} seconds of the room's music from your strongest moments, so you can play them back later. Clips stay on your phone, out of backups, and are deleted after ${MOMENTS.RETAIN_DAYS} days. Only clips where music clearly dominates are kept, but a clip can still pick up nearby voices. Off unless you turn it on; turn it off any time.`,
        [{ text: 'Not now', style: 'cancel' }, { text: 'Turn on', onPress: async () => setMoments(await saveMomentSettings({ keepAcceptedAt: Date.now() })) }],
      );
    } else {
      Alert.alert('Delete your kept clips too?', 'Turning this off stops new clips. You can also delete the ones already kept, including any sent to us.', [
        { text: 'Keep them', onPress: async () => setMoments(await saveMomentSettings({ keepAcceptedAt: null })) },
        {
          text: 'Delete them', style: 'destructive', onPress: async () => {
            try {
              await momentKeeper.deleteAll();
              setMoments(await saveMomentSettings({ keepAcceptedAt: null }));
            } catch {
              Alert.alert("Couldn't delete", 'Check your internet connection and try again. Nothing was deleted.');
            }
          },
        },
      ]);
    }
  };

  const toggleShare = (on: boolean) => {
    if (on) {
      Alert.alert(
        'Send your best moments to us?',
        `Your kept clips are copied to our private storage, where only we can open them. We use them to improve the sound cleaning (separating music from voices and noise) and to combine clips that friends' phones recorded at the same moment. They carry your anonymous ID, not your name, and are deleted after ${MOMENTS.RETAIN_DAYS} days or when you delete them. A clip can pick up nearby voices. Off unless you turn it on; turn it off any time.`,
        [{ text: 'Not now', style: 'cancel' }, { text: 'Send them', onPress: async () => setMoments(await saveMomentSettings({ shareAcceptedAt: Date.now() })) }],
      );
    } else {
      saveMomentSettings({ shareAcceptedAt: null }).then(setMoments);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete all your data?',
      'This stops any running session and permanently deletes every session, rating and measurement from this phone and from our database. You start over with a new anonymous ID.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            setDeleting(true);
            try {
              const n = await deleteMyData();
              Alert.alert('Deleted', n > 0 ? `${n} session${n === 1 ? '' : 's'} and everything recorded with them are deleted.` : 'Your data is deleted.');
              router.replace('/');
            } catch {
              Alert.alert("Couldn't delete", 'Check your internet connection and try again. Nothing was deleted yet.');
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={st.container}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 120 }}>
        <Text style={st.lead}>Everything Viibe Check may use or keep, in one place. Changes apply from the next measurement.</Text>
        <Text style={[st.label, { marginTop: 4 }]}>WHAT THE APP MAY USE</Text>
        {consent ? (
          <>
            <SensorRow title="Microphone" body={SENSOR_TEXT.mic} value locked />
            <SensorRow title="Motion" body={SENSOR_TEXT.motion} value={consent.motion} onChange={v => toggle('motion', v)} />
            <SensorRow title="Bluetooth" body={SENSOR_TEXT.bluetooth} value={consent.bluetooth} onChange={v => toggle('bluetooth', v)} />
            <SensorRow title="Location" body={SENSOR_TEXT.location} value={consent.location} onChange={v => toggle('location', v)} />
            <Text style={st.hint}>Agreed on {new Date(consent.acceptedAt).toLocaleDateString()} (version {consent.version}).</Text>
            {Platform.OS === 'ios' && (
              <SensorRow
                title="Going out mode"
                body={standbyAllowed
                  ? 'Listening on standby before a session is allowed. Turn off to withdraw; you will be asked again next time.'
                  : 'Not in use. Turn it on from "Going out tonight?" on Home; it asks first.'}
                value={standbyAllowed}
                // Turning it on happens on the Going out screen, which explains it first
                onChange={v => { if (!v) withdrawStandby(); else router.push('/going-out'); }}
              />
            )}
          </>
        ) : (
          <Text style={st.hint}>You haven't agreed yet. You'll be asked when you start your first session.</Text>
        )}

        {Platform.OS === 'ios' && (
          <>
            <Text style={[st.label, { marginTop: 12 }]}>OPTIONAL EXTRAS</Text>
            <SensorRow
              title="Keep my best moments"
              body={`When on, ${MOMENTS.CLIP_SECONDS}-second clips of your strongest dancing stay on your phone for ${MOMENTS.RETAIN_DAYS} days, out of backups. Play them in your night's recap.`}
              value={moments.keepAcceptedAt != null}
              onChange={toggleKeep}
            />
            <SensorRow
              title="Send them to us"
              body={moments.keepAcceptedAt == null
                ? 'Needs "Keep my best moments". Sends the clips to our private storage to improve the audio cleaning.'
                : `When on, kept clips are copied to our private storage for ${MOMENTS.RETAIN_DAYS} days to improve the sound cleaning. Deleting a clip here deletes our copy.`}
              value={moments.shareAcceptedAt != null && moments.keepAcceptedAt != null}
              onChange={moments.keepAcceptedAt == null ? undefined : toggleShare}
            />
          </>
        )}
        <SensorRow
          title="Buzz every 5 minutes"
          body="When on, the phone vibrates every 5 minutes to ask how the vibe is. You can also rate any time on the Meter."
          value={buzz}
          onChange={async v => { setBuzz(v); await setBuzzPrompts(v); }}
        />

        <Text style={[st.label, { marginTop: 12 }]}>GOING OUT</Text>
        <TouchableOpacity style={st.linkRow} onPress={() => router.push('/going-out')} activeOpacity={0.8}>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={st.linkTitle}>Going out mode and reminders</Text>
            <Text style={st.hint}>Standby listening, and the "Out tonight?" reminder days and time.</Text>
          </View>
          <Text style={st.linkTitle}>›</Text>
        </TouchableOpacity>

        <Text style={[st.label, { marginTop: 12 }]}>YOUR DATA</Text>
        <Text style={st.hint}>Your anonymous ID</Text>
        <Text selectable style={st.id}>{deviceId ?? '…'}</Text>
        <Text style={st.hint}>Not linked to your name, Apple ID or phone number.</Text>

        <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_URL)} style={{ paddingVertical: 8 }}>
          <Text style={[st.hint, { textDecorationLine: 'underline' }]}>Read the privacy policy</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[st.deleteBtn, deleting && { opacity: 0.5 }]} onPress={confirmDelete} disabled={deleting} activeOpacity={0.85}>
          {deleting ? <ActivityIndicator color={DNG} /> : <Text style={st.deleteText}>DELETE MY DATA</Text>}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#060608' },
  lead: { color: TXM, fontSize: 14, lineHeight: 20 },
  label: { fontFamily: MONO, fontSize: 11, color: A, letterSpacing: 2 },
  id: { fontFamily: MONO, fontSize: 12, color: TXM },
  hint: { fontFamily: MONO, fontSize: 11, color: TXD, lineHeight: 16 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#0d0d12', borderWidth: 1, borderColor: '#181824', borderRadius: 16, padding: 14 },
  linkTitle: { color: '#f0f0f5', fontSize: 16, fontWeight: '600' },
  deleteBtn: { height: 50, borderRadius: 14, borderWidth: 1, borderColor: DNG + '88', alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  deleteText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: DNG, letterSpacing: 2 },
});
