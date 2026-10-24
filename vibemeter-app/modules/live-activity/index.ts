import { requireOptionalNativeModule } from 'expo';

export type CardMode = 'session' | 'standby' | 'prompt';

export interface CardState {
  mode: CardMode;               // session, Going out standby, or the standby prompt
  sessionStartedAtMs: number | null; // the session timer counts from here
  venue: string | null;
  song: string | null;          // the song heard now ("Title - Artist"), null while listening
}

/** Lights the screen and plays the alert sound with an update. */
export interface CardAlert {
  title: string;
  body: string;
}

/** A tap on a card button: a Going out action. */
export interface CardAction {
  action: 'start' | 'not_now' | 'standby_off';
  atMs: number;                 // when the button was tapped
}

interface LiveActivityNative {
  isSupported(): boolean;
  start(startedAtMs: number, state: CardState): Promise<boolean>;
  update(state: CardState, alert: CardAlert | null): Promise<void>;
  end(): Promise<void>;
  activeCount(): number;
  takePendingActions(): CardAction[];
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

export async function updateCard(state: CardState, alert: CardAlert | null = null): Promise<void> {
  await native?.update(state, alert);
}

export async function endCard(): Promise<void> {
  await native?.end();
}

export function activeCardCount(): number {
  return native?.activeCount() ?? 0;
}

export function takePendingActions(): CardAction[] {
  return native?.takePendingActions() ?? [];
}

/** Fires when a card button was tapped; read the taps with takePendingActions(). */
export function addRatingListener(listener: () => void): { remove: () => void } {
  return native?.addListener('onRating', listener) ?? { remove: () => {} };
}
