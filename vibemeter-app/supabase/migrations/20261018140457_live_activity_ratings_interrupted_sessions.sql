-- Build 23: ratings from the lock-screen Live Activity can be given at any time, so record whether
-- a prompt was waiting (unprompted ratings may lean towards notable moments). upload_ratings
-- populates every column of the table, so it needs no change.
alter table public.subjective_ratings add column if not exists prompted boolean;
comment on column public.subjective_ratings.prompted is
  'true when a rating prompt was waiting at the moment of the rating; null before build 23';
comment on column public.subjective_ratings.rating_source is
  'lockscreen (notification button), app (in-app sheet), live_activity (lock-screen card button, build 23+)';

-- Sessions the app never ended (killed mid-session) are closed at the next launch as 'interrupted'.
alter table public.sessions drop constraint if exists sessions_end_reason_check;
alter table public.sessions add constraint sessions_end_reason_check
  check (end_reason in ('user', 'no_music', 'max_duration', 'low_battery', 'interrupted'));
