-- Build 12: the vibe rating is a 3-level scale (Dead / Decent / Best), stored as 1 / 3 / 5 so it
-- fits the existing 1-5 column. rating_scale says which scale a rating used (3, or 5 for the
-- earlier 1-5 scale); rating_source says where it was given (lock-screen button or in-app sheet).
ALTER TABLE subjective_ratings ADD COLUMN IF NOT EXISTS rating_scale smallint;
ALTER TABLE subjective_ratings ADD COLUMN IF NOT EXISTS rating_source text;
COMMENT ON COLUMN subjective_ratings.rating_scale IS '3 = Dead/Decent/Best stored as 1/3/5 (build 12+); 5 or NULL = the earlier 1-5 scale.';
COMMENT ON COLUMN subjective_ratings.rating_source IS 'lockscreen (notification button) or app (in-app sheet).';
