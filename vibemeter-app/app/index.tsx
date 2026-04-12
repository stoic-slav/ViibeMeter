import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet,
  FlatList, ScrollView, Alert, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { VenueType } from '../src/types';
import { sessionManager } from '../src/session/SessionManager';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';
import { vibePrompt } from '../src/notifications/VibePrompt';
import { getDeviceId } from '../src/storage/DeviceIdentity';

const VENUE_TYPES: VenueType[] = [
  'bar', 'club', 'house_party', 'concert', 'rooftop', 'restaurant', 'other'
];

const VENUE_LABELS: Record<VenueType, string> = {
  bar: 'Bar',
  club: 'Club',
  house_party: 'House Party',
  concert: 'Concert',
  rooftop: 'Rooftop',
  restaurant: 'Restaurant',
  other: 'Other',
};

export default function HomeScreen() {
  const router = useRouter();
  const [isActive, setIsActive] = useState(false);
  const [venueName, setVenueName] = useState('');
  const [venueType, setVenueType] = useState<VenueType | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [pastSessions, setPastSessions] = useState<any[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getDeviceId().then(id => setDeviceId(id.slice(0, 8)));
    loadPastSessions();
  }, []);

  // Session timer
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  const loadPastSessions = useCallback(async () => {
    const sessions = await sessionManager.getPastSessions();
    setPastSessions(sessions.filter((s: any) => s.ended_at != null).slice(0, 20));
  }, []);

  const handleStartSession = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const session = await sessionManager.startSession(
        venueName.trim() || null,
        venueType,
      );
      await sensorOrchestrator.startSession(session);
      vibePrompt.startPromptSchedule(session.id);
      setIsActive(true);
      setElapsedSeconds(0);
      router.push('/meter');
    } catch (err) {
      Alert.alert('Error', 'Failed to start session. Check permissions.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleEndSession = async () => {
    if (loading) return;
    setLoading(true);
    try {
      vibePrompt.stopPromptSchedule();
      await sensorOrchestrator.stopSession();
      const ended = await sessionManager.endSession();
      setIsActive(false);
      setElapsedSeconds(0);
      await loadPastSessions();
      if (ended) {
        router.push({ pathname: '/summary', params: { sessionId: ended.id } });
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to end session.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const formatElapsed = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Active session state */}
      {isActive ? (
        <View style={styles.activeCard}>
          <Text style={styles.activeLabel}>SESSION ACTIVE</Text>
          <Text style={styles.timer}>{formatElapsed(elapsedSeconds)}</Text>
          {venueName ? <Text style={styles.activeVenue}>{venueName}</Text> : null}
          {venueType ? <Text style={styles.activeType}>{VENUE_LABELS[venueType]}</Text> : null}

          <TouchableOpacity
            style={styles.endButton}
            onPress={handleEndSession}
            disabled={loading}
          >
            <Text style={styles.endButtonText}>
              {loading ? 'Ending...' : 'End Session'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.meterButton}
            onPress={() => router.push('/meter')}
          >
            <Text style={styles.meterButtonText}>View Live Meter →</Text>
          </TouchableOpacity>
        </View>
      ) : (
        /* Start session form */
        <View style={styles.startCard}>
          <Text style={styles.title}>VibeMeter</Text>
          <Text style={styles.subtitle}>Sensor-based vibe measurement</Text>

          <TextInput
            style={styles.input}
            placeholder="Venue name (optional)"
            placeholderTextColor="#555"
            value={venueName}
            onChangeText={setVenueName}
          />

          <Text style={styles.label}>Venue type</Text>
          <View style={styles.typeGrid}>
            {VENUE_TYPES.map(type => (
              <TouchableOpacity
                key={type}
                style={[styles.typeChip, venueType === type && styles.typeChipSelected]}
                onPress={() => setVenueType(type === venueType ? null : type)}
              >
                <Text style={[styles.typeChipText, venueType === type && styles.typeChipTextSelected]}>
                  {VENUE_LABELS[type]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.startButton, loading && styles.startButtonDisabled]}
            onPress={handleStartSession}
            disabled={loading}
          >
            <Text style={styles.startButtonText}>
              {loading ? 'Starting...' : 'Start Session'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Past sessions */}
      {pastSessions.length > 0 && (
        <View style={styles.historySection}>
          <Text style={styles.historyTitle}>Past Sessions</Text>
          {pastSessions.map((session: any) => (
            <TouchableOpacity
              key={session.id}
              style={styles.historyItem}
              onPress={() => router.push({ pathname: '/summary', params: { sessionId: session.id } })}
            >
              <View style={styles.historyLeft}>
                <Text style={styles.historyVenue}>
                  {session.venue_name ?? 'Unnamed session'}
                </Text>
                <Text style={styles.historyMeta}>
                  {session.venue_type ?? 'unknown'} · {session.dwell_minutes ?? 0}min
                </Text>
              </View>
              {session.computed_vibe_score != null && (
                <Text style={styles.historyScore}>
                  {Number(session.computed_vibe_score).toFixed(1)}
                </Text>
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Device ID footer */}
      <Text style={styles.deviceId}>Device: {deviceId}...</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content: { padding: 20, paddingBottom: 40 },

  // Active session
  activeCard: {
    backgroundColor: '#0D1F17',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#00FF8840',
    alignItems: 'center',
    marginBottom: 20,
  },
  activeLabel: { color: '#00FF88', fontSize: 12, letterSpacing: 3, marginBottom: 8 },
  timer: { color: '#FFF', fontSize: 52, fontWeight: 'bold', fontVariant: ['tabular-nums'] },
  activeVenue: { color: '#CCC', fontSize: 18, marginTop: 4 },
  activeType: { color: '#888', fontSize: 13, marginTop: 2, marginBottom: 24 },

  endButton: {
    backgroundColor: '#FF4444',
    paddingVertical: 14,
    paddingHorizontal: 48,
    borderRadius: 30,
    marginBottom: 12,
  },
  endButtonText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },

  meterButton: { paddingVertical: 10 },
  meterButtonText: { color: '#00FF88', fontSize: 15 },

  // Start form
  startCard: {
    backgroundColor: '#0A0A0A',
    borderRadius: 16,
    padding: 24,
    marginBottom: 20,
  },
  title: { color: '#FFF', fontSize: 32, fontWeight: 'bold', marginBottom: 4 },
  subtitle: { color: '#555', fontSize: 14, marginBottom: 24 },

  label: { color: '#888', fontSize: 13, marginBottom: 8, letterSpacing: 1 },
  input: {
    backgroundColor: '#111',
    color: '#FFF',
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#222',
  },

  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  typeChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#111',
  },
  typeChipSelected: { borderColor: '#00FF88', backgroundColor: '#0D1F17' },
  typeChipText: { color: '#888', fontSize: 13 },
  typeChipTextSelected: { color: '#00FF88' },

  startButton: {
    backgroundColor: '#00FF88',
    paddingVertical: 16,
    borderRadius: 30,
    alignItems: 'center',
  },
  startButtonDisabled: { backgroundColor: '#004422' },
  startButtonText: { color: '#000', fontSize: 18, fontWeight: 'bold' },

  // History
  historySection: { marginBottom: 20 },
  historyTitle: { color: '#888', fontSize: 13, letterSpacing: 2, marginBottom: 12 },
  historyItem: {
    backgroundColor: '#0A0A0A',
    borderRadius: 10,
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1A1A1A',
  },
  historyLeft: { flex: 1 },
  historyVenue: { color: '#DDD', fontSize: 15 },
  historyMeta: { color: '#555', fontSize: 12, marginTop: 2 },
  historyScore: { color: '#00FF88', fontSize: 22, fontWeight: 'bold' },

  deviceId: { color: '#333', fontSize: 10, textAlign: 'center', marginTop: 10 },
});
