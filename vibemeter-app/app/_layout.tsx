import { useEffect } from 'react';
import { Tabs } from 'expo-router';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { Platform } from 'react-native';
import { vibePrompt } from '../src/notifications/VibePrompt';
import { sensorOrchestrator } from '../src/sensors/SensorOrchestrator';

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
          title: 'VibeMeter',
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
