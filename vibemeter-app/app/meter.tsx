import { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Animated, Platform, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  SensorWindow, VibeScoreBreakdown, LiveDashboardData,
  SensorReading, AudioEvent,
} from '../src/types';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';
import { sessionManager } from '../src/session/SessionManager';
import { vibePrompt } from '../src/notifications/VibePrompt';

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


const TABS = ['vibe', 'music', 'motion', 'crowd'] as const;
type Tab = typeof TABS[number];
const TAB_LABELS: Record<Tab, string> = {
  vibe: 'VIBE', music: 'MUSIC', motion: 'MOTION', crowd: 'CROWD',
};

/* ── Helpers ────────────────────────────────────────────────── */
function scoreColor(v: number): string {
  return v >= 4 ? A : v >= 2.5 ? WRN : DNG;
}

function findBestSync(mbpm: number | null, musicBpm: number | null) {
  if (!musicBpm || !mbpm) return { delta: 0, targetBpm: 0, absDelta: 99, tag: '1:1', mult: 1 };
  const candidates = [
    { mult: 1,    tag: '1'    },
    { mult: 0.5,  tag: '0.5' },
    { mult: 2,    tag: '2'   },
    { mult: 0.25, tag: '0.25' },
  ].filter(c => { const t = musicBpm * c.mult; return t >= 28 && t <= 200; });
  let best: any = null;
  for (const c of candidates) {
    const target = musicBpm * c.mult;
    const absDelta = Math.abs(mbpm - target);
    if (!best || absDelta < best.absDelta)
      best = { delta: mbpm - target, targetBpm: Math.round(target), absDelta, tag: c.tag, mult: c.mult };
  }
  return best || { delta: 0, targetBpm: 0, absDelta: 99, tag: '1:1', mult: 1 };
}

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function getAudioClassColor(cls: string | null): string {
  if (!cls || cls === 'silent') return TXD;
  if (cls === 'talking' || cls === 'low_music') return WRN;
  return A;
}

/* ── Atoms ──────────────────────────────────────────────────── */
function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return (
    <View style={[a.card, style]}>
      {children}
    </View>
  );
}

type InfoFn = (label: string, info: string) => void;

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ fontSize: 11, fontFamily: MONO, color: '#c8c8e0', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10 }}>
      {children}
    </Text>
  );
}

function LblWithInfo({ label, info, onInfo }: { label: string; info: string; onInfo: InfoFn }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}>
      <Text style={{ fontSize: 11, fontFamily: MONO, color: '#c8c8e0', letterSpacing: 1.5, textTransform: 'uppercase' }}>{label}</Text>
      <TouchableOpacity onPress={() => onInfo(label, info)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 1, borderColor: TXD + '60', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 8, color: TXD + '90', fontWeight: '700', lineHeight: 10 }}>i</Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

function Chip({ label, color = A }: { label: string; color?: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: color + '40', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 }}>
      <Text style={{ fontSize: 10, fontFamily: MONO, fontWeight: '700', color, letterSpacing: 1 }}>{label}</Text>
    </View>
  );
}

function BigNum({ value, color = A, size = 22 }: { value: string | number; color?: string; size?: number }) {
  return (
    <Text style={{ fontFamily: MONO, fontSize: size, fontWeight: '700', color, lineHeight: size * 1.1 }}>
      {value}
    </Text>
  );
}

function FillBar({ value, max = 1, color = A, height = 6 }: { value: number; max?: number; color?: string; height?: number }) {
  const pct = Math.min(1, Math.max(0, value / max));
  return (
    <View style={{ height, backgroundColor: S2, borderRadius: height / 2, overflow: 'hidden' }}>
      <View style={{
        width: `${pct * 100}%`, height: '100%',
        backgroundColor: color, borderRadius: height / 2,
      }} />
    </View>
  );
}

/* ── Sparkline ──────────────────────────────────────────────── */
function Sparkline({ readings, color, height = 36 }: { readings: SensorReading[]; color: string; height?: number }) {
  const MAX = 20;
  const recent = readings.slice(-MAX);
  if (recent.length < 2) {
    return (
      <View style={{ height, justifyContent: 'center' }}>
        <Text style={{ color: TXD, fontSize: 10, textAlign: 'center', fontFamily: MONO }}>collecting…</Text>
      </View>
    );
  }
  const vals = recent.map(d => d.v);
  const min = Math.min(...vals), max = Math.max(...vals, min + 0.001);
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

/* ── Circle Gauge ───────────────────────────────────────────── */
function CircleGauge({ score, size = 160 }: { score: number; size?: number }) {
  const color = scoreColor(score);
  const stroke = size * 0.09;
  const half = size / 2;
  const progress = score / 5;

  // Two-half-circle technique: right half fills 0→0.5, left half fills 0.5→1
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
      {/* Track */}
      <View style={{
        position: 'absolute', width: size, height: size,
        borderRadius: half, borderWidth: stroke, borderColor: S2,
      }} />
      {/* Fill */}
      {rightDeg > 0 && halfCircle('right', rightDeg, color)}
      {leftDeg > 0  && halfCircle('left',  leftDeg,  color)}
      {/* Labels */}
      <View style={{ alignItems: 'center' }}>
        <Text style={{ fontFamily: MONO, fontSize: size * 0.22, fontWeight: '700', color, lineHeight: size * 0.24 }}>
          {score.toFixed(1)}
        </Text>
        <Text style={{ fontFamily: MONO, fontSize: size * 0.065, color: TXD, letterSpacing: 2, marginTop: 2 }}>
          VIBE SCORE
        </Text>
      </View>
    </View>
  );
}

