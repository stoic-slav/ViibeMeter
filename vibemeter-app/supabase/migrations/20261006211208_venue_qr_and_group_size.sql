-- Build 17: venue QR codes (venue_source 'qr') and a live group count for the Group sheet.
alter table public.sessions drop constraint if exists sessions_venue_source_check;
alter table public.sessions add constraint sessions_venue_source_check
  check (venue_source in ('auto', 'manual', 'qr'));

-- How many phones are in a group right now: distinct devices with a running session (started
-- in the last 12 h, not ended) on that code. A count only, no rows or IDs.
create or replace function public.group_size(p_code text)
returns integer language sql stable security definer set search_path = public as $$
  select count(distinct device_id)::int
  from public.sessions
  where event_code = upper(trim(p_code))
    and started_at > now() - interval '12 hours'
    and ended_at is null;
$$;
revoke all on function public.group_size(text) from public;
grant execute on function public.group_size(text) to anon, authenticated;
