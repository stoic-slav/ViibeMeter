import * as SQLite from 'expo-sqlite';
import { SensorWindow, SensorClip, Session, SubjectiveRating, EndReason, StandbyNight } from '../types';

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
      event_code TEXT,
      phone_placement TEXT,
      dance_affinity INTEGER,
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
      movement_energy REAL,
      movement_bpm REAL,
      rhythmicity REAL,
      movement_axis TEXT,
      beat_plv REAL,
      beat_phase_mean REAL,
      tempo_match REAL,
      pulse_clarity REAL,
      song_isrc TEXT,
      song_genre TEXT,
      song_bpm REAL,
      song_popularity INTEGER,
      recognition_source TEXT,
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

    CREATE TABLE IF NOT EXISTS sensor_clips (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      clip_start INTEGER NOT NULL,
      beat_plv REAL,
      beat_phase_clock REAL,
      movement_energy REAL,
      movement_bpm REAL,
      song_isrc TEXT,
      synced INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sc_synced ON sensor_clips(synced, clip_start);

    -- The night's recognised songs, for the recap. Phone only: titles are never uploaded
    CREATE TABLE IF NOT EXISTS night_songs (
      session_id TEXT NOT NULL,
      isrc TEXT NOT NULL,
      title TEXT,
      artist TEXT,
      apple_music_id TEXT,
      genre TEXT,
      first_heard_ms INTEGER NOT NULL,
      last_heard_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, isrc)
    );

    -- Known DJ edits heard during the session (catalog matches), for the recap (phone only)
    CREATE TABLE IF NOT EXISTS night_edits (
      session_id TEXT NOT NULL,
      edit_id TEXT NOT NULL,
      dj TEXT,
      title TEXT,
      first_heard_ms INTEGER NOT NULL,
      last_heard_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, edit_id)
    );

    -- Fingerprints of music Shazam couldn't name, to learn DJ edits (uploaded, then deleted)
    CREATE TABLE IF NOT EXISTS edit_prints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      signature TEXT NOT NULL,
      synced INTEGER DEFAULT 0
    );

    -- "Your night in songs", computed when the session ends (phone only)
    CREATE TABLE IF NOT EXISTS night_recaps (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      recap TEXT NOT NULL
    );

    -- 👍/👎 per recap entry (uploaded, without titles)
    CREATE TABLE IF NOT EXISTS song_feedback (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      isrc TEXT,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      score REAL NOT NULL,
      liked INTEGER NOT NULL,
      dj_name TEXT,
      created_at INTEGER NOT NULL,
      synced INTEGER DEFAULT 0
    );

    -- "Best moments": short audio clips of the person's strongest dancing (opt-in; the audio files
    -- live in the app's own folder, this row says where; titles stay on the phone)
    CREATE TABLE IF NOT EXISTS moments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      score REAL NOT NULL,
      song_isrc TEXT,
      song_title TEXT,
      song_artist TEXT,
      bass_share REAL,
      rustle_share REAL,
      avg_db REAL,
      event_code TEXT,
      venue_place_id TEXT,
      raw_path TEXT NOT NULL,
      clean_path TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      shared_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_moments_session ON moments(session_id);

    CREATE TABLE IF NOT EXISTS standby_nights (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      armed_at INTEGER NOT NULL,
      ended_at INTEGER,
      end_reason TEXT,
      prompts INTEGER DEFAULT 0,
      accepted INTEGER DEFAULT 0,
      declined INTEGER DEFAULT 0,
      ignored INTEGER DEFAULT 0,
      checks INTEGER DEFAULT 0,
      music_minutes INTEGER DEFAULT 0,
      moving_minutes INTEGER DEFAULT 0,
      party_minutes INTEGER DEFAULT 0,
      battery_start_pct REAL,
      battery_end_pct REAL,
      synced INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sw_session ON sensor_windows(session_id, window_start);
    CREATE INDEX IF NOT EXISTS idx_sw_synced ON sensor_windows(synced);
    CREATE INDEX IF NOT EXISTS idx_sr_session ON subjective_ratings(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_synced ON sessions(synced);
  `);
  // Migrate existing DBs. SQLite has no "ADD COLUMN IF NOT EXISTS", so add each column
  // and ignore the "duplicate column" error when it already exists.
  const migrations: [table: string, column: string, type: string][] = [
    // multi-dimension ratings
    ['subjective_ratings', 'music_rating', 'INTEGER'],
    ['subjective_ratings', 'crowd_rating', 'INTEGER'],
    ['subjective_ratings', 'rating_scale', 'INTEGER'],
    ['subjective_ratings', 'rating_source', 'TEXT'],
    // FFT spectral metrics
    ...['sub_bass_energy', 'spectral_centroid', 'spectral_flux', 'crest_factor', 'vocal_presence', 'harmonic_noise_ratio']
      .map(c => ['sensor_windows', c, 'REAL'] as [string, string, string]),
    // movement energy + beat sync
    ...['movement_energy', 'movement_bpm', 'rhythmicity', 'beat_plv', 'beat_phase_mean', 'tempo_match', 'pulse_clarity']
      .map(c => ['sensor_windows', c, 'REAL'] as [string, string, string]),
    ['sensor_windows', 'movement_axis', 'TEXT'],
    // recognized track descriptors
    ['sensor_windows', 'song_isrc', 'TEXT'],
    ['sensor_windows', 'song_genre', 'TEXT'],
    ['sensor_windows', 'song_bpm', 'REAL'],
    ['sensor_windows', 'song_popularity', 'INTEGER'],
    ['sensor_windows', 'recognition_source', 'TEXT'],
    ['sensor_windows', 'beat_phase_clock', 'REAL'],
    ['sensor_windows', 'song_start_ms', 'REAL'],
    ['sensor_windows', 'song_start_spread_ms', 'REAL'],
    ['sensor_windows', 'song_bpm_source', 'TEXT'],
    ['sensor_windows', 'bass_envelope', 'TEXT'],
    // session covariates for crowd sync
    ['sessions', 'event_code', 'TEXT'],
    ['sessions', 'phone_placement', 'TEXT'],
    ['sessions', 'dance_affinity', 'INTEGER'],
    // battery check
    ['sessions', 'battery_start_pct', 'REAL'],
    ['sessions', 'battery_end_pct', 'REAL'],
    ['sessions', 'low_power_mode', 'INTEGER'],
    // venue identification, auto-stop, phone context
    ['sessions', 'venue_place_id', 'TEXT'],
    ['sessions', 'venue_source', 'TEXT'],
    ['sessions', 'venue_distance_m', 'REAL'],
    ['sessions', 'end_reason', 'TEXT'],
    ['sensor_windows', 'venue_place_id', 'TEXT'],
    ['sensor_windows', 'phone_context', 'TEXT'],
    ['sensor_windows', 'on_body_share', 'REAL'],
    ['sensor_clips', 'phone_context', 'TEXT'],
    // consent recorded per session
    ['sessions', 'consent_version', 'INTEGER'],
    ['sessions', 'sensors', 'TEXT'],
    // build 23: lock-screen card ratings can be unprompted
    ['subjective_ratings', 'prompted', 'INTEGER'],
    // build 24: sessions started from a Going out prompt
    ['sessions', 'start_source', 'TEXT'],
    // build 26: links, and the recap's score parts with each 👍/👎
    ['night_edits', 'link', 'TEXT'],
    ['song_feedback', 'intensity', 'REAL'],
    ['song_feedback', 'entrainment', 'REAL'],
    ['song_feedback', 'persistence', 'REAL'],
    ['song_feedback', 'lift', 'REAL'],
    // build 29: song-level groove and carry-through-the-change, with each 👍/👎
    ['song_feedback', 'groove', 'REAL'],
    ['song_feedback', 'carry', 'REAL'],
  ];
  for (const [table, col, type] of migrations) {
    await database.runAsync(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).catch(() => {});
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function saveSession(session: Session): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR REPLACE INTO sessions
      (id, device_id, venue_name, venue_type, started_at, ended_at, dwell_minutes,
       auto_detected, venue_latitude, venue_longitude, device_model, os_version,
       event_code, phone_placement, dance_affinity, battery_start_pct, battery_end_pct, low_power_mode,
       venue_place_id, venue_source, venue_distance_m, end_reason, consent_version, sensors, start_source)
     VALUES (${Array(25).fill('?').join(',')})`,
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
      session.eventCode,
      session.phonePlacement,
      session.danceAffinity,
      session.batteryStartPct,
      session.batteryEndPct,
      session.lowPowerMode == null ? null : session.lowPowerMode ? 1 : 0,
      session.venuePlaceId,
      session.venueSource,
      session.venueDistanceM,
      session.endReason,
      session.consentVersion,
      session.sensors,
      session.startSource,
    ]
  );
}

