-- Build 25: DJ edits. Music Apple's Shazam catalog doesn't know is fingerprinted on the phone
-- (ShazamKit signatures: irreversible, no audio). Fingerprints taken during a set we know from
-- the venue's lineup become references credited to that DJ; DJs can also register their own
-- edits (live after we approve them). Phones download the references and match on the device.

-- Fingerprints of unrecognised music during sessions (not standby). Kept 90 days.
create table if not exists public.edit_prints (
  id uuid primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  device_id text not null,
  captured_at timestamptz not null,
  signature text not null check (length(signature) < 200000),
  created_at timestamptz not null default now()
);
comment on table public.edit_prints is 'ShazamKit fingerprints of music Shazam could not name (DJ edits), per session. Written only through upload_edit_prints; 90-day retention.';
create index if not exists edit_prints_captured_idx on public.edit_prints (captured_at);
create index if not exists edit_prints_session_idx on public.edit_prints (session_id);
alter table public.edit_prints enable row level security;
revoke all on public.edit_prints from anon, authenticated;

create or replace function public.upload_edit_prints(rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 50 then
    raise exception 'rows must be an array of at most 50 objects';
  end if;
  insert into public.edit_prints (id, session_id, device_id, captured_at, signature)
  select (e->>'id')::uuid, (e->>'session_id')::uuid, e->>'device_id', (e->>'captured_at')::timestamptz, e->>'signature'
    from jsonb_array_elements(rows) e
   -- only for the phone's own sessions
   where exists (select 1 from public.sessions s where s.id = (e->>'session_id')::uuid and s.device_id = e->>'device_id')
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.upload_edit_prints(jsonb) from public;
grant execute on function public.upload_edit_prints(jsonb) to anon, authenticated;

-- Edits registered by DJs themselves. Live only after we approve them:
--   update public.dj_edits set status = 'approved' where id = '<id>';
create table if not exists public.dj_edits (
  id uuid primary key default gen_random_uuid(),
  dj_name text not null check (length(dj_name) between 1 and 80),
  title text not null check (length(title) between 1 and 120),
  contact text check (length(contact) <= 200),
  device_id text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);
comment on table public.dj_edits is 'DJ-registered edits (name, title, contact for verification). Pending until approved by the team.';
alter table public.dj_edits enable row level security;
revoke all on public.dj_edits from anon, authenticated;

create table if not exists public.dj_edit_prints (
  id uuid primary key default gen_random_uuid(),
  edit_id uuid not null references public.dj_edits(id) on delete cascade,
  signature text not null check (length(signature) < 200000)
);
alter table public.dj_edit_prints enable row level security;
revoke all on public.dj_edit_prints from anon, authenticated;

create or replace function public.register_dj_edit(p_device_id text, p_dj_name text, p_title text, p_contact text, p_signatures text[])
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if p_device_id is null or length(p_device_id) < 30 or length(p_device_id) > 64 then
    raise exception 'invalid device id';
  end if;
  if p_signatures is null or array_length(p_signatures, 1) is null or array_length(p_signatures, 1) > 12 then
    raise exception 'between 1 and 12 fingerprints';
  end if;
  insert into public.dj_edits (dj_name, title, contact, device_id)
  values (trim(p_dj_name), trim(p_title), nullif(trim(coalesce(p_contact, '')), ''), p_device_id)
  returning id into new_id;
  insert into public.dj_edit_prints (edit_id, signature) select new_id, s from unnest(p_signatures) s;
  return new_id;
end $$;
revoke all on function public.register_dj_edit(text, text, text, text, text[]) from public;
grant execute on function public.register_dj_edit(text, text, text, text, text[]) to anon, authenticated;

-- The catalog phones download: approved DJ edits, plus fingerprints taken during a known set
-- (venue lineup, matched at read time, so a lineup added later still labels earlier nights).
create or replace function public.edit_catalog()
returns table (id text, signature text, dj text, title text)
language sql stable security definer set search_path = public as $$
  (select 'dj:' || p.id, p.signature, e.dj_name, e.title
     from public.dj_edit_prints p join public.dj_edits e on e.id = p.edit_id
    where e.status = 'approved')
  union all
  (select 'set:' || ep.id, ep.signature, vs.dj_name, null
     from public.edit_prints ep
     join public.sessions s on s.id = ep.session_id
     join public.venue_sets vs
       on vs.place_id = coalesce(
            (select w.venue_place_id from public.sensor_windows w
              where w.session_id = ep.session_id and w.window_start = date_trunc('minute', ep.captured_at) limit 1),
            s.venue_place_id)
      and ep.captured_at >= vs.starts_at and ep.captured_at < vs.ends_at
    where ep.captured_at > now() - interval '90 days'
    order by ep.captured_at desc
    limit 2000);
$$;
revoke all on function public.edit_catalog() from public;
grant execute on function public.edit_catalog() to anon, authenticated;

-- Deletion and retention
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
  delete from public.edit_prints where device_id = p_device_id;
  delete from public.dj_edits where device_id = p_device_id;
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
  delete from public.edit_prints where captured_at < now() - interval '90 days';
  delete from public.standby_nights where armed_at < now() - interval '24 months';
  delete from public.venue_sets where ends_at < now() - interval '24 months';
  delete from public.sessions where started_at < now() - interval '24 months';
$$;
