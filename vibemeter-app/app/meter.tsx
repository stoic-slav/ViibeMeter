import { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, Animated, ScrollView, TouchableOpacity,
} from 'react-native';
import { SensorWindow, VibeScoreBreakdown } from '../src/types';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';
import { sessionManager } from '../src/session/SessionManager';
import { vibePrompt } from '../src/notifications/VibePrompt';

const RATING_LABELS = ['Dead', 'Meh', 'Decent', 'Great', 'Peak'];
const RATING_EMOJIS = ['💀', '😐', '🙂', '🔥', '🤯'];

export default function MeterScreen() {
  const [vibeScore, setVibeScore] = useState(0);
  const [breakdown, setBreakdown] = useState<VibeScoreBreakdown | null>(null);
  const [lastWindow, setLastWindow] = useState<SensorWindow | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [selectedRating, setSelectedRating] = useState<number | null>(null);

  const scoreAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Register for vibe updates from orchestrator
    sensorOrchestrator.setVibeUpdateCallback((window, scores) => {
      setLastWindow(window);
      setBreakdown(scores);
      setLastUpdated(new Date());

      // Animate score update
      Animated.spring(scoreAnim, {
        toValue: scores.compositeVibeScore,
        useNativeDriver: false,
        tension: 40,
        friction: 7,
      }).start();

      setVibeScore(scores.compositeVibeScore);
    });

    // Register for vibe prompt shown
    vibePrompt.setPromptShownCallback(() => setShowPrompt(true));

    // Set initial score from orchestrator state
    const current = sensorOrchestrator.currentVibeScore;
    if (current > 0) {
      setVibeScore(current);
      scoreAnim.setValue(current);
      setBreakdown(sensorOrchestrator.currentBreakdown);
    }

    // BPM pulse animation
    const startPulse = () => {
      if (!lastWindow?.estimatedBpm) return;
      const bpmInterval = (60 / lastWindow.estimatedBpm) * 1000;
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.05, duration: 80, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 80, useNativeDriver: true }),
      ]).start();
    };

    return () => {
      sensorOrchestrator.setVibeUpdateCallback((() => {}) as any);
    };
  }, []);

  const handleRating = async (rating: number) => {
    setSelectedRating(rating);
    await vibePrompt.recordRating((rating + 1) as 1 | 2 | 3 | 4 | 5);
    setTimeout(() => {
      setShowPrompt(false);
      setSelectedRating(null);
    }, 800);
  };

  const getScoreColor = (score: number) => {
    if (score < 1.5) return '#444';
    if (score < 2.5) return '#888';
    if (score < 3.5) return '#FFB347';
    if (score < 4.5) return '#00CC6A';
    return '#00FF88';
  };

  const getTrendSymbol = () => {
    const trend = lastWindow?.bleCountTrend;
    if (trend === 'filling') return { symbol: '↑', color: '#00FF88' };
    if (trend === 'thinning') return { symbol: '↓', color: '#FF4444' };
    if (trend === 'stable') return { symbol: '→', color: '#888' };
    return { symbol: '~', color: '#444' };
  };

  const trend = getTrendSymbol();
  const scoreColor = getScoreColor(vibeScore);
  const isActive = sessionManager.isSessionActive;
  const session = sessionManager.currentSession;

  const secondsAgo = lastUpdated
    ? Math.round((Date.now() - lastUpdated.getTime()) / 1000)
    : null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {!isActive && (
        <View style={styles.inactiveNotice}>
          <Text style={styles.inactiveText}>No active session — start one from Home</Text>
        </View>
      )}

      {/* Main vibe score */}
      <View style={styles.scoreContainer}>
        <Animated.Text style={[styles.scoreValue, { color: scoreColor }]}>
          {isActive ? vibeScore.toFixed(1) : '--'}
        </Animated.Text>
        <Text style={styles.scoreLabel}>VIBE SCORE</Text>

        {lastUpdated && (
          <Text style={styles.timestamp}>
            Updated {secondsAgo === 0 ? 'just now' : `${secondsAgo}s ago`}
          </Text>
        )}
      </View>

      {/* Sub-scores */}
      {breakdown && (
        <View style={styles.breakdownCard}>
          <SubScoreBar label="Energy" value={breakdown.energyScore} color="#FF8C00" />
          <SubScoreBar label="Music" value={breakdown.musicScore} color="#9B59B6" />
          <SubScoreBar label="Movement" value={breakdown.movementScore} color="#3498DB" />
          <SubScoreBar label="Density" value={breakdown.densityScore} color="#E74C3C" />
        </View>
      )}

      {/* BPM + trend row */}
      <View style={styles.infoRow}>
        <View style={styles.infoCard}>
          <Text style={styles.infoValue}>
            {lastWindow?.estimatedBpm ? `${lastWindow.estimatedBpm}` : '--'}
          </Text>
          <Text style={styles.infoLabel}>BPM</Text>
        </View>

        <View style={styles.infoCard}>
          <Text style={[styles.infoValue, { color: trend.color }]}>{trend.symbol}</Text>
          <Text style={styles.infoLabel}>CROWD</Text>
        </View>

        <View style={styles.infoCard}>
          <Text style={styles.infoValue}>
            {lastWindow?.bleDeviceCount ?? '--'}
          </Text>
          <Text style={styles.infoLabel}>DEVICES</Text>
        </View>
      </View>

      {/* Audio classification badge */}
      {lastWindow?.audioClassification && (
        <View style={styles.classBadge}>
          <Text style={styles.classBadgeText}>
            {lastWindow.audioClassification.replace('_', ' ').toUpperCase()}
          </Text>
        </View>
      )}

      {/* Movement classification */}
      {lastWindow?.movementClassification && (
        <Text style={styles.movementText}>
          Movement: {lastWindow.movementClassification}
        </Text>
      )}

      {/* Vibe prompt overlay */}
      {showPrompt && (
        <View style={styles.promptOverlay}>
          <View style={styles.promptCard}>
            <Text style={styles.promptTitle}>How's the vibe? 🎉</Text>
            <View style={styles.promptOptions}>
              {RATING_EMOJIS.map((emoji, index) => (
                <TouchableOpacity
                  key={index}
                  style={[
                    styles.promptOption,
                    selectedRating === index && styles.promptOptionSelected,
                  ]}
                  onPress={() => handleRating(index)}
                >
                  <Text style={styles.promptEmoji}>{emoji}</Text>
                  <Text style={styles.promptLabel}>{RATING_LABELS[index]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={() => setShowPrompt(false)}>
              <Text style={styles.promptDismiss}>Skip</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

function SubScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const width = `${Math.min(100, (value / 5) * 100)}%` as any;
  return (
    <View style={subStyles.row}>
      <Text style={subStyles.label}>{label}</Text>
      <View style={subStyles.track}>
        <View style={[subStyles.fill, { width, backgroundColor: color }]} />
      </View>
      <Text style={subStyles.value}>{value.toFixed(1)}</Text>
    </View>
  );
}

const subStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  label: { color: '#888', fontSize: 12, width: 70 },
  track: { flex: 1, height: 6, backgroundColor: '#1A1A1A', borderRadius: 3, overflow: 'hidden', marginHorizontal: 10 },
  fill: { height: '100%', borderRadius: 3 },
  value: { color: '#888', fontSize: 12, width: 28, textAlign: 'right' },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content: { padding: 20, paddingBottom: 40 },

  inactiveNotice: {
    backgroundColor: '#1A0A00',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#FF8C0033',
  },
  inactiveText: { color: '#FF8C00', fontSize: 13, textAlign: 'center' },

  scoreContainer: { alignItems: 'center', marginVertical: 32 },
  scoreValue: { fontSize: 96, fontWeight: 'bold', fontVariant: ['tabular-nums'] },
  scoreLabel: { color: '#444', fontSize: 12, letterSpacing: 4, marginTop: -8 },
  timestamp: { color: '#333', fontSize: 11, marginTop: 8 },

  breakdownCard: {
    backgroundColor: '#0A0A0A',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#1A1A1A',
  },

  infoRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  infoCard: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1A1A1A',
  },
  infoValue: { color: '#FFF', fontSize: 26, fontWeight: 'bold', fontVariant: ['tabular-nums'] },
  infoLabel: { color: '#444', fontSize: 10, letterSpacing: 2, marginTop: 4 },

  classBadge: {
    backgroundColor: '#111',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'center',
    marginBottom: 8,
  },
  classBadgeText: { color: '#00FF88', fontSize: 11, letterSpacing: 3 },

  movementText: { color: '#444', fontSize: 12, textAlign: 'center', marginBottom: 16 },

  // Prompt overlay
  promptOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  promptCard: {
    backgroundColor: '#0D0D0D',
    borderRadius: 20,
    padding: 28,
    width: '100%',
    borderWidth: 1,
    borderColor: '#00FF8840',
    alignItems: 'center',
  },
  promptTitle: { color: '#FFF', fontSize: 22, fontWeight: 'bold', marginBottom: 24 },
  promptOptions: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  promptOption: {
    flex: 1,
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#222',
  },
  promptOptionSelected: { borderColor: '#00FF88', backgroundColor: '#0D1F17' },
  promptEmoji: { fontSize: 28, marginBottom: 4 },
  promptLabel: { color: '#888', fontSize: 10 },
  promptDismiss: { color: '#444', fontSize: 13 },
});
