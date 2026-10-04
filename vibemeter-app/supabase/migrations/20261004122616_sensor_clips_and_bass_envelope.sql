-- One row per 10 s measurement cycle (collect-only). Cycles start on wall-clock multiples of
-- 10 s on every phone, so clips line up across phones for moment-by-moment crowd sync.
-- Deleted after 90 days (see the retention job).
CREATE TABLE IF NOT EXISTS sensor_clips (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  clip_start timestamptz NOT NULL,
  beat_plv real,
  beat_phase_clock real,
  movement_energy real,
  movement_bpm real,
  song_isrc text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensor_clips_start ON sensor_clips (clip_start);
CREATE INDEX IF NOT EXISTS idx_sensor_clips_session ON sensor_clips (session_id);
ALTER TABLE sensor_clips ENABLE ROW LEVEL SECURITY;

-- Bass-loudness envelope per minute: 240 frames of 250 ms (40–150 Hz energy, dB relative to the
-- window median), one byte each, base64. Room fingerprint for automatic grouping. Collect-only;
-- cleared after 90 days.
ALTER TABLE sensor_windows ADD COLUMN IF NOT EXISTS bass_envelope text;
COMMENT ON COLUMN sensor_windows.bass_envelope IS '240 x 250 ms bass (40-150 Hz) dB relative to window median, 1 byte/frame (0 = missing), base64. Room fingerprint; cleared after 90 days.';
