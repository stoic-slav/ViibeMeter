-- Recognized-track descriptors per window (collect-only, not in the composite score).
-- No title or artist is stored: the ISRC identifies the track across devices.
alter table public.sensor_windows
  add column if not exists song_isrc text,
  add column if not exists song_genre text,
  add column if not exists song_bpm real,
  add column if not exists song_popularity integer,
  add column if not exists recognition_source text
    check (recognition_source in ('shazam', 'audd'));