/* ── Mini Gauge ─────────────────────────────────────────────── */
function MiniGauge({ score, size = 46 }: { score: number; size?: number }) {
  const color = scoreColor(score);
  const stroke = size * 0.12;
  const half = size / 2;
  const progress = score / 5;
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

/* ── EQ Bars (BPM-adaptive, requestAnimationFrame) ──────────── */
function EQBars({ bpm }: { bpm: number | null }) {
  const COUNT = 12;
  const BAR_H = 36;
  const anims = useRef(Array.from({ length: COUNT }, () => new Animated.Value(0.5))).current;
  const rafRef = useRef<number | null>(null);
  const phaseRef = useRef(0);
  const lastRef = useRef<number | null>(null);
  const bpmRef = useRef(bpm ?? 120);

  useEffect(() => { bpmRef.current = bpm ?? 120; }, [bpm]);

  useEffect(() => {
    function tick(ts: number) {
      if (lastRef.current !== null) {
        const speed = (bpmRef.current / 60) * Math.PI * 2;
        phaseRef.current += ((ts - lastRef.current) / 1000) * speed;
      }
      lastRef.current = ts;
      const p = phaseRef.current;
      anims.forEach((anim, i) => {
        const po = (i / COUNT) * Math.PI * 2;
        const norm = 0.5
          + 0.30 * Math.sin(p + po)
          + 0.13 * Math.sin(p * 1.73 + po * 1.31)
          + 0.07 * Math.sin(p * 3.17 + po * 0.73);
        anim.setValue(Math.max(0.08, norm));
      });
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); lastRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: BAR_H, width: 64 }}>
      {anims.map((anim, i) => (
        <Animated.View key={i} style={{
          flex: 1,
          height: anim.interpolate({ inputRange: [0, 1], outputRange: [3, BAR_H] }),
          backgroundColor: A,
          borderRadius: 2,
        }} />
      ))}
    </View>
  );
}

