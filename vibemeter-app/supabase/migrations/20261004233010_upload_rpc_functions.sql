-- Lockdown step 2a: the app uploads through these functions instead of table upserts, so the
-- anon key can later lose SELECT and UPDATE on the tables (step 2b, once testers have updated).
-- Rows are JSON objects keyed by column name; unknown keys are ignored, missing columns are null
-- (created_at defaults to now()).

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
    low_power_mode = excluded.low_power_mode
  -- only the phone that created a session may change it
  where sessions.device_id = excluded.device_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.upload_sensor_windows(rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 500 then
    raise exception 'rows must be an array of at most 500 objects';
  end if;
  insert into public.sensor_windows
  select * from jsonb_populate_recordset(null::public.sensor_windows,
    (select coalesce(jsonb_agg(jsonb_build_object('created_at', now()) || e), '[]') from jsonb_array_elements(rows) e))
  on conflict (id) do nothing; -- a window is final once written
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.upload_ratings(rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 500 then
    raise exception 'rows must be an array of at most 500 objects';
  end if;
  insert into public.subjective_ratings
  select * from jsonb_populate_recordset(null::public.subjective_ratings,
    (select coalesce(jsonb_agg(jsonb_build_object('created_at', now()) || e), '[]') from jsonb_array_elements(rows) e))
  on conflict (id) do nothing; -- a rating is final once written
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.upload_sessions(jsonb), public.upload_sensor_windows(jsonb), public.upload_ratings(jsonb) from public;
grant execute on function public.upload_sessions(jsonb), public.upload_sensor_windows(jsonb), public.upload_ratings(jsonb) to anon, authenticated;
