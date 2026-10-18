import * as SecureStore from 'expo-secure-store';
import { NIGHT_REMINDER } from '../config/constants';

/**
 * Going out mode settings (iOS, build 24): the user's separate opt-in to standby listening, and
 * the weekend-night reminder. Kept apart from Consent.ts so that turning a sensor on or off there
 * never resets this, and nobody re-consents for a feature they don't use.
 */

const KEY = 'vibemeter_standby_settings';

export interface NightReminderSettings {
  enabled: boolean;
  weekdays: number[];   // 1 = Sunday … 7 = Saturday
  hour: number;
  minute: number;
}

export interface StandbySettings {
  acceptedAt: number | null;          // when the user agreed to standby listening
  reminders: NightReminderSettings;
}

const DEFAULTS: StandbySettings = {
  acceptedAt: null,
  reminders: {
    enabled: false,
    weekdays: [...NIGHT_REMINDER.DEFAULT_WEEKDAYS],
    hour: NIGHT_REMINDER.DEFAULT_HOUR,
    minute: NIGHT_REMINDER.DEFAULT_MINUTE,
  },
};

let cached: StandbySettings | null = null;

export async function getStandbySettings(): Promise<StandbySettings> {
  if (cached) return cached;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    cached = { ...DEFAULTS, ...parsed, reminders: { ...DEFAULTS.reminders, ...(parsed.reminders ?? {}) } };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached!;
}

export async function saveStandbySettings(change: Partial<StandbySettings>): Promise<StandbySettings> {
  const current = await getStandbySettings();
  cached = { ...current, ...change, reminders: { ...current.reminders, ...(change.reminders ?? {}) } };
  await SecureStore.setItemAsync(KEY, JSON.stringify(cached)).catch(() => {});
  return cached;
}

/** After "Delete my data". */
export async function clearStandbySettings(): Promise<void> {
  cached = null;
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
}