export async function updateSessionEnd(
  sessionId: string,
  endedAt: Date,
  dwellMinutes: number,
  batteryEndPct: number | null,
  lowPowerMode: boolean | null,
  endReason: EndReason,
): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `UPDATE sessions SET ended_at = ?, dwell_minutes = ?, battery_end_pct = ?,
       low_power_mode = COALESCE(?, low_power_mode), end_reason = ?, synced = 0 WHERE id = ?`,
    [endedAt.getTime(), dwellMinutes, batteryEndPct, lowPowerMode == null ? null : lowPowerMode ? 1 : 0, endReason, sessionId]
  );
}

/** The venue was identified after the session started (or the phone moved to another one). */
/**
 * Sessions the app never ended (it was swiped away or killed by iOS mid-session) are closed at
 * the next launch: ended at their last window or rating, else at their start, as 'interrupted'.
 * `activeId` (a session started meanwhile) is left alone. Returns how many were closed.
 */
export async function closeInterruptedSessions(activeId: string | null): Promise<number> {
  const database = await getDb();
  const open = await database.getAllAsync<{ id: string; started_at: number }>(
    `SELECT id, started_at FROM sessions WHERE ended_at IS NULL AND id != ?`, [activeId ?? '']
  );
  for (const s of open) {
    const last = await database.getFirstAsync<{ w: number | null; r: number | null }>(
      `SELECT (SELECT MAX(window_end) FROM sensor_windows WHERE session_id = ?) AS w,
              (SELECT MAX(rated_at) FROM subjective_ratings WHERE session_id = ?) AS r`,
      [s.id, s.id]
    );
    const endedAt = Math.max(s.started_at, last?.w ?? 0, last?.r ?? 0);
    await database.runAsync(
      `UPDATE sessions SET ended_at = ?, dwell_minutes = ?, end_reason = 'interrupted', synced = 0
       WHERE id = ? AND ended_at IS NULL`,
      [endedAt, Math.round((endedAt - s.started_at) / 60000), s.id]
    );
  }
  return open.length;
}

