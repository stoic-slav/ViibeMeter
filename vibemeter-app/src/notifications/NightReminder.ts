import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import { Alert, AppState } from 'react-native';
import { router } from 'expo-router';
import { NightReminderSettings } from '../storage/StandbySettings';
import { getNightPlan, saveNightPlan, NightPlan } from '../storage/NightPlan';
import { getConsent } from '../storage/Consent';
import { NIGHT_NUDGE } from '../config/constants';
import { supabase } from '../config/supabase';
import { scheduleArrivalNudges, cancelArrivalNudges, ArrivalRegion } from '../../modules/arrival-nudge';
import { lateNudgeDates, nightKey, nameFromTitle, placeIdFromIdentifier } from './NightNudgePlan';
import { expressStart, onSessionStarted } from '../session/SessionControl';

/**
 * Getting a night measured without having to remember it (iOS, build 32). The phone can't start
 * the microphone by itself, so the app arranges for ONE tap to arrive at the right moments:
 *
 * 1. Plan-ahead question, Friday and Saturday at 19:00 (days and time are in Settings → Going
 *    out): "Going out tonight?" with Yes / Not tonight.
 * 2. After a Yes: the system watches the few clubs near the phone (location-triggered
 *    notifications, no app running) and shows "At <club>? Start measuring" on arrival; if that
 *    never fires (a house party, location off), "Still out?" nudges follow at 23:30 and 01:00.
 * 3. Tapping any nudge starts the session at once with no screens (`expressStart`), using the club
 *    from the arrival notification (or none, to be filled in afterwards) and the last settings.
 *    The phone has to be unlocked for the app to open; that's iOS.
 * Everything pending is cancelled when a session starts, on "Not tonight", and when the night is over.
 */

const LOG_TAG = '[NightNudges]';
const PLAN_CATEGORY = 'night-plan';
const NUDGE_CATEGORY = 'start-nudge';
const ACTION_YES = 'plan-yes';
const ACTION_NO = 'plan-no';
const ACTION_START = 'nudge-start';
const PLAN_PREFIX = 'night-reminder-';      // kept from build 24 so old schedules are replaced
const LATE_PREFIX = 'start-nudge-';

let responseSub: { remove: () => void } | null = null;
let stopListening: (() => void) | null = null;

export async function setupNightReminder(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(PLAN_CATEGORY, [
    { identifier: ACTION_YES, buttonTitle: "Yes, I'm going out", options: { opensAppToForeground: true } },
    { identifier: ACTION_NO, buttonTitle: 'Not tonight', options: { opensAppToForeground: false } },
  ]).catch(err => console.warn(`${LOG_TAG} Could not register the plan buttons:`, err));
  await Notifications.setNotificationCategoryAsync(NUDGE_CATEGORY, [
    { identifier: ACTION_START, buttonTitle: 'Start measuring', options: { opensAppToForeground: true } },
  ]).catch(err => console.warn(`${LOG_TAG} Could not register the start button:`, err));

  responseSub?.remove();
  responseSub = Notifications.addNotificationResponseReceivedListener(r => handle(r));
  Notifications.getLastNotificationResponseAsync().then(r => { if (r) handle(r); }).catch(() => {});

  // Once a session runs, the nudges have done their job
  stopListening?.();
  stopListening = onSessionStarted(() => { cancelNightNudges().catch(() => {}); });
  cleanupStaleNudges().catch(() => {});
}

function handle(response: Notifications.NotificationResponse): void {
  const req = response.notification.request;
  const id = req.identifier;
  const action = response.actionIdentifier;
  const category = req.content.categoryIdentifier;
  const isPlan = id.startsWith(PLAN_PREFIX) || category === PLAN_CATEGORY;
  const isNudge = id.startsWith(LATE_PREFIX) || id.startsWith('arrival-') || category === NUDGE_CATEGORY;
  if (!isPlan && !isNudge) return;
  // Handled once: the last response is otherwise replayed at every launch
  Notifications.clearLastNotificationResponseAsync().catch(() => {});

  if (isPlan) {
    if (action === ACTION_NO) { skipTonight().catch(() => {}); return; }
    // "Yes", or a tap on the notification itself: the app is open, so arrange tonight
    setTimeout(() => { planTonight().then(() => router.push('/going-out')).catch(() => {}); }, 500);
    return;
  }
  if (action !== ACTION_START && action !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const data = (req.content.data ?? {}) as Record<string, any>;
  const body = (data.body && typeof data.body === 'object' ? data.body : data) as Record<string, any>;
  const placeId = placeIdFromIdentifier(id) ?? (typeof body.placeId === 'string' ? body.placeId : null);
  const rawName = typeof body.name === 'string' && body.name ? body.name : null;
  const name = nameFromTitle(rawName) ?? rawName ?? nameFromTitle(req.content.title);
  setTimeout(() => { startFromNudge(placeId && name ? { placeId, name } : null).catch(() => {}); }, 500);
}

/** The one tap: start measuring now. Explains what's missing when it can't. */
export async function startFromNudge(venue: { placeId: string; name: string } | null): Promise<void> {
  // The microphone can only be started with the app in the foreground
  for (let i = 0; i < 20 && AppState.currentState !== 'active'; i++) await new Promise(r => setTimeout(r, 250));
  const result = await expressStart(venue);
  if (result === 'started' || result === 'already') { router.push('/meter'); return; }
  if (result === 'needs_consent') {
    Alert.alert('One quick step first', 'Before your first session, Viibe Check asks you to agree to what it may use. It only takes a moment.');
    router.push('/');
  } else if (result === 'needs_mic') {
    Alert.alert('Microphone needed', 'Viibe Check needs the microphone to measure the music. Allow it in Settings, then tap Start session.');
    router.push('/');
  } else {
    Alert.alert("Couldn't start", 'Open Viibe Check and tap Start session.');
  }
}

async function cancelScheduled(prefix: string): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  for (const n of scheduled) {
    if (n.identifier.startsWith(prefix)) await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
  }
}

