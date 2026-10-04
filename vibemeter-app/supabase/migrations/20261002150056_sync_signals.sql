-- ============================================
-- Movement energy, beat sync and crowd-sync inputs
-- ============================================
-- Per-window scalars only — no raw sensor data leaves the phone.
-- Beat sync is collect-only: it is NOT part of computed_vibe_score.

ALTER TABLE public.sensor_windows
  -- RMS of gravity-removed acceleration (m/s²) — Martella 2015, Dotov 2021
  ADD COLUMN IF NOT EXISTS movement_energy  real,
  ADD COLUMN IF NOT EXISTS movement_bpm     real,
  ADD COLUMN IF NOT EXISTS rhythmicity      real CHECK (rhythmicity BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS movement_axis    text CHECK (movement_axis IN ('vertical', 'horizontal')),
  -- Phase-locking of movement peaks to the audio beat (0–1)
  ADD COLUMN IF NOT EXISTS beat_plv         real CHECK (beat_plv BETWEEN 0 AND 1),
  -- Mean beat phase (radians); compared across devices for crowd sync
  ADD COLUMN IF NOT EXISTS beat_phase_mean  real,
  ADD COLUMN IF NOT EXISTS tempo_match      real CHECK (tempo_match BETWEEN 0 AND 1),
  -- Audio beat clarity (onset-interval agreement, 0–1) — Ellamil 2016, Burger 2013
  ADD COLUMN IF NOT EXISTS pulse_clarity    real CHECK (pulse_clarity BETWEEN 0 AND 1);

ALTER TABLE public.sessions
  -- Shared code typed by testers at the same event, used to group devices for crowd sync
  ADD COLUMN IF NOT EXISTS event_code       text,
  ADD COLUMN IF NOT EXISTS phone_placement  text CHECK (phone_placement IN ('pocket', 'hand', 'bag')),
  -- One-time self-report "How much do you enjoy dancing?" — Witek 2014
  ADD COLUMN IF NOT EXISTS dance_affinity   integer CHECK (dance_affinity BETWEEN 1 AND 5);

-- Crowd-sync grouping: same event, same minute
CREATE INDEX IF NOT EXISTS idx_sessions_event_code ON public.sessions(event_code);
