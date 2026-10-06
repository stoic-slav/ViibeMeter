import { useCallback } from 'react';
import { View, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { sessionManager } from '../src/session/SessionManager';
import { joinUrl, venueJoinUrl, parseScan } from '../src/session/GroupCode';
import { applyScan } from '../src/session/SessionControl';

/**
 * Deep link target, from scanning a code with the phone's Camera app:
 *   vibemeter://join?code=G-XXXXXX            a friend's group
 *   vibemeter://join?venue=<place ID>&name=…  a venue's code: confirms the venue, joins its crowd
 * Applies to the running session, or to the next one to be started.
 */
export default function JoinScreen() {
  const { code, venue, name } = useLocalSearchParams<{ code?: string; venue?: string; name?: string }>();
  const router = useRouter();

  // On every visit, not only the first: tab screens stay mounted, and the same code may be opened twice
  useFocusEffect(useCallback(() => {
    const scan = parseScan(venue ? venueJoinUrl(venue, name ?? 'Venue') : code ? joinUrl(code) : null);
    (async () => {
      if (scan) {
        const msg = await applyScan(scan);
        if (sessionManager.isSessionActive) {
          Alert.alert(scan.kind === 'venue' ? 'Venue confirmed' : 'Joined group', msg);
          router.replace('/meter');
          return;
        }
      }
      router.replace('/');
    })();
  }, [code, venue, name]));

  return (
    <View style={{ flex: 1, backgroundColor: '#060608', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#00E8A0" />
    </View>
  );
}
