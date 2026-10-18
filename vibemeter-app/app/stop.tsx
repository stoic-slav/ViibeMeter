import { useCallback } from 'react';
import { View, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { sessionManager } from '../src/session/SessionManager';
import { stopEverything } from '../src/session/SessionControl';

/**
 * Deep link target of the lock-screen card's STOP button (vibemeter://stop). Opening it needs the
 * phone unlocked, and the session ends only after a confirmation, so a tap in a pocket can't end
 * the night.
 */
export default function StopScreen() {
  const router = useRouter();

  useFocusEffect(useCallback(() => {
    if (!sessionManager.isSessionActive) {
      router.replace('/');
      return;
    }
    router.replace('/meter');
    Alert.alert('End this session?', 'Viibe Check stops measuring and uploads what it recorded.', [
      { text: 'Keep measuring', style: 'cancel' },
      {
        text: 'End session', style: 'destructive', onPress: async () => {
          const session = await stopEverything('user');
          router.push({ pathname: '/summary', params: { sessionId: session?.id } });
        },
      },
    ]);
  }, []));

  return (
    <View style={{ flex: 1, backgroundColor: '#060608', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#00E8A0" />
    </View>
  );
}
