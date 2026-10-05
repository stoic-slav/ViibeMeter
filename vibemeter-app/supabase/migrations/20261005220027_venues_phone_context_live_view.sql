-- Build 15: venue auto-identification, phone context, auto-stop reason, live view.
-- Venues are public Google Maps places (written by the identify-venue Edge Function with the
-- service role). The user's coordinates are never stored: only the place a phone was in.

alter table public.sessions
  add column if not exists venue_place_id text,
  add column if not exists venue_source text check (venue_source in ('auto', 'manual')),
  add column if not exists venue_distance_m real,
  add column if not exists end_reason text check (end_reason in ('user', 'no_music', 'max_duration', 'low_battery'));

alter table public.sensor_windows
  add column if not exists venue_place_id text,
  add column if not exists phone_context text check (phone_context in ('off_body', 'on_body_still', 'on_body_moving', 'uncertain')),
  add column if not exists on_body_share real;

alter table public.sensor_clips
  add column if not exists phone_context text check (phone_context in ('off_body', 'on_body_still', 'on_body_moving', 'uncertain'));

create index if not exists idx_sw_venue_recent on public.sensor_windows (venue_place_id, window_start)
  where venue_place_id is not null;

create table if not exists public.venues (
  place_id text primary key,
  name text not null,
  types text[] not null default '{}',
  lat double precision,
  lng double precision,
  updated_at timestamptz not null default now()
);
alter table public.venues enable row level security; -- no policies: read through live_venues()

-- "Does the live view change where people go?": which venues a phone was shown, and when
create table if not exists public.live_views (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  viewed_at timestamptz not null default now(),
  venue_place_ids text[] not null default '{}',
  unlocked boolean not null default false
);
alter table public.live_views enable row level security; -- no policies: insert through log_live_view()

-- Sessions may now get their venue after the start (identification finishes later) and an end reason
create or replace function public.upload_sessions(rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 500 then
    raise exception 'rows must be an array of at most 500 objects';
  end if;
  insert into public.sessions
  select * from jsonb_populate_recordset(null::public.sessions,
    (select coalesce(jsonb_agg(jsonb_build_object('created_at', now()) || e), '[]') from jsonb_array_elements(rows) e))
  on conflict (id) do update set
    ended_at = excluded.ended_at,
    dwell_minutes = excluded.dwell_minutes,
    event_code = excluded.event_code,
    phone_placement = excluded.phone_placement,
    dance_affinity = excluded.dance_affinity,
    app_version = excluded.app_version,
    battery_end_pct = excluded.battery_end_pct,
    low_power_mode = excluded.low_power_mode,
    venue_name = excluded.venue_name,
    venue_place_id = excluded.venue_place_id,
    venue_source = excluded.venue_source,
    venue_distance_m = excluded.venue_distance_m,
    end_reason = excluded.end_reason
  -- only the phone that created a session may change it
  where sessions.device_id = excluded.device_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Live state per venue from the last 15 minutes of on-body phones. Aggregates only.
-- Energy is judged against each phone's own normal (its last 30 days), so an athletic dancer
-- and a calm one count alike; phones with too little history use absolute levels.
create or replace function public.live_venues()
returns table (
  place_id text, name text, lat double precision, lng double precision,
  contributors integer, dancing_share real, energy_level text, momentum text,
  genre text, bpm real, crowd real, confidence text, updated_at timestamptz
) language sql stable security definer set search_path = public as $$
  with recent as (
    select w.*, s.device_id
    from public.sensor_windows w join public.sessions s on s.id = w.session_id
    where w.window_start > now() - interval '15 minutes'
      and w.venue_place_id is not null
      and coalesce(w.phone_context, 'uncertain') <> 'off_body'
  ), baseline as (
    select s.device_id, avg(w.movement_energy) as m, stddev_samp(w.movement_energy) as sd, count(*) as n
    from public.sensor_windows w join public.sessions s on s.id = w.session_id
    where w.window_start > now() - interval '30 days' and w.movement_energy is not null
      and s.device_id in (select device_id from recent)
    group by s.device_id
  ), scored as (
    select r.*,
      case when b.n >= 30 and b.sd > 0 then (r.movement_energy - b.m) / b.sd end as energy_z
    from recent r left join baseline b on b.device_id = r.device_id
  ), per as (
    select venue_place_id,
      count(distinct device_id)::int as contributors,
      avg(case when movement_classification in ('dancing', 'jumping') or rhythmicity >= 0.35 then 1.0 else 0.0 end)::real as dancing_share,
      percentile_cont(0.5) within group (order by energy_z) as energy_z,
      percentile_cont(0.5) within group (order by movement_energy) as energy_abs,
      avg(movement_energy) filter (where window_start > now() - interval '5 minutes') as e_new,
      avg(movement_energy) filter (where window_start <= now() - interval '5 minutes') as e_old,
      mode() within group (order by song_genre) as genre,
      percentile_cont(0.5) within group (order by song_bpm)::real as bpm,
      percentile_cont(0.5) within group (order by ble_device_count)::real as crowd,
      max(window_end) as updated_at
    from scored group by venue_place_id
  )
  select p.venue_place_id, v.name, v.lat, v.lng, p.contributors, p.dancing_share,
    case
      when p.energy_z is not null then case when p.energy_z < -0.5 then 'low' when p.energy_z > 0.5 then 'high' else 'medium' end
      when p.energy_abs is null then null
      when p.energy_abs < 0.8 then 'low' when p.energy_abs < 2.0 then 'medium' else 'high'
    end,
    case
      when p.e_new is null or p.e_old is null or p.e_old <= 0 then null
      when p.e_new / p.e_old > 1.15 then 'rising' when p.e_new / p.e_old < 0.85 then 'falling' else 'stable'
    end,
    p.genre, p.bpm, p.crowd,
    case when p.contributors >= 8 then 'high' when p.contributors >= 3 then 'medium' else 'low' end,
    p.updated_at
  from per p join public.venues v on v.place_id = p.venue_place_id;
$$;

create or replace function public.log_live_view(p_device_id text, p_venue_place_ids text[], p_unlocked boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_device_id is null or length(p_device_id) > 64 or coalesce(array_length(p_venue_place_ids, 1), 0) > 200 then
    raise exception 'invalid live view';
  end if;
  insert into public.live_views (device_id, venue_place_ids, unlocked)
  values (p_device_id, coalesce(p_venue_place_ids, '{}'), coalesce(p_unlocked, false));
end $$;

revoke all on function public.live_venues(), public.log_live_view(text, text[], boolean) from public;
grant execute on function public.live_venues(), public.log_live_view(text, text[], boolean) to anon, authenticated;

-- Retention: live views go after 90 days, like the clips
create or replace function public.apply_retention() returns void
language sql security definer set search_path = public as $$
  delete from public.sensor_clips where clip_start < now() - interval '90 days';
  update public.sensor_windows set bass_envelope = null
   where bass_envelope is not null and window_start < now() - interval '90 days';
  delete from public.live_views where viewed_at < now() - interval '90 days';
$$;
revoke all on function public.apply_retention() from public, anon, authenticated;
