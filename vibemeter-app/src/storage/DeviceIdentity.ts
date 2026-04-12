import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'vibemeter_device_id';

let cachedDeviceId: string | null = null;

/**
 * Returns a stable anonymous device ID. Generated once and persisted in SecureStore.
 */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = Crypto.randomUUID();
      await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
    }
    cachedDeviceId = deviceId;
    return deviceId;
  } catch (err) {
    // Fallback: in-memory only (survives session but not app restarts)
    if (!cachedDeviceId) {
      cachedDeviceId = Crypto.randomUUID();
    }
    return cachedDeviceId;
  }
}
