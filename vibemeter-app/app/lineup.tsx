import { useEffect, useState } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';
import { supabase } from '../src/config/supabase';

const A = '#00E8A0';
const BG = '#060608';
const S1 = '#0d0d12';
const S2 = '#181824';
const TX = '#f0f0f5';
const TXM = '#c0c0d8';
const TXD = '#9898c0';
const DNG = '#e84560';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

interface FoundVenue { placeId: string; name: string; address: string | null }
interface SetRow { djName: string; djLink: string; start: string; end: string }

// A night runs from 12:00 on its date to 12:00 the next day (sets after midnight belong to it)
const NIGHT_START_HOUR = 12;

function nightOf(offsetDays: number): Date {
  const d = new Date();
  if (d.getHours() < NIGHT_START_HOUR) d.setDate(d.getDate() - 1); // 02:00 is still last night
  d.setDate(d.getDate() + offsetDays);
  d.setHours(NIGHT_START_HOUR, 0, 0, 0);
  return d;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "23:30" on the night starting at `night` (12:00); times before 12:00 are after midnight. */
function timeOnNight(night: Date, text: string): Date | null {
  const m = /^(\d{1,2})[:.h]?(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(night);
  d.setHours(h, min, 0, 0);
  if (h < NIGHT_START_HOUR) d.setDate(d.getDate() + 1);
  return d;
}

function normalizeLink(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  return /^https?:\/\//i.test(t) ? t.replace(/^http:/i, 'https:') : `https://${t}`;
}

const EMPTY_ROW: SetRow = { djName: '', djLink: '', start: '', end: '' };

/**
 * A venue's lineup, entered by the venue itself (vibemeter://lineup, with the edit code we give
 * them). Who plays when credits DJs in people's "night in songs" and teaches the app their edits.
 */
export default function LineupScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoundVenue[] | null>(null);
  const [venue, setVenue] = useState<FoundVenue | null>(null);
  const [code, setCode] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<SetRow[]>([{ ...EMPTY_ROW }]);
  const [busy, setBusy] = useState(false);

  const night = nightOf(offset);
  const nightEnd = new Date(night.getTime() + 24 * 3600_000);

  const search = async () => {
    if (query.trim().length < 2) return;
    setBusy(true);
    try {
      let lat: number | undefined, lng: number | undefined;
      const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
      if (perm?.granted) {
        const pos = await Location.getLastKnownPositionAsync({ maxAge: 600_000 }).catch(() => null);
        if (pos) { lat = pos.coords.latitude; lng = pos.coords.longitude; }
      }
      const { data, error } = await supabase.functions.invoke('find-venue', { body: { query: query.trim(), lat, lng } });
      if (error) throw error;
      setResults((data?.venues ?? []) as FoundVenue[]);
    } catch {
      Alert.alert("Couldn't search", 'Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    if (!venue) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('venue_editor_check', { p_place_id: venue.placeId, p_code: code.trim() });
      if (error || !data) Alert.alert('Wrong code', 'Check the venue code you received from Viibe Check.');
      else setUnlocked(true);
    } finally {
      setBusy(false);
    }
  };

  // The night's current lineup
  useEffect(() => {
    if (!unlocked || !venue) return;
    supabase.rpc('venue_sets_for', { p_place_id: venue.placeId, p_from: night.toISOString(), p_to: nightEnd.toISOString() })
      .then(({ data }) => {
        const sets = Array.isArray(data) ? data : [];
        setRows(sets.length > 0
          ? sets.map((s: any) => ({ djName: s.dj_name, djLink: s.dj_link ?? '', start: hhmm(Date.parse(s.starts_at)), end: hhmm(Date.parse(s.ends_at)) }))
          : [{ ...EMPTY_ROW }]);
      });
  }, [unlocked, venue?.placeId, offset]);

  const update = (i: number, change: Partial<SetRow>) => setRows(rs => rs.map((r, n) => (n === i ? { ...r, ...change } : r)));

  const save = async () => {
    if (!venue) return;
    const sets = [];
    for (const r of rows.filter(r => r.djName.trim())) {
      const start = timeOnNight(night, r.start);
      let end = timeOnNight(night, r.end);
      if (!start || !end) {
        Alert.alert('Check the times', `Use 24-hour times like 23:30 for ${r.djName.trim()}.`);
        return;
      }
      if (end <= start) end = new Date(end.getTime() + 24 * 3600_000);
      sets.push({ dj_name: r.djName.trim(), dj_link: normalizeLink(r.djLink), starts_at: start.toISOString(), ends_at: end.toISOString() });
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('save_venue_lineup', {
        p_place_id: venue.placeId, p_code: code.trim(), p_from: night.toISOString(), p_to: nightEnd.toISOString(), p_sets: sets,
      });
      if (error) throw error;
      Alert.alert('Lineup saved', `${data} set${data === 1 ? '' : 's'} for ${night.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}.`);
    } catch {
      Alert.alert("Couldn't save", 'Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!venue) {
    return (
      <ScrollView style={st.container} contentContainerStyle={st.content} keyboardShouldPersistTaps="handled">
        <Text style={st.kicker}>FOR VENUES</Text>
        <Text style={st.title}>Your lineup</Text>
        <Text style={st.body}>
          Tell Viibe Check who plays when. Guests then see the DJ next to the songs they danced to most, and DJs get credited for their own edits.
        </Text>
        <TextInput style={st.input} value={query} onChangeText={setQuery} onSubmitEditing={search} placeholder="Venue name, e.g. C12 Brussels" placeholderTextColor={TXD} returnKeyType="search" />
        <TouchableOpacity style={st.primaryBtn} onPress={search} disabled={busy}>
          {busy ? <ActivityIndicator color="#030904" /> : <Text style={st.primaryText}>FIND VENUE</Text>}
        </TouchableOpacity>
        {results?.map(v => (
          <TouchableOpacity key={v.placeId} style={st.card} onPress={() => setVenue(v)}>
            <Text style={st.cardTitle}>{v.name}</Text>
            {v.address && <Text style={st.meta}>{v.address}</Text>}
          </TouchableOpacity>
        ))}
        {results?.length === 0 && <Text style={st.meta}>No venue found.</Text>}
      </ScrollView>
    );
  }

  if (!unlocked) {
    return (
      <ScrollView style={st.container} contentContainerStyle={st.content} keyboardShouldPersistTaps="handled">
        <Text style={st.kicker}>FOR VENUES</Text>
        <Text style={st.title}>{venue.name}</Text>
        <Text style={st.body}>Enter the venue code you received from Viibe Check.</Text>
        <TextInput style={st.input} value={code} onChangeText={setCode} placeholder="Venue code" placeholderTextColor={TXD} autoCapitalize="characters" autoCorrect={false} />
        <TouchableOpacity style={st.primaryBtn} onPress={unlock} disabled={busy || !code.trim()}>
          {busy ? <ActivityIndicator color="#030904" /> : <Text style={st.primaryText}>CONTINUE</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setVenue(null)}><Text style={[st.meta, { textAlign: 'center' }]}>Another venue</Text></TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={st.container} contentContainerStyle={st.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Text style={st.kicker}>LINEUP · {venue.name.toUpperCase()}</Text>
      <View style={st.chipRow}>
        {[0, 1, 2, 3, 4, 5, 6].map(o => {
          const d = nightOf(o);
          return (
            <TouchableOpacity key={o} style={[st.chip, offset === o && st.chipOn]} onPress={() => setOffset(o)}>
              <Text style={[st.chipText, offset === o && { color: A }]}>
                {o === 0 ? 'Tonight' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {rows.map((r, i) => (
        <View key={i} style={st.card}>
          <TextInput style={st.input} value={r.djName} onChangeText={t => update(i, { djName: t })} placeholder="DJ name" placeholderTextColor={TXD} maxLength={80} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput style={[st.input, { flex: 1 }]} value={r.start} onChangeText={t => update(i, { start: t })} placeholder="From 23:00" placeholderTextColor={TXD} keyboardType="numbers-and-punctuation" maxLength={5} />
            <TextInput style={[st.input, { flex: 1 }]} value={r.end} onChangeText={t => update(i, { end: t })} placeholder="To 01:00" placeholderTextColor={TXD} keyboardType="numbers-and-punctuation" maxLength={5} />
          </View>
          <TextInput style={st.input} value={r.djLink} onChangeText={t => update(i, { djLink: t })} placeholder="DJ link (SoundCloud / Instagram), optional" placeholderTextColor={TXD} autoCapitalize="none" keyboardType="url" maxLength={300} />
          {rows.length > 1 && (
            <TouchableOpacity onPress={() => setRows(rs => rs.filter((_, n) => n !== i))}>
              <Text style={[st.meta, { color: DNG }]}>Remove</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}

      <TouchableOpacity style={st.secondaryBtn} onPress={() => setRows(rs => [...rs, { ...EMPTY_ROW }])}>
        <Text style={st.secondaryText}>+ ADD A SET</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[st.primaryBtn, busy && { opacity: 0.5 }]} onPress={save} disabled={busy}>
        {busy ? <ActivityIndicator color="#030904" /> : <Text style={st.primaryText}>SAVE LINEUP</Text>}
      </TouchableOpacity>
      <Text style={[st.meta, { textAlign: 'center' }]}>Times after midnight belong to the same night (e.g. 23:00 → 02:00).</Text>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content: { padding: 20, gap: 12, paddingBottom: 120 },
  kicker: { fontFamily: MONO, fontSize: 11, color: A, letterSpacing: 3 },
  title: { fontSize: 26, fontWeight: '700', color: TX },
  body: { color: TXM, fontSize: 14, lineHeight: 20 },
  meta: { fontFamily: MONO, fontSize: 11, color: TXD },
  card: { backgroundColor: S1, borderWidth: 1, borderColor: S2, borderRadius: 16, padding: 12, gap: 8 },
  cardTitle: { color: TX, fontSize: 16, fontWeight: '600' },
  input: { height: 46, borderRadius: 12, backgroundColor: BG, borderWidth: 1, borderColor: S2, color: TX, fontSize: 15, paddingHorizontal: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: S2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  chipOn: { borderColor: A + '80', backgroundColor: A + '14' },
  chipText: { fontFamily: MONO, fontSize: 12, color: TXD },
  primaryBtn: { height: 50, borderRadius: 14, backgroundColor: A, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontFamily: MONO, fontSize: 13, fontWeight: '700', color: '#030904', letterSpacing: 2 },
  secondaryBtn: { height: 46, borderRadius: 14, borderWidth: 1, borderColor: TXD + '66', alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: TXM, letterSpacing: 2 },
});
