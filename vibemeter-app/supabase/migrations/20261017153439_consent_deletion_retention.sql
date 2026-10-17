-- GDPR P0: consent recorded per session, in-app deletion, retention limit.

-- Which consent version the user accepted and which sensors were allowed for this session
-- (e.g. 'mic,motion,ble,loc'), so the analysis can control for partial permissions.
alter table public.sessions
  add column if not exists consent_version integer,
  add column if not exists sensors text;

-- "Delete my data" in the app: removes everything uploaded under this anonymous device ID.
-- Sessions cascade to their windows, clips and ratings. Returns how many sessions were removed.
-- The device ID is a random UUID known only to the phone (shown to its owner in the app).
create or replace function public.delete_my_data(p_device_id text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_device_id is null or length(p_device_id) < 30 or length(p_device_id) > 64 then
    raise exception 'invalid device id';
  end if;
  delete from public.subjective_ratings where device_id = p_device_id;
  delete from public.live_views where device_id = p_device_id;
  delete from public.sessions where device_id = p_device_id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.delete_my_data(text) from public;
grant execute on function public.delete_my_data(text) to anon, authenticated;

-- Retention: 10 s clips, bass curves and live-view logs after 90 days (unchanged); whole sessions
-- (with their windows and ratings) after 24 months.
create or replace function public.apply_retention() returns void
language sql security definer set search_path = public as $$
  delete from public.sensor_clips where clip_start < now() - interval '90 days';
  update public.sensor_windows set bass_envelope = null
   where bass_envelope is not null and window_start < now() - interval '90 days';
  delete from public.live_views where viewed_at < now() - interval '90 days';
  delete from public.sessions where started_at < now() - interval '24 months';
$$;
revoke all on function public.apply_retention() from public, anon, authenticated;