/** Cancels the arrival and "Still out?" nudges (a session started, "Not tonight", or a new night). */
export async function cancelNightNudges(): Promise<void> {
  await cancelScheduled(LATE_PREFIX);
  await cancelArrivalNudges();
  // Tonight's card must not say clubs are still being watched
  const plan = await getNightPlan();
  if (plan?.answer === 'yes' && (plan.late > 0 || plan.clubs > 0)) await saveNightPlan({ ...plan, late: 0, clubs: 0 });
}

/** Nudges left from an earlier night are removed when the app next opens. */
async function cleanupStaleNudges(): Promise<void> {
  const plan = await getNightPlan();
  if (!plan || plan.night !== nightKey(Date.now(), NIGHT_NUDGE.NIGHT_ENDS_HOUR)) await cancelNightNudges();
}

export interface PlanResult { late: number; clubs: number }

/** "Yes, going out tonight": remembers it and arranges the arrival and "Still out?" nudges. */
export async function planTonight(): Promise<PlanResult> {
  const now = new Date();
  await cancelNightNudges();

  // "Still out?" nudges, for the case that nothing else started the session
  let late = 0;
  for (const [i, at] of lateNudgeDates(now, NIGHT_NUDGE.LATE, NIGHT_NUDGE.NIGHT_ENDS_HOUR).entries()) {
    await Notifications.scheduleNotificationAsync({
      identifier: `${LATE_PREFIX}${i}`,
      content: { title: 'Still out? 🎶', body: 'Tap to start measuring. Your night in songs is waiting.', categoryIdentifier: NUDGE_CATEGORY, sound: 'default' },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at },
    }).then(() => { late++; }).catch(err => console.warn(`${LOG_TAG} Could not schedule a nudge:`, err));
  }

  // Arrival nudges: only with location allowed (in Settings and by iOS); otherwise just the late ones
  const clubs = await scheduleArrival().catch(err => { console.warn(`${LOG_TAG} Arrival nudges failed:`, err); return 0; });

  const plan: NightPlan = { night: nightKey(now.getTime(), NIGHT_NUDGE.NIGHT_ENDS_HOUR), answer: 'yes', at: now.getTime(), late, clubs };
  await saveNightPlan(plan);
  console.log(`${LOG_TAG} Going out tonight: ${late} late nudges, ${clubs} clubs watched`);
  return { late, clubs };
}

export async function skipTonight(): Promise<void> {
  await cancelNightNudges();
  await saveNightPlan({ night: nightKey(Date.now(), NIGHT_NUDGE.NIGHT_ENDS_HOUR), answer: 'no', at: Date.now(), late: 0, clubs: 0 });
}

/** The clubs near the phone, watched by the system. The position is rounded and never stored. */
async function scheduleArrival(): Promise<number> {
  const consent = await getConsent();
  if (!consent?.location) return 0;
  const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!perm?.granted) return 0;
  const pos = (await Location.getLastKnownPositionAsync({ maxAge: 30 * 60_000 }).catch(() => null))
    ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null));
  if (!pos) return 0;
  const round = (v: number) => Math.round(v * 1000) / 1000;      // ~100 m; the server rounds further
  const { data, error } = await supabase.functions.invoke('nearby-clubs', { body: { lat: round(pos.coords.latitude), lng: round(pos.coords.longitude) } });
  if (error) throw error;
  const clubs = ((data?.clubs ?? []) as { placeId: string; name: string | null; lat: number; lng: number }[])
    .filter(c => c.name).slice(0, NIGHT_NUDGE.ARRIVAL_MAX);
  const regions: ArrivalRegion[] = clubs.map(c => ({
    id: c.placeId, name: c.name!, lat: c.lat, lng: c.lng, title: `At ${c.name}?`, body: 'Tap to start measuring. Nothing else to do.',
  }));
  return scheduleArrivalNudges(regions, NIGHT_NUDGE.ARRIVAL_RADIUS_M, NUDGE_CATEGORY);
}

/** Replaces the scheduled plan-ahead questions with the given settings (none when disabled). */
export async function scheduleNightReminders(s: NightReminderSettings): Promise<void> {
  await cancelScheduled(PLAN_PREFIX);
  if (!s.enabled) return;
  for (const weekday of s.weekdays) {
    await Notifications.scheduleNotificationAsync({
      identifier: `${PLAN_PREFIX}${weekday}`,
      content: {
        title: 'Going out tonight? 🎶',
        body: "One tap and your night gets measured. Nothing else to remember.",
        categoryIdentifier: PLAN_CATEGORY,
        sound: 'default',
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday, hour: s.hour, minute: s.minute },
    }).catch(err => console.warn(`${LOG_TAG} Could not schedule weekday ${weekday}:`, err));
  }
  console.log(`${LOG_TAG} Plan-ahead question on days ${s.weekdays.join(',')} at ${s.hour}:${String(s.minute).padStart(2, '0')}`);
}
