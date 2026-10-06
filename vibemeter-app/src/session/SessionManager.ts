import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import * as Battery from 'expo-battery';
import { Session, VenueType, PhonePlacement, EndReason, VenueSource } from '../types';
import { saveSession, updateSessionEnd, getSessions, updateSessionEventCode, updateSessionVenue } from '../storage/LocalBuffer';
import { Venue } from './VenueLocator';
import { getDraftGroupCode, clearDraftGroupCode, venueGroupCode } from './GroupCode';
import { nightBounds } from '../storage/LiveAccess';
import { getDeviceId } from '../storage/DeviceIdentity';
import { getDanceAffinity } from '../storage/UserProfile';
import { syncSessions } from '../storage/SupabaseSync';

const LOG_TAG = '[SessionManager]';

/** Where the session's group came from: its own code, a friend's, or a venue's crowd group. */
type GroupKind = 'own' | 'friend' | 'venue';

export class SessionManager {
  private activeSession: Session | null = null;
  private groupKind: GroupKind = 'own';

  get currentSession(): Session | null {
    return this.activeSession;
  }

  get isSessionActive(): boolean {
    return this.activeSession != null;
  }

  async startSession(
    venueName: string | null,
    venueType: VenueType | null,
    options: {
      eventCode?: string | null; phonePlacement?: PhonePlacement | null;
      // The confirmed venue; when the user typed their own name, venueName differs from it
      venue?: Venue | null;
      venueSource?: VenueSource;   // 'auto' (Google proposal confirmed) or 'qr' (venue code scanned)
      groupKind?: GroupKind;       // how eventCode was obtained (friend's code or a venue's crowd group)
    } = {},
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
      // Every session gets a group code (the one shown before the start, if any); friends join it
      // by scanning its QR code
      eventCode: normalizeEventCode(options.eventCode) ?? getDraftGroupCode(),
      phonePlacement: options.phonePlacement ?? null,
      danceAffinity,
      ...(await readBattery()).asStart,
      batteryEndPct: null,
      ...venueFields(venueName, options.venue ?? null, options.venueSource ?? 'auto'),
      endReason: null,
    };

    await saveSession(session);
    this.activeSession = session;
    this.groupKind = normalizeEventCode(options.eventCode) ? (options.groupKind ?? 'friend') : 'own';
    clearDraftGroupCode();
    console.log(`${LOG_TAG} Session started: ${session.id} at ${venueName ?? 'unnamed'}`);

    // Sync to Supabase (fire-and-forget, non-blocking)
    syncSessions().catch(err => console.warn(`${LOG_TAG} Sync error:`, err));

    return session;
  }

  async endSession(reason: EndReason = 'user'): Promise<Session | null> {
    if (!this.activeSession) {
      console.warn(`${LOG_TAG} No active session to end`);
      return null;
    }

    const endedAt = new Date();
    const dwellMinutes = Math.round(
      (endedAt.getTime() - this.activeSession.startedAt.getTime()) / 60000
    );

    const battery = await readBattery();
    // Low Power Mode at either end marks the session (it slows sampling down)
    const lowPowerMode = this.activeSession.lowPowerMode || battery.lowPowerMode;
    await updateSessionEnd(this.activeSession.id, endedAt, dwellMinutes, battery.pct, lowPowerMode, reason);

    const ended: Session = {
      ...this.activeSession,
      endedAt,
      dwellMinutes,
      batteryEndPct: battery.pct,
      lowPowerMode,
      endReason: reason,
    };

    console.log(`${LOG_TAG} Session ended: ${ended.id}, dwell=${dwellMinutes}min, reason=${reason}`);
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
    this.groupKind = 'friend';
    await updateSessionEventCode(this.activeSession.id, normalized);
    syncSessions().catch(err => console.warn(`${LOG_TAG} Sync error:`, err));
  }

  /**
   * A venue identified after the start (the lookup was still running, or the user had no venue
   * yet). The session keeps its first venue; later moves show up per window (venue_place_id).
   */
  async setVenueIfMissing(venue: Venue, source: 'auto' | 'qr' = 'auto'): Promise<void> {
    const s = this.activeSession;
    // A scanned venue code is authoritative and also replaces a typed name
    if (!s || s.venuePlaceId || (s.venueSource === 'manual' && source !== 'qr')) return;
    const venueName = source === 'qr' ? venue.name : (s.venueName ?? venue.name);
    this.activeSession = { ...s, venueName, venuePlaceId: venue.placeId, venueSource: source, venueDistanceM: venue.distanceM };
    await updateSessionVenue(s.id, venueName, venue.placeId, venue.distanceM, source);
    syncSessions().catch(err => console.warn(`${LOG_TAG} Sync error:`, err));
  }

  /**
   * A venue's QR code was scanned during the session: the venue is confirmed, and the phone joins
   * that venue's crowd group for tonight unless it is in a friend's group. Returns whether it
   * joined the crowd group.
   */
  async applyVenueCode(venue: Venue): Promise<boolean> {
    if (!this.activeSession) return false;
    await this.setVenueIfMissing(venue, 'qr');
    if (this.groupKind === 'friend') return false;
    const code = await venueGroupCode(venue.placeId, nightBounds().start);
    this.activeSession = { ...this.activeSession, eventCode: code };
    this.groupKind = 'venue';
    await updateSessionEventCode(this.activeSession.id, code);
    syncSessions().catch(err => console.warn(`${LOG_TAG} Sync error:`, err));
    return true;
  }

  async getPastSessions(): Promise<any[]> {
    return getSessions();
  }
}

/**
 * The auto-identified venue counts only if the user kept its name. A name they typed instead
 * (usually because the lookup found the wrong place) is "manual", with no place ID.
 */
function venueFields(
  venueName: string | null, venue: Venue | null, source: VenueSource,
): Pick<Session, 'venuePlaceId' | 'venueSource' | 'venueDistanceM'> {
  if (venue && (!venueName || venueName === venue.name)) {
    return { venuePlaceId: venue.placeId, venueSource: source, venueDistanceM: venue.distanceM };
  }
  return { venuePlaceId: null, venueSource: venueName ? 'manual' : null, venueDistanceM: null };
}

/**
 * Battery level (0–100) for the battery check: drain per hour = (start − end) / duration.
 * Null while charging (the drain would be meaningless) or when unknown (simulator: -1).
 */
async function readBattery(): Promise<{
  pct: number | null; lowPowerMode: boolean | null;
  asStart: { batteryStartPct: number | null; lowPowerMode: boolean | null };
}> {
  try {
    const [level, state, lowPowerMode] = await Promise.all([
      Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync(), Battery.isLowPowerModeEnabledAsync(),
    ]);
    const charging = state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
    const pct = level >= 0 && !charging ? Math.round(level * 1000) / 10 : null;
    return { pct, lowPowerMode, asStart: { batteryStartPct: pct, lowPowerMode } };
  } catch {
    return { pct: null, lowPowerMode: null, asStart: { batteryStartPct: null, lowPowerMode: null } };
  }
}

/** Event codes are compared exactly server-side, so normalise case and whitespace. */
function normalizeEventCode(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return c.length > 0 ? c.slice(0, 32) : null;
}

// Singleton
export const sessionManager = new SessionManager();
