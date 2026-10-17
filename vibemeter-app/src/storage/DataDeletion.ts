import { supabase } from '../config/supabase';
import { sessionManager } from '../session/SessionManager';
import { stopEverything } from '../session/SessionControl';
import { getDeviceId, resetDeviceId } from './DeviceIdentity';
import { wipeLocalData } from './LocalBuffer';
import { clearConsent } from './Consent';
import { clearDanceAffinity } from './UserProfile';

/**
 * "Delete my data" (GDPR right to erasure), from the Privacy & data screen. Stops a running
 * session, deletes everything uploaded under this phone's anonymous ID (delete_my_data RPC:
 * sessions with their minute readings, clips and ratings, and live-view logs), then wipes the
 * phone's own copy and starts over with a new, unrelated ID. If the server can't be reached,
 * nothing is wiped locally, so the user can try again.
 */
export async function deleteMyData(): Promise<number> {
  if (sessionManager.isSessionActive) await stopEverything('user');
  const deviceId = await getDeviceId();
  const { data, error } = await supabase.rpc('delete_my_data', { p_device_id: deviceId });
  if (error) throw new Error(error.message);
  await wipeLocalData();
  await resetDeviceId();
  await clearConsent();
  await clearDanceAffinity();
  return typeof data === 'number' ? data : 0;
}
