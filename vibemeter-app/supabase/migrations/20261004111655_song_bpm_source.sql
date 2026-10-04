-- Where song_bpm came from: Deezer metadata, or learned on the phone from the song's clips.
ALTER TABLE sensor_windows ADD COLUMN IF NOT EXISTS song_bpm_source text;
COMMENT ON COLUMN sensor_windows.song_bpm_source IS 'Where song_bpm came from: deezer (metadata) or learned (summed onset autocorrelation of the song''s clips on the phone).';