export async function updateSessionVenue(
  id: string, venueName: string | null, placeId: string | null, distanceM: number | null,
  source: 'auto' | 'qr' = 'auto',
): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `UPDATE sessions SET venue_name = ?, venue_place_id = ?, venue_source = ?, venue_distance_m = ?, synced = 0 WHERE id = ?`,
    [venueName, placeId, source, distanceM, id]
  );
}

export async function updateSessionEventCode(id: string, eventCode: string): Promise<void> {
  const database = await getDb();
  await database.runAsync(`UPDATE sessions SET event_code = ?, synced = 0 WHERE id = ?`, [eventCode, id]);
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

// ── Going out standby ─────────────────────────────────────────────────────────

/** Insert or update a standby evening; it is uploaded again after every change. */
export async function saveStandbyNight(n: StandbyNight): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR REPLACE INTO standby_nights
      (id, device_id, armed_at, ended_at, end_reason, prompts, accepted, declined, ignored, checks,
       music_minutes, moving_minutes, party_minutes, battery_start_pct, battery_end_pct, synced)
     VALUES (${Array(15).fill('?').join(',')}, 0)`,
    [
      n.id, n.deviceId, n.armedAt, n.endedAt, n.endReason, n.prompts, n.accepted, n.declined, n.ignored,
      n.checks, n.musicMinutes, n.movingMinutes, n.partyMinutes, n.batteryStartPct, n.batteryEndPct,
    ]
  );
}

export async function getUnsyncedStandbyNights(): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(`SELECT * FROM standby_nights WHERE synced = 0`);
}

export async function markStandbyNightSynced(id: string, uploaded: { ended_at: number | null; checks: number }): Promise<void> {
  const database = await getDb();
  // Only if unchanged since the upload read it (it is updated every check while standby runs)
  await database.runAsync(
    `UPDATE standby_nights SET synced = 1 WHERE id = ? AND checks = ? AND ended_at IS ?`,
    [id, uploaded.checks, uploaded.ended_at]
  );
}

/**
 * A standby left running by an app that was killed: closed at the next launch as 'interrupted',
 * ending after its last counted check (checks run every 30 s).
 */
export async function closeOpenStandbyNights(activeId: string | null, checkIntervalMs: number): Promise<number> {
  const database = await getDb();
  const r = await database.runAsync(
    `UPDATE standby_nights SET ended_at = armed_at + checks * ?, end_reason = 'interrupted', synced = 0
     WHERE ended_at IS NULL AND id != ?`,
    [checkIntervalMs, activeId ?? '']
  );
  return r.changes;
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
       movement_energy, movement_bpm, rhythmicity, movement_axis,
       beat_plv, beat_phase_mean, beat_phase_clock, tempo_match, pulse_clarity,
       song_isrc, song_genre, song_bpm, song_popularity, recognition_source,
       song_start_ms, song_start_spread_ms, song_bpm_source, bass_envelope,
       ble_device_count, ble_count_delta, ble_count_trend,
       gps_is_at_venue, gps_accuracy_meters, screen_off_ratio, camera_activations,
       computed_energy_score, computed_density_score, computed_movement_score,
       computed_music_score, computed_vibe_score,
       venue_place_id, phone_context, on_body_share)
     VALUES (${Array(57).fill('?').join(',')})`,
    [
      w.id, w.sessionId, w.windowStart.getTime(), w.windowEnd.getTime(),
      w.avgDb, w.maxDb, w.dbVariance,
      w.musicDetected == null ? null : (w.musicDetected ? 1 : 0),
      w.estimatedBpm, w.audioClassification, w.bassPresence, w.midHighRatio,
      w.subBassEnergy, w.spectralCentroid, w.spectralFlux, w.crestFactor, w.vocalPresence, w.harmonicNoiseRatio,
      w.accelMagnitudeAvg, w.accelMagnitudeMax, w.accelVariance,
      w.gyroActivityAvg, w.gyroActivityMax, w.movementClassification,
      w.movementEnergy, w.movementBpm, w.rhythmicity, w.movementAxis,
      w.beatPlv, w.beatPhaseMean, w.beatPhaseClock, w.tempoMatch, w.pulseClarity,
      w.songIsrc, w.songGenre, w.songBpm, w.songPopularity, w.recognitionSource,
      w.songStartMs, w.songStartSpreadMs, w.songBpmSource, w.bassEnvelope,
      w.bleDeviceCount, w.bleCountDelta, w.bleCountTrend,
      w.gpsIsAtVenue == null ? null : (w.gpsIsAtVenue ? 1 : 0),
      w.gpsAccuracyMeters, w.screenOffRatio, w.cameraActivations,
      w.computedEnergyScore, w.computedDensityScore, w.computedMovementScore,
      w.computedMusicScore, w.computedVibeScore,
      w.venuePlaceId, w.phoneContext, w.onBodyShare,
    ]
  );
}

