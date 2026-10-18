import {
  CardState, CardAction, isSupported, startCard, updateCard, endCard, activeCardCount,
  takePendingActions, addRatingListener,
} from '../../modules/live-activity';

/**
 * The lock-screen card (iOS Live Activity, `modules/live-activity` + the widget in
 * `targets/live-activity`). Three modes:
 * - session: venue, a timer, STOP, and 💀/🙂/🔥 buttons that rate without unlocking (iOS 17+),
 *   driven by VibePrompt;
 * - standby: Going out mode is listening ("Standing by", TURN OFF), driven by Standby;
 * - prompt: "Sounds like a party. Start measuring?" with Yes / Not now.
 * A standby card turns into the session card in place: iOS allows starting a card only with the
 * app in the foreground, and a session started from the prompt starts in the background.
 * Every call is a no-op where Live Activities are unavailable (Android, iOS < 16.2, or off).
 */

const LOG_TAG = '[LockScreenCard]';
// Renews the card's 15-minute stale date; a card that goes stale means the app stopped running
const HEARTBEAT_MS = 5 * 60 * 1000;
const THANKS_MS = 4000;

const EMPTY: CardState = { mode: 'session', sessionStartedAtMs: null, venue: null, due: false, lastRating: null, thanksUntilMs: null };

let state: CardState = EMPTY;
let active = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let thanksTimer: ReturnType<typeof setTimeout> | null = null;
let actionSub: { remove: () => void } | null = null;

type ActionHandler = (action: CardAction) => void;
const handlers: Partial<Record<CardAction['action'], ActionHandler>> = {};

function push(alert: { title: string; body: string } | null = null): void {
  if (!active) return;
  updateCard(state, alert).catch(err => console.warn(`${LOG_TAG} Update failed:`, err));
}

async function begin(startedAtMs: number, next: CardState): Promise<void> {
  if (!isSupported()) return;
  state = next;
  try {
    active = await startCard(startedAtMs, state);
  } catch (err) {
    console.warn(`${LOG_TAG} Start failed:`, err);
    active = false;
  }
  if (!active) return;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => push(), HEARTBEAT_MS);
}

/**
 * The session card. If a standby card is showing (the session was started from its prompt,
 * maybe in the background), that card becomes the session card instead of a new one.
 */
export async function startSessionCard(startedAt: Date, venue: string | null): Promise<void> {
  const next: CardState = { ...EMPTY, mode: 'session', sessionStartedAtMs: startedAt.getTime(), venue };
  if (active && state.mode !== 'session') {
    state = next;
    push();
    return;
  }
  await begin(startedAt.getTime(), next);
}

/** Going out standby: "Standing by". Needs the app in the foreground (iOS starts cards only then). */
export async function startStandbyCard(): Promise<void> {
  await begin(Date.now(), { ...EMPTY, mode: 'standby' });
}

/** Standby ↔ prompt. The prompt lights the screen and plays the alert sound. */
export function setStandbyCardMode(mode: 'standby' | 'prompt'): void {
  if (!active || state.mode === 'session' || state.mode === mode) return;
  state = { ...state, mode };
  push(mode === 'prompt' ? { title: 'Sounds like a party 🎶', body: 'Start measuring? Tap Yes on the card.' } : null);
}

/** Whether a card is showing, and in which mode. */
export function cardMode(): CardState['mode'] | null {
  return active ? state.mode : null;
}

export async function endCardNow(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  if (thanksTimer) clearTimeout(thanksTimer);
  heartbeat = null;
  thanksTimer = null;
  active = false;
  state = EMPTY;
  await endCard().catch(() => {});
}

/** Ends the session card (and only a session card: a standby card belongs to Standby). */
export async function endSessionCard(): Promise<void> {
  if (active && state.mode !== 'session') return;
  await endCardNow();
}

export function setCardVenue(venue: string | null): void {
  if (state.venue === venue) return;
  state = { ...state, venue };
  push();
}

/** A prompt is waiting (the card asks "How's the vibe right now?") or was answered or skipped. */
export function setCardDue(due: boolean): void {
  if (state.mode !== 'session' || state.due === due) return;
  state = { ...state, due };
  push();
}

/** A rating from anywhere (card, notification or app): "Thanks 🔥" for a few seconds. */
export function showCardThanks(rating: number): void {
  if (!active || state.mode !== 'session') return;
  state = { ...state, due: false, lastRating: rating, thanksUntilMs: Date.now() + THANKS_MS };
  push();
  if (thanksTimer) clearTimeout(thanksTimer);
  thanksTimer = setTimeout(() => {
    state = { ...state, thanksUntilMs: null };
    push();
  }, THANKS_MS);
}

/** Who handles each card button (VibePrompt: ratings; Standby: start, not now, turn off). */
export function setCardActionHandler(action: CardAction['action'], handler: ActionHandler): void {
  handlers[action] = handler;
}

/**
 * Starts handing card button taps to their handlers, including taps queued while JS was not
 * listening (the system can wake a killed app to run a button). Call once at app start, after
 * the handlers are set.
 */
export function listenForCardActions(): void {
  const drain = () => {
    for (const tap of takePendingActions()) {
      const action = tap.action ?? 'rate'; // build 23 queued ratings without an action
      const handler = handlers[action];
      if (handler) handler({ ...tap, action });
      else console.warn(`${LOG_TAG} No handler for card action ${action}`);
    }
  };
  actionSub?.remove();
  actionSub = addRatingListener(drain);
  drain();
}

/** At launch with nothing running: a card left from a killed run is removed. */
export async function endLeftoverCard(): Promise<void> {
  if (!active && activeCardCount() > 0) await endCard().catch(() => {});
}
