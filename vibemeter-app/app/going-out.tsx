import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, Alert, Linking, Switch, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { standby, StandbyState } from '../src/session/Standby';
import { getStandbySettings, saveStandbySettings, StandbySettings } from '../src/storage/StandbySettings';
import { scheduleNightReminders } from '../src/notifications/NightReminder';
import { STANDBY } from '../src/config/constants';

const A = '#00E8A0';
const TX = '#f0f0f5';
const TXM = '#c0c0d8';
const TXD = '#9898c0';
const S1 = '#0d0d12';
const S2 = '#181824';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

// Monday first; values are expo-notifications weekdays (1 = Sunday … 7 = Saturday)
const DAYS: { label: string; weekday: number }[] = [
  { label: 'Mon', weekday: 2 }, { label: 'Tue', weekday: 3 }, { label: 'Wed', weekday: 4 },
  { label: 'Thu', weekday: 5 }, { label: 'Fri', weekday: 6 }, { label: 'Sat', weekday: 7 }, { label: 'Sun', weekday: 1 },
];
const TIMES: [number, number][] = [[21, 30], [22, 0], [22, 30], [23, 0], [23, 30]];

/**
 * Going out mode (iOS, build 24): the opt-in, switching standby on and off, answering its prompt,
 * and the weekend-night reminder. Opened from Home and from the reminder notification.
 */
