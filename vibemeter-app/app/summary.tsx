import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { getWindowsForSession } from '../src/storage/LocalBuffer';
import { getRatingsForSession } from '../src/storage/LocalBuffer';
import { getSessions } from '../src/storage/LocalBuffer';

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

interface RatingRow {
  id: string;
  rating: number;
  rated_at: number;
}

export default function SummaryScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>();
  const [windows, setWindows] = useState<WindowRow[]>([]);
  const [ratings, setRatings] = useState<RatingRow[]>([]);
  const [session, setSession] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      return;
    }
    loadData(sessionId);
  }, [sessionId]);

  const loadData = async (sid: string) => {
    try {
      const [wins, rats, sessions] = await Promise.all([
        getWindowsForSession(sid),
        getRatingsForSession(sid),
        getSessions(),
      ]);
      setWindows(wins);
      setRatings(rats);
      const s = sessions.find((s: any) => s.id === sid);
      setSession(s ?? null);
    } catch (err) {
      console.error('Summary load error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color="#00FF88" />
      </View>
    );
  }

  if (!sessionId || windows.length === 0) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={styles.emptyText}>No session data yet.</Text>
        <Text style={styles.emptySubtext}>Complete a session to see your summary.</Text>
      </View>
    );
  }

  // Compute stats
  const vibeScores = windows.map(w => w.computed_vibe_score).filter(v => v != null) as number[];
  const avgVibe = vibeScores.length > 0
    ? vibeScores.reduce((s, v) => s + v, 0) / vibeScores.length
    : 0;
  const peakVibe = vibeScores.length > 0 ? Math.max(...vibeScores) : 0;
  const peakWindow = windows.find(w => w.computed_vibe_score === peakVibe);
  const peakTime = peakWindow
    ? new Date(peakWindow.window_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--';

  const bpmValues = windows.map(w => w.estimated_bpm).filter(v => v != null) as number[];
  const bpmMin = bpmValues.length > 0 ? Math.min(...bpmValues) : null;
  const bpmMax = bpmValues.length > 0 ? Math.max(...bpmValues) : null;

  const classificationCounts: Record<string, number> = {};
  windows.forEach(w => {
    if (w.audio_classification) {
      classificationCounts[w.audio_classification] = (classificationCounts[w.audio_classification] ?? 0) + 1;
    }
  });

  const avgRating = ratings.length > 0
    ? ratings.reduce((s, r) => s + r.rating, 0) / ratings.length
    : null;

  const sessionStartMs = windows[0]?.window_start ?? 0;
  const sessionEndMs = windows[windows.length - 1]?.window_end ?? 0;
  const durationMin = Math.round((sessionEndMs - sessionStartMs) / 60000);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.venueName}>
          {session?.venue_name ?? 'Session Summary'}
        </Text>
        {session?.venue_type && (
          <Text style={styles.venueType}>{session.venue_type.replace('_', ' ')}</Text>
        )}
      </View>

      {/* Key stats */}
      <View style={styles.statsGrid}>
        <StatCard label="Avg Vibe" value={avgVibe.toFixed(1)} color="#00FF88" />
        <StatCard label="Peak Vibe" value={peakVibe.toFixed(1)} sub={peakTime} color="#FFB347" />
        <StatCard label="Duration" value={`${durationMin}m`} color="#3498DB" />
        <StatCard label="Ratings" value={`${ratings.length}`} color="#9B59B6" />
      </View>

      {/* Sensor vs rating alignment */}
      {avgRating != null && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sensor vs You</Text>
          <View style={styles.comparisonRow}>
            <View style={styles.comparisonItem}>
              <Text style={styles.comparisonValue}>{avgVibe.toFixed(1)}</Text>
              <Text style={styles.comparisonLabel}>Sensor avg</Text>
            </View>
            <Text style={styles.comparisonDivider}>vs</Text>
            <View style={styles.comparisonItem}>
              <Text style={styles.comparisonValue}>{avgRating.toFixed(1)}</Text>
              <Text style={styles.comparisonLabel}>Your avg</Text>
            </View>
          </View>
          <Text style={styles.alignmentNote}>
            {Math.abs(avgVibe - avgRating) < 0.8
              ? '✓ Good alignment — sensors matched your experience'
              : avgVibe > avgRating
              ? '↑ Sensors rated higher than you felt'
              : '↓ Sensors rated lower than you felt'}
          </Text>
        </View>
      )}

      {/* Timeline chart (simplified bar chart) */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Vibe Timeline</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.timeline}>
            {windows.map((w, i) => {
              const score = w.computed_vibe_score ?? 0;
              const barHeight = Math.max(4, (score / 5) * 80);
              const time = new Date(w.window_start).toLocaleTimeString([], {
                hour: '2-digit', minute: '2-digit'
              });
              // Find rating closest to this window
              const nearRating = ratings.find(r => {
                const diff = Math.abs(r.rated_at - w.window_start);
                return diff < 90000; // within 90 sec
              });
              return (
                <View key={w.id} style={styles.timelineBar}>
                  {nearRating && (
                    <View style={[styles.ratingDot, { bottom: barHeight + 4 }]}>
                      <Text style={styles.ratingDotText}>{nearRating.rating}</Text>
                    </View>
                  )}
                  <View style={[styles.bar, { height: barHeight, backgroundColor: getBarColor(score) }]} />
                  {i % 5 === 0 && <Text style={styles.timeLabel}>{time}</Text>}
                </View>
              );
            })}
          </View>
        </ScrollView>
        <Text style={styles.timelineLegend}>• Bars = sensor score · Numbers = your ratings</Text>
      </View>

      {/* BPM */}
      {bpmMin != null && bpmMax != null && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Music</Text>
          <Text style={styles.stat}>
            BPM range: {bpmMin} – {bpmMax}
          </Text>
          {Object.entries(classificationCounts).map(([cls, count]) => (
            <Text key={cls} style={styles.stat}>
              {cls.replace('_', ' ')}: {Math.round((count / windows.length) * 100)}% of session
            </Text>
          ))}
        </View>
      )}

      {/* BLE density */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Crowd</Text>
        {windows.filter(w => w.ble_device_count != null).length > 0 ? (
          <>
            <Text style={styles.stat}>
              Max devices nearby: {Math.max(...windows.map(w => w.ble_device_count ?? 0))}
            </Text>
            <Text style={styles.stat}>
              Avg devices nearby: {
                Math.round(
                  windows.filter(w => w.ble_device_count != null)
                    .reduce((s, w) => s + (w.ble_device_count ?? 0), 0) /
                  Math.max(1, windows.filter(w => w.ble_device_count != null).length)
                )
              }
            </Text>
          </>
        ) : (
          <Text style={styles.emptySubtext}>No BLE data collected</Text>
        )}
      </View>

      {/* Data quality note */}
      <Text style={styles.qualityNote}>
        {windows.length} windows · {ratings.length} ratings ·{' '}
        {Math.round((windows.filter(w => w.avg_db != null).length / windows.length) * 100)}% audio coverage
      </Text>
    </ScrollView>
  );
}

