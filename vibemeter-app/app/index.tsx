import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet,
  ScrollView, Alert, Platform, Switch, Linking,
} from 'react-native';
import { Audio } from 'expo-av';
import { useRouter } from 'expo-router';
import { sessionManager } from '../src/session/SessionManager';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';
import { vibePrompt } from '../src/notifications/VibePrompt';
import { getRecentVenues } from '../src/storage/LocalBuffer';
import { getDanceAffinity, setDanceAffinity } from '../src/storage/UserProfile';
import { getConsent, saveConsent } from '../src/storage/Consent';
import { SensorRow, SENSOR_TEXT, PRIVACY_URL } from '../src/components/SensorConsent';
import { PhonePlacement, VenueSource } from '../src/types';
import { getDeviceId } from '../src/storage/DeviceIdentity';
import { GroupSheet } from '../src/components/GroupQR';
import {
  getPendingGroupCode, onPendingGroupCode, setPendingGroupCode, parseGroupCode, getDraftGroupCode,
  getPendingVenue, onPendingVenue, setPendingVenue, venueGroupCode,
} from '../src/session/GroupCode';
import { applyScan, notifySessionStarted } from '../src/session/SessionControl';
import { standby, StandbyState } from '../src/session/Standby';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import { deleteSession } from '../src/storage/DataDeletion';
import { nightBounds } from '../src/storage/LiveAccess';
import { venueLocator, confirmVenue, Venue } from '../src/session/VenueLocator';

type StartOptions = {
  venueName: string; eventCode: string; phonePlacement: PhonePlacement | null; venue: Venue | null;
  venueSource?: VenueSource; groupKind?: 'friend' | 'venue';
};
type VenueLookup = 'looking' | 'found' | 'qr' | 'declined' | 'none' | 'off';

const PLACEMENTS: { value: PhonePlacement; label: string }[] = [
  { value: 'pocket', label: 'Pocket' },
  { value: 'hand',   label: 'Hand' },
  { value: 'bag',    label: 'Bag' },
];

/* ── Design tokens ─────────────────────────────────────────── */
const A   = '#00E8A0';
const AD  = '#004d35';
const S1  = '#0d0d12';
const S2  = '#181824';
const S3  = '#22222e';
const TX  = '#f0f0f5';
const TXD = '#9898c0';
const TXM = '#c0c0d8';
const WRN = '#e8a800';
const DNG = '#e84560';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

function scoreColor(v: number) { return v >= 4 ? A : v >= 2.5 ? WRN : DNG; }

/* ── Mini circle gauge ─────────────────────────────────────── */
function MiniGauge({ score, size = 50 }: { score: number; size?: number }) {
  const color = scoreColor(score);
  const stroke = size * 0.12;
  const half = size / 2;
  const progress = Math.min(score / 5, 1);
  const rightDeg = Math.min(1, progress * 2) * 180;
  const leftDeg  = Math.max(0, (progress - 0.5) * 2) * 180;

  const halfCircle = (side: 'left' | 'right', rotation: number, c: string) => {
    const clipped = side === 'right'
      ? { position: 'absolute' as const, top: 0, right: 0, width: half, height: size, overflow: 'hidden' as const }
      : { position: 'absolute' as const, top: 0, left: 0, width: half, height: size, overflow: 'hidden' as const };
    const offset = side === 'right' ? { left: -half } : { left: 0 };
    return (
      <View style={clipped}>
        <View style={[offset, {
          position: 'absolute', top: 0, width: size, height: size,
          borderRadius: half, borderWidth: stroke, borderColor: c,
          transform: [{ rotate: `${rotation}deg` }],
        }]} />
      </View>
    );
  };

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: half, borderWidth: stroke, borderColor: S2 }} />
      {rightDeg > 0 && halfCircle('right', rightDeg, color)}
      {leftDeg > 0  && halfCircle('left',  leftDeg,  color)}
      <Text style={{ fontFamily: MONO, fontSize: size * 0.28, fontWeight: '700', color }}>{score.toFixed(1)}</Text>
    </View>
  );
}

