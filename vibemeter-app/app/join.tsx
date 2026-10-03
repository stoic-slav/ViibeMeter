import { useEffect } from 'react';
import { View, ActivityIndicator, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { sessionManager } from '../src/session/SessionManager';
import { parseGroupCode, setPendingGroupCode } from '../src/session/GroupCode';

/**
 * Deep link target: vibemeter://join?code=G-XXXXXX (from scanning a friend's QR code with the
 * phone's Camera app). Joins the running session to that group, or the next one to be started.
 */
export default function JoinScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router = useRouter();

  useEffect(() => {
    const parsed = parseGroupCode(code ?? null);
    (async () => {
      if (parsed) {
        if (sessionManager.isSessionActive) {
          await sessionManager.setEventCode(parsed);
          Alert.alert('Joined group', `This session is now in group ${parsed}.`);
          router.replace('/meter');
          return;
        }
        setPendingGroupCode(parsed);
      }
      router.replace('/');
    })();
  }, [code]);

  return (
    <View style={{ flex: 1, backgroundColor: '#060608', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#00E8A0" />
    </View>
  );
}
