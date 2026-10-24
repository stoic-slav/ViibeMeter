import * as SecureStore from 'expo-secure-store';

const KEY = 'vibemeter_moments';

/**
 * Two separate, off-by-default choices about "best moments" (short audio clips of the person's
 * strongest dancing). They are not part of the main consent (changing that asks everyone again):
 * - keep: clips stay on the phone, about 14 days, out of backups, never uploaded;
 * - share: on top of keep, the clips are sent to us (private storage, 30 days) so the audio
 *   cleaning can be compared and several phones' clips merged. Needs keep.
 */
export interface MomentSettings {
  keepAcceptedAt: number | null;
  shareAcceptedAt: number | null;
}

const OFF: MomentSettings = { keepAcceptedAt: null, shareAcceptedAt: null };
let cached: MomentSettings | undefined;

export async function getMomentSettings(): Promise<MomentSettings> {
  if (cached) return cached;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    cached = raw ? { ...OFF, ...JSON.parse(raw) } : OFF;
  } catch {
    cached = OFF;
  }
  return cached!;
}

/** Synchronous view for the sensor loop; off until getMomentSettings() has run. */
export function momentsEnabled(): { keep: boolean; share: boolean } {
  return { keep: cached?.keepAcceptedAt != null, share: cached?.keepAcceptedAt != null && cached?.shareAcceptedAt != null };
}

export async function saveMomentSettings(patch: Partial<MomentSettings>): Promise<MomentSettings> {
  const next = { ...(await getMomentSettings()), ...patch };
  // Sharing needs keeping: turning keep off turns share off
  if (next.keepAcceptedAt == null) next.shareAcceptedAt = null;
  cached = next;
  await SecureStore.setItemAsync(KEY, JSON.stringify(next)).catch(() => {});
  return next;
}

/** After "Delete my data": both back to off. */
export async function clearMomentSettings(): Promise<void> {
  cached = OFF;
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
}
