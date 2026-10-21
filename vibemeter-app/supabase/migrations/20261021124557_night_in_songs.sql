-- Build 25: "Your night in songs".

-- The night's lineup per venue (public information: who plays when). Written by us for partner
-- nights; read by the app through venue_sets_for to credit songs and unrecognised tracks.
create table if not exists public.venue_sets (
  id uuid primary key default gen_random_uuid(),
  place_id text not null,
  dj_name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  created_at timestamptz not null default now()
);
comment on table public.venue_sets is 'DJ lineup per venue and night (public info). Read via venue_sets_for.';
create index if not exists venue_sets_place_idx on public.venue_sets (place_id, starts_at);
alter table public.venue_sets enable row level security;
revoke all on public.venue_sets from anon, authenticated;

create or replace function public.venue_sets_for(p_place_id text, p_from timestamptz, p_to timestamptz)
returns table (dj_name text, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select dj_name, starts_at, ends_at from public.venue_sets
   where place_id = p_place_id and starts_at < p_to and ends_at > p_from
     and p_to - p_from <= interval '24 hours'
   order by starts_at;
$$;
revoke all on function public.venue_sets_for(text, timestamptz, timestamptz) from public;
grant execute on function public.venue_sets_for(text, timestamptz, timestamptz) to anon, authenticated;

-- 👍/👎 on a recap entry: ground truth for "does movement predict enjoying a song?".
-- No titles: ISRC (null for an unrecognised stretch), when, rank and score shown.
create table if not exists public.song_feedback (
  id uuid primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  device_id text not null,
  kind text not null check (kind in ('song', 'unknown')),
  isrc text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  rank integer not null,
  score real not null,
  liked boolean not null,
  dj_name text,
  app_version text,
  created_at timestamptz not null default now()
);
comment on table public.song_feedback is 'Night recap 👍/👎 per entry (build 25+). Written only through upload_song_feedback.';
create index if not exists song_feedback_session_idx on public.song_feedback (session_id);
alter table public.song_feedback enable row level security;
revoke all on public.song_feedback from anon, authenticated;

create or replace function public.upload_song_feedback(rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 200 then
    raise exception 'rows must be an array of at most 200 objects';
  end if;
  insert into public.song_feedback
  select * from jsonb_populate_recordset(null::public.song_feedback,
    (select coalesce(jsonb_agg(jsonb_build_object('created_at', now()) || e), '[]') from jsonb_array_elements(rows) e))
  on conflict (id) do update set liked = excluded.liked
  -- only the phone that gave the answer may change it
  where song_feedback.device_id = excluded.device_id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.upload_song_feedback(jsonb) from public;
grant execute on function public.upload_song_feedback(jsonb) to anon, authenticated;

-- Deletion: song_feedback goes with its sessions (cascade), and by device for safety
create or replace function public.delete_my_data(p_device_id text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_device_id is null or length(p_device_id) < 30 or length(p_device_id) > 64 then
    raise exception 'invalid device id';
  end if;
  delete from public.subjective_ratings where device_id = p_device_id;
  delete from public.live_views where device_id = p_device_id;
  delete from public.standby_nights where device_id = p_device_id;
  delete from public.song_feedback where device_id = p_device_id;
  delete from public.sessions where device_id = p_device_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.apply_retention()
returns void language sql security definer set search_path = public as $$
  delete from public.sensor_clips where clip_start < now() - interval '90 days';
  update public.sensor_windows set bass_envelope = null
   where bass_envelope is not null and window_start < now() - interval '90 days';
  delete from public.live_views where viewed_at < now() - interval '90 days';
  delete from public.standby_nights where armed_at < now() - interval '24 months';
  delete from public.venue_sets where ends_at < now() - interval '24 months';
  delete from public.sessions where started_at < now() - interval '24 months';
$$;
