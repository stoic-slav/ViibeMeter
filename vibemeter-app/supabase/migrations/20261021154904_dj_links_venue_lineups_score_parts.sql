-- Build 26: links for DJs and their edits, venues editing their own lineup, and the recap's score
-- parts stored with each 👍/👎 (so the analysis can fit the weights).

-- DJ links (SoundCloud / Instagram / Beatport …), public profile pages only
alter table public.dj_edits add column if not exists link text
  check (link is null or (length(link) <= 300 and link ~ '^https://'));
alter table public.venue_sets add column if not exists dj_link text
  check (dj_link is null or (length(dj_link) <= 300 and dj_link ~ '^https://'));

-- The recap's four signals with each answer
alter table public.song_feedback
  add column if not exists intensity real,
  add column if not exists entrainment real,
  add column if not exists persistence real,
  add column if not exists lift real;

-- Registration now takes an optional link (calls without it keep working)
drop function if exists public.register_dj_edit(text, text, text, text, text[]);
create or replace function public.register_dj_edit(p_device_id text, p_dj_name text, p_title text, p_contact text, p_signatures text[], p_link text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if p_device_id is null or length(p_device_id) < 30 or length(p_device_id) > 64 then
    raise exception 'invalid device id';
  end if;
  if p_signatures is null or array_length(p_signatures, 1) is null or array_length(p_signatures, 1) > 12 then
    raise exception 'between 1 and 12 fingerprints';
  end if;
  insert into public.dj_edits (dj_name, title, contact, device_id, link)
  values (trim(p_dj_name), trim(p_title), nullif(trim(coalesce(p_contact, '')), ''), p_device_id, nullif(trim(coalesce(p_link, '')), ''))
  returning id into new_id;
  insert into public.dj_edit_prints (edit_id, signature) select new_id, s from unnest(p_signatures) s;
  return new_id;
end $$;
revoke all on function public.register_dj_edit(text, text, text, text, text[], text) from public;
grant execute on function public.register_dj_edit(text, text, text, text, text[], text) to anon, authenticated;

-- Catalog and lineups now return links
drop function if exists public.edit_catalog();
create function public.edit_catalog()
returns table (id text, signature text, dj text, title text, link text)
language sql stable security definer set search_path = public as $$
  (select 'dj:' || p.id, p.signature, e.dj_name, e.title, e.link
     from public.dj_edit_prints p join public.dj_edits e on e.id = p.edit_id
    where e.status = 'approved')
  union all
  (select 'set:' || ep.id, ep.signature, vs.dj_name, null, vs.dj_link
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

drop function if exists public.venue_sets_for(text, timestamptz, timestamptz);
create function public.venue_sets_for(p_place_id text, p_from timestamptz, p_to timestamptz)
returns table (dj_name text, dj_link text, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select dj_name, dj_link, starts_at, ends_at from public.venue_sets
   where place_id = p_place_id and starts_at < p_to and ends_at > p_from
     and p_to - p_from <= interval '24 hours'
   order by starts_at;
$$;
revoke all on function public.venue_sets_for(text, timestamptz, timestamptz) from public;
grant execute on function public.venue_sets_for(text, timestamptz, timestamptz) to anon, authenticated;

-- Venues edit their own lineup with an edit code we give them. Only the code's SHA-256 is stored.
-- Create one:  insert into public.venue_editors (place_id, venue_name, code_hash)
--   values ('<place id>', '<name>', encode(extensions.digest('<CODE>', 'sha256'), 'hex'));
create table if not exists public.venue_editors (
  place_id text primary key,
  venue_name text not null,
  code_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.venue_editors enable row level security;
revoke all on public.venue_editors from anon, authenticated;

create or replace function public.venue_editor_check(p_place_id text, p_code text)
returns text language sql stable security definer set search_path = public as $$
  select venue_name from public.venue_editors
   where place_id = p_place_id and code_hash = encode(extensions.digest(coalesce(p_code, ''), 'sha256'), 'hex');
$$;

-- Replaces the venue's sets that start in [p_from, p_to) with p_sets: [{ dj_name, dj_link, starts_at, ends_at }]
create or replace function public.save_venue_lineup(p_place_id text, p_code text, p_from timestamptz, p_to timestamptz, p_sets jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if public.venue_editor_check(p_place_id, p_code) is null then
    raise exception 'wrong venue code';
  end if;
  if p_to - p_from > interval '24 hours' or p_to <= p_from then
    raise exception 'one night at a time';
  end if;
  if jsonb_typeof(p_sets) <> 'array' or jsonb_array_length(p_sets) > 30 then
    raise exception 'at most 30 sets';
  end if;
  delete from public.venue_sets where place_id = p_place_id and starts_at >= p_from and starts_at < p_to;
  insert into public.venue_sets (place_id, dj_name, dj_link, starts_at, ends_at)
  select p_place_id, trim(e->>'dj_name'), nullif(trim(coalesce(e->>'dj_link', '')), ''),
         (e->>'starts_at')::timestamptz, (e->>'ends_at')::timestamptz
    from jsonb_array_elements(p_sets) e
   where length(trim(coalesce(e->>'dj_name', ''))) between 1 and 80;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.venue_editor_check(text, text), public.save_venue_lineup(text, text, timestamptz, timestamptz, jsonb) from public;
grant execute on function public.venue_editor_check(text, text), public.save_venue_lineup(text, text, timestamptz, timestamptz, jsonb) to anon, authenticated;