/* ── Harmonic Bar ───────────────────────────────────────────── */
function HarmonicBar({ mbpm, musicBpm }: { mbpm: number | null; musicBpm: number | null }) {
  const MIN_BPM = 20, MAX_BPM = 270;
  const toFrac = (v: number) => (v - MIN_BPM) / (MAX_BPM - MIN_BPM);

  const harmonics = [
    { mult: 0.25, tag: '0.25' },
    { mult: 0.5,  tag: '0.5'  },
    { mult: 1,    tag: '1'    },
    { mult: 2,    tag: '2'    },
  ].map(h => ({ ...h, bpm: Math.round((musicBpm || 128) * h.mult) }))
   .filter(h => h.bpm >= MIN_BPM && h.bpm <= MAX_BPM);

  const cursorFrac = mbpm ? Math.min(0.99, Math.max(0.01, toFrac(mbpm))) : 0;
  const minDelta = harmonics.length
    ? Math.min(...harmonics.map(h => Math.abs((mbpm || 0) - h.bpm)))
    : 99;
  const cursorColor = minDelta <= 5 ? A : minDelta <= 14 ? WRN : DNG;

  return (
    <View style={{ marginTop: 8 }}>
      {/* Track + ticks + cursor */}
      <View style={{ height: 28, position: 'relative' }}>
        <View style={{ position: 'absolute', top: 13, left: 0, right: 0, height: 4, backgroundColor: '#2a2a3a', borderRadius: 2 }} />

        {harmonics.map(h => {
          const near = Math.abs((mbpm || 0) - h.bpm) <= 5;
          return (
            <View key={h.mult} style={{
              position: 'absolute', left: `${toFrac(h.bpm) * 100}%`,
              top: 8, width: 2.4, height: 12, backgroundColor: near ? A : '#d0d0e4',
              borderRadius: 1.2, opacity: near ? 1 : 0.6,
              transform: [{ translateX: -1.2 }],
            }} />
          );
        })}

        <View style={{
          position: 'absolute', left: `${cursorFrac * 100}%`,
          top: 5, width: 18, height: 18,
          borderRadius: 9, backgroundColor: cursorColor,
          transform: [{ translateX: -9 }],
          shadowColor: cursorColor, shadowOpacity: 0.8, shadowRadius: 6, elevation: 4,
        }}>
          <View style={{ position: 'absolute', top: 5, left: 5, width: 8, height: 8, borderRadius: 4, backgroundColor: S1 }} />
        </View>
      </View>

      {/* Harmonic labels below */}
      <View style={{ flexDirection: 'row', height: 22, position: 'relative', marginTop: 4 }}>
        {harmonics.map(h => {
          const near = Math.abs((mbpm || 0) - h.bpm) <= 5;
          return (
            <View key={h.mult} style={{ position: 'absolute', left: `${toFrac(h.bpm) * 100}%`, width: 40, alignItems: 'center', transform: [{ translateX: -20 }] }}>
              <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: near ? '700' : '400', color: near ? A : TXM }}>{h.tag}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/* ── Collective Sync Card ───────────────────────────────────── */
function CollectiveSyncCard({ csync, ble }: { csync: number; ble: number | null }) {
  const pct    = Math.round(csync * 100);
  const inSync = Math.round(csync * Math.min(ble || 0, 12));
  const color  = pct >= 65 ? A : pct >= 40 ? WRN : DNG;
  return (
    <View style={{ borderRadius: 14, padding: 14, backgroundColor: color + '0e', borderWidth: 1, borderColor: color + '45', marginBottom: 4, shadowColor: color, shadowOpacity: 0.15, shadowRadius: 12, elevation: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <View>
          <Text style={{ fontSize: 10, fontFamily: MONO, color, letterSpacing: 1.5, marginBottom: 6 }}>★ COLLECTIVE SYNC</Text>
          <Text style={{ fontFamily: MONO, fontSize: 36, fontWeight: '700', color, lineHeight: 38 }}>{pct}%</Text>
          <Text style={{ fontSize: 12, color: TXM, marginTop: 5 }}>of {ble ?? 0} devices moving together</Text>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, width: 72, paddingTop: 2 }}>
          {Array.from({ length: 12 }, (_, i) => (
            <View key={i} style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: i < inSync ? color : S2, opacity: i < inSync ? 0.9 : 0.25 }} />
          ))}
        </View>
      </View>
      <FillBar value={csync} max={1} color={color} height={5} />
      <Text style={{ fontSize: 10, fontFamily: MONO, color: color + '80', marginTop: 7 }}>
        {(ble ?? 0) >= 3
          ? `${Math.round(csync * (ble ?? 0))} of ${ble} devices in sync`
          : '⚠ needs 3+ devices for accuracy'}
      </Text>
    </View>
  );
}

/* ── Panels ─────────────────────────────────────────────────── */
function VibePanel({ live, scores }: { live: LiveDashboardData | null; scores: VibeScoreBreakdown | null }) {
  const csync = live ? Math.sqrt(Math.max(0, live.rhythmicity * live.phaseCoherence)) : 0;
  const comps = [
    { l: 'ENERGY', v: scores?.energyScore    ?? 0, w: '30%' },
    { l: 'MUSIC',  v: scores?.musicScore     ?? 0, w: '25%' },
    { l: 'MOTION', v: scores?.movementScore  ?? 0, w: '20%' },
    { l: 'CROWD',  v: scores?.densityScore   ?? 0, w: '15%' },
    { l: 'ENGAGE', v: scores?.engagementScore ?? 0, w: '10%' },
  ];
  const composite = scores?.compositeVibeScore ?? 0;
  const conf = scores?.confidence ?? 0;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 14 }}>
      <CollectiveSyncCard csync={csync} ble={live?.bleCount ?? null} />
      <View style={{ alignItems: 'center', marginVertical: 4 }}>
        <CircleGauge score={composite} size={160} />
        <Text style={{ fontSize: 12, color: TXM, marginTop: 8 }}>
          CONFIDENCE <Text style={{ color: TX }}>{conf > 0 ? `${Math.round(conf * 100)}%` : '—'}</Text>
        </Text>
      </View>
      <Card>
        <Lbl>Component Scores</Lbl>
        {comps.map(c => (
          <View key={c.l} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Text style={{ width: 48, fontSize: 10, fontFamily: MONO, color: TXM, letterSpacing: 1 }}>{c.l}</Text>
            <Text style={{ fontSize: 10, fontFamily: MONO, color: TXD, width: 26, textAlign: 'right' }}>{c.w}</Text>
            <View style={{ flex: 1 }}><FillBar value={c.v} max={5} color={scoreColor(c.v)} /></View>
            <Text style={{ width: 28, fontSize: 12, fontFamily: MONO, fontWeight: '700', color: scoreColor(c.v), textAlign: 'right' }}>{c.v.toFixed(1)}</Text>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

function MusicPanel({ live, onInfo }: { live: LiveDashboardData | null; onInfo: (label: string, info: string) => void }) {
  const db   = live?.dbReadings.length  ? live.dbReadings[live.dbReadings.length - 1].v   : null;
  const bpm  = live?.audioBpm ?? null;
  const cls  = live?.audioClass ?? null;
  const clsC = cls === 'loud_music' ? DNG : cls === 'high_music' ? WRN : A;
  const clsLabel = cls ? cls.replace('_', ' ').toUpperCase() : '—';
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 12 }}>
      {/* Audio Level */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <LblWithInfo label="Audio Level" onInfo={onInfo} info="Sound pressure level in dB SPL. 55 dB = quiet conversation, 70 dB = typical bar, 85 dB = loud club, 95+ dB = very loud / hearing-risk territory. Used as the primary energy signal — louder environments score higher on the vibe scale." />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Chip label={clsLabel} color={clsC} />
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
              <BigNum value={db != null ? Math.round(db) : '--'} size={24} />
              <Text style={{ fontSize: 11, color: TXD }}>dB</Text>
            </View>
          </View>
        </View>
        <FillBar value={db ?? 0} max={95} color={(db ?? 0) > 85 ? DNG : (db ?? 0) > 78 ? WRN : A} height={8} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 }}>
          <Text style={{ fontSize: 9, fontFamily: MONO, color: TXD }}>55 dB</Text>
          <Text style={{ fontSize: 9, fontFamily: MONO, color: TXD }}>95 dB</Text>
        </View>
        <Sparkline readings={live?.dbReadings ?? []} color='#FF8C00' height={32} />
      </Card>

      {/* Music BPM */}
      <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16 }}>
        <View>
          <LblWithInfo label="Music BPM" onInfo={onInfo} info="Beats per minute detected from the raw audio waveform via spectral onset detection (iOS). 60–90 BPM = chill/hip-hop, 120–130 = house, 140+ = techno/drum & bass. Null when no clear rhythm is found." />
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <BigNum value={bpm ?? '--'} size={42} color={A} />
            {bpm != null && <Text style={{ fontSize: 11, color: TXD }}>BPM</Text>}
          </View>
        </View>
        <EQBars bpm={bpm} />
      </Card>

      {/* Now Playing */}
      <Card>
        <Lbl>Now Playing</Lbl>
        {live?.recognizedSong ? (
          <>
            <Text style={{ fontSize: 17, fontWeight: '600', color: TX, marginBottom: 3 }}>{live.recognizedSong}</Text>
            {live.recognizedGenre && (
              <View style={{ flexDirection: 'row', marginTop: 6 }}>
                <Chip label={live.recognizedGenre.toUpperCase()} color={TXD} />
              </View>
            )}
          </>
        ) : (
          <Text style={{ fontSize: 12, fontFamily: MONO, color: TXD, fontStyle: 'italic' }}>Detecting…</Text>
        )}
        {live?.audioEvent && <AudioEventBadge event={live.audioEvent} />}
      </Card>

      {/* Spectral Analysis */}
      <Card>
        <Lbl>Spectral Analysis</Lbl>
        {/* Bar metrics: natural 0–100% ratios */}
      {([
          {
            label: 'SUB-BASS  20–80 Hz', value: live?.subBassEnergy ?? 0, color: '#7B68EE',
            fmt: (v: number) => `${(v * 100).toFixed(0)}%`,
            info: 'Fraction of audio energy in the kick drum and bass synth range (20–80 Hz). High = heavy bass — the primary signal for dance-floor intensity. A packed club with a loud system typically reads 20–40%.',
          },
          {
            label: 'DYNAMICS (FLUX)', value: live?.spectralFlux ?? 0, color: '#3DB8F5',
            fmt: (v: number) => `${(v * 100).toFixed(0)}%`,
            info: 'How rapidly the frequency spectrum changes between audio frames. High = evolving mix — drops, builds, transitions. Low = static loop, silence, or a flat sustained tone. A live DJ set in a good moment reads 40–70%.',
          },
          {
            label: 'VOCAL  300–3 kHz', value: live?.vocalPresence ?? 0, color: '#2ECC71',
            fmt: (v: number) => `${(v * 100).toFixed(0)}%`,
            info: 'Fraction of energy in the speech and singing band (300 Hz – 3 kHz). High = vocals or talking dominate. Low = purely instrumental or sub-bass heavy. Useful for distinguishing a vocal track from a DJ instrumental set.',
          },
          {
            label: 'TONAL (HNR)', value: live?.harmonicNoiseRatio ?? 0, color: A,
            fmt: (v: number) => `${(v * 100).toFixed(0)}%`,
            info: 'Harmonic-to-noise ratio: how tonal vs noisy the audio is. High = clear musical tones, chords, or melody. Low = crowd chatter, hiss, or wind. Helps distinguish live music from ambient crowd noise.',
          },
        ] as Array<{ label: string; value: number; color: string; fmt: (v: number) => string; info: string }>).map(({ label, value, color, fmt, info }) => (
          <View key={label} style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Text style={{ fontFamily: MONO, fontSize: 11, color: TXD, letterSpacing: 0.5 }}>{label}</Text>
                <TouchableOpacity onPress={() => onInfo(label, info)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 1, borderColor: TXD + '60', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 8, color: TXD + '90', fontWeight: '700', lineHeight: 10 }}>i</Text>
                  </View>
                </TouchableOpacity>
              </View>
              <Text style={{ fontFamily: MONO, fontSize: 12, fontWeight: '700', color }}>{fmt(value)}</Text>
            </View>
            <FillBar value={value} max={1} color={color} height={5} />
          </View>
        ))}

      {/* Scalar metrics: Centroid + Transient side by side */}
      <View style={{ flexDirection: 'row', gap: 0 }}>
        {([
            {
              label: 'CENTROID', value: live?.spectralCentroid ?? 0, color: '#FFB347',
              fmt: (v: number) => v > 0 ? `${Math.round(v)} Hz` : '--',
              chip: (v: number) => v < 1000 ? 'WARM' : v < 3000 ? 'MID' : 'BRIGHT',
              chipColor: (v: number) => v < 1000 ? '#7B68EE' : v < 3000 ? '#FFB347' : '#FF6B6B',
              info: 'The frequency "centre of mass" of the audio. Low = warm, bass-heavy sound. High = bright, harsh. Energetic club music typically lands between 1500–4000 Hz. Very low (<800 Hz) means mostly sub-bass; very high (>6000 Hz) suggests hiss or hi-hats dominating.',
            },
            {
              label: 'TRANSIENT', value: live?.crestFactor ?? 0, color: '#E74C3C',
              fmt: (v: number) => `${v.toFixed(1)} dB`,
              chip: (v: number) => v < 6 ? 'FLAT' : v < 13 ? 'PUNCHY' : 'SHARP',
              chipColor: (v: number) => v < 6 ? TXD : v < 13 ? WRN : A,
              info: 'Peak-to-RMS ratio in dB. High (>12 dB) = punchy transients — kick drums, snares, DJ drops. Low (<6 dB) = heavily compressed or flat sound. Most modern club tracks sit around 8–14 dB.',
            },
          ] as Array<{ label: string; value: number; color: string; fmt: (v: number) => string; chip: (v: number) => string; chipColor: (v: number) => string; info: string }>).map(({ label, value, color, fmt, chip, chipColor, info }, idx) => (
            <View key={label} style={{ flex: 1, paddingLeft: idx === 1 ? 12 : 0, borderLeftWidth: idx === 1 ? 1 : 0, borderLeftColor: S2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 6 }}>
                <Text style={{ fontFamily: MONO, fontSize: 11, color: TXD, letterSpacing: 0.5 }}>{label}</Text>
                <TouchableOpacity onPress={() => onInfo(label, info)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 1, borderColor: TXD + '60', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 8, color: TXD + '90', fontWeight: '700', lineHeight: 10 }}>i</Text>
                  </View>
                </TouchableOpacity>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <View style={{ borderWidth: 1, borderColor: chipColor(value) + '60', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontFamily: MONO, fontSize: 10, fontWeight: '700', color: chipColor(value), letterSpacing: 1 }}>{chip(value)}</Text>
                </View>
                <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: '700', color }}>{fmt(value)}</Text>
              </View>
            </View>
          ))}
      </View>
      </Card>

    </ScrollView>
  );
}

