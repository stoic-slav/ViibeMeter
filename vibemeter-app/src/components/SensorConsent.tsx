import { View, Text, Switch, StyleSheet, TouchableOpacity } from 'react-native';

/** Shared by the first-start consent screen and the Settings screen. */
export const PRIVACY_URL = 'https://github.com/stoic-slav/ViibeMeter/blob/master/docs/PRIVACY.md';

const A = '#00E8A0';
const S1 = '#0d0d12';
const S2 = '#181824';
const S3 = '#22222e';
const TX = '#f0f0f5';
const TXD = '#9898c0';

export function SensorRow({ title, body, value, onChange, locked }: {
  title: string; body: string; value: boolean; onChange?: (v: boolean) => void; locked?: boolean;
}) {
  // The whole row toggles (a bigger target than the switch alone)
  return (
    <TouchableOpacity style={s.sensorRow} activeOpacity={locked ? 1 : 0.8} disabled={locked}
      onPress={() => onChange?.(!value)} accessibilityRole="switch" accessibilityState={{ checked: value, disabled: locked }}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={s.sensorTitle}>{title}{locked ? '  · required' : ''}</Text>
        <Text style={s.sensorBody}>{body}</Text>
      </View>
      {/* Display only: the row handles the tap, so a tap on the switch can't toggle twice */}
      <View pointerEvents="none">
        <Switch value={value} disabled={locked} trackColor={{ true: A + '88', false: S3 }} thumbColor={value ? A : TXD} />
      </View>
    </TouchableOpacity>
  );
}

export const SENSOR_TEXT = {
  mic: 'Music tempo and loudness, analysed on the phone and not recorded (unless you later switch on "Keep my best moments", which is off by default). It also keeps the session measuring while your phone is locked.',
  motion: 'How much you move, and whether you move on the beat.',
  bluetooth: 'Counts nearby devices to estimate how crowded it is. No device names or IDs are kept.',
  location: 'Only to suggest which club or bar you\'re in. You confirm it; your position is never stored.',
};


const s = StyleSheet.create({
  sensorRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: S1, borderWidth: 1, borderColor: S2, borderRadius: 14, padding: 14 },
  sensorTitle: { color: TX, fontSize: 15, fontWeight: '600' },
  sensorBody: { color: TXD, fontSize: 12, lineHeight: 17 },
});
