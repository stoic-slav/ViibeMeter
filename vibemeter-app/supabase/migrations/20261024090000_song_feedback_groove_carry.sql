-- Build 29: two more recap signals stored with each 👍/👎, so their weights can be fitted from day one.
alter table public.song_feedback
  add column if not exists groove real,   -- song-level: pulse clarity, bass, spectral flux, tempo range (vs the rest of the night's music)
  add column if not exists carry real;    -- kept moving through the change from the previous song
