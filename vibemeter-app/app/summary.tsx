import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Platform, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getWindowsForSession, getRatingsForSession, getSessions } from '../src/storage/LocalBuffer';

/* ── Design tokens ─────────────────────────────────────────── */
const A   = '#00E8A0';
const S1  = '#0d0d12';
const S2  = '#181824';
const TX  = '#f0f0f5';
const TXD = '#9898c0';
const TXM = '#c0c0d8';
const WRN = '#e8a800';
const DNG = '#e84560';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

function scoreColor(v: number) { return v >= 4 ? A : v >= 2.5 ? WRN : DNG; }

/* ── Types ──────────────────────────────────────────────────── */
interface WindowRow {
  id: string;
  window_start: number;
  window_end: number;
  computed_vibe_score: number | null;
  avg_db: number | null;
  music_detected: number | null;
  estimated_bpm: number | null;
  audio_classification: string | null;
  accel_magnitude_avg: number | null;
  ble_device_count: number | null;
  ble_count_trend: string | null;
  computed_energy_score: number | null;
  computed_movement_score: number | null;
  computed_music_score: number | null;
  computed_density_score: number | null;
}
interface RatingRow { id: string; rating: number; rated_at: number; }

/* ── Hero gauge (two-half-circle technique) ─────────────────── */
function HeroGauge({ score, size = 140 }: { score: number; size?: number }) {
  const color = scoreColor(score);
  const stroke = size * 0.09;
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
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: half, borderWidth: stroke, borderColor: S2 }} />
      {rightDeg > 0 && halfCircle('right', rightDeg, color)}
      {leftDeg  > 0 && halfCircle('left',  leftDeg,  color)}
      <View style={{ alignItems: 'center' }}>
        <Text style={{ fontFamily: MONO, fontSize: size * 0.22, fontWeight: '700', color, lineHeight: size * 0.26 }}>
          {score.toFixed(1)}
        </Text>
        <Text style={{ fontFamily: MONO, fontSize: size * 0.068, color: TXD, letterSpacing: 2, marginTop: 2 }}>
          VIBE SCORE
        </Text>
      </View>
    </View>
  );
}

