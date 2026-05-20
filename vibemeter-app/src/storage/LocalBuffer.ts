import * as SQLite from 'expo-sqlite';
import { SensorWindow, Session, SubjectiveRating } from '../types';

let db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync('vibemeter.db');
  await initSchema(db);
  return db;
}

async function initSchema(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      venue_name TEXT,
      venue_type TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      dwell_minutes INTEGER,
      auto_detected INTEGER DEFAULT 0,
      venue_latitude REAL,
      venue_longitude REAL,
      device_model TEXT,
      os_version TEXT,
      synced INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS sensor_windows (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      avg_db REAL,
      max_db REAL,
      db_variance REAL,
      music_detected INTEGER,
      estimated_bpm INTEGER,
      audio_classification TEXT,
      bass_presence REAL,
      mid_high_ratio REAL,
      sub_bass_energy REAL,
      spectral_centroid REAL,
      spectral_flux REAL,
      crest_factor REAL,
      vocal_presence REAL,
      harmonic_noise_ratio REAL,
      accel_magnitude_avg REAL,
      accel_magnitude_max REAL,
      accel_variance REAL,
      gyro_activity_avg REAL,
      gyro_activity_max REAL,
      movement_classification TEXT,
      ble_device_count INTEGER,
      ble_count_delta INTEGER,
      ble_count_trend TEXT,
      gps_is_at_venue INTEGER,
      gps_accuracy_meters REAL,
      screen_off_ratio REAL,
      camera_activations INTEGER,
      computed_energy_score REAL,
      computed_density_score REAL,
      computed_movement_score REAL,
      computed_music_score REAL,
      computed_vibe_score REAL,
      synced INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS subjective_ratings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      music_rating INTEGER,
      crowd_rating INTEGER,
      rated_at INTEGER NOT NULL,
      nearest_window_id TEXT,
      response_time_ms INTEGER,
      synced INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sw_session ON sensor_windows(session_id, window_start);
    CREATE INDEX IF NOT EXISTS idx_sw_synced ON sensor_windows(synced);
    CREATE INDEX IF NOT EXISTS idx_sr_session ON subjective_ratings(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_synced ON sessions(synced);
  `);
  // Migrate existing DBs that predate multi-dimension ratings
  for (const col of ['music_rating', 'crowd_rating']) {
    await database.runAsync(`ALTER TABLE subjective_ratings ADD COLUMN IF NOT EXISTS ${col} INTEGER`).catch(() => {});
  }
  // Migrate existing DBs that predate FFT spectral metrics
  for (const col of ['sub_bass_energy', 'spectral_centroid', 'spectral_flux', 'crest_factor', 'vocal_presence', 'harmonic_noise_ratio']) {
    await database.runAsync(`ALTER TABLE sensor_windows ADD COLUMN IF NOT EXISTS ${col} REAL`).catch(() => {});
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function saveSession(session: Session): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR REPLACE INTO sessions
      (id, device_id, venue_name, venue_type, started_at, ended_at, dwell_minutes,
       auto_detected, venue_latitude, venue_longitude, device_model, os_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.deviceId,
      session.venueName,
      session.venueType,
      session.startedAt.getTime(),
      session.endedAt?.getTime() ?? null,
      session.dwellMinutes,
      session.autoDetected ? 1 : 0,
      session.venueLatitude,
      session.venueLongitude,
      session.deviceModel,
      session.osVersion,
    ]
  );
}

export async function updateSessionEnd(
  sessionId: string,
  endedAt: Date,
  dwellMinutes: number
): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `UPDATE sessions SET ended_at = ?, dwell_minutes = ?, synced = 0 WHERE id = ?`,
    [endedAt.getTime(), dwellMinutes, sessionId]
  );
}

export async function getSessions(): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(
    `SELECT * FROM sessions ORDER BY started_at DESC`
  );
}

export async function getUnsyncedSessions(): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(`SELECT * FROM sessions WHERE synced = 0`);
}

export async function markSessionSynced(id: string): Promise<void> {
  const database = await getDb();
  await database.runAsync(`UPDATE sessions SET synced = 1 WHERE id = ?`, [id]);
}

// ── Sensor Windows ────────────────────────────────────────────────────────────

export async function saveSensorWindow(w: SensorWindow): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR REPLACE INTO sensor_windows
      (id, session_id, window_start, window_end,
       avg_db, max_db, db_variance, music_detected, estimated_bpm,
       audio_classification, bass_presence, mid_high_ratio,
       sub_bass_energy, spectral_centroid, spectral_flux, crest_factor, vocal_presence, harmonic_noise_ratio,
       accel_magnitude_avg, accel_magnitude_max, accel_variance,
       gyro_activity_avg, gyro_activity_max, movement_classification,
       ble_device_count, ble_count_delta, ble_count_trend,
       gps_is_at_venue, gps_accuracy_meters, screen_off_ratio, camera_activations,
       computed_energy_score, computed_density_score, computed_movement_score,
       computed_music_score, computed_vibe_score)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      w.id, w.sessionId, w.windowStart.getTime(), w.windowEnd.getTime(),
      w.avgDb, w.maxDb, w.dbVariance,
      w.musicDetected == null ? null : (w.musicDetected ? 1 : 0),
      w.estimatedBpm, w.audioClassification, w.bassPresence, w.midHighRatio,
      w.subBassEnergy, w.spectralCentroid, w.spectralFlux, w.crestFactor, w.vocalPresence, w.harmonicNoiseRatio,
      w.accelMagnitudeAvg, w.accelMagnitudeMax, w.accelVariance,
      w.gyroActivityAvg, w.gyroActivityMax, w.movementClassification,
      w.bleDeviceCount, w.bleCountDelta, w.bleCountTrend,
      w.gpsIsAtVenue == null ? null : (w.gpsIsAtVenue ? 1 : 0),
      w.gpsAccuracyMeters, w.screenOffRatio, w.cameraActivations,
      w.computedEnergyScore, w.computedDensityScore, w.computedMovementScore,
      w.computedMusicScore, w.computedVibeScore,
    ]
  );
}

export async function getUnsyncedWindows(limit = 100): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(
    `SELECT * FROM sensor_windows WHERE synced = 0 ORDER BY window_start ASC LIMIT ?`,
    [limit]
  );
}

export async function getWindowsForSession(sessionId: string): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(
    `SELECT * FROM sensor_windows WHERE session_id = ? ORDER BY window_start ASC`,
    [sessionId]
  );
}

export async function markWindowsSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await database.runAsync(
    `UPDATE sensor_windows SET synced = 1 WHERE id IN (${placeholders})`,
    ids
  );
}

export async function getNearestWindowId(sessionId: string, timestamp: Date): Promise<string | null> {
  const database = await getDb();
  const ts = timestamp.getTime();
  const row = await database.getFirstAsync<{ id: string }>(
    `SELECT id FROM sensor_windows
     WHERE session_id = ?
     ORDER BY ABS(window_start - ?) ASC
     LIMIT 1`,
    [sessionId, ts]
  );
  return row?.id ?? null;
}

export async function deleteOldSyncedWindows(olderThanMs: number = 86400000): Promise<void> {
  const database = await getDb();
  const cutoff = Date.now() - olderThanMs;
  await database.runAsync(
    `DELETE FROM sensor_windows WHERE synced = 1 AND window_start < ?`,
    [cutoff]
  );
}

// ── Subjective Ratings ────────────────────────────────────────────────────────

export async function saveRating(rating: SubjectiveRating): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR REPLACE INTO subjective_ratings
      (id, session_id, device_id, rating, music_rating, crowd_rating, rated_at, nearest_window_id, response_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rating.id,
      rating.sessionId,
      rating.deviceId,
      rating.rating,
      rating.musicRating ?? null,
      rating.crowdRating ?? null,
      rating.ratedAt.getTime(),
      rating.nearestWindowId,
      rating.responseTimeMs,
    ]
  );
}

export async function getRecentVenues(limit = 3): Promise<string[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<{ venue_name: string }>(
    `SELECT DISTINCT venue_name FROM sessions
     WHERE venue_name IS NOT NULL AND venue_name != '' AND ended_at IS NOT NULL
     ORDER BY started_at DESC LIMIT ?`,
    [limit]
  );
  return rows.map(r => r.venue_name);
}

export async function getUnsyncedRatings(): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(`SELECT * FROM subjective_ratings WHERE synced = 0`);
}

export async function getRatingsForSession(sessionId: string): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(
    `SELECT * FROM subjective_ratings WHERE session_id = ? ORDER BY rated_at ASC`,
    [sessionId]
  );
}

export async function markRatingsSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await database.runAsync(
    `UPDATE subjective_ratings SET synced = 1 WHERE id IN (${placeholders})`,
    ids
  );
}
