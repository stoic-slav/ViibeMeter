import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import { Session, VenueType, PhonePlacement } from '../types';
import { saveSession, updateSessionEnd, getSessions, updateSessionEventCode } from '../storage/LocalBuffer';
import { generateGroupCode } from './GroupCode';
import { getDeviceId } from '../storage/DeviceIdentity';
import { getDanceAffinity } from '../storage/UserProfile';
import { syncSessions } from '../storage/SupabaseSync';

const LOG_TAG = '[SessionManager]';

export class SessionManager {
  private activeSession: Session | null = null;

  get currentSession(): Session | null {
    return this.activeSession;
  }

  get isSessionActive(): boolean {
    return this.activeSession != null;
  }

  async startSession(
    venueName: string | null,
    venueType: VenueType | null,
    options: { eventCode?: string | null; phonePlacement?: PhonePlacement | null } = {},
  ): Promise<Session> {
    if (this.activeSession) {
      console.warn(`${LOG_TAG} Session already active, ending it first`);
      await this.endSession();
    }

    const deviceId = await getDeviceId();
    const danceAffinity = await getDanceAffinity();
    const session: Session = {
      id: Crypto.randomUUID(),
      deviceId,
      venueName,
      venueType,
      startedAt: new Date(),
      endedAt: null,
      dwellMinutes: null,
      autoDetected: false,
      venueLatitude: null,
      venueLongitude: null,
      deviceModel: Device.modelName ?? Platform.OS,
      osVersion: `${Platform.OS} ${Platform.Version}`,
      // Every session gets a group code; friends join it by scanning its QR code
      eventCode: normalizeEventCode(options.eventCode) ?? generateGroupCode(),
      phonePlacement: options.phonePlacement ?? null,
      danceAffinity,
    };

    await saveSession(session);
    this.activeSession = session;
    console.log(`${LOG_TAG} Session started: ${session.id} at ${venueName ?? 'unnamed'}`);

    // Sync to Supabase (fire-and-forget, non-blocking)
    syncSessions().catch(err => console.warn(`${LOG_TAG} Sync error:`, err));

    return session;
  }

  async endSession(): Promise<Session | null> {
    if (!this.activeSession) {
      console.warn(`${LOG_TAG} No active session to end`);
      return null;
    }

    const endedAt = new Date();
    const dwellMinutes = Math.round(
      (endedAt.getTime() - this.activeSession.startedAt.getTime()) / 60000
    );

    await updateSessionEnd(this.activeSession.id, endedAt, dwellMinutes);

    const ended: Session = {
      ...this.activeSession,
      endedAt,
      dwellMinutes,
    };

    console.log(`${LOG_TAG} Session ended: ${ended.id}, dwell=${dwellMinutes}min`);
    this.activeSession = null;

    // Sync the update
    syncSessions().catch(err => console.warn(`${LOG_TAG} Sync error:`, err));

    return ended;
  }

  /** Move the running session into another group (after scanning a friend's code). */
  async setEventCode(code: string): Promise<void> {
    const normalized = normalizeEventCode(code);
    if (!this.activeSession || !normalized) return;
    this.activeSession = { ...this.activeSession, eventCode: normalized };
    await updateSessionEventCode(this.activeSession.id, normalized);
    syncSessions().catch(err => console.warn(`${LOG_TAG} Sync error:`, err));
  }

  async getPastSessions(): Promise<any[]> {
    return getSessions();
  }
}

/** Event codes are compared exactly server-side, so normalise case and whitespace. */
function normalizeEventCode(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return c.length > 0 ? c.slice(0, 32) : null;
}

// Singleton
export const sessionManager = new SessionManager();
