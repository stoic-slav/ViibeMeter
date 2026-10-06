import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { supabase } from '../src/config/supabase';
import { QRCodeView } from '../src/components/GroupQR';
import { venueJoinUrl } from '../src/session/GroupCode';

const A = '#00E8A0';
const S1 = '#0d0d12';
const S2 = '#181824';
const TX = '#f0f0f5';
const TXD = '#9898c0';
const TXM = '#c0c0d8';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

interface FoundVenue { placeId: string; name: string; address: string | null }

/**
 * Make a venue's QR code: search Google Maps (find-venue Edge Function), pick the venue, and
 * show a large code to screenshot for a poster or table card. Scanning it with Viibe Check
 * confirms the venue and joins that night's crowd group there.
 */
export default function VenueCodeScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoundVenue[] | null>(null);
  const [chosen, setChosen] = useState<FoundVenue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (query.trim().length < 2) return;
    setBusy(true); setError(null); setChosen(null);
    try {
      // Bias the search to where the phone is (read on the phone, not stored)
      let lat: number | undefined, lng: number | undefined;
      const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
      if (perm?.granted) {
        const pos = await Location.getLastKnownPositionAsync({ maxAge: 600_000 }).catch(() => null);
        if (pos) { lat = pos.coords.latitude; lng = pos.coords.longitude; }
      }
      const { data, error: err } = await supabase.functions.invoke('find-venue', { body: { query: query.trim(), lat, lng } });
      if (err) throw err;
      setResults((data?.venues ?? []) as FoundVenue[]);
    } catch {
      setError("Couldn't search right now. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (chosen) {
    return (
      <View style={[s.container, { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 }]}>
        <Text style={s.posterTitle}>{chosen.name}</Text>
        <QRCodeView value={venueJoinUrl(chosen.placeId, chosen.name)} size={300} />
        <Text style={s.posterLine}>Scan with Viibe Check to join tonight's crowd</Text>
        <Text style={s.hint}>Take a screenshot to print it or share it with the venue.</Text>
        <TouchableOpacity onPress={() => setChosen(null)} style={{ paddingVertical: 10 }}>
          <Text style={s.link}>← choose another venue</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Text style={s.lead}>Make a QR code for a venue. Anyone who scans it with Viibe Check is linked to the venue and joins tonight's crowd there.</Text>
        <TextInput
          style={s.input}
          placeholder="Venue name and city, e.g. C12 Brussels"
          placeholderTextColor={TXD}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          onSubmitEditing={search}
          autoCorrect={false}
        />
        <TouchableOpacity style={[s.btn, busy && { opacity: 0.5 }]} onPress={search} disabled={busy} activeOpacity={0.85}>
          {busy ? <ActivityIndicator color="#030904" /> : <Text style={s.btnText}>SEARCH</Text>}
        </TouchableOpacity>
        {error && <Text style={s.hint}>{error}</Text>}
        {results?.length === 0 && <Text style={s.hint}>No venue found. Try adding the city.</Text>}
        {results?.map(v => (
          <TouchableOpacity key={v.placeId} style={s.row} onPress={() => setChosen(v)} activeOpacity={0.8}>
            <Text style={s.rowTitle}>{v.name}</Text>
            {v.address && <Text style={s.hint}>{v.address}</Text>}
          </TouchableOpacity>
        ))}
        <TouchableOpacity onPress={() => router.back()} style={{ alignItems: 'center', paddingVertical: 12 }}>
          <Text style={s.link}>close</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#060608' },
  lead: { color: TXM, fontSize: 14, lineHeight: 20 },
  input: { height: 50, borderRadius: 14, borderWidth: 1, borderColor: S2, backgroundColor: S1, color: TX, paddingHorizontal: 16, fontSize: 16 },
  btn: { height: 50, borderRadius: 14, backgroundColor: A, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: '#030904', letterSpacing: 2 },
  row: { backgroundColor: S1, borderColor: S2, borderWidth: 1, borderRadius: 14, padding: 14, gap: 4 },
  rowTitle: { color: TX, fontSize: 16, fontWeight: '600' },
  hint: { color: TXD, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  link: { fontFamily: MONO, fontSize: 11, color: TXD, textDecorationLine: 'underline' },
  posterTitle: { color: TX, fontSize: 26, fontWeight: '800', textAlign: 'center' },
  posterLine: { color: A, fontFamily: MONO, fontSize: 13, letterSpacing: 1, textAlign: 'center' },
});
