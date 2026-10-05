import { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Location from 'expo-location';
import { supabase } from '../src/config/supabase';
import { getDeviceId } from '../src/storage/DeviceIdentity';
import { getLiveAccess, spendNightPass, LiveAccessStatus } from '../src/storage/LiveAccess';

/* ── Design tokens (as in meter.tsx) ───────────────────────── */
const A   = '#00E8A0';
const S1  = '#0d0d12';
const S2  = '#181824';
const TX  = '#f0f0f5';
const TXD = '#9898c0';
const TXM = '#c0c0d8';
const WRN = '#e8a800';
const DNG = '#e84560';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;
const REFRESH_MS = 60_000;

interface LiveVenue {
  place_id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  contributors: number;
  dancing_share: number | null;
  energy_level: 'low' | 'medium' | 'high' | null;
  momentum: 'rising' | 'stable' | 'falling' | null;
  genre: string | null;
  bpm: number | null;
  crowd: number | null;
  confidence: 'low' | 'medium' | 'high';
  updated_at: string;
}

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

function distanceText(m: number | null): string | null {
  if (m == null) return null;
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Where the phone is now, for distances only: read, used on the device, never kept or sent. */
async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const pos = (await Location.getLastKnownPositionAsync({ maxAge: 300_000 }))
      ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : null;
  } catch {
    return null;
  }
}

/* ── Venue card: separate indicators, never one overall score ── */
function Indicator({ label, value, color, locked }: { label: string; value: string; color?: string; locked: boolean }) {
  return (
    <View style={s.indicator}>
      <Text style={s.indicatorLabel}>{label}</Text>
      <Text style={[s.indicatorValue, { color: locked ? TXD : (color ?? TX) }]}>{locked ? '🔒' : value}</Text>
    </View>
  );
}

function VenueCard({ v, distance, locked }: { v: LiveVenue; distance: number | null; locked: boolean }) {
  const dancing = v.dancing_share != null ? `${Math.round(v.dancing_share * 100)}%` : '–';
  const energy = v.energy_level ?? '–';
  const momentum = v.momentum === 'rising' ? '↑ rising' : v.momentum === 'falling' ? '↓ falling' : v.momentum === 'stable' ? '→ stable' : '–';
  const music = [v.genre, v.bpm ? `${Math.round(v.bpm)} BPM` : null].filter(Boolean).join(' · ') || '–';
  const crowd = v.crowd != null ? `${Math.round(v.crowd)} devices` : '–';
  return (
    <View style={s.card}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={s.cardTitle} numberOfLines={1}>{v.name}</Text>
        {distanceText(distance) && <Text style={s.meta}>{distanceText(distance)}</Text>}
      </View>
      <View style={s.indicatorRow}>
        <Indicator label="DANCING" value={dancing} locked={locked}
          color={v.dancing_share != null ? (v.dancing_share >= 0.5 ? A : v.dancing_share >= 0.25 ? WRN : DNG) : undefined} />
        <Indicator label="ENERGY" value={energy} locked={locked}
          color={v.energy_level === 'high' ? A : v.energy_level === 'medium' ? WRN : v.energy_level === 'low' ? DNG : undefined} />
        <Indicator label="MOMENTUM" value={momentum} locked={locked}
          color={v.momentum === 'rising' ? A : v.momentum === 'falling' ? DNG : undefined} />
      </View>
      <View style={s.indicatorRow}>
        <Indicator label="MUSIC" value={music} locked={locked} />
        {/* Crowded is not the same as popping: the crowd size sits apart from the dancing */}
        <Indicator label="CROWD" value={crowd} locked={locked} />
      </View>
      <Text style={s.meta}>
        {v.contributors} {v.contributors === 1 ? 'phone' : 'phones'} · {v.confidence} confidence · updated {ago(v.updated_at)}
      </Text>
    </View>
  );
}

/* ── Screen ─────────────────────────────────────────────────── */
export default function LiveScreen() {
  const [venues, setVenues] = useState<LiveVenue[] | null>(null);
  const [access, setAccess] = useState<LiveAccessStatus | null>(null);
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (logView: boolean) => {
    const [res, acc, pos] = await Promise.all([supabase.rpc('live_venues'), getLiveAccess(), currentPosition()]);
    setAccess(acc);
    setHere(pos);
    if (res.error) { setError(true); return; }
    setError(false);
    const list = (res.data ?? []) as LiveVenue[];
    setVenues(list);
    // Research: which venues the view showed, so we can see whether it changes where people go
    if (logView) {
      getDeviceId().then(id => supabase.rpc('log_live_view', {
        p_device_id: id, p_venue_place_ids: list.map(v => v.place_id), p_unlocked: acc.unlocked,
      })).catch(() => {});
    }
  }, []);

  useFocusEffect(useCallback(() => {
    load(true);
    const id = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]));

  const refresh = async () => { setRefreshing(true); await load(false); setRefreshing(false); };
  const takePass = async () => { if (await spendNightPass()) load(false); };

  const locked = !access?.unlocked;
  const sorted = (venues ?? []).map(v => ({
    v, d: here && v.lat != null && v.lng != null ? distanceM(here.lat, here.lng, v.lat, v.lng) : null,
  })).sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity));

  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={A} />}>
        <Text style={s.lead}>Where the night is moving, from phones already there.</Text>

        {access && (
          <View style={[s.accessBox, access.unlocked && { borderColor: A + '55' }]}>
            {access.unlocked ? (
              <Text style={[s.accessText, { color: A }]}>
                ✓ Unlocked until 6:00{access.reason === 'contribution' ? ' — thanks for contributing tonight' : ' (Night Pass)'}
              </Text>
            ) : (
              <>
                <Text style={s.accessText}>
                  Run a session at a venue for {access.minutesNeeded} more {access.minutesNeeded === 1 ? 'minute' : 'minutes'} to unlock tonight's live view.
                </Text>
                {access.freePasses > 0 && (
                  <TouchableOpacity style={s.passBtn} onPress={takePass} activeOpacity={0.85}>
                    <Text style={s.passBtnText}>USE A FREE NIGHT PASS ({access.freePasses} LEFT)</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        )}

        {error && <Text style={s.empty}>Couldn't load the live view. Pull down to try again.</Text>}
        {!error && venues != null && sorted.length === 0 && (
          <Text style={s.empty}>No venue has live data right now. Venues appear once phones there run a session.</Text>
        )}
        {sorted.map(({ v, d }) => <VenueCard key={v.place_id} v={v} distance={d} locked={locked} />)}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#060608' },
  lead: { color: TXM, fontSize: 15 },
  accessBox: { backgroundColor: S1, borderColor: S2, borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
  accessText: { color: TXM, fontSize: 13, lineHeight: 19 },
  passBtn: { borderColor: A + '66', borderWidth: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  passBtnText: { color: A, fontFamily: MONO, fontSize: 12, letterSpacing: 1.5, fontWeight: '700' },
  empty: { color: TXD, fontSize: 13, textAlign: 'center', marginTop: 30, lineHeight: 19 },
  card: { backgroundColor: S1, borderColor: S2, borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  cardTitle: { color: TX, fontSize: 18, fontWeight: '700', flexShrink: 1 },
  indicatorRow: { flexDirection: 'row', gap: 10 },
  indicator: { flex: 1, gap: 4 },
  indicatorLabel: { color: TXD, fontFamily: MONO, fontSize: 10, letterSpacing: 1.5 },
  indicatorValue: { fontSize: 14, fontWeight: '600' },
  meta: { color: TXD, fontFamily: MONO, fontSize: 11 },
});
