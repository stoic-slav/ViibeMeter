import { supabase } from '../config/supabase';
import { sessionManager } from '../session/SessionManager';
import { stopEverything } from '../session/SessionControl';
import { getDeviceId, resetDeviceId } from './DeviceIdentity';
import { wipeLocalData, deleteSessionLocal } from './LocalBuffer';
import * as Notifications from 'expo-notifications';
import { clearConsent } from './Consent';
import { clearDanceAffinity } from './UserProfile';
import { clearPromptSettings } from './PromptSettings';
import { clearMomentSettings } from './MomentSettings';
import { momentKeeper } from '../session/MomentKeeper';
import { clearStandbySettings, getStandbySettings } from './StandbySettings';
import { standby } from '../session/Standby';
import { scheduleNightReminders } from '../notifications/NightReminder';
import { clearEditCatalogCache } from '../session/EditCatalog';

/**
 * Swipe-to-delete on Home: one session, from the phone and from the database (its ratings, recap
 * answers, readings and clips go with it). The server goes first, so that if the phone is offline
 * nothing is deleted and the user can try again. A session that never uploaded is only local.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const deviceId = await getDeviceId();
  await momentKeeper.deleteSessionMoments(sessionId); // clips first: the server copies, then the phone's
  const { error } = await supabase.rpc('delete_my_session', { p_device_id: deviceId, p_session_id: sessionId });
  if (error) throw new Error(error.message);
  await deleteSessionLocal(sessionId);
  // Its "Your night in songs" reminder is no longer needed
  Notifications.cancelScheduledNotificationAsync(`night-recap-${sessionId}`).catch(() => {});
}

/**
 * "Delete my data" (GDPR right to erasure), from the Settings screen. Stops a running
 * session, deletes everything uploaded under this phone's anonymous ID (delete_my_data RPC:
 * sessions with their minute readings, clips and ratings, live-view logs and Going out standby
 * evenings), then wipes the
 * phone's own copy and starts over with a new, unrelated ID. If the server can't be reached,
 * nothing is wiped locally, so the user can try again.
 */
export async function deleteMyData(): Promise<number> {
  if (sessionManager.isSessionActive) await stopEverything('user');
  await standby.disarm('deleted');
  const deviceId = await getDeviceId();
  await momentKeeper.deleteAll(); // audio clips, on the phone and on the server
  const { data, error } = await supabase.rpc('delete_my_data', { p_device_id: deviceId });
  if (error) throw new Error(error.message);
  await wipeLocalData();
  await resetDeviceId();
  await clearConsent();
  await clearDanceAffinity();
  await clearPromptSettings();
  await clearMomentSettings();
  await scheduleNightReminders({ ...(await getStandbySettings()).reminders, enabled: false });
  await clearStandbySettings();
  await clearEditCatalogCache();
  return typeof data === 'number' ? data : 0;
}