/* ── Sessions list screen ──────────────────────────────────── */
function SessionsScreen({ onStart, pastSessions, loading, onDeleted }: {
  onStart: () => void;
  pastSessions: any[];
  loading: boolean;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [standbyState, setStandbyState] = useState<StandbyState>(standby.current);
  useEffect(() => { getDeviceId().then(setDeviceId).catch(() => {}); }, []);
  useEffect(() => standby.onChange(setStandbyState), []);

  const confirmDelete = (session: any) => {
    const name = session.venue_name ?? 'This session';
    Alert.alert(
      'Delete this session?',
      `${name} is removed from your phone and from our database, with its ratings and song answers. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            try {
              await deleteSession(session.id);
              onDeleted();
            } catch {
              Alert.alert("Couldn't delete", 'Check your internet connection and try again. Nothing was deleted.');
            }
          },
        },
      ],
    );
  };
  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.wordmark}>VIIBE CHECK</Text>
        <Text style={s.title}>Sessions</Text>
      </View>
      <GestureHandlerRootView style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        {pastSessions.map((session: any) => (
          <Swipeable
            key={session.id}
            overshootRight={false}
            friction={2}
            renderRightActions={() => (
              <TouchableOpacity style={s.deleteAction} activeOpacity={0.85} onPress={() => confirmDelete(session)}>
                <Text style={s.deleteActionText}>DELETE</Text>
              </TouchableOpacity>
            )}
          >
          <TouchableOpacity
            style={s.sessionRow}
            onPress={() => router.push({ pathname: '/summary', params: { sessionId: session.id } })}
          >
            {session.computed_vibe_score != null ? (
              <MiniGauge score={Number(session.computed_vibe_score)} size={50} />
            ) : (
              <View style={{ width: 50, height: 50, borderRadius: 25, backgroundColor: S1, borderWidth: 1, borderColor: S2, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: TXD, fontSize: 10, fontFamily: MONO }}>—</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={s.sessionVenue}>{session.venue_name ?? 'Unnamed session'}</Text>
              <Text style={s.sessionMeta}>
                {session.started_at
                  ? new Date(session.started_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                  : 'unknown'} · {session.dwell_minutes ?? 0}min
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              {session.venue_type && (
                <View style={s.chip}>
                  <Text style={s.chipText}>{session.venue_type.replace('_', ' ')}</Text>
                </View>
              )}
              {session.computed_vibe_score != null && (
                <Text style={{ fontFamily: MONO, fontSize: 10, color: AD }}>↑ {Number(session.computed_vibe_score).toFixed(1)} peak</Text>
              )}
            </View>
          </TouchableOpacity>
          </Swipeable>
        ))}
      </ScrollView>
      </GestureHandlerRootView>
      <View style={{ padding: 20, paddingBottom: 28 }}>
        <TouchableOpacity
          style={[s.startBtn, loading && { opacity: 0.5 }]}
          onPress={onStart}
          disabled={loading}
          activeOpacity={0.85}
        >
          <Text style={s.startBtnText}>▶  START SESSION</Text>
        </TouchableOpacity>
        {Platform.OS === 'ios' && (
          // Going out mode: standby that asks "Start measuring?" when it sounds like a party
          <TouchableOpacity style={s.goingOutBtn} onPress={() => router.push('/going-out')} activeOpacity={0.85}>
            <Text style={s.goingOutText}>
              {standbyState === 'off' ? '🎶  GOING OUT TONIGHT?' : '🎶  GOING OUT MODE IS ON'}
            </Text>
          </TouchableOpacity>
        )}
        {deviceId && (
          // Shown so testers can quote it when asking for their data to be deleted
          <Text selectable style={{ marginTop: 10, textAlign: 'center', fontFamily: MONO, fontSize: 9, color: TXD }}>
            anonymous id · {deviceId}
          </Text>
        )}
        <TouchableOpacity onPress={() => router.push('/privacy')} style={{ alignItems: 'center', paddingTop: 8 }}>
          <Text style={[s.hint, { textDecorationLine: 'underline' }]}>privacy & data</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* ── Consent (first start; GDPR) ────────────────────────────── */
function ConsentScreen({ onDone }: { onDone: () => void }) {
  const [adult, setAdult] = useState(false);
  const [motion, setMotion] = useState(true);
  const [bluetooth, setBluetooth] = useState(true);
  const [location, setLocation] = useState(true);
  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.wordmark}>VIIBE CHECK</Text>
        <Text style={s.title}>Before you start</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, gap: 12, paddingBottom: 12 }}>
        <Text style={s.consentLead}>
          Viibe Check is a research app. During a session it turns your phone's sensors into summary numbers. No audio, no device names and no location history are ever stored. Choose what you allow:
        </Text>
        <SensorRow title="Microphone" body={SENSOR_TEXT.mic} value locked />
        <SensorRow title="Motion" body={SENSOR_TEXT.motion} value={motion} onChange={setMotion} />
        <SensorRow title="Bluetooth" body={SENSOR_TEXT.bluetooth} value={bluetooth} onChange={setBluetooth} />
        <SensorRow title="Location" body={SENSOR_TEXT.location} value={location} onChange={setLocation} />
        <TouchableOpacity style={[s.sensorRow, adult && s.recentRowSelected]} onPress={() => setAdult(a => !a)} activeOpacity={0.8}>
          <Text style={[s.sensorTitle, { flex: 1 }]}>{adult ? '☑' : '☐'}  I'm 18 or older</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_URL)}>
          <Text style={[s.hint, { textDecorationLine: 'underline' }]}>Read the privacy policy</Text>
        </TouchableOpacity>
        <Text style={s.hint}>You can change these choices, or delete all your data, at any time under "privacy & data" on the home screen.</Text>
      </ScrollView>
      <View style={{ padding: 20, paddingBottom: 28 }}>
        <TouchableOpacity
          style={[s.startBtn, !adult && { opacity: 0.4 }]}
          disabled={!adult}
          activeOpacity={0.85}
          onPress={async () => { await saveConsent({ motion, bluetooth, location }); onDone(); }}
        >
          <Text style={s.startBtnText}>AGREE AND CONTINUE</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* ── Venue input screen ────────────────────────────────────── */
/* ── One-time dance affinity question ───────────────────────── */
function AffinityScreen({ onDone }: { onDone: (value: number) => void }) {
  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.wordmark}>VIIBE CHECK</Text>
        <Text style={s.title}>One quick question</Text>
      </View>
      <View style={{ paddingHorizontal: 20 }}>
        <Text style={s.formLabel}>HOW MUCH DO YOU ENJOY DANCING?</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[1, 2, 3, 4, 5].map(v => (
            <TouchableOpacity key={v} style={s.affinityBtn} onPress={() => onDone(v)} activeOpacity={0.8}>
              <Text style={s.affinityNum}>{v}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
          <Text style={s.hint}>not at all</Text>
          <Text style={s.hint}>love it</Text>
        </View>
        <Text style={[s.hint, { marginTop: 20 }]}>Asked once. Stays anonymous — it helps compare ratings fairly between people.</Text>
      </View>
    </View>
  );
}

/* ── Venue input screen ────────────────────────────────────── */
function VenueScreen({ onStart, loading }: {
  onStart: (opts: StartOptions) => void;
  loading: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  // The closest club (or else bar) on Google Maps, proposed to the user: only a "Yes" links the
  // session to it; "No" or no answer leaves the venue blank. The user can also type a name.
  // A scanned venue code sets the venue directly, without the proposal.
  const [venue, setVenue] = useState<Venue | null>(null);
  const [lookup, setLookup] = useState<VenueLookup>('looking');
  const nameRef = useRef('');
  nameRef.current = name;
  const qrRef = useRef<Venue | null>(getPendingVenue());
  // With a venue code (and no friend's code), the session joins the venue's crowd group: show that
  const [crowdCode, setCrowdCode] = useState<string | null>(null);
  const applyQrVenue = (v: Venue | null) => {
    qrRef.current = v;
    if (!v) { setCrowdCode(null); return; }
    setVenue(v);
    setName(v.name);
    setLookup('qr');
    venueGroupCode(v.placeId, nightBounds().start).then(setCrowdCode);
  };
  useEffect(() => {
    applyQrVenue(getPendingVenue());
    return onPendingVenue(applyQrVenue);
  }, []);
  useEffect(() => {
    let alive = true;
    venueLocator.resetDeclined();
    venueLocator.identify().then(async v => {
      if (!alive || qrRef.current) return; // the venue's code already said where we are
      if (v === undefined) { setLookup('off'); return; }
      if (!v) { setLookup('none'); return; }
      if (nameRef.current) { setLookup('declined'); return; } // already typed their own name
      const yes = await confirmVenue(v);
      if (!alive || qrRef.current) return;
      if (yes) {
        setVenue(v);
        setName(v.name);
        setLookup('found');
      } else {
        venueLocator.decline(v.placeId);
        setLookup('declined');
      }
    });
    return () => { alive = false; };
  }, []);
  // Group: joined by scanning a friend's QR (in-app, or the Camera app deep link), or typed
  const [joinedCode, setJoinedCode] = useState<string | null>(getPendingGroupCode());
  const [typing, setTyping] = useState(false);
  const [typedCode, setTypedCode] = useState('');
  const [showGroup, setShowGroup] = useState(false);
  useEffect(() => onPendingGroupCode(setJoinedCode), []);
  const eventCode = joinedCode ?? parseGroupCode(typedCode) ?? '';
  // Pocket is the recommended placement, so it is preselected
  const [placement, setPlacement] = useState<PhonePlacement | null>('pocket');
  const start = async (venueName: string) => {
    const qr = qrRef.current; // read before clearing: clearing the pending venue resets qrRef
    setPendingGroupCode(null);
    setPendingVenue(null);
    // A venue code joins the venue's crowd group for tonight, unless a friend's code was joined
    if (qr && !eventCode) {
      const code = crowdCode ?? await venueGroupCode(qr.placeId, nightBounds().start);
      onStart({ venueName, eventCode: code, phonePlacement: placement, venue, venueSource: 'qr', groupKind: 'venue' });
      return;
    }
    onStart({ venueName, eventCode, phonePlacement: placement, venue, venueSource: qr ? 'qr' : 'auto', groupKind: 'friend' });
  };
  const [recentVenues, setRecentVenues] = useState<string[]>([]);
  useEffect(() => { getRecentVenues(3).then(setRecentVenues); }, []);
  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.wordmark}>VIIBE CHECK</Text>
        <Text style={s.title}>New Session</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20 }}>
        <Text style={s.formLabel}>WHERE ARE YOU? (OPTIONAL)</Text>
        <TextInput
          style={[s.input, name.length > 0 && { borderColor: A + '55' }]}
          placeholder="Venue name…"
          placeholderTextColor={TXD}
          value={name}
          onChangeText={setName}
          returnKeyType="go"
          onSubmitEditing={() => start(name)}
        />
        <Text style={[s.hint, { marginTop: 6 }]}>
          {lookup === 'looking' ? 'Looking for the club you\'re in…'
            : lookup === 'found' && venue ? (name === venue.name
                ? `📍 Confirmed${venue.distanceM != null ? ` · ${venue.distanceM} m away` : ''}`
                : `📍 Your name is used instead of ${venue.name}`)
            : lookup === 'qr' && venue ? (name === venue.name ? '📍 From the venue\'s code' : `📍 Your name is used instead of ${venue.name}`)
            : lookup === 'declined' ? (name ? '' : 'Venue left blank. Type the name if you like.')
            : lookup === 'none' ? 'No club or bar found nearby. Type the name if you like.'
            : 'Couldn\'t recognise the venue (location off or no connection). Type the name if you like.'}
        </Text>
        <Text style={[s.formLabel, { marginTop: 20 }]}>WHERE'S YOUR PHONE?</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {PLACEMENTS.map(p => (
            <TouchableOpacity
              key={p.value}
              style={[s.placementChip, placement === p.value && s.recentRowSelected]}
              onPress={() => setPlacement(p.value)}
            >
              <Text style={[s.recentText, placement === p.value && { color: A }]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[s.formLabel, { marginTop: 20 }]}>WITH FRIENDS? (OPTIONAL)</Text>
        {joinedCode ? (
          <View style={[s.recentRow, s.recentRowSelected, { flexDirection: 'row', justifyContent: 'space-between' }]}>
            <Text style={[s.recentText, { color: A }]}>✓ Joined group {joinedCode}</Text>
            <TouchableOpacity onPress={() => setPendingGroupCode(null)}>
              <Text style={{ fontFamily: MONO, fontSize: 11, color: TXD }}>leave</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={s.recentRow} onPress={() => setShowGroup(true)}>
            <Text style={s.recentText}>👥  GROUP: share or scan</Text>
          </TouchableOpacity>
        )}
        {!joinedCode && (typing ? (
          <TextInput
            style={[s.input, { marginTop: 8 }, typedCode.length > 0 && { borderColor: A + '55' }]}
            placeholder="Group code, e.g. G-7KQ3XM"
            placeholderTextColor={TXD}
            value={typedCode}
            onChangeText={setTypedCode}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={32}
          />
        ) : (
          <TouchableOpacity onPress={() => setTyping(true)} style={{ paddingVertical: 8 }}>
            <Text style={{ fontFamily: MONO, fontSize: 11, color: TXD }}>or type a code</Text>
          </TouchableOpacity>
        ))}
        <Text style={[s.hint, { marginTop: 6 }]}>
          Not needed: you get your own group. Show your code so friends can join, or scan a friend's or the venue's code. Groups let us measure how in sync the crowd is.
        </Text>
        <GroupSheet
          visible={showGroup}
          code={joinedCode ?? crowdCode ?? getDraftGroupCode()}
          onClose={() => setShowGroup(false)}
          onScan={applyScan}
          onMakeVenueCode={() => { setShowGroup(false); router.push('/venue-code'); }}
        />

        {recentVenues.length > 0 && <Text style={[s.formLabel, { marginTop: 20 }]}>RECENT</Text>}
        <View style={{ gap: 8 }}>
          {recentVenues.map(v => (
            <TouchableOpacity
              key={v}
              style={[s.recentRow, name === v && s.recentRowSelected]}
              onPress={() => setName(v)}
            >
              <Text style={[s.recentText, name === v && { color: A }]}>{v}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
      <View style={{ padding: 20, paddingBottom: 28, gap: 10 }}>
        <TouchableOpacity
          style={[s.startBtn, loading && { opacity: 0.5 }]}
          onPress={() => start(name)}
          disabled={loading}
          activeOpacity={0.85}
        >
          <Text style={s.startBtnText}>{loading ? 'Starting…' : '▶  START SESSION'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => start(venue?.name ?? '')} style={{ alignItems: 'center', paddingVertical: 8 }}>
          <Text style={{ fontFamily: MONO, fontSize: 11, color: TXD }}>skip →</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* ── Main screen (two-step: sessions → venue) ──────────────── */
export default function HomeScreen() {
  const router = useRouter();
  const [step, setStep]             = useState<'sessions' | 'consent' | 'affinity' | 'venue'>('sessions');
  const [pastSessions, setPastSessions] = useState<any[]>([]);
  const [loading, setLoading]       = useState(false);

  useEffect(() => { loadPastSessions(); }, []);

  const loadPastSessions = useCallback(async () => {
    const sessions = await sessionManager.getPastSessions();
    setPastSessions(sessions.filter((s: any) => s.ended_at != null).slice(0, 10));
  }, []);

  const handleNewSession = async () => {
    if (!(await getConsent())) { setStep('consent'); return; }
    const affinity = await getDanceAffinity();
    setStep(affinity == null ? 'affinity' : 'venue');
  };

  const handleStartSession = async (opts: StartOptions) => {
    const { venueName, eventCode, phonePlacement, venue } = opts;
    if (loading) return;
    // The microphone is required: on iPhone the open mic is what keeps a session measuring
    // with the phone locked. Without it the session would silently stop measuring.
    const mic = await Audio.requestPermissionsAsync().catch(() => null);
    if (!mic?.granted) {
      Alert.alert(
        'Microphone needed',
        'Viibe Check needs the microphone to measure the music, and to keep measuring while your phone is locked. Audio is analysed on the phone and never recorded or uploaded.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }],
      );
      return;
    }
    setLoading(true);
    try {
      const session = await sessionManager.startSession(venueName.trim() || null, null, {
        eventCode, phonePlacement, venue, venueSource: opts.venueSource, groupKind: opts.groupKind,
      });
      await sensorOrchestrator.startSession(session);
      vibePrompt.startPromptSchedule(session.id, { startedAt: session.startedAt, venue: session.venueName });
      notifySessionStarted(session);
      setStep('sessions');
      router.push('/meter');
    } catch (err) {
      Alert.alert('Error', 'Failed to start session. Check permissions.');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'consent') {
    return <ConsentScreen onDone={handleNewSession} />;
  }

  if (step === 'affinity') {
    return (
      <AffinityScreen
        onDone={async v => { await setDanceAffinity(v); setStep('venue'); }}
      />
    );
  }

  if (step === 'venue') {
    return (
      <VenueScreen
        loading={loading}
        onStart={handleStartSession}
      />
    );
  }

  return (
    <SessionsScreen
      pastSessions={pastSessions}
      loading={loading}
      onStart={handleNewSession}
      onDeleted={loadPastSessions}
    />
  );
}

const s = StyleSheet.create({
  consentLead: { color: TXM, fontSize: 14, lineHeight: 20 },
  sensorRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: S1, borderWidth: 1, borderColor: S2, borderRadius: 14, padding: 14 },
  sensorTitle: { color: TX, fontSize: 15, fontWeight: '600' },
  sensorBody: { color: TXD, fontSize: 12, lineHeight: 17 },
  container: { flex: 1, backgroundColor: '#060608' },

  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
  wordmark: { fontSize: 10, fontFamily: MONO, color: TXD, letterSpacing: 3, marginBottom: 4 },
  title:    { fontSize: 30, fontWeight: '700', color: TX },

  sessionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: S1, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: S2, marginBottom: 10,
  },
  sessionVenue: { fontSize: 16, fontWeight: '600', color: TX, marginBottom: 2 },
  sessionMeta:  { fontSize: 11, fontFamily: MONO, color: TXD },

  chip: { borderWidth: 1, borderColor: TXD + '40', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 },
  chipText: { fontSize: 10, fontFamily: MONO, color: TXD, letterSpacing: 1 },

  formLabel: { fontSize: 11, fontFamily: MONO, color: TXM, letterSpacing: 2, marginBottom: 10 },
  input: {
    width: '100%', height: 52, borderRadius: 14, backgroundColor: S1,
    borderWidth: 1, borderColor: S2, color: TX, fontSize: 16, paddingHorizontal: 16,
  },

  recentRow: {
    backgroundColor: S1, borderWidth: 1, borderColor: S2,
    borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
  },
  recentRowSelected: { borderColor: A + '40', backgroundColor: A + '12' },
  recentText: { fontSize: 15, color: TXM },
  placementChip: {
    flex: 1, alignItems: 'center',
    backgroundColor: S1, borderWidth: 1, borderColor: S2,
    borderRadius: 12, paddingVertical: 12,
  },
  hint: { fontSize: 11, fontFamily: MONO, color: TXD },
  affinityBtn: {
    flex: 1, height: 56, borderRadius: 14, backgroundColor: S1,
    borderWidth: 1, borderColor: S2, alignItems: 'center', justifyContent: 'center',
  },
  affinityNum: { fontFamily: MONO, fontSize: 20, fontWeight: '700', color: TX },

  startBtn: {
    width: '100%', height: 58, borderRadius: 18, backgroundColor: A,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: A, shadowOpacity: 0.55, shadowRadius: 20, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  startBtnText: { fontFamily: MONO, fontSize: 13, fontWeight: '700', color: '#030904', letterSpacing: 3 },
  goingOutBtn: {
    width: '100%', height: 46, borderRadius: 14, marginTop: 10,
    borderWidth: 1, borderColor: A + '55', backgroundColor: A + '10',
    alignItems: 'center', justifyContent: 'center',
  },
  deleteAction: {
    width: 96, marginBottom: 10, marginLeft: 8, borderRadius: 16,
    backgroundColor: DNG, alignItems: 'center', justifyContent: 'center',
  },
  deleteActionText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: '#ffffff', letterSpacing: 2 },
  goingOutText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: A, letterSpacing: 2 },
});
