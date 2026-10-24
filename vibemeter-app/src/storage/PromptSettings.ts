import * as SecureStore from 'expo-secure-store';

const BUZZ_KEY = 'vibemeter_buzz_prompts';

let cachedBuzz: boolean | undefined;

/**
 * Whether the phone buzzes every 5 minutes to ask "How's the vibe right now?". Off by default
 * since build 29: the per-song 👍/👎 on the next day's recap is better research data, and the
 * Meter's rate button still works any time.
 */
export async function getBuzzPrompts(): Promise<boolean> {
  if (cachedBuzz !== undefined) return cachedBuzz;
  try {
    cachedBuzz = (await SecureStore.getItemAsync(BUZZ_KEY)) === '1';
  } catch {
    cachedBuzz = false;
  }
  return cachedBuzz;
}

export async function setBuzzPrompts(on: boolean): Promise<void> {
  cachedBuzz = on;
  try {
    await SecureStore.setItemAsync(BUZZ_KEY, on ? '1' : '0');
  } catch {
    // Keep the in-memory value for this app run
  }
}

/** After "Delete my data": back to the default (off). */
export async function clearPromptSettings(): Promise<void> {
  cachedBuzz = undefined;
  await SecureStore.deleteItemAsync(BUZZ_KEY).catch(() => {});
}
