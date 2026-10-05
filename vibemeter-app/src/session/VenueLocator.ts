import * as Location from 'expo-location';
import { supabase } from '../config/supabase';

const LOG_TAG = '[VenueLocator]';
const TIMEOUT_MS = 8000;
const LAST_KNOWN_MAX_AGE_MS = 120_000;

export interface Venue {
  placeId: string;
  name: string;
  distanceM: number | null;
}

/**
 * Which club (or else bar) the phone is in. One position fix, rounded to ~11 m, goes to the
 * identify-venue Edge Function, which asks Google Maps for the closest night club within 150 m,
 * then the closest bar or pub. The position is discarded straight away: only the place is kept.
 * Location is "While Using" only; there is no background location.
 */
export class VenueLocator {
  private last: Venue | null = null;
  private lastCheckAt = 0;
  private inFlight: Promise<Venue | null | undefined> | null = null;

  /** The venue from the latest successful lookup (null: none found nearby). */
  get current(): Venue | null { return this.last; }

  /** Milliseconds since the last lookup attempt. */
  get msSinceCheck(): number { return Date.now() - this.lastCheckAt; }

  /**
   * Look the venue up now. Resolves to the venue, null when no club or bar is nearby, or
   * undefined when the lookup could not run (no permission, no fix, offline, not configured).
   */
  identify(): Promise<Venue | null | undefined> {
    if (!this.inFlight) {
      this.inFlight = withTimeout(this.lookup(), TIMEOUT_MS)
        .catch(err => { console.warn(`${LOG_TAG} Lookup failed:`, err?.message ?? err); return undefined; })
        .finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async lookup(): Promise<Venue | null | undefined> {
    this.lastCheckAt = Date.now();
    const perm = await Location.getForegroundPermissionsAsync();
    const granted = perm.granted || (perm.canAskAgain && (await Location.requestForegroundPermissionsAsync()).granted);
    if (!granted) return undefined;

    const recent = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
    const pos = recent ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    if (!pos) return undefined;
    // ~11 m: enough to find the building, no finer
    const lat = Math.round(pos.coords.latitude * 1e4) / 1e4;
    const lng = Math.round(pos.coords.longitude * 1e4) / 1e4;

    const { data, error } = await supabase.functions.invoke('identify-venue', { body: { lat, lng } });
    if (error) throw error;
    this.last = data?.placeId
      ? { placeId: data.placeId, name: data.name ?? 'Unknown venue', distanceM: data.distanceM ?? null }
      : null;
    console.log(`${LOG_TAG} Venue: ${this.last ? `${this.last.name} (${this.last.distanceM} m)` : 'none nearby'}`);
    return this.last;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

export const venueLocator = new VenueLocator();
