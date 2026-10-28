import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator, PanResponder, LayoutChangeEvent,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { supabase } from '../src/config/supabase';

/**
 * "Your set": the report a DJ opens after a night (link vibemeter://set?code=XXXXXXXX, or the code
 * typed here). It is built by analysis/dj_report.py from the phones that were in the room and
 * released by us; only aggregates are shown (minutes with at least 3 phones). The DJ can scrub the
 * crowd curve, zoom, see what was playing, read how each track and each change worked, claim an
 * unidentified stretch as their edit, and approve or decline the report.
 */

const A = '#00E8A0';
const BG = '#060608';
const S1 = '#0d0d12';
const S2 = '#181824';
const TX = '#f0f0f5';
const TXM = '#c0c0d8';
const TXD = '#9898c0';
const DNG = '#e84560';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;
const MIN = 60_000;

interface Point { t: number; p: number; d: number | null; s: number | null; b: number | null }
interface Track { start: number; end: number; unknown: boolean; title: string | null; artist: string | null; d: number | null; s: number | null; b: number | null; lift: number | null; keep: number | null }
interface Moment { t: number; d?: number | null; from?: number | null; to?: number | null; track: number | null }
interface Report {
  v: number; status: 'sent' | 'approved'; venue: string | null; dj: string | null; start: string; end: string; phones: number;
  curve: Point[]; tracks: Track[]; peaks: Moment[]; jumps: Moment[];
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pct = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const pts = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)} pts`;
const trackName = (t: Track) => (t.unknown ? 'Unidentified music' : t.title ?? 'Unknown title');

/** The crowd curve: bars of the dancing share per minute, track bands underneath, a cursor to scrub. */
function Timeline({ report, cursor, onCursor, win, onWin, onScrub }: {
  report: Report; cursor: number | null; onCursor: (t: number) => void; win: [number, number]; onWin: (w: [number, number]) => void;
  onScrub: (active: boolean) => void;
}) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const winRef = useRef(win);
  winRef.current = win;
  const first = report.curve[0].t, last = report.curve[report.curve.length - 1].t + MIN;
  const byT = useMemo(() => new Map(report.curve.map(p => [p.t, p])), [report.curve]);

  const at = (x: number) => {
    const [w0, w1] = winRef.current;
    const t = w0 + Math.max(0, Math.min(0.999, x / Math.max(1, widthRef.current))) * (w1 - w0);
    return Math.floor(t / MIN) * MIN;
  };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: e => { onScrub(true); onCursor(at(e.nativeEvent.locationX)); },
    onPanResponderMove: e => onCursor(at(e.nativeEvent.locationX)),
    onPanResponderRelease: () => onScrub(false),
    onPanResponderTerminate: () => onScrub(false),
  })).current;

  const [w0, w1] = win;
  const span = w1 - w0;
  const x = (t: number) => ((t - w0) / span) * width;
  const visible = report.curve.filter(p => p.t >= w0 && p.t < w1);
  const barW = Math.max(1, (MIN / span) * width - (span / MIN > 120 ? 0 : 1));
  const H = 130;

  const zoom = (minutes: number | null) => {
    const len = minutes == null ? last - first : Math.min(minutes * MIN, last - first);
    const center = cursor ?? (w0 + w1) / 2;
    let a = Math.floor((center - len / 2) / MIN) * MIN;
    a = Math.max(first, Math.min(last - len, a));
    onWin([a, a + len]);
  };
  const shift = (dir: -1 | 1) => {
    const len = w1 - w0;
    const a = Math.max(first, Math.min(last - len, w0 + dir * Math.floor(len / 2 / MIN) * MIN));
    onWin([a, a + len]);
  };
  const zoomed = w1 - w0 < last - first;
  const total = Math.round((last - first) / MIN);
  const label = (m: number | null) => ({ on: m == null ? !zoomed : zoomed && Math.round((w1 - w0) / MIN) === m && m < total });

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {([['ALL', null], ['1 H', 60], ['30 MIN', 30], ['10 MIN', 10]] as [string, number | null][]).map(([name, m]) => (
          <TouchableOpacity key={name} onPress={() => zoom(m)} style={[st.chip, label(m).on && st.chipOn]}>
            <Text style={[st.chipText, label(m).on && { color: A }]}>{name}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1 }} />
        {zoomed && (
          <>
            <TouchableOpacity onPress={() => shift(-1)} style={st.chip}><Text style={st.chipText}>‹</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => shift(1)} style={st.chip}><Text style={st.chipText}>›</Text></TouchableOpacity>
          </>
        )}
      </View>

      <View style={st.chart} onLayout={(e: LayoutChangeEvent) => { widthRef.current = e.nativeEvent.layout.width; setWidth(e.nativeEvent.layout.width); }}>
        <View style={{ height: H }} {...pan.panHandlers}>
          {[0.5, 1].map(v => (
            <View key={v} pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: v * (H - 16), height: 1, backgroundColor: S2 }}>
              <Text style={st.axis}>{Math.round(v * 100)}%</Text>
            </View>
          ))}
          {width > 0 && visible.map(p => (
            <View key={p.t} pointerEvents="none" style={{
              position: 'absolute', left: x(p.t), width: barW, bottom: 0, borderRadius: 1.5,
              height: p.d == null ? 3 : Math.max(2, p.d * (H - 16)),
              backgroundColor: p.d == null ? S2 : A, opacity: p.d == null ? 1 : 0.35 + 0.65 * p.d,
            }} />
          ))}
          {width > 0 && cursor != null && cursor >= w0 && cursor < w1 && (
            <View pointerEvents="none" style={{ position: 'absolute', left: x(cursor), top: 0, bottom: 0, width: 2, backgroundColor: TX }} />
          )}
        </View>
        {/* What was playing: one band per track */}
        <View style={{ height: 22, marginTop: 6 }} pointerEvents="none">
          {width > 0 && report.tracks.map((t, i) => {
            const a = Math.max(w0, t.start), b = Math.min(w1, t.end);
            if (b <= a) return null;
            return (
              <View key={i} style={{ position: 'absolute', left: x(a), width: Math.max(2, x(b) - x(a) - 1), height: 22, borderRadius: 4, justifyContent: 'center', paddingHorizontal: 4, backgroundColor: t.unknown ? TXD + '33' : A + '33' }}>
                <Text numberOfLines={1} style={{ fontSize: 10, color: TXM }}>{trackName(t)}</Text>
              </View>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }} pointerEvents="none">
          <Text style={st.axisText}>{clock(w0)}</Text>
          <Text style={st.axisText}>{clock((w0 + w1) / 2)}</Text>
          <Text style={st.axisText}>{clock(w1)}</Text>
        </View>
      </View>
      <Text style={st.hint}>Drag across the chart to see any minute. Zoom in on a track or a surge.</Text>
    </View>
  );
}

export default function SetScreen() {
  const params = useLocalSearchParams<{ code?: string }>();
  const [code, setCode] = useState((params.code ?? '').toString().toUpperCase());
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [win, setWin] = useState<[number, number]>([0, 1]);
  const [scrubbing, setScrubbing] = useState(false);
  const [claimed, setClaimed] = useState<Set<number>>(new Set());
  const [done, setDone] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);

  const load = useCallback(async (c: string) => {
    const clean = c.trim().toUpperCase();
    if (clean.length < 8) return;
    setLoading(true); setError(null); setDone(null);
    try {
      const { data, error: err } = await supabase.rpc('get_dj_report', { p_code: clean });
      if (err) throw err;
      if (!data || !data.curve?.length) { setReport(null); setError('No report for that code. Check it, or ask us to release it.'); return; }
      const r = data as Report;
      setReport(r);
      setWin([r.curve[0].t, r.curve[r.curve.length - 1].t + MIN]);
      setCursor(r.peaks[0]?.t ?? null);
    } catch {
      setError("Couldn't load it. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (params.code) { const c = params.code.toString().toUpperCase(); setCode(c); load(c); } }, [params.code, load]);

  const point = useMemo(() => (report && cursor != null ? report.curve.find(p => p.t === cursor) ?? null : null), [report, cursor]);
  const trackIdx = useMemo(() => (report && cursor != null ? report.tracks.findIndex(t => cursor >= t.start && cursor < t.end) : -1), [report, cursor]);

  const focus = (from: number, to: number, t: number) => {
    if (!report) return;
    const first = report.curve[0].t, last = report.curve[report.curve.length - 1].t + MIN;
    const len = Math.min(last - first, Math.max(10 * MIN, to - from + 4 * MIN));
    let a = Math.floor((from - 2 * MIN) / MIN) * MIN;
    a = Math.max(first, Math.min(last - len, a));
    setWin([a, a + len]);
    setCursor(Math.floor(t / MIN) * MIN);
    scroll.current?.scrollTo({ y: 0, animated: true });
  };

  const respond = async (action: 'approve' | 'decline' | 'claim', trackStart?: number) => {
    const { data, error: err } = await supabase.rpc('respond_dj_report', {
      p_code: code.trim().toUpperCase(), p_action: action, p_track_start: trackStart != null ? new Date(trackStart).toISOString() : null,
    });
    if (err || data !== true) throw new Error('failed');
  };

  const claim = (t: Track, i: number) => {
    Alert.alert('Is this your edit?', `We'll credit you whenever this music is recognised at nights we know you play. We check it with you before anything is shown to anyone.`, [
      { text: 'Not mine', style: 'cancel' },
      {
        text: 'Yes, mine', onPress: async () => {
          try { await respond('claim', t.start); setClaimed(new Set(claimed).add(i)); }
          catch { Alert.alert("Couldn't send it", 'Check your connection and try again.'); }
        },
      },
    ]);
  };

  const approve = async () => {
    try { await respond('approve'); setReport(r => (r ? { ...r, status: 'approved' } : r)); }
    catch { Alert.alert("Couldn't send it", 'Check your connection and try again.'); }
  };

  const decline = () => {
    Alert.alert('Delete this report?', 'It is emptied for good and your claims are removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try { await respond('decline'); setReport(null); setDone('The report is deleted.'); }
          catch { Alert.alert("Couldn't delete it", 'Check your connection and try again.'); }
        },
      },
    ]);
  };

  // What stood out, in words
  const insights = useMemo(() => {
    if (!report) return [];
    const out: string[] = [];
    const peak = report.peaks.slice().sort((a, b) => (b.d ?? 0) - (a.d ?? 0))[0];
    if (peak) out.push(`Peak at ${clock(peak.t)}: ${pct(peak.d)} of the phones were dancing${peak.track != null ? `, during ${trackName(report.tracks[peak.track])}` : ''}.`);
    const lifts = report.tracks.filter(t => t.lift != null && !t.unknown).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
    if (lifts[0] && (lifts[0].lift ?? 0) >= 0.1) out.push(`Biggest lift: ${trackName(lifts[0])} (${pts(lifts[0].lift!)} when it came in).`);
    const lowest = lifts[lifts.length - 1];
    if (lowest && lowest !== lifts[0] && (lowest.lift ?? 0) <= -0.1) out.push(`The floor thinned most after ${trackName(lowest)} came in (${pts(lowest.lift!)}).`);
    const keeps = report.tracks.map(t => t.keep).filter((k): k is number => k != null);
    if (keeps.length >= 2) out.push(`On average ${pct(keeps.reduce((a, b) => a + b, 0) / keeps.length)} of the people dancing kept dancing through your changes.`);
    const bpms = report.curve.map(p => p.b).filter((b): b is number => b != null);
    if (bpms.length) out.push(`Tempo ran ${Math.round(Math.min(...bpms))}–${Math.round(Math.max(...bpms))} BPM.`);
    return out;
  }, [report]);

  if (!report) {
    return (
      <View style={st.container}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }} keyboardShouldPersistTaps="handled">
          <Text style={st.kicker}>FOR DJS</Text>
          <Text style={st.title}>Your set</Text>
          {done ? <Text style={st.body}>{done}</Text> : (
            <>
              <Text style={st.body}>
                Played a night with Viibe Check in the room? Enter the code we sent you to see how the floor moved, minute by minute and track by track.
                You register nothing beforehand, and nothing is shown to anyone without you.
              </Text>
              <TextInput
                style={st.input} value={code} onChangeText={t => setCode(t.toUpperCase())} placeholder="CODE" placeholderTextColor={TXD}
                autoCapitalize="characters" autoCorrect={false} maxLength={12} returnKeyType="go" onSubmitEditing={() => load(code)}
              />
              <TouchableOpacity style={[st.primaryBtn, (loading || code.trim().length < 8) && { opacity: 0.4 }]} disabled={loading || code.trim().length < 8} onPress={() => load(code)}>
                {loading ? <ActivityIndicator color="#030904" /> : <Text style={st.primaryText}>OPEN</Text>}
              </TouchableOpacity>
              {error && <Text style={[st.hint, { color: DNG }]}>{error}</Text>}
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  const nowTrack = trackIdx >= 0 ? report.tracks[trackIdx] : null;
  return (
    <View style={st.container}>
      <ScrollView ref={scroll} scrollEnabled={!scrubbing} contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 120 }}>
        <View>
          <Text style={st.kicker}>YOUR SET{report.dj ? ` · ${report.dj.toUpperCase()}` : ''}</Text>
          <Text style={st.title}>{report.venue ?? 'Your night'}</Text>
          <Text style={st.meta}>{clock(report.curve[0].t)}–{clock(report.curve[report.curve.length - 1].t + MIN)} · {report.phones} phones measuring · {report.tracks.length} tracks</Text>
        </View>

        <View style={st.card}>
          <Text style={st.cardLabel}>THE FLOOR, MINUTE BY MINUTE</Text>
          <Timeline report={report} cursor={cursor} onCursor={setCursor} win={win} onWin={setWin} onScrub={setScrubbing} />
          {cursor != null && (
            <View style={st.readout}>
              <Text style={st.readTime}>{clock(cursor)}</Text>
              {point && point.d != null ? (
                <Text style={st.readMain}>{pct(point.d)} dancing · {point.p} phones{point.b ? ` · ${Math.round(point.b)} BPM` : ''}{point.s != null ? ` · ${pct(point.s)} on the beat` : ''}</Text>
              ) : (
                <Text style={st.readMain}>Too few phones to show this minute</Text>
              )}
              <Text style={st.readSub}>{nowTrack ? `Playing: ${nowTrack.unknown ? 'unidentified music' : `${nowTrack.title ?? 'unknown'}${nowTrack.artist ? ` · ${nowTrack.artist}` : ''}`}` : 'Nothing identified in this minute'}</Text>
            </View>
          )}
        </View>

        {insights.length > 0 && (
          <View style={st.card}>
            <Text style={st.cardLabel}>WHAT STOOD OUT</Text>
            {insights.map((line, i) => <Text key={i} style={st.line}>• {line}</Text>)}
          </View>
        )}

        {report.jumps.length > 0 && (
          <View style={st.card}>
            <Text style={st.cardLabel}>BIGGEST SURGES</Text>
            {report.jumps.map((j, i) => (
              <TouchableOpacity key={i} onPress={() => focus(j.t - 6 * MIN, j.t, j.t)} activeOpacity={0.7}>
                <Text style={st.line}>
                  <Text style={{ color: A }}>{clock(j.t)}</Text>  {pct(j.from)} → {pct(j.to)} dancing in 3 min
                  {j.track != null ? ` · ${trackName(report.tracks[j.track])}` : ''}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <Text style={[st.cardLabel, { marginTop: 6 }]}>TRACK BY TRACK</Text>
        {report.tracks.map((t, i) => (
          <TouchableOpacity key={i} style={[st.card, trackIdx === i && { borderColor: A + '88' }]} activeOpacity={0.8} onPress={() => focus(t.start, t.end, t.start)}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Text style={st.time}>{clock(t.start)}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={st.trackTitle} numberOfLines={2}>{trackName(t)}</Text>
                <Text style={st.meta} numberOfLines={2}>
                  {t.unknown ? 'Not in the catalogue: possibly your own edit' : t.artist ?? ''} · {Math.round((t.end - t.start) / MIN)} min
                </Text>
              </View>
            </View>
            <View style={st.stats}>
              <Stat label="DANCING" value={pct(t.d)} />
              <Stat label="ON THE BEAT" value={pct(t.s)} />
              {t.b != null && <Stat label="BPM" value={String(Math.round(t.b))} />}
              {t.lift != null && <Stat label="LIFT" value={pts(t.lift)} color={t.lift >= 0.05 ? A : t.lift <= -0.05 ? DNG : undefined} />}
              {t.keep != null && <Stat label="STAYED" value={pct(t.keep)} />}
            </View>
            {t.unknown && (
              claimed.has(i)
                ? <Text style={[st.hint, { color: A }]}>Claimed ✓ We'll check it with you.</Text>
                : <TouchableOpacity style={st.claimBtn} onPress={() => claim(t, i)}><Text style={st.claimText}>THIS IS MY EDIT</Text></TouchableOpacity>
            )}
          </TouchableOpacity>
        ))}
        <Text style={st.hint}>
          LIFT: dancing share in the first 3 minutes of the track against the 3 minutes before. STAYED: of the people dancing just before, how many kept dancing through the change.
          Built from phones in the room; minutes with fewer than 3 phones are left out and nothing identifies a person.
        </Text>

        <View style={{ gap: 10, marginTop: 6 }}>
          {report.status === 'approved'
            ? <Text style={[st.hint, { color: A, textAlign: 'center' }]}>You approved this report ✓</Text>
            : <TouchableOpacity style={st.primaryBtn} onPress={approve}><Text style={st.primaryText}>LOOKS GOOD</Text></TouchableOpacity>}
          <TouchableOpacity style={st.deleteBtn} onPress={decline}><Text style={st.deleteText}>DELETE THIS REPORT</Text></TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={[st.statValue, color ? { color } : null]}>{value}</Text>
      <Text style={st.statLabel}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  kicker: { fontFamily: MONO, fontSize: 11, color: A, letterSpacing: 3, marginBottom: 6 },
  title: { fontSize: 26, fontWeight: '700', color: TX },
  meta: { fontFamily: MONO, fontSize: 11, color: TXD },
  body: { color: TXM, fontSize: 14, lineHeight: 20 },
  hint: { fontFamily: MONO, fontSize: 11, color: TXD, lineHeight: 16 },
  card: { backgroundColor: S1, borderWidth: 1, borderColor: S2, borderRadius: 16, padding: 14, gap: 10 },
  cardLabel: { fontFamily: MONO, fontSize: 11, color: A, letterSpacing: 2 },
  line: { color: TXM, fontSize: 14, lineHeight: 21 },
  chart: { backgroundColor: BG, borderRadius: 12, paddingTop: 6 },
  axis: { position: 'absolute', right: 2, top: -13, fontSize: 9, color: TXD },
  axisText: { fontFamily: MONO, fontSize: 10, color: TXD },
  chip: { borderWidth: 1, borderColor: S2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: BG },
  chipOn: { borderColor: A, backgroundColor: A + '22' },
  chipText: { fontFamily: MONO, fontSize: 10, fontWeight: '700', color: TXM, letterSpacing: 1 },
  readout: { borderTopWidth: 1, borderTopColor: S2, paddingTop: 10, gap: 3 },
  readTime: { fontFamily: MONO, fontSize: 18, fontWeight: '700', color: TX },
  readMain: { color: TX, fontSize: 15 },
  readSub: { color: TXM, fontSize: 13 },
  time: { fontFamily: MONO, fontSize: 13, color: A, width: 46, paddingTop: 2 },
  trackTitle: { color: TX, fontSize: 16, fontWeight: '600' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  statValue: { color: TX, fontSize: 16, fontWeight: '700' },
  statLabel: { fontFamily: MONO, fontSize: 9, color: TXD, letterSpacing: 1 },
  claimBtn: { height: 40, borderRadius: 12, borderWidth: 1, borderColor: A + '88', alignItems: 'center', justifyContent: 'center' },
  claimText: { fontFamily: MONO, fontSize: 11, fontWeight: '700', color: A, letterSpacing: 1.5 },
  input: { height: 52, borderRadius: 14, borderWidth: 1, borderColor: S2, backgroundColor: S1, color: TX, paddingHorizontal: 16, fontSize: 20, letterSpacing: 4, fontFamily: MONO },
  primaryBtn: { height: 52, borderRadius: 14, backgroundColor: A, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontFamily: MONO, fontSize: 13, fontWeight: '700', color: '#030904', letterSpacing: 2 },
  deleteBtn: { height: 48, borderRadius: 14, borderWidth: 1, borderColor: DNG + '88', alignItems: 'center', justifyContent: 'center' },
  deleteText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: DNG, letterSpacing: 2 },
});
