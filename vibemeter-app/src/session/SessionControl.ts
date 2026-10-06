import * as Notifications from 'expo-notifications';
import { EndReason, Session } from '../types';
import { sessionManager } from './SessionManager';
import { sensorOrchestrator } from '../sensors/SensorOrchestrator';
import { vibePrompt } from '../notifications/VibePrompt';
import { confirmVenue } from './VenueLocator';

/**
 * The one way a session ends, from the Stop button or an auto-stop rule (no music for 20 min,
 * 8 h, low battery), so both turn off the same things in the same order.
 */

const listeners = new Set<(session: Session | null, reason: EndReason) => void>();

const AUTO_STOP_TEXT: Record<Exclude<EndReason, 'user'>, string> = {
  no_music: 'No music for a while, so your session ended. Start a new one at the next place.',
  max_duration: 'Your session ran for 8 hours, so it ended.',
  low_battery: 'Your battery is low, so your session ended to save it.',
};

export async function stopEverything(reason: EndReason = 'user'): Promise<Session | null> {
  if (!sessionManager.isSessionActive) return null;
  const session = await sessionManager.endSession(reason);
  await sensorOrchestrator.stopSession();
  vibePrompt.stopPromptSchedule();
  if (reason !== 'user') {
    Notifications.scheduleNotificationAsync({
      content: { title: 'Viibe Check stopped', body: AUTO_STOP_TEXT[reason] },
      trigger: null,
    }).catch(() => {});
  }
  listeners.forEach(l => l(session, reason));
  return session;
}

/** An open screen hears about a session that ended without the Stop button. */
export function onSessionEnded(listener: (session: Session | null, reason: EndReason) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

sensorOrchestrator.setAutoStopHandler(reason => {
  stopEverything(reason).catch(err => console.warn('[SessionControl] Auto-stop failed:', err));
});
// A venue found during the session is linked only after the user confirms it
sensorOrchestrator.setVenueProposalHandler(async venue => {
  const yes = await confirmVenue(venue);
  if (yes) await sessionManager.setVenueIfMissing(venue).catch(() => {});
  return yes;
});
