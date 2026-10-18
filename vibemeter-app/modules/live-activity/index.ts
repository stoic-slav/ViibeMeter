import { requireOptionalNativeModule } from 'expo';

export interface CardState {
  venue: string | null;
  due: boolean;                 // a rating prompt is waiting
  lastRating: number | null;    // 1 / 3 / 5
  thanksUntilMs: number | null; // show "Thanks" until then
}

export interface CardRating {
  value: number;                // 1 / 3 / 5
  atMs: number;                 // when the button was tapped
}

interface LiveActivityNative {
  isSupported(): boolean;
  start(startedAtMs: number, state: CardState): Promise<boolean>;
  update(state: CardState): Promise<void>;
  end(): Promise<void>;
  activeCount(): number;
  takePendingRatings(): CardRating[];
  addListener(event: 'onRating', listener: () => void): { remove: () => void };
}

// iOS only. Null on Android and on builds made before this module existed.
const native = requireOptionalNativeModule<LiveActivityNative>('ViibeLiveActivity');

export const isLiveActivityAvailable = native != null;

export function isSupported(): boolean {
  try {
    return native?.isSupported() ?? false;
  } catch {
    return false;
  }
}

export async function startCard(startedAtMs: number, state: CardState): Promise<boolean> {
  return (await native?.start(startedAtMs, state)) ?? false;
}

export async function updateCard(state: CardState): Promise<void> {
  await native?.update(state);
}

export async function endCard(): Promise<void> {
  await native?.end();
}

export function activeCardCount(): number {
  return native?.activeCount() ?? 0;
}

export function takePendingRatings(): CardRating[] {
  return native?.takePendingRatings() ?? [];
}

/** Fires when a card button was tapped; read the taps with takePendingRatings(). */
export function addRatingListener(listener: () => void): { remove: () => void } {
  return native?.addListener('onRating', listener) ?? { remove: () => {} };
}
