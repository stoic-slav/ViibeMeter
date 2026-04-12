-- ============================================
-- VibeMeter — Data Quality Monitoring Queries
-- Run in Supabase SQL Editor during Week 3 data collection
-- ============================================

-- Daily data health check
select
  date_trunc('day', sw.created_at) as day,
  count(distinct s.id) as sessions,
  count(distinct s.device_id) as unique_devices,
  count(sw.id) as sensor_windows,
  count(sr.id) as ratings,
  round(avg(sw.computed_vibe_score)::numeric, 2) as avg_vibe,
  round(avg(sw.avg_db)::numeric, 1) as avg_db,
  count(case when sw.music_detected then 1 end) as windows_with_music,
  count(case when sw.estimated_bpm is not null then 1 end) as windows_with_bpm
from sessions s
left join sensor_windows sw on sw.session_id = s.id
left join subjective_ratings sr on sr.session_id = s.id
group by 1
order by 1 desc;


-- Per-session quality check
select
  s.id,
  s.venue_name,
  s.venue_type,
  s.dwell_minutes,
  s.device_model,
  count(sw.id) as windows,
  count(sr.id) as ratings,
  round(avg(sw.computed_vibe_score)::numeric, 2) as avg_sensor_vibe,
  round(avg(sr.rating)::numeric, 2) as avg_user_rating,
  round(avg(sw.avg_db)::numeric, 1) as avg_db,
  bool_or(sw.music_detected) as any_music_detected
from sessions s
left join sensor_windows sw on sw.session_id = s.id
left join subjective_ratings sr on sr.session_id = s.id
where s.ended_at is not null
group by s.id
order by s.started_at desc;


-- Signal coverage: what % of windows have each signal?
select
  count(*) as total_windows,
  round(100.0 * count(avg_db) / count(*), 1) as pct_has_audio,
  round(100.0 * count(estimated_bpm) / count(*), 1) as pct_has_bpm,
  round(100.0 * count(accel_magnitude_avg) / count(*), 1) as pct_has_motion,
  round(100.0 * count(ble_device_count) / count(*), 1) as pct_has_ble,
  round(100.0 * count(gps_is_at_venue) / count(*), 1) as pct_has_gps,
  round(100.0 * count(screen_off_ratio) / count(*), 1) as pct_has_screen
from sensor_windows;


-- Distribution of audio classifications
select
  audio_classification,
  count(*) as windows,
  round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
from sensor_windows
where audio_classification is not null
group by audio_classification
order by windows desc;


-- BPM distribution (where detected)
select
  estimated_bpm,
  count(*) as occurrences
from sensor_windows
where estimated_bpm is not null
group by estimated_bpm
order by estimated_bpm;


-- Sensor-vs-rating alignment per session
select
  s.venue_name,
  s.venue_type,
  round(avg(sw.computed_vibe_score)::numeric, 2) as sensor_avg,
  round(avg(sr.rating)::numeric, 2) as user_avg,
  round(abs(avg(sw.computed_vibe_score) - avg(sr.rating))::numeric, 2) as divergence,
  count(sr.id) as rating_count
from sessions s
join sensor_windows sw on sw.session_id = s.id
join subjective_ratings sr on sr.session_id = s.id
where s.ended_at is not null
group by s.id
having count(sr.id) >= 2
order by divergence asc;


-- Experiment readiness check (minimum viable dataset)
select
  count(distinct s.id) as total_sessions,
  count(distinct s.id) filter (where s.ended_at is not null) as completed_sessions,
  count(distinct s.device_id) as unique_devices,
  count(distinct s.venue_type) as venue_types_covered,
  count(sr.id) as total_ratings,
  count(sw.id) as total_windows,
  -- Minimum targets
  count(distinct s.id) filter (where s.ended_at is not null) >= 8 as has_8_sessions,
  count(sr.id) >= 30 as has_30_ratings,
  count(distinct s.venue_type) >= 3 as has_3_venue_types
from sessions s
left join sensor_windows sw on sw.session_id = s.id
left join subjective_ratings sr on sr.session_id = s.id;
