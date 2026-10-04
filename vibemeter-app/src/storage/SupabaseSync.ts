import { supabase } from '../config/supabase';
import {
  getUnsyncedSessions, markSessionSynced,
  getUnsyncedWindows, markWindowsSynced,
  getUnsyncedRatings, markRatingsSynced,
  getUnsyncedClips, markClipsSynced,
} from './LocalBuffer';
import { SENSOR_CONFIG } from '../config/constants';
import * as Application from 'expo-application';

// e.g. "0.2.0 (7)". The build number tells analysis which calibration and algorithms produced a row.
const APP_VERSION = `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`;

const LOG_TAG = '[SupabaseSync]';

async function withRetry<T>(fn: () => Promise<T>, attempts = SENSOR_CONFIG.UPLOAD_RETRY_ATTEMPTS): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, SENSOR_CONFIG.UPLOAD_RETRY_DELAY_MS * (i + 1)));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Retry limit exceeded');
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function syncSessions(): Promise<void> {
  const rows = await getUnsyncedSessions();
  if (rows.length === 0) return;

  const payload = rows.map(r => ({
    id: r.id,
    device_id: r.device_id,
    venue_name: r.venue_name,
    venue_type: r.venue_type,
    started_at: new Date(r.started_at).toISOString(),
    ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    dwell_minutes: r.dwell_minutes,
    auto_detected: r.auto_detected === 1,
    // Deliberately NOT including venue_latitude/longitude to protect privacy
    device_model: r.device_model,
    os_version: r.os_version,
    app_version: APP_VERSION,
    event_code: r.event_code ?? null,
    phone_placement: r.phone_placement ?? null,
    dance_affinity: r.dance_affinity ?? null,
  }));

  await withRetry(async () => {
    const { error } = await supabase
      .from('sessions')
      .upsert(payload, { onConflict: 'id' });
    if (error) throw new Error(`Session upsert failed: ${error.message}`);
  });

  for (const row of rows) {
    await markSessionSynced(row.id);
  }

  console.log(`${LOG_TAG} Synced ${rows.length} session(s)`);
}

// ── Sensor Windows ────────────────────────────────────────────────────────────

export async function syncSensorWindows(): Promise<void> {
  const rows = await getUnsyncedWindows(100);
  if (rows.length === 0) return;

  const payload = rows.map(r => ({
    id: r.id,
    session_id: r.session_id,
    window_start: new Date(r.window_start).toISOString(),
    window_end: new Date(r.window_end).toISOString(),
    avg_db: r.avg_db,
    max_db: r.max_db,
    db_variance: r.db_variance,
    music_detected: r.music_detected == null ? null : r.music_detected === 1,
    estimated_bpm: r.estimated_bpm,
    audio_classification: r.audio_classification,
    bass_presence: r.bass_presence,
    mid_high_ratio: r.mid_high_ratio,
    sub_bass_energy: r.sub_bass_energy ?? null,
    spectral_centroid: r.spectral_centroid ?? null,
    spectral_flux: r.spectral_flux ?? null,
    crest_factor: r.crest_factor ?? null,
    vocal_presence: r.vocal_presence ?? null,
    harmonic_noise_ratio: r.harmonic_noise_ratio ?? null,
    pulse_clarity: r.pulse_clarity ?? null,
    accel_magnitude_avg: r.accel_magnitude_avg,
    accel_magnitude_max: r.accel_magnitude_max,
    accel_variance: r.accel_variance,
    gyro_activity_avg: r.gyro_activity_avg,
    gyro_activity_max: r.gyro_activity_max,
    movement_classification: r.movement_classification,
    movement_energy: r.movement_energy ?? null,
    movement_bpm: r.movement_bpm ?? null,
    rhythmicity: r.rhythmicity ?? null,
    movement_axis: r.movement_axis ?? null,
    beat_plv: r.beat_plv ?? null,
    beat_phase_mean: r.beat_phase_mean ?? null,
    beat_phase_clock: r.beat_phase_clock ?? null,
    tempo_match: r.tempo_match ?? null,
    song_isrc: r.song_isrc ?? null,
    song_genre: r.song_genre ?? null,
    song_bpm: r.song_bpm ?? null,
    song_popularity: r.song_popularity ?? null,
    recognition_source: r.recognition_source ?? null,
    song_started_at: r.song_start_ms != null ? new Date(r.song_start_ms).toISOString() : null,
    song_start_spread_ms: r.song_start_spread_ms ?? null,
    song_bpm_source: r.song_bpm_source ?? null,
    bass_envelope: r.bass_envelope ?? null,
    ble_device_count: r.ble_device_count,
    ble_count_delta: r.ble_count_delta,
    ble_count_trend: r.ble_count_trend,
    gps_is_at_venue: r.gps_is_at_venue == null ? null : r.gps_is_at_venue === 1,
    gps_accuracy_meters: r.gps_accuracy_meters,
    screen_off_ratio: r.screen_off_ratio,
    camera_activations: r.camera_activations,
    computed_energy_score: r.computed_energy_score,
    computed_density_score: r.computed_density_score,
    computed_movement_score: r.computed_movement_score,
    computed_music_score: r.computed_music_score,
    computed_vibe_score: r.computed_vibe_score,
  }));

  await withRetry(async () => {
    const { error } = await supabase
      .from('sensor_windows')
      .upsert(payload, { onConflict: 'id' });
    if (error) throw new Error(`Sensor window upsert failed: ${error.message}`);
  });

  await markWindowsSynced(rows.map(r => r.id));
  console.log(`${LOG_TAG} Synced ${rows.length} sensor window(s)`);
}