function MotionPanel({ live, onInfo }: { live: LiveDashboardData | null; onInfo: InfoFn }) {
  const mag   = live?.magReadings.length ? live.magReadings[live.magReadings.length - 1].v : null;
  const mbpm  = live?.movementBpm ?? null;
  const bpm   = live?.audioBpm ?? null;
  const rhy   = live?.rhythmicity ?? 0;
  const phase = live?.phaseCoherence ?? 0;

  const mvLabel = (mag ?? 0) > 2 ? 'DANCING' : (mag ?? 0) > 1.2 ? 'MOVING' : (mag ?? 0) > 0.6 ? 'WALKING' : 'STATIONARY';
  const mvC     = (mag ?? 0) > 2 ? A : (mag ?? 0) > 1.2 ? WRN : TXD;

  const sync = findBestSync(mbpm, bpm);
  const syncColor = sync.absDelta <= 5 ? A : sync.absDelta <= 14 ? WRN : DNG;
  const syncChip  = sync.absDelta <= 5
    ? (sync.mult === 1 ? 'IN SYNC' : sync.tag.toUpperCase())
    : `${sync.delta > 0 ? '+' : ''}${Math.round(sync.delta)} BPM`;
  const syncSub = sync.mult === 1
    ? `vs ${bpm ?? '--'} BPM music`
    : `${mbpm ?? '--'} body · ${bpm ?? '--'} music (${sync.tag})`;

  const bs    = Math.sqrt(Math.max(0, rhy * phase));
  const bsC   = scoreColor(bs * 5);
  const bsLbl = bs > 0.65 ? 'LOCKED IN' : bs > 0.4 ? 'BUILDING' : 'DRIFTING';

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 12 }}>
      {/* Accelerometer */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <View>
            <LblWithInfo label="Accelerometer" onInfo={onInfo} info="Raw acceleration magnitude in m/s², averaged over the sample window. Captures physical movement intensity: <0.3 = stationary, 0.3–0.8 = walking, 0.8–1.5 = swaying, 1.5–3 = dancing, >3 = jumping. Measured by the phone's built-in accelerometer." />
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
              <BigNum value={mag != null ? mag.toFixed(2) : '--'} size={28} color={mvC} />
              <Text style={{ fontSize: 11, color: TXD }}>m/s²</Text>
            </View>
          </View>
          <Chip label={mvLabel} color={mvC} />
        </View>
        <FillBar value={mag ?? 0} max={3} color={mvC} height={8} />
        <Sparkline readings={live?.magReadings ?? []} color='#3498DB' height={28} />
      </Card>

      {/* Movement BPM */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
          <View>
            <LblWithInfo label="Movement BPM" onInfo={onInfo} info="Dominant rhythmic frequency of body movement (30–240 BPM), extracted from the accelerometer signal via FFT. When you dance, your movements create a periodic signal — this is the tempo of that signal. Compared against audio BPM to measure beat sync." />
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5 }}>
              <BigNum value={mbpm ?? '--'} size={44} color={syncColor} />
              {mbpm != null && <Text style={{ fontSize: 11, color: TXD }}>BPM</Text>}
            </View>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 5, paddingTop: 2 }}>
            <Chip label={syncChip} color={syncColor} />
            <Text style={{ fontSize: 11, fontFamily: MONO, color: TXM }}>{syncSub}</Text>
          </View>
        </View>
        <HarmonicBar mbpm={mbpm} musicBpm={bpm} />
      </Card>

      {/* Beat Sync */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
          <View>
            <LblWithInfo label="Beat Sync" onInfo={onInfo} info="How well your body movement aligns with the music beat, combining rhythmicity × phase coherence. >0.65 = locked in, 0.4–0.65 = building, <0.4 = drifting. Requires both audio BPM and movement BPM to be active." />
            <BigNum value={bs.toFixed(2)} size={44} color={bsC} />
          </View>
          <Chip label={bsLbl} color={bsC} />
        </View>
        <FillBar value={bs} max={1} color={bsC} height={8} />
        <Text style={{ fontSize: 12, color: TXM, marginTop: 8 }}>rhythmic body movement in sync with music</Text>
        <View style={{ flexDirection: 'row', gap: 14, marginTop: 14 }}>
          {([
            { l: 'RHYTHMICITY', v: rhy, info: 'How regular and periodic your movement signal is (0–1). High = consistent repeating movement like dancing to a beat. Low = irregular or stationary. Computed from the ratio of peak spectral power to total power in the accelerometer FFT.' },
            { l: 'PHASE COHERENCE', v: phase, info: 'Whether your movement rhythm matches the music BPM or a harmonic of it (½×, 1×, 2×, 3×). 1.0 = perfectly in sync with a harmonic, 0 = no match detected. Requires both movement BPM and audio BPM to be active.' },
          ] as Array<{ l: string; v: number; info: string }>).map(item => (
            <View key={item.l} style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 5 }}>
                <Text style={{ fontSize: 10, fontFamily: MONO, color: TXD, letterSpacing: 1 }}>{item.l}</Text>
                <TouchableOpacity onPress={() => onInfo(item.l, item.info)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: TXD + '60', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 7, color: TXD + '90', fontWeight: '700', lineHeight: 9 }}>i</Text>
                  </View>
                </TouchableOpacity>
              </View>
              <FillBar value={item.v} max={1} color={TXM} height={4} />
              <Text style={{ fontSize: 11, fontFamily: MONO, color: TXM, marginTop: 3 }}>{item.v.toFixed(2)}</Text>
            </View>
          ))}
        </View>
      </Card>
    </ScrollView>
  );
}

