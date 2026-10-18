import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { NightReminderSettings } from '../storage/StandbySettings';

/**
 * The weekend-night reminder ("Out tonight?"), a local weekly notification on the chosen days
 * (iOS, build 24). Tapping it opens the Going out screen, where one tap turns standby on: the
 * microphone can only be switched on with the app in the foreground.
 */

const LOG_TAG = '[NightReminder]';
const CATEGORY_ID = 'night-reminder';
const ACTION_GOING_OUT = 'going-out';
const ID_PREFIX = 'night-reminder-';

let responseSub: { remove: () => void } | null = null;

export async function setupNightReminder(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    { identifier: ACTION_GOING_OUT, buttonTitle: '🎶 Turn on Going out', options: { opensAppToForeground: true } },
  ]).catch(err => console.warn(`${LOG_TAG} Could not register the reminder button:`, err));

  responseSub?.remove();
  responseSub = Notifications.addNotificationResponseReceivedListener(r => handle(r));
  Notifications.getLastNotificationResponseAsync().then(r => { if (r) handle(r); }).catch(() => {});
}

function handle(response: Notifications.NotificationResponse): void {
  if (!response.notification.request.identifier.startsWith(ID_PREFIX)) return;
  // Handled once: the last response is otherwise replayed at every launch
  Notifications.clearLastNotificationResponseAsync().catch(() => {});
  // The tap or the button: both open the Going out screen (after the navigator mounts)
  setTimeout(() => router.push('/going-out'), 500);
}

/** Replaces the scheduled reminders with the given settings (none when disabled). */
export async function scheduleNightReminders(s: NightReminderSettings): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  for (const n of scheduled) {
    if (n.identifier.startsWith(ID_PREFIX)) await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
  }
  if (!s.enabled) return;
  for (const weekday of s.weekdays) {
    await Notifications.scheduleNotificationAsync({
      identifier: `${ID_PREFIX}${weekday}`,
      content: {
        title: 'Out tonight? 🎶',
        body: "Turn on Going out mode and we'll ask when it sounds like a party.",
        categoryIdentifier: CATEGORY_ID,
        sound: 'default',
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday, hour: s.hour, minute: s.minute },
    }).catch(err => console.warn(`${LOG_TAG} Could not schedule weekday ${weekday}:`, err));
  }
  console.log(`${LOG_TAG} Reminders on days ${s.weekdays.join(',')} at ${s.hour}:${String(s.minute).padStart(2, '0')}`);
}
