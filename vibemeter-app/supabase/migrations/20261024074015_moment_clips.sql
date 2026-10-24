-- "Best moments" (build 29): opt-in short audio clips of a person's strongest dancing. By default
-- they stay on the phone. A second, separate opt-in sends them here so the cleaning can be
-- compared (analysis/clip_enhance.py: phone layer, voice/music separation, several phones merged).
-- The audio sits in a private bucket nobody can read through the public key; every upload and
-- delete goes through the `moments` Edge Function (service role), which checks the device ID.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('moments', 'moments', false, 3145728, array['audio/wav', 'audio/x-wav'])
on conflict (id) do update set public = false, file_size_limit = 3145728, allowed_mime_types = array['audio/wav', 'audio/x-wav'];

create table if not exists public.moment_clips (
  id uuid primary key,
  device_id text not null,
  session_id uuid,
  started_at timestamptz not null,
  duration_ms integer not null,
  event_code text,
  venue_place_id text,
  song_isrc text,                 -- no titles: the phone keeps those
  score real,
  bass_share real,
  rustle_share real,
  avg_db real,
  has_clean boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);

create index if not exists moment_clips_device on public.moment_clips (device_id);
create index if not exists moment_clips_event on public.moment_clips (event_code, started_at);

alter table public.moment_clips enable row level security;
revoke all on public.moment_clips from anon, authenticated;
