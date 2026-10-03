-- Movement phase against a wall-clock grid at the recognised song tempo (radians).
-- Comparable across phones for crowd sync without using microphone timing. Collect-only.
ALTER TABLE sensor_windows ADD COLUMN IF NOT EXISTS beat_phase_clock real;
COMMENT ON COLUMN sensor_windows.beat_phase_clock IS 'Radians. Movement-peak phase against a wall-clock grid at the recognised song tempo; comparable across phones (crowd sync). Collect-only.';