// ── Sensor Clips (10 s cycles) ────────────────────────────────────────────────

export async function saveClip(c: SensorClip): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR REPLACE INTO sensor_clips
      (id, session_id, clip_start, beat_plv, beat_phase_clock, movement_energy, movement_bpm, song_isrc, phone_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.id, c.sessionId, c.clipStart, c.beatPlv, c.beatPhaseClock, c.movementEnergy, c.movementBpm, c.songIsrc, c.phoneContext]
  );
}

export async function getUnsyncedClips(limit = 200): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(
    `SELECT * FROM sensor_clips WHERE synced = 0 ORDER BY clip_start ASC LIMIT ?`,
    [limit]
  );
}

export async function markClipsSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await database.runAsync(`UPDATE sensor_clips SET synced = 1 WHERE id IN (${placeholders})`, ids);
}

export async function deleteOldSyncedClips(olderThanMs: number = 86400000): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `DELETE FROM sensor_clips WHERE synced = 1 AND clip_start < ?`,
    [Date.now() - olderThanMs]
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

// ── Night in songs ────────────────────────────────────────────────────────────

export interface NightSong {
  isrc: string;
  title: string | null;
  artist: string | null;
  appleMusicId: string | null;
  genre: string | null;
  firstHeardMs: number;
  lastHeardMs: number;
}

