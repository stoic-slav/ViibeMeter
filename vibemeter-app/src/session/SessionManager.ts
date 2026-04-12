import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { v4 as uuidv4 } from 'uuid';
import { Session, VenueType } from '../types';
import { saveSession, updateSessionEnd, getSessions } from '../storage/LocalBuffer';
import { getDeviceId } from '../storage/DeviceIdentity';
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
  ): Promise<Session> {
    if (this.activeSession) {
      console.warn(`${LOG_TAG} Session already active, ending it first`);
      await this.endSession();
    }

    const deviceId = await getDeviceId();
    const session: Session = {
      id: uuidv4(),
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
    };

    await saveSession(session);
    this.activeSession = session;
    console.log(`${LOG_TAG} Session started: ${session.id} at ${venueName ?? 'unnamed'}`);

    // Sync to Supabase (fire-and-forget, non-blocking)
    syncSessions().catch(err => console.error(`${LOG_TAG} Sync error:`, err));

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
    syncSessions().catch(err => console.error(`${LOG_TAG} Sync error:`, err));

    return ended;
  }

  async getPastSessions(): Promise<any[]> {
    return getSessions();
  }
}

// Singleton
export const sessionManager = new SessionManager();
