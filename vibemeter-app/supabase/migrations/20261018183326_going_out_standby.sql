-- Build 24: "Going out" standby. One row per standby (an evening the user switched it on), to
-- judge battery cost and false alarms. Counts only: no audio, no per-minute values, no location.
create table if not exists public.standby_nights (
  id uuid primary key,
  device_id text not null,
  armed_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('user', 'morning', 'max_duration', 'low_battery', 'session_ended', 'deleted')),
  prompts integer not null default 0,
  accepted integer not null default 0,
  declined integer not null default 0,
  ignored integer not null default 0,
  checks integer not null default 0,
  music_minutes integer not null default 0,
  moving_minutes integer not null default 0,
  party_minutes integer not null default 0,
  battery_start_pct real,
  battery_end_pct real,
  app_version text,
  created_at timestamptz not null default now()
);
comment on table public.standby_nights is
  'Going out standby (build 24+): one row per evening it was on. Written only through upload_standby_nights.';
create index if not exists standby_nights_device_idx on public.standby_nights (device_id);
alter table public.standby_nights enable row level security;
revoke all on public.standby_nights from anon, authenticated;

create or replace function public.upload_standby_nights(rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 200 then
    raise exception 'rows must be an array of at most 200 objects';
  end if;
  insert into public.standby_nights
  select * from jsonb_populate_recordset(null::public.standby_nights,
    (select coalesce(jsonb_agg(jsonb_build_object('created_at', now()) || e), '[]') from jsonb_array_elements(rows) e))
  on conflict (id) do update set
    ended_at = excluded.ended_at,
    end_reason = excluded.end_reason,
    prompts = excluded.prompts,
    accepted = excluded.accepted,
    declined = excluded.declined,
    ignored = excluded.ignored,
    checks = excluded.checks,
    music_minutes = excluded.music_minutes,
    moving_minutes = excluded.moving_minutes,
    party_minutes = excluded.party_minutes,
    battery_end_pct = excluded.battery_end_pct
  -- only the phone that created a row may change it
  where standby_nights.device_id = excluded.device_id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.upload_standby_nights(jsonb) from public;
grant execute on function public.upload_standby_nights(jsonb) to anon, authenticated;

-- How a session was started: by hand, or by "Yes, start" on a standby prompt
alter table public.sessions add column if not exists start_source text
  check (start_source in ('manual', 'standby'));
comment on column public.sessions.start_source is 'manual or standby (Going out prompt accepted); null before build 24';

-- Data rights and retention cover the new table
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
  delete from public.sessions where started_at < now() - interval '24 months';
$$;
