import { useEffect } from 'react';
import { Tabs } from 'expo-router';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { Platform } from 'react-native';
import { vibePrompt } from '../src/notifications/VibePrompt';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';
import { sessionManager } from '../src/session/SessionManager';
import { closeInterruptedSessions } from '../src/storage/LocalBuffer';
import { syncSessions } from '../src/storage/SupabaseSync';
import { endLeftoverCard } from '../src/notifications/LockScreenCard';

const BACKGROUND_TASK = 'VIBEMETER_BACKGROUND_FETCH';

// Define background task at module level (required by expo-task-manager)
TaskManager.defineTask(BACKGROUND_TASK, async () => {
  try {
    await sensorOrchestrator.runCollectionCycle();
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (err) {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export default function RootLayout() {
  useEffect(() => {
    // Setup notifications
    vibePrompt.setup().catch(console.error);

    // A session never ends by itself when the app is killed mid-session: close it now (as
    // 'interrupted') and remove its lock-screen card
    if (!sessionManager.isSessionActive) {
      endLeftoverCard().catch(() => {});
      closeInterruptedSessions(null)
        .then(n => { if (n > 0) syncSessions().catch(() => {}); })
        .catch(err => console.warn('[Layout] Closing interrupted sessions failed:', err));
    }

    // Register background fetch task
    (BackgroundFetch as any).registerTaskAsync(BACKGROUND_TASK, {
      minimumInterval: 60,         // 60 sec minimum (iOS may fire less often)
      stopOnTerminate: false,
      startOnBoot: false,
    }).catch((err: any) => {
      // Non-fatal — app still works in foreground
      console.warn('[Layout] Background fetch registration failed:', err?.message);
    });

    return () => {
      (BackgroundFetch as any).unregisterTaskAsync(BACKGROUND_TASK).catch(() => {});
    };
  }, []);

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: '#0d0d12',
          borderTopColor: '#181824',
        },
        tabBarActiveTintColor: '#00E8A0',
        tabBarInactiveTintColor: '#9898c0',
        headerStyle: { backgroundColor: '#060608' },
        headerTintColor: '#f0f0f5',
        headerTitleStyle: { fontWeight: 'bold' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Viibe Check',
          tabBarLabel: 'Home',
          tabBarIcon: ({ color }) => <TabIcon label="⌂" color={color} />,
        }}
      />
      <Tabs.Screen
        name="meter"
        options={{
          title: 'Live Meter',
          tabBarLabel: 'Meter',
          tabBarIcon: ({ color }) => <TabIcon label="◉" color={color} />,
        }}
      />
      <Tabs.Screen
        name="live"
        options={{
          title: 'Live',
          tabBarLabel: 'Live',
          tabBarIcon: ({ color }) => <TabIcon label="✦" color={color} />,
        }}
      />
      {/* Deep link target for group QR codes (vibemeter://join?code=…); not a tab */}
      <Tabs.Screen name="join" options={{ href: null, headerShown: false }} />
      {/* Make a venue's QR code (opened from the Group sheet); not a tab */}
      <Tabs.Screen name="venue-code" options={{ href: null, title: 'Venue code' }} />
      {/* Consent choices, anonymous ID and data deletion (from the home screen); not a tab */}
      <Tabs.Screen name="privacy" options={{ href: null, title: 'Privacy & data' }} />
      {/* The lock-screen card's STOP button (vibemeter://stop): asks to confirm; not a tab */}
      <Tabs.Screen name="stop" options={{ href: null, headerShown: false }} />
      <Tabs.Screen
        name="summary"
        options={{
          title: 'Summary',
          tabBarLabel: 'Summary',
          tabBarIcon: ({ color }) => <TabIcon label="▤" color={color} />,
        }}
      />
    </Tabs>
  );
}

function TabIcon({ label, color }: { label: string; color: string }) {
  const { Text } = require('react-native');
  return <Text style={{ color, fontSize: 18 }}>{label}</Text>;
}
