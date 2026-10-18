import {
  CardState, isSupported, startCard, updateCard, endCard, activeCardCount,
  takePendingRatings, addRatingListener,
} from '../../modules/live-activity';

/**
 * The session's lock-screen card (iOS Live Activity, `modules/live-activity` + the widget in
 * `targets/live-activity`): venue, a timer, Stop, and 💀/🙂/🔥 buttons that rate without unlocking
 * (iOS 17+). It is a mirror of the session; VibePrompt drives it. Every call is a no-op where Live
 * Activities are unavailable (Android, iOS < 16.2, or turned off by the user).
 */

const LOG_TAG = '[LockScreenCard]';
// Renews the card's 15-minute stale date; a card that goes stale means the app stopped running
const HEARTBEAT_MS = 5 * 60 * 1000;
const THANKS_MS = 4000;

let state: CardState = { venue: null, due: false, lastRating: null, thanksUntilMs: null };
let active = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let thanksTimer: ReturnType<typeof setTimeout> | null = null;
let ratingSub: { remove: () => void } | null = null;

function push(): void {
  if (!active) return;
  updateCard(state).catch(err => console.warn(`${LOG_TAG} Update failed:`, err));
}

export async function startSessionCard(startedAt: Date, venue: string | null): Promise<void> {
  if (!isSupported()) return;
  state = { venue, due: false, lastRating: null, thanksUntilMs: null };
  try {
    active = await startCard(startedAt.getTime(), state);
  } catch (err) {
    console.warn(`${LOG_TAG} Start failed:`, err);
    active = false;
  }
  if (!active) return;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(push, HEARTBEAT_MS);
}

export async function endSessionCard(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  if (thanksTimer) clearTimeout(thanksTimer);
  heartbeat = null;
  thanksTimer = null;
  active = false;
  await endCard().catch(() => {});
}

export function setCardVenue(venue: string | null): void {
  if (state.venue === venue) return;
  state = { ...state, venue };
  push();
}

/** A prompt is waiting (the card asks "How's the vibe right now?") or was answered or skipped. */
export function setCardDue(due: boolean): void {
  if (state.due === due) return;
  state = { ...state, due };
  push();
}

/** A rating from anywhere (card, notification or app): "Thanks 🔥" for a few seconds. */
export function showCardThanks(rating: number): void {
  if (!active) return;
  state = { ...state, due: false, lastRating: rating, thanksUntilMs: Date.now() + THANKS_MS };
  push();
  if (thanksTimer) clearTimeout(thanksTimer);
  thanksTimer = setTimeout(() => {
    state = { ...state, thanksUntilMs: null };
    push();
  }, THANKS_MS);
}

/**
 * Hands card button taps to `onRating`, including taps queued while JS was not listening (the
 * system can wake a killed app to run the button). Call once at app start.
 */
export function listenForCardRatings(onRating: (value: number, atMs: number) => void): void {
  const drain = () => {
    for (const tap of takePendingRatings()) {
      if (tap.value === 1 || tap.value === 3 || tap.value === 5) onRating(tap.value, tap.atMs);
    }
  };
  ratingSub?.remove();
  ratingSub = addRatingListener(drain);
  drain();
}

/** At launch with no session running: a card left from a killed run is removed. */
export async function endLeftoverCard(): Promise<void> {
  if (!active && activeCardCount() > 0) await endCard().catch(() => {});
}