function CrowdPanel({ live, onInfo }: { live: LiveDashboardData | null; onInfo: InfoFn }) {
  const ble   = live?.bleCount ?? 0;
  const trend = live?.bleTrend ?? 'stable';
  const tArrow = trend === 'filling' ? '↑' : trend === 'thinning' ? '↓' : '→';
  const tColor = trend === 'filling' ? A : trend === 'thinning' ? DNG : WRN;
  const MAX_DOTS = 48;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 12 }}>
      <Card style={{ alignItems: 'center', paddingVertical: 20, gap: 8 }}>
        <LblWithInfo label="Nearby Devices (BLE)" onInfo={onInfo} info="Number of unique Bluetooth Low Energy (BLE) devices detected within roughly 10–30 metres — mostly phones in people's pockets. The app never sees device identifiers, only a count. Used as a crowd density proxy: more devices = more people around you." />
        <BigNum value={ble} size={72} color={A} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 20, color: tColor, fontWeight: '700', lineHeight: 24 }}>{tArrow}</Text>
          <Text style={{ fontSize: 11, fontFamily: MONO, fontWeight: '700', color: tColor, letterSpacing: 1.5 }}>{trend.toUpperCase()}</Text>
          <TouchableOpacity onPress={() => onInfo('Crowd Trend', 'Whether nearby BLE device count is increasing (↑ filling), decreasing (↓ thinning), or holding steady (→ stable). Calculated from the rolling delta between consecutive scans. A filling crowd tends to signal rising energy.')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 1, borderColor: TXD + '60', alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 8, color: TXD + '90', fontWeight: '700', lineHeight: 10 }}>i</Text>
            </View>
          </TouchableOpacity>
        </View>
        <Sparkline readings={live?.bleReadings ?? []} color='#E74C3C' height={28} />
      </Card>

      <Card>
        <LblWithInfo label="Density Map" onInfo={onInfo} info="Each dot represents one detected BLE device (up to 48 shown). Lit dots = detected devices, grey dots = empty slots. The brightness increases with count, giving an at-a-glance sense of how packed the space is." />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
          {Array.from({ length: MAX_DOTS }, (_, i) => (
            <View key={i} style={{
              width: 8, height: 8, borderRadius: 4,
              backgroundColor: i < ble ? A : S2,
              opacity: i < ble ? Math.min(1, 0.45 + (i / MAX_DOTS) * 0.7) : 0.25,
            }} />
          ))}
        </View>
      </Card>

      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <LblWithInfo label="BLE Signal Quality" onInfo={onInfo} info="A measure of scan reliability — higher values mean more consistent BLE readings. Currently uses trend delta rather than absolute count, which is more robust to phones cycling Bluetooth on and off. Full RSSI-based quality scoring is planned." />
          <BigNum value='72%' size={14} color={A} />
        </View>
        <FillBar value={0.72} max={1} color={A} height={5} />
        <Text style={{ fontSize: 12, color: TXM, marginTop: 8 }}>Using trend delta, not absolute count</Text>
      </Card>
    </ScrollView>
  );
}

