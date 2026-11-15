import { requireOptionalNativeModule } from 'expo';

export interface ArrivalRegion {
  id: string;        // Google place ID
  name: string;      // the club's name, handed back when the notification is tapped
  lat: number;
  lng: number;
  title: string;     // the notification's title, e.g. "At C12?"
  body: string;
}

interface ArrivalNudgeNative {
  schedule(regions: ArrivalRegion[], radiusM: number, category: string): Promise<number>;
  cancelAll(): Promise<void>;
  pendingCount(): Promise<number>;
}

// iOS only. Null on Android and on builds made before this module existed.
const native = requireOptionalNativeModule<ArrivalNudgeNative>('ViibeArrivalNudge');

export const isArrivalNudgeAvailable = native != null;

/** Replaces the pending arrival nudges; returns how many the system accepted. */
export async function scheduleArrivalNudges(regions: ArrivalRegion[], radiusM: number, category: string): Promise<number> {
  try {
    return (await native?.schedule(regions, radiusM, category)) ?? 0;
  } catch {
    return 0;
  }
}

export async function cancelArrivalNudges(): Promise<void> {
  try { await native?.cancelAll(); } catch {}
}

export async function pendingArrivalNudges(): Promise<number> {
  try { return (await native?.pendingCount()) ?? 0; } catch { return 0; }
}