export default function GoingOutScreen() {
  const router = useRouter();
  const [state, setState] = useState<StandbyState>(standby.current);
  const [settings, setSettings] = useState<StandbySettings | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => standby.onChange(setState), []);
  useFocusEffect(useCallback(() => {
    setState(standby.current);
    getStandbySettings().then(setSettings);
  }, []));

  const turnOn = async () => {
    setBusy(true);
    try {
      if (!settings?.acceptedAt) setSettings(await saveStandbySettings({ acceptedAt: Date.now() }));
      const problem = await standby.arm();
      if (problem === 'mic') {
        Alert.alert('Microphone needed', 'Going out mode listens for music on your phone. Allow the microphone in Settings.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]);
      } else if (problem === 'session') {
        Alert.alert('Already measuring', 'A session is running, so Going out mode is not needed now.');
      } else if (problem) {
        Alert.alert("Couldn't turn it on", 'The microphone could not be started. Try again in a moment.');
      }
    } finally {
      setBusy(false);
    }
  };

  const updateReminders = async (change: Partial<StandbySettings['reminders']>) => {
    if (!settings) return;
    const next = await saveStandbySettings({ reminders: { ...settings.reminders, ...change } });
    setSettings(next);
    scheduleNightReminders(next.reminders).catch(() => {});
  };

  if (Platform.OS !== 'ios') {
    return (
      <View style={st.container}>
        <Text style={[st.lead, { padding: 20 }]}>Going out mode is coming to Android later. Start a session when you arrive.</Text>
      </View>
    );
  }

  const on = state === 'standby' || state === 'prompt';
  const since = standby.armedAt ? new Date(standby.armedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <View style={st.container}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 120 }}>
        {state === 'prompt' && (
          <View style={[st.card, { borderColor: A }]}>
            <Text style={[st.cardTitle, { color: A }]}>Sounds like a party 🎶</Text>
            <Text style={st.body}>Start measuring?</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
              <TouchableOpacity style={[st.primaryBtn, { flex: 1 }]} onPress={() => standby.accept().then(() => router.replace('/meter'))}>
                <Text style={st.primaryText}>YES, START</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[st.secondaryBtn, { flex: 1 }]} onPress={() => standby.notNow()}>
                <Text style={st.secondaryText}>NOT NOW</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {on && (
          <View style={st.card}>
            <Text style={st.cardTitle}>Standing by{since ? ` since ${since}` : ''}</Text>
            <Text style={st.body}>
              Lock your phone and put it in your pocket. When it sounds and moves like a party, your phone buzzes and the
              lock-screen card asks "Start measuring?". Tap Yes, no need to unlock.
            </Text>
            <TouchableOpacity style={st.secondaryBtn} onPress={() => standby.disarm('user')}>
              <Text style={st.secondaryText}>TURN OFF</Text>
            </TouchableOpacity>
          </View>
        )}

        {state === 'session' && (
          <View style={st.card}>
            <Text style={st.cardTitle}>Measuring</Text>
            <Text style={st.body}>Your session is running. Rate the vibe from the lock-screen card.</Text>
            <TouchableOpacity style={st.secondaryBtn} onPress={() => router.replace('/meter')}>
              <Text style={st.secondaryText}>OPEN THE METER</Text>
            </TouchableOpacity>
          </View>
        )}

        {state === 'off' && settings && (
          <View style={st.card}>
            <Text style={st.cardTitle}>Going out tonight?</Text>
            <Text style={st.body}>
              Turn this on before you go out. Viibe Check then listens on your phone for loud music with a beat and
              feels for dancing. When both happen for a few minutes, it asks "Start measuring?" on your lock screen.
            </Text>
            <Text style={st.body}>
              Nothing is recorded, stored or uploaded until you say yes, apart from how often it asked and your battery
              level. The orange microphone dot stays on while it listens. It turns itself off at 06:00, after
              {` ${STANDBY.MAX_DURATION_MS / 3_600_000} `}hours, or at {STANDBY.LOW_BATTERY_PCT}% battery.
            </Text>
            {!settings.acceptedAt && (
              <TouchableOpacity style={st.agreeRow} onPress={() => setAgreed(a => !a)} activeOpacity={0.8}>
                <View style={[st.checkbox, agreed && { backgroundColor: A, borderColor: A }]}>
                  {agreed && <Text style={{ color: '#030904', fontWeight: '700', fontSize: 13 }}>✓</Text>}
                </View>
                <Text style={[st.body, { flex: 1 }]}>I agree that Viibe Check may listen on standby as described.</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[st.primaryBtn, (busy || (!settings.acceptedAt && !agreed)) && { opacity: 0.4 }]}
              disabled={busy || (!settings.acceptedAt && !agreed)}
              onPress={turnOn}
            >
              {busy ? <ActivityIndicator color="#030904" /> : <Text style={st.primaryText}>🎶  TURN ON GOING OUT MODE</Text>}
            </TouchableOpacity>
          </View>
        )}

        {settings && (
          <View style={st.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={[st.cardTitle, { flex: 1 }]}>Remind me on nights out</Text>
              <Switch
                value={settings.reminders.enabled}
                onValueChange={v => updateReminders({ enabled: v })}
                trackColor={{ true: A, false: S2 }}
              />
            </View>
            <Text style={st.body}>"Out tonight?" on the days you pick, so you remember to turn Going out mode on.</Text>
            {settings.reminders.enabled && (
              <>
                <View style={st.chipRow}>
                  {DAYS.map(d => {
                    const sel = settings.reminders.weekdays.includes(d.weekday);
                    return (
                      <TouchableOpacity
                        key={d.weekday}
                        style={[st.chip, sel && st.chipOn]}
                        onPress={() => updateReminders({
                          weekdays: sel ? settings.reminders.weekdays.filter(w => w !== d.weekday) : [...settings.reminders.weekdays, d.weekday],
                        })}
                      >
                        <Text style={[st.chipText, sel && { color: A }]}>{d.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <View style={st.chipRow}>
                  {TIMES.map(([h, m]) => {
                    const sel = settings.reminders.hour === h && settings.reminders.minute === m;
                    return (
                      <TouchableOpacity key={`${h}:${m}`} style={[st.chip, sel && st.chipOn]} onPress={() => updateReminders({ hour: h, minute: m })}>
                        <Text style={[st.chipText, sel && { color: A }]}>{`${h}:${String(m).padStart(2, '0')}`}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#060608' },
  lead: { color: TXM, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: S1, borderWidth: 1, borderColor: S2, borderRadius: 16, padding: 16, gap: 10 },
  cardTitle: { color: TX, fontSize: 17, fontWeight: '700' },
  body: { color: TXM, fontSize: 13, lineHeight: 19 },
  agreeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: TXD, alignItems: 'center', justifyContent: 'center' },
  primaryBtn: { height: 50, borderRadius: 14, backgroundColor: A, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: '#030904', letterSpacing: 2 },
  secondaryBtn: { height: 46, borderRadius: 14, borderWidth: 1, borderColor: TXD + '66', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  secondaryText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: TXM, letterSpacing: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: S2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#060608' },
  chipOn: { borderColor: A + '80', backgroundColor: A + '14' },
  chipText: { fontFamily: MONO, fontSize: 12, color: TXD },
});