/* ── Audio event badge ──────────────────────────────────────── */
function AudioEventBadge({ event }: { event: AudioEvent }) {
  const map: Record<AudioEvent, { label: string; color: string }> = {
    crowd_clapping: { label: '👏 CROWD CLAPPING', color: '#FFB347' },
    cheering:       { label: '🙌 CHEERING',       color: A         },
    dj_drop:        { label: '💥 DJ DROP',         color: DNG       },
  };
  const { label, color } = map[event];
  return (
    <View style={{ backgroundColor: color + '22', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: color + '44', alignSelf: 'flex-start', marginTop: 8 }}>
      <Text style={{ color, fontSize: 11, fontWeight: '600', fontFamily: MONO }}>{label}</Text>
    </View>
  );
}

/* ── Info Modal ─────────────────────────────────────────────── */
function InfoModal({ label, info, onClose }: { label: string; info: string; onClose: () => void }) {
  return (
    <TouchableOpacity
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.82)', justifyContent: 'center', alignItems: 'center', padding: 28 }}
      activeOpacity={1}
      onPress={onClose}
    >
      <TouchableOpacity activeOpacity={1} onPress={() => {}}>
        <View style={{ backgroundColor: '#0d0d12', borderRadius: 20, borderWidth: 1, borderColor: A + '30', padding: 22, maxWidth: 360 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: A, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 11, color: A, fontWeight: '700', lineHeight: 13 }}>i</Text>
            </View>
            <Text style={{ fontFamily: MONO, fontSize: 11, fontWeight: '700', color: A, letterSpacing: 1.5 }}>{label}</Text>
          </View>
          <View style={{ height: 1, backgroundColor: A + '20', marginBottom: 14 }} />
          <Text style={{ fontSize: 14, color: '#c8c8dc', lineHeight: 22 }}>{info}</Text>
          <TouchableOpacity onPress={onClose} style={{ marginTop: 20, alignSelf: 'center', paddingVertical: 9, paddingHorizontal: 28, borderRadius: 10, borderWidth: 1, borderColor: A + '50', backgroundColor: A + '12' }}>
            <Text style={{ fontFamily: MONO, fontSize: 11, fontWeight: '700', color: A, letterSpacing: 2 }}>CLOSE</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}


