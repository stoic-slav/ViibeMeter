import { useEffect } from 'react';
import { Tabs } from 'expo-router';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { AppState, Platform } from 'react-native';
import { momentKeeper } from '../src/session/MomentKeeper';
import { vibePrompt } from '../src/notifications/VibePrompt';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';
import { sessionManager } from '../src/session/SessionManager';
import { closeInterruptedSessions } from '../src/storage/LocalBuffer';
import { syncSessions } from '../src/storage/SupabaseSync';
import { endLeftoverCard, listenForCardActions } from '../src/notifications/LockScreenCard';
import { standby } from '../src/session/Standby';
import { setupNightReminder, scheduleNightReminders } from '../src/notifications/NightReminder';
import { getStandbySettings } from '../src/storage/StandbySettings';
import { setupRecapNotifications } from '../src/session/NightRecapService';
import { refreshEditCatalog } from '../src/session/EditCatalog';

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
    standby.setup().catch(console.error);
    // Card button taps reach VibePrompt (ratings) and Standby (start, not now, turn off)
    listenForCardActions();
    // "Your night in songs" notification (12:00 the day after) opens the recap
    setupRecapNotifications();
    // Best moments (opt-in): finish cleaning and sending clips from earlier nights, drop expired ones
    momentKeeper.processPending().catch(() => {});
    const appStateSub = AppState.addEventListener('change', st => { if (st === 'active') momentKeeper.processPending().catch(() => {}); });
    // The DJ edit catalog (cached; refreshed at most twice a day)
    refreshEditCatalog().catch(() => {});
    if (Platform.OS === 'ios') {
      setupNightReminder().catch(console.error);
      getStandbySettings().then(s => scheduleNightReminders(s.reminders)).catch(() => {});
    }

    // A session never ends by itself when the app is killed mid-session: close it now (as
    // 'interrupted') and remove its lock-screen card
    if (!sessionManager.isSessionActive && standby.current === 'off') {
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
      appStateSub.remove();
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
      {/* Going out mode (standby) and the weekend-night reminder; not a tab */}
      <Tabs.Screen name="going-out" options={{ href: null, title: 'Going out' }} />
      {/* "Your night in songs" for a session (from the summary or the 12:00 notification); not a tab */}
      <Tabs.Screen name="recap" options={{ href: null, title: 'Your night in songs' }} />
      {/* "Register your edits" for DJs, from a link we give them (vibemeter://dj); not a tab */}
      <Tabs.Screen name="dj" options={{ href: null, title: 'For DJs' }} />
      {/* A venue's lineup, edited by the venue with its code (vibemeter://lineup); not a tab */}
      <Tabs.Screen name="lineup" options={{ href: null, title: 'Lineup' }} />
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
