import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet,
  ScrollView, Alert, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { sessionManager } from '../src/session/SessionManager';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';
import { vibePrompt } from '../src/notifications/VibePrompt';
import { getRecentVenues } from '../src/storage/LocalBuffer';

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
function SessionsScreen({ onStart, pastSessions, loading }: {
  onStart: () => void;
  pastSessions: any[];
  loading: boolean;
}) {
  const router = useRouter();
  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.wordmark}>VIIBEMETER</Text>
        <Text style={s.title}>Sessions</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        {pastSessions.map((session: any) => (
          <TouchableOpacity
            key={session.id}
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
        ))}
      </ScrollView>
      <View style={{ padding: 20, paddingBottom: 28 }}>
        <TouchableOpacity
          style={[s.startBtn, loading && { opacity: 0.5 }]}
          onPress={onStart}
          disabled={loading}
          activeOpacity={0.85}
        >
          <Text style={s.startBtnText}>▶  START SESSION</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* ── Venue input screen ────────────────────────────────────── */
function VenueScreen({ onStart, onSkip, loading }: {
  onStart: (name: string) => void;
  onSkip: () => void;
  loading: boolean;
}) {
  const [name, setName] = useState('');
  const [recentVenues, setRecentVenues] = useState<string[]>([]);
  useEffect(() => { getRecentVenues(3).then(setRecentVenues); }, []);
  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.wordmark}>VIIBEMETER</Text>
        <Text style={s.title}>New Session</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20 }}>
        <Text style={s.formLabel}>WHERE ARE YOU?</Text>
        <TextInput
          style={[s.input, name.length > 0 && { borderColor: A + '55' }]}
          placeholder="Venue name…"
          placeholderTextColor={TXD}
          value={name}
          onChangeText={setName}
          autoFocus
          returnKeyType="go"
          onSubmitEditing={() => onStart(name)}
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
          onPress={() => onStart(name || 'Unknown venue')}
          disabled={loading}
          activeOpacity={0.85}
        >
          <Text style={s.startBtnText}>{loading ? 'Starting…' : '▶  START SESSION'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onSkip} style={{ alignItems: 'center', paddingVertical: 8 }}>
          <Text style={{ fontFamily: MONO, fontSize: 11, color: TXD }}>skip →</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* ── Main screen (two-step: sessions → venue) ──────────────── */
export default function HomeScreen() {
  const router = useRouter();
  const [step, setStep]             = useState<'sessions' | 'venue'>('sessions');
  const [pastSessions, setPastSessions] = useState<any[]>([]);
  const [loading, setLoading]       = useState(false);

  useEffect(() => { loadPastSessions(); }, []);

  const loadPastSessions = useCallback(async () => {
    const sessions = await sessionManager.getPastSessions();
    setPastSessions(sessions.filter((s: any) => s.ended_at != null).slice(0, 10));
  }, []);

  const handleStartSession = async (venueName: string) => {
    if (loading) return;
    setLoading(true);
    try {
      const session = await sessionManager.startSession(venueName.trim() || null, null);
      await sensorOrchestrator.startSession(session);
      vibePrompt.startPromptSchedule(session.id);
      setStep('sessions');
      router.push('/meter');
    } catch (err) {
      Alert.alert('Error', 'Failed to start session. Check permissions.');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'venue') {
    return (
      <VenueScreen
        loading={loading}
        onStart={handleStartSession}
        onSkip={() => handleStartSession('')}
      />
    );
  }

  return (
    <SessionsScreen
      pastSessions={pastSessions}
      loading={loading}
      onStart={() => setStep('venue')}
    />
  );
}

const s = StyleSheet.create({
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

  startBtn: {
    width: '100%', height: 58, borderRadius: 18, backgroundColor: A,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: A, shadowOpacity: 0.55, shadowRadius: 20, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  startBtnText: { fontFamily: MONO, fontSize: 13, fontWeight: '700', color: '#030904', letterSpacing: 3 },
});
