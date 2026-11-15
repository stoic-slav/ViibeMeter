import * as SecureStore from 'expo-secure-store';

const KEY = 'vibemeter_night_plan';

/** Tonight's answer to "Going out tonight?" (build 32). One per night (06:00 to 06:00). */
export interface NightPlan {
  night: string;                 // nightKey of the night it was answered for
  answer: 'yes' | 'no';
  at: number;                    // when it was answered
  late: number;                  // "Still out?" nudges scheduled
  clubs: number;                 // clubs the system is watching for arrival nudges
}

let cached: NightPlan | null | undefined;

export async function getNightPlan(): Promise<NightPlan | null> {
  if (cached !== undefined) return cached;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    cached = raw ? (JSON.parse(raw) as NightPlan) : null;
  } catch {
    cached = null;
  }
  return cached;
}

export async function saveNightPlan(plan: NightPlan): Promise<void> {
  cached = plan;
  await SecureStore.setItemAsync(KEY, JSON.stringify(plan)).catch(() => {});
}

/** After "Delete my data". */
export async function clearNightPlan(): Promise<void> {
  cached = null;
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
}
