import { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Animated } from 'react-native';
import { SensorWindow, VibeScoreBreakdown, LiveDashboardData, SensorReading, TrendDir, AudioEvent } from '../src/types';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';
import { sessionManager } from '../src/session/SessionManager';
import { vibePrompt } from '../src/notifications/VibePrompt';

const RATING_LABELS = ['Dead', 'Meh', 'Decent', 'Great', 'Peak'];
const RATING_EMOJIS = ['💀', '😐', '🙂', '🔥', '🤯'];

export default function MeterScreen() {
  const [vibeScore, setVibeScore] = useState(0);
  const [live, setLive] = useState<LiveDashboardData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const scoreAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    sensorOrchestrator.setVibeUpdateCallback((_window: SensorWindow, scores: VibeScoreBreakdown, liveData: LiveDashboardData) => {
      setLive(liveData);
      setLastUpdated(new Date());
      Animated.spring(scoreAnim, { toValue: scores.compositeVibeScore, useNativeDriver: false, tension: 40, friction: 7 }).start();
      setVibeScore(scores.compositeVibeScore);
    });
    vibePrompt.setPromptShownCallback(() => setShowPrompt(true));
    const cur = sensorOrchestrator.currentVibeScore;
    if (cur > 0) { setVibeScore(cur); scoreAnim.setValue(cur); }
    return () => { sensorOrchestrator.setVibeUpdateCallback((() => {}) as any); };
  }, []);

  const handleRating = async (rating: number) => {
    setSelectedRating(rating);
    await vibePrompt.recordRating((rating + 1) as 1 | 2 | 3 | 4 | 5);
    setTimeout(() => { setShowPrompt(false); setSelectedRating(null); }, 800);
  };

  const isActive = sessionManager.isSessionActive;
  const secondsAgo = lastUpdated ? Math.round((Date.now() - lastUpdated.getTime()) / 1000) : null;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {!isActive && (
        <View style={s.inactiveNotice}>
          <Text style={s.inactiveText}>No active session — start one from Home</Text>
        </View>
      )}

      {/* ── Hero ── */}
      <View style={s.hero}>
        <View style={s.heroLeft}>
          <Animated.Text style={[s.heroScore, { color: getScoreColor(vibeScore) }]}>
            {isActive ? vibeScore.toFixed(1) : '--'}
          </Animated.Text>
          <Text style={s.heroLabel}>VIBE SCORE</Text>
          {lastUpdated && (
            <Text style={s.heroTime}>{secondsAgo === 0 ? 'just now' : `${secondsAgo}s ago`}</Text>
          )}
        </View>
        <TrendBadge dir={live?.trend15m ?? 'flat'} />
      </View>

      {/* ── Full-width MUSIC panel ── */}
      <MusicPanel live={live} />

      {/* ── 2-column grid ── */}
      <View style={s.grid}>

        {/* MOTION */}
        <View style={p.card}>
          <View style={p.header}>
            <Text style={p.icon}>📳</Text>
            <Text style={p.label}>MOTION</Text>
            {live?.phaseCoherence === 1 && (
              <View style={p.badge}>
                <Text style={p.badgeText}>🎵 IN SYNC</Text>
              </View>
            )}
          </View>
          <Text style={[p.value, { fontSize: 20 }]} numberOfLines={1}>
            {live?.movementClass ?? '--'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            {live?.movementBpm != null && (
              <Text style={{ color: '#3498DB', fontSize: 13 }}>
                {live.movementBpm} <Text style={{ fontSize: 10, color: '#555' }}>BPM</Text>
              </Text>
            )}
            {live?.rhythmicity != null && live.rhythmicity > 0 && (
              <Text style={{ color: rhythmicityColor(live.rhythmicity), fontSize: 11 }}>
                {rhythmicityLabel(live.rhythmicity)}
              </Text>
            )}
          </View>
          <Text style={{ color: '#555', fontSize: 10, marginTop: 2 }}>
            {live?.gyroReadings.length
              ? `gyro ${live.gyroReadings[live.gyroReadings.length - 1].v.toFixed(2)}`
              : '—'}
          </Text>
          <Sparkline readings={live?.gyroReadings ?? []} color="#3498DB" />
        </View>

        {/* DEVICES */}
        <SensorPanel
          label="DEVICES"
          icon="📡"
          value={live?.bleCount != null ? `${live.bleCount}` : '--'}
          sub={formatCrowdTrend(live?.bleTrend ?? null)}
          subColor={getCrowdColor(live?.bleTrend ?? null)}
          readings={live?.bleReadings ?? []}
          sparkColor="#E74C3C"
          trendArrow={live?.bleTrend ?? null}
        />

        {/* STEPS */}
        <SensorPanel
          label="STEPS"
          icon="👟"
          value={live?.stepCadence != null ? `${live.stepCadence}` : '--'}
          sub={live?.stepCadence != null ? `${cadenceLabel(live.stepCadence)} spm` : 'no data'}
          subColor={getCadenceColor(live?.stepCadence ?? null)}
          readings={live?.stepReadings ?? []}
          sparkColor="#27AE60"
        />

      </View>

      {/* ── Rating prompt ── */}
      {showPrompt && (
        <View style={s.promptOverlay}>
          <View style={s.promptCard}>
            <Text style={s.promptTitle}>How's the vibe? 🎉</Text>
            <View style={s.promptOptions}>
              {RATING_EMOJIS.map((emoji, index) => (
                <TouchableOpacity
                  key={index}
                  style={[s.promptOption, selectedRating === index && s.promptOptionSelected]}
                  onPress={() => handleRating(index)}
                >
                  <Text style={s.promptEmoji}>{emoji}</Text>
                  <Text style={s.promptLabel}>{RATING_LABELS[index]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={() => setShowPrompt(false)}>
              <Text style={s.promptDismiss}>Skip</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

// ── Music panel ───────────────────────────────────────────────────────────────

function MusicPanel({ live }: { live: LiveDashboardData | null }) {
  const db  = live?.dbReadings.length  ? live.dbReadings[live.dbReadings.length - 1].v   : null;
  const bpm = live?.bpmReadings.length ? live.bpmReadings[live.bpmReadings.length - 1].v : null;

  return (
    <View style={m.card}>
      {/* Header row */}
      <View style={p.header}>
        <Text style={p.icon}>🎵</Text>
        <Text style={p.label}>MUSIC</Text>
        {live?.audioEvent && <AudioEventBadge event={live.audioEvent} />}
      </View>

      {/* Song recognition */}
      <Text style={m.song} numberOfLines={1} ellipsizeMode="tail">
        {live?.recognizedSong ?? '—'}
      </Text>

      {/* dB + BPM row */}
      <View style={m.metricsRow}>
        <View style={m.metricCol}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
            <Text style={m.bigNum}>{db != null ? db.toFixed(0) : '--'}</Text>
            <Text style={m.unit}>dB</Text>
          </View>
          <Text style={[m.metricSub, { color: getAudioColor(live?.audioClass ?? null) }]}>
            {live?.audioClass?.replace('_', ' ').toUpperCase() ?? '—'}
          </Text>
        </View>

        <View style={m.divider} />

        <View style={m.metricCol}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
            <Text style={[m.bigNum, { color: bpm ? '#9B59B6' : '#444' }]}>
              {bpm ?? '--'}
            </Text>
            {bpm != null && <Text style={m.unit}>BPM</Text>}
          </View>
          <Text style={[m.metricSub, { color: bpm ? '#9B59B6' : '#444' }]}>
            {bpm ? 'audio beat' : 'no rhythm'}
          </Text>
        </View>
      </View>

      {/* Sparkline */}
      <Sparkline readings={live?.dbReadings ?? []} color="#FF8C00" height={32} />
    </View>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function SensorPanel({
  label, icon, value, sub, subColor, readings, sparkColor, trendArrow,
}: {
  label: string; icon: string; value: string; sub: string; subColor: string;
  readings: SensorReading[]; sparkColor: string; trendArrow?: string | null;
}) {
  return (
    <View style={p.card}>
      <View style={p.header}>
        <Text style={p.icon}>{icon}</Text>
        <Text style={p.label}>{label}</Text>
        {trendArrow && <CrowdArrow trend={trendArrow} />}
      </View>
      <Text style={p.value} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={[p.sub, { color: subColor }]}>{sub}</Text>
      <Sparkline readings={readings} color={sparkColor} />
    </View>
  );
}

function Sparkline({ readings, color, height = 36 }: { readings: SensorReading[]; color: string; height?: number }) {
  const MAX = 20;
  const recent = readings.slice(-MAX);
  if (recent.length < 2) {
    return (
      <View style={{ height, justifyContent: 'center' }}>
        <Text style={{ color: '#2A2A2A', fontSize: 10, textAlign: 'center' }}>collecting…</Text>
      </View>
    );
  }
  const vals = recent.map(d => d.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals, min + 0.001);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: 2, marginTop: 8 }}>
      {recent.map((d, i) => (
        <View key={i} style={{
          flex: 1,
          height: Math.max(2, ((d.v - min) / (max - min)) * height),
          backgroundColor: color,
          borderRadius: 2,
          opacity: 0.3 + (i / recent.length) * 0.7,
        }} />
      ))}
    </View>
  );
}

function TrendBadge({ dir }: { dir: TrendDir }) {
  const map = {
    up:   { symbol: '↑', color: '#00FF88' },
    down: { symbol: '↓', color: '#FF4444' },
    flat: { symbol: '→', color: '#555' },
  };
  const { symbol, color } = map[dir];
  return (
    <View style={[tb.badge, { borderColor: color + '40' }]}>
      <Text style={[tb.symbol, { color }]}>{symbol}</Text>
      <Text style={tb.label}>15m</Text>
    </View>
  );
}

function AudioEventBadge({ event }: { event: AudioEvent }) {
  const map: Record<AudioEvent, { label: string; color: string; bg: string }> = {
    crowd_clapping: { label: '👏 CROWD CLAPPING', color: '#FFB347', bg: '#FF8C0022' },
    cheering:       { label: '🙌 CHEERING',       color: '#00FF88', bg: '#00FF8822' },
    dj_drop:        { label: '💥 DJ DROP',         color: '#FF4444', bg: '#FF444422' },
  };
  const { label, color, bg } = map[event];
  return (
    <View style={[m.clapBadge, { backgroundColor: bg, borderColor: color + '44' }]}>
      <Text style={[m.clapText, { color }]}>{label}</Text>
    </View>
  );
}

function CrowdArrow({ trend }: { trend: string }) {
  if (trend === 'filling')  return <Text style={{ color: '#00FF88', fontSize: 14 }}>↑</Text>;
  if (trend === 'thinning') return <Text style={{ color: '#FF4444', fontSize: 14 }}>↓</Text>;
  if (trend === 'stable')   return <Text style={{ color: '#888', fontSize: 14 }}>→</Text>;
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getScoreColor(score: number) {
  if (score < 1.5) return '#444';
  if (score < 2.5) return '#888';
  if (score < 3.5) return '#FFB347';
  if (score < 4.5) return '#00CC6A';
  return '#00FF88';
}

function getAudioColor(cls: string | null) {
  if (!cls || cls === 'silent') return '#444';
  if (cls === 'talking') return '#FFB347';
  return '#00FF88';
}

function getCrowdColor(trend: string | null) {
  if (trend === 'filling')  return '#00FF88';
  if (trend === 'thinning') return '#FF4444';
  if (trend === 'stable')   return '#888';
  return '#444';
}

function formatCrowdTrend(trend: string | null) {
  if (trend === 'filling')  return 'filling up';
  if (trend === 'thinning') return 'thinning out';
  if (trend === 'stable')   return 'stable';
  return 'scanning…';
}

function cadenceLabel(spm: number): string {
  if (spm < 20)  return 'still';
  if (spm < 80)  return 'slow';
  if (spm < 110) return 'walking';
  if (spm < 140) return 'fast';
  return 'running';
}

function getCadenceColor(spm: number | null): string {
  if (spm == null) return '#444';
  if (spm < 20)   return '#444';
  if (spm < 80)   return '#888';
  if (spm < 110)  return '#FFB347';
  if (spm < 140)  return '#27AE60';
  return '#00FF88';
}

function rhythmicityLabel(r: number): string {
  if (r > 0.7) return 'very rhythmic';
  if (r > 0.5) return 'rhythmic';
  if (r > 0.3) return 'some rhythm';
  return 'irregular';
}

function rhythmicityColor(r: number): string {
  if (r > 0.6) return '#00FF88';
  if (r > 0.35) return '#FFB347';
  return '#555';
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content:   { padding: 16, paddingBottom: 40 },

  inactiveNotice: { backgroundColor: '#1A0A00', borderRadius: 8, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#FF8C0033' },
  inactiveText:   { color: '#FF8C00', fontSize: 13, textAlign: 'center' },

  hero: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#0A0A0A', borderRadius: 16, padding: 20, marginBottom: 12,
    borderWidth: 1, borderColor: '#1A1A1A',
  },
  heroLeft:  { flex: 1 },
  heroScore: { fontSize: 80, fontWeight: 'bold', fontVariant: ['tabular-nums'], lineHeight: 84 },
  heroLabel: { color: '#444', fontSize: 11, letterSpacing: 3, marginTop: -4 },
  heroTime:  { color: '#333', fontSize: 10, marginTop: 4 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },

  promptOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  promptCard:    { backgroundColor: '#0D0D0D', borderRadius: 20, padding: 28, width: '100%', borderWidth: 1, borderColor: '#00FF8840', alignItems: 'center' },
  promptTitle:   { color: '#FFF', fontSize: 22, fontWeight: 'bold', marginBottom: 24 },
  promptOptions: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  promptOption:  { flex: 1, alignItems: 'center', padding: 12, borderRadius: 12, backgroundColor: '#111', borderWidth: 1, borderColor: '#222' },
  promptOptionSelected: { borderColor: '#00FF88', backgroundColor: '#0D1F17' },
  promptEmoji:   { fontSize: 28, marginBottom: 4 },
  promptLabel:   { color: '#888', fontSize: 10 },
  promptDismiss: { color: '#444', fontSize: 13 },
});

// Music panel styles
const m = StyleSheet.create({
  card: {
    backgroundColor: '#0A0A0A', borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: '#1A1A1A', marginBottom: 10,
  },
  song: {
    color: '#FFF', fontSize: 17, fontWeight: '600', marginBottom: 12, marginTop: 4,
  },
  metricsRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  metricCol:  { flex: 1 },
  divider:    { width: 1, height: 40, backgroundColor: '#222', marginHorizontal: 16 },
  bigNum:     { color: '#FFF', fontSize: 30, fontWeight: 'bold', fontVariant: ['tabular-nums'] },
  unit:       { color: '#555', fontSize: 13 },
  metricSub:  { fontSize: 11, marginTop: 2 },
  clapBadge:  { marginLeft: 'auto', backgroundColor: '#FF8C0022', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#FF8C0044' },
  clapText:   { color: '#FF8C00', fontSize: 11, fontWeight: '600' },
});

// Panel styles
const p = StyleSheet.create({
  card:     { width: '48%', backgroundColor: '#0A0A0A', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#1A1A1A' },
  cardWide: { width: '100%' },
  header:   { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  icon:     { fontSize: 15 },
  label:    { color: '#FFFFFF', fontSize: 15, fontWeight: 'bold', letterSpacing: 0.5, flex: 1 },
  value:    { color: '#CCCCCC', fontSize: 22, fontWeight: '500', fontVariant: ['tabular-nums'] },
  sub:      { fontSize: 11, marginTop: 2 },
  badge:    { backgroundColor: '#3498DB22', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: '#3498DB44' },
  badgeText:{ color: '#3498DB', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
});

const tb = StyleSheet.create({
  badge:  { alignItems: 'center', borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, minWidth: 60 },
  symbol: { fontSize: 28, fontWeight: 'bold' },
  label:  { color: '#444', fontSize: 9, letterSpacing: 1, marginTop: 2 },
});
