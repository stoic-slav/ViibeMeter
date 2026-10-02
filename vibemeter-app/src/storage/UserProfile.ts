import * as SecureStore from 'expo-secure-store';

const DANCE_AFFINITY_KEY = 'vibemeter_dance_affinity';

let cachedDanceAffinity: number | null | undefined;

/**
 * One-time self-report: "How much do you enjoy dancing?" (1–5).
 * Anonymous covariate — Witek et al. 2014 found dance enjoyment strongly shifts
 * groove/pleasure ratings, so analysis needs it to compare people fairly.
 */
export async function getDanceAffinity(): Promise<number | null> {
  if (cachedDanceAffinity !== undefined) return cachedDanceAffinity;
  try {
    const raw = await SecureStore.getItemAsync(DANCE_AFFINITY_KEY);
    const n = raw != null ? Number(raw) : NaN;
    cachedDanceAffinity = n >= 1 && n <= 5 ? n : null;
  } catch {
    cachedDanceAffinity = null;
  }
  return cachedDanceAffinity;
}

export async function setDanceAffinity(value: number): Promise<void> {
  cachedDanceAffinity = value;
  try {
    await SecureStore.setItemAsync(DANCE_AFFINITY_KEY, String(value));
  } catch {
    // Keep in-memory value for this app run
  }
}
