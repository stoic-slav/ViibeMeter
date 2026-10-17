import { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, Alert, Linking, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { getConsent, saveConsent, Consent } from '../src/storage/Consent';
import { getDeviceId } from '../src/storage/DeviceIdentity';
import { deleteMyData } from '../src/storage/DataDeletion';
import { SensorRow, SENSOR_TEXT, PRIVACY_URL } from '../src/components/SensorConsent';

const A = '#00E8A0';
const DNG = '#e84560';
const TXM = '#c0c0d8';
const TXD = '#9898c0';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

/**
 * Privacy & data: change which sensors are allowed (takes effect from the next measurement),
 * see the anonymous ID, read the policy, and delete everything (GDPR rights to withdraw consent
 * and to erasure).
 */
export default function PrivacyScreen() {
  const router = useRouter();
  const [consent, setConsent] = useState<Consent | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useFocusEffect(useCallback(() => {
    getConsent().then(setConsent);
    getDeviceId().then(setDeviceId).catch(() => {});
  }, []));

  const toggle = async (sensor: 'motion' | 'bluetooth' | 'location', value: boolean) => {
    if (!consent) return;
    setConsent(await saveConsent({ motion: consent.motion, bluetooth: consent.bluetooth, location: consent.location, [sensor]: value }));
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
        <Text style={st.lead}>What Viibe Check may use. Changes apply from the next measurement.</Text>
        {consent ? (
          <>
            <SensorRow title="Microphone" body={SENSOR_TEXT.mic} value locked />
            <SensorRow title="Motion" body={SENSOR_TEXT.motion} value={consent.motion} onChange={v => toggle('motion', v)} />
            <SensorRow title="Bluetooth" body={SENSOR_TEXT.bluetooth} value={consent.bluetooth} onChange={v => toggle('bluetooth', v)} />
            <SensorRow title="Location" body={SENSOR_TEXT.location} value={consent.location} onChange={v => toggle('location', v)} />
            <Text style={st.hint}>Agreed on {new Date(consent.acceptedAt).toLocaleDateString()} (version {consent.version}).</Text>
          </>
        ) : (
          <Text style={st.hint}>You haven't agreed yet. You'll be asked when you start your first session.</Text>
        )}

        <Text style={[st.label, { marginTop: 12 }]}>YOUR ANONYMOUS ID</Text>
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
  deleteBtn: { height: 50, borderRadius: 14, borderWidth: 1, borderColor: DNG + '88', alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  deleteText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: DNG, letterSpacing: 2 },
});