/** A recognised song heard during the session (phone only). */
export async function recordNightSong(sessionId: string, s: Omit<NightSong, 'firstHeardMs' | 'lastHeardMs'>, atMs: number): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT INTO night_songs (session_id, isrc, title, artist, apple_music_id, genre, first_heard_ms, last_heard_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, isrc) DO UPDATE SET last_heard_ms = excluded.last_heard_ms,
       title = COALESCE(night_songs.title, excluded.title), artist = COALESCE(night_songs.artist, excluded.artist),
       apple_music_id = COALESCE(night_songs.apple_music_id, excluded.apple_music_id)`,
    [sessionId, s.isrc, s.title, s.artist, s.appleMusicId, s.genre, atMs, atMs]
  );
}

export async function getNightSongs(sessionId: string): Promise<NightSong[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<any>(`SELECT * FROM night_songs WHERE session_id = ?`, [sessionId]);
  return rows.map(r => ({
    isrc: r.isrc, title: r.title, artist: r.artist, appleMusicId: r.apple_music_id, genre: r.genre,
    firstHeardMs: r.first_heard_ms, lastHeardMs: r.last_heard_ms,
  }));
}

export interface NightEdit {
  editId: string;
  dj: string | null;
  title: string | null;
  link: string | null;
  firstHeardMs: number;
  lastHeardMs: number;
}

/** A known DJ edit heard during the session (phone only). */
export async function recordNightEdit(sessionId: string, e: { id: string; dj: string | null; title: string | null; link: string | null }, atMs: number): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT INTO night_edits (session_id, edit_id, dj, title, link, first_heard_ms, last_heard_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, edit_id) DO UPDATE SET last_heard_ms = excluded.last_heard_ms`,
    [sessionId, e.id, e.dj, e.title, e.link, atMs, atMs]
  );
}

export async function getNightEdits(sessionId: string): Promise<NightEdit[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<any>(`SELECT * FROM night_edits WHERE session_id = ?`, [sessionId]);
  return rows.map(r => ({ editId: r.edit_id, dj: r.dj, title: r.title, link: r.link ?? null, firstHeardMs: r.first_heard_ms, lastHeardMs: r.last_heard_ms }));
}

export async function saveEditPrint(p: { id: string; sessionId: string; capturedAt: number; signature: string }): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR IGNORE INTO edit_prints (id, session_id, captured_at, signature, synced) VALUES (?, ?, ?, ?, 0)`,
    [p.id, p.sessionId, p.capturedAt, p.signature]
  );
}

export async function getUnsyncedEditPrints(limit = 20): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(`SELECT * FROM edit_prints WHERE synced = 0 ORDER BY captured_at ASC LIMIT ?`, [limit]);
}

/** Uploaded fingerprints are not needed on the phone any more. */
export async function deleteEditPrints(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await getDb();
  await database.runAsync(`DELETE FROM edit_prints WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
}

export async function getClipsForSession(sessionId: string): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(
    `SELECT clip_start, movement_energy, beat_plv, movement_bpm, song_isrc, phone_context FROM sensor_clips
     WHERE session_id = ? ORDER BY clip_start ASC`,
    [sessionId]
  );
}

