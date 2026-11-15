import * as Notifications from 'expo-notifications';
import { EndReason, Session } from '../types';
import { sessionManager } from './SessionManager';
import { sensorOrchestrator } from '../sensors/SensorOrchestrator';
import { vibePrompt } from '../notifications/VibePrompt';
import { momentKeeper } from './MomentKeeper';
import { confirmVenue } from './VenueLocator';
import { ScanResult, setPendingGroupCode, setPendingVenue } from './GroupCode';
import { onSessionFinished } from './NightRecapService';
import { refreshEditCatalog } from './EditCatalog';
import { Audio } from 'expo-av';
import { getConsent } from '../storage/Consent';

/**
 * The one way a session ends, from the Stop button or an auto-stop rule (no music for 20 min,
 * 8 h, low battery), so both turn off the same things in the same order.
 */

const listeners = new Set<(session: Session | null, reason: EndReason) => void>();
const startListeners = new Set<(session: Session) => void>();

const AUTO_STOP_TEXT: Record<Exclude<EndReason, 'user' | 'interrupted'>, string> = {
  no_music: 'No music for a while, so your session ended. Start a new one at the next place.',
  max_duration: 'Your session ran for 8 hours, so it ended.',
  low_battery: 'Your battery is low, so your session ended to save it.',
};

export async function stopEverything(reason: EndReason = 'user'): Promise<Session | null> {
  if (!sessionManager.isSessionActive) return null;
  const session = await sessionManager.endSession(reason);
  await sensorOrchestrator.stopSession();
  vibePrompt.stopPromptSchedule();
  if (reason !== 'user' && reason !== 'interrupted') {
    Notifications.scheduleNotificationAsync({
      content: { title: 'Viibe Check stopped', body: AUTO_STOP_TEXT[reason] },
      trigger: null,
    }).catch(() => {});
  }
  // "Your night in songs" is built now (the clips are on the phone) and announced at 12:00
  if (session?.endedAt) onSessionFinished(session.id, session.endedAt).catch(() => {});
  // Best moments (opt-in): clean the clips, send them if allowed. Runs while the app is open.
  momentKeeper.processPending().catch(() => {});
  listeners.forEach(l => l(session, reason));
  return session;
}

/** Going out standby hears about any session start (by hand or from its prompt). */
export function onSessionStarted(listener: (session: Session) => void): () => void {
  startListeners.add(listener);
  return () => startListeners.delete(listener);
}

/** Called by whoever started a session, after its sensors and prompts run. */
export function notifySessionStarted(session: Session): void {
  // The DJ edit catalog, so unknown music can still be credited during this session
  refreshEditCatalog().catch(() => {});
  startListeners.forEach(l => l(session));
}

/**
 * "Yes, start" on a Going out prompt, usually with the phone locked: a session with no venue
 * (no location in the background; asked when the app is next opened) that reuses the standby's
 * open microphone and turns the standby card into the session card.
 */
export async function startSessionFromStandby(): Promise<Session> {
  const session = await sessionManager.startSession(null, null, { startSource: 'standby' });
  await sensorOrchestrator.startSession(session);
  vibePrompt.startPromptSchedule(session.id, { startedAt: session.startedAt, venue: null });
  notifySessionStarted(session);
  return session;
}

/**
 * The one tap from a nudge notification (build 32): starts a session at once with no screens. The
 * club comes from an arrival notification (tapping Start confirms it) or is left empty to be filled
 * in afterwards; the phone is assumed to be in a pocket. Says what is missing instead of starting
 * when the first-time agreement or the microphone permission isn't there yet.
 */
export async function expressStart(venue: { placeId: string; name: string } | null): Promise<'started' | 'already' | 'needs_consent' | 'needs_mic' | 'error'> {
  if (sessionManager.isSessionActive) return 'already';
  if (!(await getConsent())) return 'needs_consent';
  const mic = await Audio.requestPermissionsAsync().catch(() => null);
  if (!mic?.granted) return 'needs_mic';
  try {
    const v = venue ? { placeId: venue.placeId, name: venue.name, distanceM: null } : null;
    const session = await sessionManager.startSession(v?.name ?? null, null, {
      venue: v, venueSource: 'auto', phonePlacement: 'pocket', startSource: 'nudge',
    });
    await sensorOrchestrator.startSession(session);
    vibePrompt.startPromptSchedule(session.id, { startedAt: session.startedAt, venue: session.venueName });
    notifySessionStarted(session);
    return 'started';
  } catch (err) {
    console.warn('[SessionControl] Express start failed:', err);
    return 'error';
  }
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

/**
 * A scanned QR code or opened join link, during a session or before one. A friend's code joins
 * their group; a venue code confirms the venue and joins the venue's crowd group for tonight
 * (unless the phone is in a friend's group). Returns a short message for the user.
 */
export async function applyScan(scan: ScanResult): Promise<string> {
  if (scan.kind === 'group') {
    if (sessionManager.isSessionActive) {
      await sessionManager.setEventCode(scan.code);
      return `This session is now in group ${scan.code}.`;
    }
    setPendingGroupCode(scan.code);
    return `You'll join group ${scan.code} when you start.`;
  }
  const venue = { placeId: scan.placeId, name: scan.name, distanceM: null };
  if (sessionManager.isSessionActive) {
    const joined = await sessionManager.applyVenueCode(venue);
    sensorOrchestrator.setConfirmedVenue(venue);
    return joined ? `📍 You're at ${venue.name}. Joined tonight's crowd there.` : `📍 You're at ${venue.name}. You stay in your friends' group.`;
  }
  setPendingVenue(venue);
  return `📍 You're at ${venue.name}. It's set for your session.`;
}