// ── Subjective Ratings ────────────────────────────────────────────────────────

export async function syncRatings(): Promise<void> {
  const rows = await getUnsyncedRatings();
  if (rows.length === 0) return;

  const payload = rows.map(r => ({
    id: r.id,
    session_id: r.session_id,
    device_id: r.device_id,
    rating: r.rating,
    music_rating: r.music_rating ?? null,
    crowd_rating: r.crowd_rating ?? null,
    rated_at: new Date(r.rated_at).toISOString(),
    nearest_window_id: r.nearest_window_id ?? null,
    response_time_ms: r.response_time_ms,
  }));

  await withRetry(async () => {
    const { error } = await supabase
      .from('subjective_ratings')
      .upsert(payload, { onConflict: 'id' });
    if (error) throw new Error(`Ratings upsert failed: ${error.message}`);
  });

  await markRatingsSynced(rows.map(r => r.id));
  console.log(`${LOG_TAG} Synced ${rows.length} rating(s)`);
}

// ── Full sync ─────────────────────────────────────────────────────────────────

// ── Sensor Clips (10 s cycles) ────────────────────────────────────────────────

export async function syncClips(): Promise<void> {
  // Several batches per sync: a long session produces 30 clips per 5-minute sync interval
  for (let round = 0; round < 5; round++) {
    const rows = await getUnsyncedClips(200);
    if (rows.length === 0) return;
    const payload = rows.map(r => ({
      id: r.id,
      session_id: r.session_id,
      clip_start: new Date(r.clip_start).toISOString(),
      beat_plv: r.beat_plv ?? null,
      beat_phase_clock: r.beat_phase_clock ?? null,
      movement_energy: r.movement_energy ?? null,
      movement_bpm: r.movement_bpm ?? null,
      song_isrc: r.song_isrc ?? null,
    }));
    await withRetry(async () => {
      // The app may only insert clips (no read access, so no upsert). A batch that hits a clip
      // already uploaded (sync interrupted before it was marked) is retried one row at a time,
      // skipping the duplicates.
      const { error } = await supabase.from('sensor_clips').insert(payload);
      if (!error) return;
      if (error.code !== '23505') throw new Error(`Clip insert failed: ${error.message}`);
      for (const row of payload) {
        const { error: rowError } = await supabase.from('sensor_clips').insert(row);
        if (rowError && rowError.code !== '23505') throw new Error(`Clip insert failed: ${rowError.message}`);
      }
    });
    await markClipsSynced(rows.map(r => r.id));
    console.log(`${LOG_TAG} Synced ${rows.length} clip(s)`);
  }
}

export async function syncAll(): Promise<void> {
  try {
    await syncSessions();
    await syncSensorWindows();
    await syncClips();
    await syncRatings();
  } catch (err) {
    console.error(`${LOG_TAG} Sync error:`, err);
    // Don't throw — sync failures are non-fatal, data is safe in SQLite
  }
}