export async function saveNightRecap(sessionId: string, recap: unknown): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR REPLACE INTO night_recaps (session_id, created_at, recap) VALUES (?, ?, ?)`,
    [sessionId, Date.now(), JSON.stringify(recap)]
  );
}

export async function getNightRecap<T>(sessionId: string): Promise<T | null> {
  const database = await getDb();
  const row = await database.getFirstAsync<{ recap: string }>(`SELECT recap FROM night_recaps WHERE session_id = ?`, [sessionId]);
  return row ? (JSON.parse(row.recap) as T) : null;
}

export async function saveSongFeedback(f: {
  id: string; sessionId: string; deviceId: string; kind: 'song' | 'unknown'; isrc: string | null;
  startsAt: number; endsAt: number; rank: number; score: number; liked: boolean; djName: string | null;
  parts: { intensity: number; entrainment: number | null; persistence: number; lift: number | null; groove: number | null; carry: number | null } | null;
}): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR REPLACE INTO song_feedback
      (id, session_id, device_id, kind, isrc, starts_at, ends_at, rank, score, liked, dj_name, created_at,
       intensity, entrainment, persistence, lift, groove, carry, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [f.id, f.sessionId, f.deviceId, f.kind, f.isrc, f.startsAt, f.endsAt, f.rank, f.score, f.liked ? 1 : 0, f.djName, Date.now(),
     f.parts?.intensity ?? null, f.parts?.entrainment ?? null, f.parts?.persistence ?? null, f.parts?.lift ?? null, f.parts?.groove ?? null, f.parts?.carry ?? null]
  );
}

export async function getUnsyncedSongFeedback(): Promise<any[]> {
  const database = await getDb();
  return database.getAllAsync(`SELECT * FROM song_feedback WHERE synced = 0`);
}

export async function markSongFeedbackSynced(ids: string[], createdBefore: number): Promise<void> {
  if (ids.length === 0) return;
  const database = await getDb();
  // A 👍 changed to 👎 after the upload read it is uploaded again
  await database.runAsync(
    `UPDATE song_feedback SET synced = 1 WHERE id IN (${ids.map(() => '?').join(',')}) AND created_at <= ?`,
    [...ids, createdBefore]
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

/**
 * Give-to-get credit: minutes since `sinceMs` measured at an identified venue, with the phone
 * mostly on a body and audio present (a phone left on a table earns nothing).
 */
export async function countValidContributionMinutes(sinceMs: number, minOnBodyShare: number): Promise<number> {
  const database = await getDb();
  const row = await database.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sensor_windows
      WHERE window_start >= ? AND venue_place_id IS NOT NULL AND avg_db IS NOT NULL
        AND on_body_share >= ?`,
    [sinceMs, minOnBodyShare]
  );
  return row?.n ?? 0;
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
      (id, session_id, device_id, rating, music_rating, crowd_rating, rated_at, nearest_window_id, response_time_ms,
       rating_scale, rating_source, prompted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      rating.ratingScale,
      rating.ratingSource,
      rating.prompted ? 1 : 0,
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

/** "Delete my data": removes every session, window, clip and rating stored on this phone. */
/** One session and everything the phone keeps for it (readings, ratings, recap, songs, prints). */
export async function deleteSessionLocal(sessionId: string): Promise<boolean> {
  const database = await getDb();
  const row = await database.getFirstAsync<{ synced: number }>(`SELECT synced FROM sessions WHERE id = ?`, [sessionId]);
  for (const table of ['sensor_clips', 'sensor_windows', 'subjective_ratings', 'night_songs', 'night_recaps', 'song_feedback', 'night_edits', 'edit_prints', 'moments']) {
    await database.runAsync(`DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
  }
  await database.runAsync(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
  return row != null;
}

export interface MomentRow {
  id: string;
  sessionId: string;
  startedAt: number;
  durationMs: number;
  score: number;
  songIsrc: string | null;
  songTitle: string | null;
  songArtist: string | null;
  bassShare: number | null;
  rustleShare: number | null;
  avgDb: number | null;
  eventCode: string | null;
  venuePlaceId: string | null;
  rawPath: string;
  cleanPath: string | null;
  createdAt: number;
  expiresAt: number;
  sharedAt: number | null;
}

const momentFromRow = (r: any): MomentRow => ({
  id: r.id, sessionId: r.session_id, startedAt: r.started_at, durationMs: r.duration_ms, score: r.score,
  songIsrc: r.song_isrc, songTitle: r.song_title, songArtist: r.song_artist, bassShare: r.bass_share,
  rustleShare: r.rustle_share, avgDb: r.avg_db, eventCode: r.event_code, venuePlaceId: r.venue_place_id,
  rawPath: r.raw_path, cleanPath: r.clean_path, createdAt: r.created_at, expiresAt: r.expires_at, sharedAt: r.shared_at,
});

export async function saveMoment(m: MomentRow): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    `INSERT OR REPLACE INTO moments (id, session_id, started_at, duration_ms, score, song_isrc, song_title, song_artist,
       bass_share, rustle_share, avg_db, event_code, venue_place_id, raw_path, clean_path, created_at, expires_at, shared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.sessionId, m.startedAt, m.durationMs, m.score, m.songIsrc, m.songTitle, m.songArtist, m.bassShare,
     m.rustleShare, m.avgDb, m.eventCode, m.venuePlaceId, m.rawPath, m.cleanPath, m.createdAt, m.expiresAt, m.sharedAt]
  );
}

/** A session's moments, strongest first. */
export async function getSessionMoments(sessionId: string): Promise<MomentRow[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<any>(`SELECT * FROM moments WHERE session_id = ? ORDER BY score DESC`, [sessionId]);
  return rows.map(momentFromRow);
}

export async function getMoment(id: string): Promise<MomentRow | null> {
  const database = await getDb();
  const row = await database.getFirstAsync<any>(`SELECT * FROM moments WHERE id = ?`, [id]);
  return row ? momentFromRow(row) : null;
}

/** Moments of ended sessions that were not sent to us yet. */
export async function getMomentsToShare(): Promise<MomentRow[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<any>(
    `SELECT m.* FROM moments m JOIN sessions s ON s.id = m.session_id
     WHERE m.shared_at IS NULL AND s.ended_at IS NOT NULL ORDER BY m.created_at`);
  return rows.map(momentFromRow);
}

export async function markMomentShared(id: string): Promise<void> {
  const database = await getDb();
  await database.runAsync(`UPDATE moments SET shared_at = ? WHERE id = ?`, [Date.now(), id]);
}

export async function getExpiredMoments(now: number): Promise<MomentRow[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<any>(`SELECT * FROM moments WHERE expires_at < ?`, [now]);
  return rows.map(momentFromRow);
}

/** Clips cut during a session that are not cleaned and checked yet (ended sessions only). */
export async function getUnprocessedMoments(): Promise<MomentRow[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<any>(
    `SELECT m.* FROM moments m JOIN sessions s ON s.id = m.session_id
     WHERE m.clean_path IS NULL AND s.ended_at IS NOT NULL ORDER BY m.created_at`);
  return rows.map(momentFromRow);
}

export async function updateMomentAnalysis(id: string, a: { cleanPath: string; bassShare: number; rustleShare: number }): Promise<void> {
  const database = await getDb();
  await database.runAsync(`UPDATE moments SET clean_path = ?, bass_share = ?, rustle_share = ? WHERE id = ?`, [a.cleanPath, a.bassShare, a.rustleShare, id]);
}

export async function deleteMomentRow(id: string): Promise<void> {
  const database = await getDb();
  await database.runAsync(`DELETE FROM moments WHERE id = ?`, [id]);
}

export async function wipeLocalData(): Promise<void> {
  const database = await getDb();
  await database.execAsync(
    `DELETE FROM sensor_clips; DELETE FROM sensor_windows; DELETE FROM subjective_ratings; DELETE FROM sessions; DELETE FROM standby_nights;
     DELETE FROM night_songs; DELETE FROM night_recaps; DELETE FROM song_feedback;
     DELETE FROM night_edits; DELETE FROM edit_prints; DELETE FROM moments;`
  );
}
