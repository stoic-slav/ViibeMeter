-- Mirrors the migration applied from the Supabase dashboard on 2026-05-20
-- (committed later so the repo matches the live schema).

-- Drop the FK constraint that causes immediate rating syncs to fail
-- (ratings sync before their nearest_window reaches Supabase)
ALTER TABLE public.subjective_ratings
  DROP CONSTRAINT IF EXISTS subjective_ratings_nearest_window_id_fkey;

-- Add multi-dimension rating columns
ALTER TABLE public.subjective_ratings
  ADD COLUMN IF NOT EXISTS music_rating integer CHECK (music_rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS crowd_rating integer CHECK (crowd_rating BETWEEN 1 AND 5);