function StatCard({
  label, value, sub, color,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <View style={statStyles.card}>
      <Text style={[statStyles.value, { color }]}>{value}</Text>
      {sub && <Text style={statStyles.sub}>{sub}</Text>}
      <Text style={statStyles.label}>{label}</Text>
    </View>
  );
}

function getBarColor(score: number): string {
  if (score < 1.5) return '#333';
  if (score < 2.5) return '#555';
  if (score < 3.5) return '#FFB347';
  if (score < 4.5) return '#00CC6A';
  return '#00FF88';
}

const statStyles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1A1A1A',
    minWidth: 70,
  },
  value: { fontSize: 26, fontWeight: 'bold' },
  sub: { color: '#888', fontSize: 10, marginTop: 2 },
  label: { color: '#555', fontSize: 10, marginTop: 4, letterSpacing: 1 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content: { padding: 20, paddingBottom: 40 },

  header: { marginBottom: 20 },
  venueName: { color: '#FFF', fontSize: 24, fontWeight: 'bold' },
  venueType: { color: '#888', fontSize: 13, marginTop: 2 },

  statsGrid: { flexDirection: 'row', gap: 10, marginBottom: 16 },

  card: {
    backgroundColor: '#0A0A0A',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#1A1A1A',
  },
  cardTitle: { color: '#888', fontSize: 12, letterSpacing: 2, marginBottom: 12 },

  comparisonRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', marginBottom: 12 },
  comparisonItem: { alignItems: 'center' },
  comparisonValue: { color: '#FFF', fontSize: 36, fontWeight: 'bold' },
  comparisonLabel: { color: '#555', fontSize: 12 },
  comparisonDivider: { color: '#333', fontSize: 14 },
  alignmentNote: { color: '#888', fontSize: 12, textAlign: 'center' },

  // Timeline
  timeline: { flexDirection: 'row', alignItems: 'flex-end', height: 100, gap: 3, paddingBottom: 16 },
  timelineBar: { alignItems: 'center', width: 20, position: 'relative' },
  bar: { width: 16, borderRadius: 3, minHeight: 4 },
  timeLabel: { color: '#333', fontSize: 8, position: 'absolute', bottom: 0, width: 50 },
  ratingDot: {
    position: 'absolute',
    backgroundColor: '#00FF88',
    width: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  ratingDotText: { color: '#000', fontSize: 9, fontWeight: 'bold' },
  timelineLegend: { color: '#333', fontSize: 10, marginTop: 8, textAlign: 'center' },

  stat: { color: '#CCC', fontSize: 14, marginBottom: 4 },

  emptyText: { color: '#555', fontSize: 16 },
  emptySubtext: { color: '#333', fontSize: 13, marginTop: 8, textAlign: 'center' },
  qualityNote: { color: '#333', fontSize: 11, textAlign: 'center' },
});
