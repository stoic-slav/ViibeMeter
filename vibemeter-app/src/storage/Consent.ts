import * as SecureStore from 'expo-secure-store';

/**
 * The user's consent (GDPR): given once on the first start, per sensor, and changeable or
 * withdrawable at any time on the Settings screen. The microphone is required (on iPhone
 * the open mic is what keeps a session measuring with the phone locked); motion, Bluetooth and
 * location are optional and each sensor is skipped when it is switched off.
 *
 * Bump CONSENT_VERSION when what is collected changes: everyone is then asked again.
 */
export const CONSENT_VERSION = 1;
const KEY = 'viibe_consent';

export interface Consent {
  version: number;
  acceptedAt: number;   // ms
  adult: true;          // confirmed 18 or older
  motion: boolean;
  bluetooth: boolean;
  location: boolean;
}

let cached: Consent | null = null;

/** The consent in force, or null when none was given (or it was for an older version). */
export async function getConsent(): Promise<Consent | null> {
  if (cached) return cached;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const c = raw ? (JSON.parse(raw) as Consent) : null;
    cached = c && c.version === CONSENT_VERSION && c.adult ? c : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Synchronous view for the sensor loop; false until getConsent() has run. */
export function sensorAllowed(sensor: 'motion' | 'bluetooth' | 'location'): boolean {
  return cached ? cached[sensor] : false;
}

export async function saveConsent(c: Omit<Consent, 'version' | 'acceptedAt' | 'adult'>): Promise<Consent> {
  const consent: Consent = { ...c, version: CONSENT_VERSION, acceptedAt: Date.now(), adult: true };
  await SecureStore.setItemAsync(KEY, JSON.stringify(consent));
  cached = consent;
  return consent;
}

export async function clearConsent(): Promise<void> {
  cached = null;
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
}

/** Sensors allowed for a session, as stored with it: 'mic,motion,ble,loc'. */
export function sensorsLabel(c: Consent): string {
  return ['mic', c.motion && 'motion', c.bluetooth && 'ble', c.location && 'loc'].filter(Boolean).join(',');
}
