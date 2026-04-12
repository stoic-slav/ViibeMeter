import * as Location from 'expo-location';
import { SENSOR_CONFIG } from '../config/constants';

const LOG_TAG = '[LocationTracker]';

export interface LocationMetrics {
  gpsIsAtVenue: boolean | null;
  gpsAccuracyMeters: number | null;
}

interface VenueCoords {
  latitude: number;
  longitude: number;
}

export class LocationTracker {
  private venueCoords: VenueCoords | null = null;
  private hasPermission = false;

  async requestPermissions(): Promise<boolean> {
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      this.hasPermission = fg.status === 'granted';
      return this.hasPermission;
    } catch (err) {
      console.error(`${LOG_TAG} Permission error:`, err);
      return false;
    }
  }

  setVenueLocation(latitude: number, longitude: number): void {
    this.venueCoords = { latitude, longitude };
  }

  clearVenueLocation(): void {
    this.venueCoords = null;
  }

  /**
   * Get current location and check if user is at the venue.
   * PRIVACY: Raw GPS coordinates are NEVER uploaded. Only the boolean result is returned.
   */
  async check(): Promise<LocationMetrics> {
    if (!this.hasPermission) {
      const granted = await this.requestPermissions();
      if (!granted) return { gpsIsAtVenue: null, gpsAccuracyMeters: null };
    }

    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const accuracy = location.coords.accuracy ?? null;

      // If accuracy is worse than threshold, don't report venue check (too unreliable)
      if (accuracy != null && accuracy > SENSOR_CONFIG.GPS_ACCURACY_THRESHOLD_METERS) {
        return { gpsIsAtVenue: null, gpsAccuracyMeters: accuracy };
      }

      // On-device geofence check — raw coords never leave this function
      const isAtVenue = this.venueCoords
        ? haversineDistance(location.coords, this.venueCoords) < SENSOR_CONFIG.GPS_GEOFENCE_RADIUS_METERS
        : null;

      return {
        gpsIsAtVenue: isAtVenue,
        gpsAccuracyMeters: accuracy,
        // latitude: NEVER include
        // longitude: NEVER include
      };
    } catch (err) {
      console.error(`${LOG_TAG} Location check failed:`, err);
      return { gpsIsAtVenue: null, gpsAccuracyMeters: null };
    }
  }

  /**
   * Get a single GPS fix for recording venue location at session start.
   * PRIVACY: Coordinates stay on-device only (stored in LocationTracker state).
   */
  async captureVenueLocation(): Promise<{ latitude: number; longitude: number } | null> {
    if (!this.hasPermission) await this.requestPermissions();
    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const { latitude, longitude } = location.coords;
      this.venueCoords = { latitude, longitude };
      // Return to allow GeofenceManager to use on-device; caller must NOT upload these
      return { latitude, longitude };
    } catch (err) {
      console.error(`${LOG_TAG} Venue location capture failed:`, err);
      return null;
    }
  }
}

/**
 * Haversine distance in meters between two lat/lng points.
 */
export function haversineDistance(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const R = 6371000; // Earth radius in meters
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;

  const hav =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
}