/* ── Rating Row ─────────────────────────────────────────────── */
const RATING_COLORS = ['#e84560', '#e8a800', '#e8c800', '#8ee800', '#00E8A0'];

function RatingRow({ label, value, onSelect, size, required }: {
  label: string; value: number | null;
  onSelect: (v: number) => void;
  size: 'large' | 'small';
  required?: boolean;
}) {
  const btnSize = size === 'large' ? 52 : 40;
  return (
    <View style={{ marginBottom: size === 'large' ? 16 : 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Text style={{ fontFamily: MONO, fontSize: 10, color: TXM, letterSpacing: 1.5 }}>{label}</Text>
        {required && value == null && <Text style={{ fontSize: 9, color: DNG, fontFamily: MONO }}>required</Text>}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[1, 2, 3, 4, 5].map(v => {
          const active = value === v;
          const c = RATING_COLORS[v - 1];
          return (
            <TouchableOpacity
              key={v}
              onPress={() => onSelect(v)}
              activeOpacity={0.7}
              style={{
                width: btnSize, height: btnSize, borderRadius: btnSize / 2,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: active ? c + '22' : S1,
                borderWidth: active ? 2 : 1,
                borderColor: active ? c : S2,
                shadowColor: active ? c : 'transparent',
                shadowOpacity: active ? 0.6 : 0,
                shadowRadius: 8, elevation: active ? 4 : 0,
              }}
            >
              <Text style={{ fontFamily: MONO, fontSize: size === 'large' ? 18 : 14, fontWeight: '700', color: active ? c : TXD }}>{v}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

/* ── Main Screen ────────────────────────────────────────────── */
export default function MeterScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('vibe');
  const [vibeScore, setVibeScore] = useState(0);
  const [scores, setScores] = useState<VibeScoreBreakdown | null>(null);
  const [live, setLive] = useState<LiveDashboardData | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showPrompt, setShowPrompt] = useState(false);
  const [vibeRating, setVibeRating]   = useState<number | null>(null);
  const [musicRating, setMusicRating] = useState<number | null>(null);
  const [crowdRating, setCrowdRating] = useState<number | null>(null);
  const [autoSubmitIn, setAutoSubmitIn] = useState<number | null>(null);
  const autoSubmitRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [infoModal, setInfoModal] = useState<{ label: string; info: string } | null>(null);
  const [stopping, setStopping] = useState(false);

  const isActive = sessionManager.isSessionActive;

  useEffect(() => {
    sensorOrchestrator.setVibeUpdateCallback(
      (_window: SensorWindow, sc: VibeScoreBreakdown, ld: LiveDashboardData) => {
        setLive(ld);
        setScores(sc);
        setVibeScore(sc.compositeVibeScore);
      },
    );
    vibePrompt.setPromptShownCallback(() => {
      setShowPrompt(true);
      // Auto-dismiss after 15s if user never interacts at all
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = setTimeout(() => dismissPrompt(), 15000);
    });
    const cur = sensorOrchestrator.currentVibeScore;
    if (cur > 0) setVibeScore(cur);
    return () => { sensorOrchestrator.setVibeUpdateCallback((() => {}) as any); };
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const handleStop = () => {
    Alert.alert('Stop Session?', 'This will end the current recording.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop', style: 'destructive', onPress: async () => {
          setStopping(true);
          try {
            const session = await sessionManager.endSession();
            await sensorOrchestrator.stopSession();
            vibePrompt.stopPromptSchedule();
            router.push({ pathname: '/summary', params: { sessionId: session?.id } });
          } finally {
            setStopping(false);
          }
        },
      },
    ]);
  };

  const dismissPrompt = () => {
    if (autoSubmitRef.current) { clearInterval(autoSubmitRef.current); autoSubmitRef.current = null; }
    if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null; }
    setShowPrompt(false);
    setVibeRating(null); setMusicRating(null); setCrowdRating(null); setAutoSubmitIn(null);
  };

  const submitRating = async (vibe: number, music: number | null, crowd: number | null) => {
    if (autoSubmitRef.current) { clearInterval(autoSubmitRef.current); autoSubmitRef.current = null; }
    if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null; }
    await vibePrompt.recordRating(
      vibe as 1|2|3|4|5,
      music as 1|2|3|4|5|null,
      crowd as 1|2|3|4|5|null,
    );
    setShowPrompt(false);
    setVibeRating(null); setMusicRating(null); setCrowdRating(null); setAutoSubmitIn(null);
  };

  const startAutoSubmit = (vibe: number, music: number | null, crowd: number | null) => {
    // Cancel the idle-dismiss timer — user is now interacting
    if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null; }
    if (autoSubmitRef.current) clearInterval(autoSubmitRef.current);
    setAutoSubmitIn(4);
    let count = 4;
    autoSubmitRef.current = setInterval(() => {
      count -= 1;
      setAutoSubmitIn(count);
      if (count <= 0) { submitRating(vibe, music, crowd); }
    }, 1000);
  };

  const handleVibeRating = (v: number) => {
    setVibeRating(v);
    startAutoSubmit(v, musicRating, crowdRating);
  };

  const handleMusicRating = (v: number) => {
    setMusicRating(v);
    if (vibeRating) startAutoSubmit(vibeRating, v, crowdRating);
  };

  const handleCrowdRating = (v: number) => {
    setCrowdRating(v);
    if (vibeRating) startAutoSubmit(vibeRating, musicRating, v);
  };

  const PANELS: Record<Tab, React.ReactNode> = {
    vibe:   <VibePanel   live={live} scores={scores} />,
    music:  <MusicPanel  live={live} onInfo={(label, info) => setInfoModal({ label, info })} />,
    motion: <MotionPanel live={live} onInfo={(l, i) => setInfoModal({ label: l, info: i })} />,
    crowd:  <CrowdPanel  live={live} onInfo={(l, i) => setInfoModal({ label: l, info: i })} />,
  };

  return (
    <View style={s.root}>
      {/* Session header */}
      <View style={s.recBar}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          {isActive && <PulseDot />}
          <Text style={{ fontSize: 11, fontFamily: MONO, color: isActive ? DNG : TXD, letterSpacing: 2 }}>
            {isActive ? 'REC' : 'INACTIVE'}
          </Text>
        </View>
        {isActive && (
          <Text style={{ fontSize: 17, fontFamily: MONO, fontWeight: '700', color: TX }}>
            {fmtTime(elapsedSeconds)}
          </Text>
        )}
        {!isActive && (
          <Text style={{ fontSize: 12, color: TXD }}>Start session from Home</Text>
        )}
        {isActive && (
          <TouchableOpacity
            style={s.stopBtn}
            onPress={handleStop}
            disabled={stopping}
            activeOpacity={0.75}
          >
            <Text style={s.stopBtnText}>{stopping ? '…' : '■ STOP'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Segmented control */}
      <View style={s.segContainer}>
        {TABS.map(t => (
          <TouchableOpacity key={t} style={[s.segBtn, tab === t && s.segBtnActive]} onPress={() => setTab(t)} activeOpacity={0.75}>
            <Text style={[s.segLabel, { color: tab === t ? '#030904' : TXM }]}>{TAB_LABELS[t]}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Panel content */}
      <View style={{ flex: 1 }}>
        {PANELS[tab]}
      </View>

      {/* Info modal */}
      {infoModal && (
        <InfoModal
          label={infoModal.label}
          info={infoModal.info}
          onClose={() => setInfoModal(null)}
        />
      )}

      {/* Rating prompt */}
      {showPrompt && (
        <View style={s.promptOverlay}>
          <View style={s.promptCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <Text style={s.promptTitle}>VIBE CHECK</Text>
              {autoSubmitIn != null && vibeRating != null && (
                <View style={{ borderRadius: 12, borderWidth: 1, borderColor: A + '50', paddingHorizontal: 10, paddingVertical: 3 }}>
                  <Text style={{ fontFamily: MONO, fontSize: 11, color: A }}>auto {autoSubmitIn}s</Text>
                </View>
              )}
            </View>

            <RatingRow label="OVERALL VIBE" value={vibeRating} onSelect={handleVibeRating} size="large" required />
            {vibeRating != null && (
              <>
                <RatingRow label="MUSIC" value={musicRating} onSelect={handleMusicRating} size="small" />
                <RatingRow label="CROWD" value={crowdRating} onSelect={handleCrowdRating} size="small" />
              </>
            )}

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18 }}>
              {vibeRating != null && (
                <TouchableOpacity
                  style={[s.promptSubmit, { flex: 1 }]}
                  onPress={() => submitRating(vibeRating, musicRating, crowdRating)}
                >
                  <Text style={s.promptSubmitText}>SUBMIT</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={dismissPrompt}
                style={{ paddingVertical: 12, paddingHorizontal: 8 }}
              >
                <Text style={{ fontFamily: MONO, fontSize: 11, color: TXD }}>skip</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

function PulseDot() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.15, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1,    duration: 600, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: DNG, opacity }} />;
}

/* ── Styles ─────────────────────────────────────────────────── */
const a = StyleSheet.create({
  card: { backgroundColor: S1, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: S2 },
});

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#060608' },

  recBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: S2,
  },
  stopBtn: {
    borderWidth: 1, borderColor: DNG + '80', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 5, backgroundColor: DNG + '15',
  },
  stopBtnText: { fontSize: 11, fontFamily: Platform.select({ ios: 'Courier New', android: 'monospace' }) as string, fontWeight: '700', color: DNG, letterSpacing: 1 },

  segContainer: {
    flexDirection: 'row',
    marginHorizontal: 14, marginVertical: 10,
    backgroundColor: S2,
    borderRadius: 12,
    padding: 3,
    borderWidth: 1, borderColor: '#22222e',
  },
  segBtn: {
    flex: 1, height: 36, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
  },
  segBtnActive: {
    backgroundColor: A,
    shadowColor: A, shadowOpacity: 0.45, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  segLabel: {
    fontSize: 11, fontFamily: Platform.select({ ios: 'Courier New', android: 'monospace' }) as string,
    fontWeight: '700', letterSpacing: 1.2,
  },

  promptOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.88)', justifyContent: 'flex-end',
  },
  promptCard: {
    backgroundColor: '#0d0d12', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 36,
    borderTopWidth: 1, borderColor: A + '30',
  },
  promptTitle: { fontFamily: Platform.select({ ios: 'Courier New', android: 'monospace' }) as string, fontSize: 13, fontWeight: '700', color: A, letterSpacing: 2 },
  promptSubmit: {
    height: 48, borderRadius: 14, backgroundColor: A,
    alignItems: 'center', justifyContent: 'center',
  },
  promptSubmitText: { fontFamily: Platform.select({ ios: 'Courier New', android: 'monospace' }) as string, fontSize: 13, fontWeight: '700', color: '#030904', letterSpacing: 2 },
});