/* ── Timeline chart (segment line using Views) ──────────────── */
function TimelineChart({ values, peakValue }: { values: number[]; peakValue: number }) {
  const H = 64;
  if (values.length < 2) return <Text style={{ color: TXD, fontFamily: MONO, fontSize: 11 }}>No timeline data</Text>;

  const peakIdx = values.indexOf(peakValue);

  return (
    <View>
      {/* Bar-based chart with gradient opacity — matches design's filled area look */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: H, gap: 1.5 }}>
        {values.map((v, i) => {
          const isPeak = i === peakIdx;
          const barH = Math.max(4, (v / 5) * H * 0.9);
          const c = scoreColor(v);
          return (
            <View key={i} style={{ flex: 1, justifyContent: 'flex-end', height: H }}>
              {isPeak && (
                <Text style={{ fontSize: 8, fontFamily: MONO, color: A, textAlign: 'center', marginBottom: 2 }}>
                  {v.toFixed(1)}
                </Text>
              )}
              <View style={{
                height: barH, borderRadius: 2,
                backgroundColor: isPeak ? A : c,
                opacity: isPeak ? 1 : 0.55 + (i / values.length) * 0.3,
              }} />
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
        <Text style={{ fontSize: 9, fontFamily: MONO, color: TXD }}>start</Text>
        <Text style={{ fontSize: 9, fontFamily: MONO, color: A }}>↑ {peakValue.toFixed(2)} peak</Text>
        <Text style={{ fontSize: 9, fontFamily: MONO, color: TXD }}>end</Text>
      </View>
    </View>
  );
}

/* ── Fill bar ───────────────────────────────────────────────── */
function FillBar({ value, max = 1, color = A, height = 6 }: { value: number; max?: number; color?: string; height?: number }) {
  const pct = Math.min(1, Math.max(0, value / max));
  return (
    <View style={{ height, backgroundColor: S2, borderRadius: height / 2, overflow: 'hidden' }}>
      <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: color, borderRadius: height / 2 }} />
    </View>
  );
}

/* ── Main screen ────────────────────────────────────────────── */
export default function SummaryScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>();
  const router = useRouter();
  const [windows, setWindows]   = useState<WindowRow[]>([]);
  const [ratings, setRatings]   = useState<RatingRow[]>([]);
  const [session, setSession]   = useState<any | null>(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const allSessions = await getSessions();
        const ended = allSessions.filter((s: any) => s.ended_at != null);
        const targetId = sessionId ?? ended[0]?.id ?? null;
        if (!targetId) { setLoading(false); return; }
        const [wins, rats] = await Promise.all([
          getWindowsForSession(targetId),
          getRatingsForSession(targetId),
        ]);
        setWindows(wins);
        setRatings(rats);
        setSession(allSessions.find((s: any) => s.id === targetId) ?? null);
      } catch (err) {
        console.error('Summary load error:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  if (loading) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={A} />
      </View>
    );
  }

  if (windows.length === 0) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center', padding: 40 }]}>
        <Text style={{ color: TXM, fontSize: 16, textAlign: 'center' }}>
          {session ? 'No sensor data recorded.' : 'No completed sessions yet.'}
        </Text>
        <Text style={{ color: TXD, fontSize: 13, marginTop: 8, textAlign: 'center' }}>
          {session ? 'Try recording for a bit longer.' : 'Complete a session to see your summary.'}
        </Text>
      </View>
    );
  }

  /* ── Compute stats ── */
  const vibeScores = windows.map(w => w.computed_vibe_score).filter(v => v != null) as number[];
  const avgVibe  = vibeScores.length ? vibeScores.reduce((s, v) => s + v, 0) / vibeScores.length : 0;
  const peakVibe = vibeScores.length ? Math.max(...vibeScores) : 0;

  const energyScores   = windows.map(w => w.computed_energy_score).filter(v => v != null) as number[];
  const musicScores    = windows.map(w => w.computed_music_score).filter(v => v != null)  as number[];
  const motionScores   = windows.map(w => w.computed_movement_score).filter(v => v != null) as number[];
  const densityScores  = windows.map(w => w.computed_density_score).filter(v => v != null) as number[];
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const engagementScores = windows.map(w => (w as any).computed_engagement_score).filter(v => v != null) as number[];

  const comps = [
    { l: 'ENERGY', v: avg(energyScores),      w: '30%' },
    { l: 'MUSIC',  v: avg(musicScores),        w: '25%' },
    { l: 'MOTION', v: avg(motionScores),       w: '20%' },
    { l: 'CROWD',  v: avg(densityScores),      w: '15%' },
    { l: 'ENGAGE', v: avg(engagementScores),   w: '10%' },
  ];

  const bpmValues = windows.map(w => w.estimated_bpm).filter(v => v != null) as number[];
  const classCount: Record<string, number> = {};
  windows.forEach(w => { if (w.audio_classification) classCount[w.audio_classification] = (classCount[w.audio_classification] ?? 0) + 1; });

  const avgRating = ratings.length ? ratings.reduce((s, r) => s + r.rating, 0) / ratings.length : null;

  const sessionStartMs = windows[0]?.window_start ?? 0;
  const sessionEndMs   = windows[windows.length - 1]?.window_end ?? 0;
  const durationSec    = Math.round((sessionEndMs - sessionStartMs) / 1000);
  const durH = Math.floor(durationSec / 3600), durM = Math.floor((durationSec % 3600) / 60);
  const durStr = durH > 0 ? `${durH}h ${String(durM).padStart(2, '0')}m` : `${durM}m`;

  const venueName = session?.venue_name ?? 'Session Summary';

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {/* Header */}
      <View style={{ marginBottom: 16 }}>
        <Text style={{ fontSize: 10, fontFamily: MONO, color: TXD, letterSpacing: 3, marginBottom: 3 }}>SESSION COMPLETE</Text>
        <Text style={{ fontSize: 28, fontWeight: '700', color: TX }}>Summary</Text>
      </View>

      {/* Score card */}
      <View style={[s.card, { alignItems: 'center', gap: 10, paddingVertical: 20 }]}>
        <HeroGauge score={avgVibe} size={140} />
        <Text style={{ fontSize: 12, color: TXM }}>
          {durStr} · {venueName} · ↑ {peakVibe.toFixed(2)}
        </Text>
      </View>

      {/* Sensor vs Rating alignment */}
      {avgRating != null && (
        <View style={s.card}>
          <Text style={s.cardTitle}>SENSOR VS YOU</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', marginBottom: 12 }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontFamily: MONO, fontSize: 36, fontWeight: '700', color: scoreColor(avgVibe) }}>{avgVibe.toFixed(1)}</Text>
              <Text style={{ fontSize: 12, color: TXD }}>Sensor avg</Text>
            </View>
            <Text style={{ color: S2, fontSize: 14 }}>vs</Text>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontFamily: MONO, fontSize: 36, fontWeight: '700', color: scoreColor(avgRating) }}>{avgRating.toFixed(1)}</Text>
              <Text style={{ fontSize: 12, color: TXD }}>Your avg</Text>
            </View>
          </View>
          <Text style={{ fontSize: 12, color: TXM, textAlign: 'center' }}>
            {Math.abs(avgVibe - avgRating) < 0.8
              ? '✓ Good alignment — sensors matched your experience'
              : avgVibe > avgRating
              ? '↑ Sensors rated higher than you felt'
              : '↓ Sensors rated lower than you felt'}
          </Text>
        </View>
      )}

      {/* Vibe Over Time */}
      <View style={s.card}>
        <Text style={s.cardTitle}>VIBE OVER TIME</Text>
        <TimelineChart values={vibeScores} peakValue={peakVibe} />
        <Text style={{ fontSize: 10, color: TXD, fontFamily: MONO, marginTop: 8, textAlign: 'center' }}>
          {windows.length} windows sampled
        </Text>
      </View>

      {/* Component Breakdown */}
      <View style={s.card}>
        <Text style={s.cardTitle}>COMPONENT BREAKDOWN</Text>
        {comps.map(c => (
          <View key={c.l} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 11 }}>
            <Text style={{ width: 48, fontSize: 10, fontFamily: MONO, color: TXD, letterSpacing: 1 }}>{c.l}</Text>
            <Text style={{ width: 24, fontSize: 9, fontFamily: MONO, color: TXD, textAlign: 'right' }}>{c.w}</Text>
            <View style={{ flex: 1 }}><FillBar value={c.v} max={5} color={scoreColor(c.v)} /></View>
            <Text style={{ width: 28, fontSize: 12, fontFamily: MONO, fontWeight: '700', color: scoreColor(c.v), textAlign: 'right' }}>{c.v.toFixed(1)}</Text>
          </View>
        ))}
      </View>

      {/* Music */}
      {bpmValues.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>MUSIC</Text>
          <Text style={{ color: TXM, fontSize: 14, marginBottom: 8 }}>
            BPM range: {Math.min(...bpmValues)} – {Math.max(...bpmValues)}
          </Text>
          {Object.entries(classCount).map(([cls, count]) => (
            <Text key={cls} style={{ color: TXD, fontSize: 13, marginBottom: 4, fontFamily: MONO }}>
              {cls.replace('_', ' ')}: {Math.round((count / windows.length) * 100)}%
            </Text>
          ))}
        </View>
      )}

      {/* Crowd */}
      <View style={s.card}>
        <Text style={s.cardTitle}>CROWD</Text>
        {windows.filter(w => w.ble_device_count != null).length > 0 ? (
          <>
            <Text style={{ color: TXM, fontSize: 14, marginBottom: 4 }}>
              Max nearby: {Math.max(...windows.map(w => w.ble_device_count ?? 0))}
            </Text>
            <Text style={{ color: TXM, fontSize: 14 }}>
              Avg nearby: {Math.round(
                windows.filter(w => w.ble_device_count != null)
                  .reduce((sum, w) => sum + (w.ble_device_count ?? 0), 0) /
                Math.max(1, windows.filter(w => w.ble_device_count != null).length)
              )}
            </Text>
          </>
        ) : (
          <Text style={{ color: TXD, fontSize: 13 }}>No BLE data collected</Text>
        )}
      </View>

      {/* Back button */}
      <TouchableOpacity style={s.backBtn} onPress={() => router.push('/')}>
        <Text style={s.backBtnText}>← BACK TO SESSIONS</Text>
      </TouchableOpacity>

      <Text style={{ color: TXD, fontSize: 11, textAlign: 'center', fontFamily: MONO, marginTop: 8 }}>
        {windows.length} windows · {ratings.length} ratings
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#060608' },
  content:   { padding: 20, paddingBottom: 48, gap: 12 },
  card: {
    backgroundColor: S1, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: S2,
  },
  cardTitle: { fontSize: 10, fontFamily: MONO, color: '#b8b8cc', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 12 },
  backBtn: {
    height: 52, borderRadius: 16, backgroundColor: S2, borderWidth: 1, borderColor: '#22222e',
    alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  backBtnText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: TXM, letterSpacing: 2 },
});
