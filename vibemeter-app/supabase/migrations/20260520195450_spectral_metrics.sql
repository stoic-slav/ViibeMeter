-- Mirrors the migration applied from the Supabase dashboard on 2026-05-20
-- (committed later so the repo matches the live schema).

ALTER TABLE public.sensor_windows
  ADD COLUMN IF NOT EXISTS sub_bass_energy    real,
  ADD COLUMN IF NOT EXISTS spectral_centroid  real,
  ADD COLUMN IF NOT EXISTS spectral_flux      real,
  ADD COLUMN IF NOT EXISTS crest_factor       real,
  ADD COLUMN IF NOT EXISTS vocal_presence     real,
  ADD COLUMN IF NOT EXISTS harmonic_noise_ratio real;
