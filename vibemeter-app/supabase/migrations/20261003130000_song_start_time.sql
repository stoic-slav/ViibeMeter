-- When this playback of the recognised track began (wall clock), from ShazamKit's match offset.
-- Phones hearing the same speakers get the same value; used for automatic grouping. Collect-only.
ALTER TABLE sensor_windows ADD COLUMN IF NOT EXISTS song_started_at timestamptz;
ALTER TABLE sensor_windows ADD COLUMN IF NOT EXISTS song_start_spread_ms real;
COMMENT ON COLUMN sensor_windows.song_started_at IS 'When this playback of song_isrc began (wall clock), from ShazamKit match offset. Same for phones hearing the same speakers; used for automatic grouping. Collect-only.';
COMMENT ON COLUMN sensor_windows.song_start_spread_ms IS 'Max minus min of the window''s song start estimates (ms); accuracy check.';
