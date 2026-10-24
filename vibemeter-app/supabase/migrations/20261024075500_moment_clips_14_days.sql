-- Moment clips are kept 14 days everywhere (phone and server), not 30.
alter table public.moment_clips alter column expires_at set default now() + interval '14 days';
