-- "Here is your set" for DJs (build 31): a small, aggregated report per DJ set, shown inside the app.
-- Created as a draft by analysis/dj_report.py; the owner releases it ('sent'); the DJ opens it with
-- its code (vibemeter://set?code=...) and approves, claims an unidentified stretch, or declines
-- (which empties the report). Only aggregates (>= 3 phones per minute); no identifiers.

create table if not exists public.dj_reports (
  code text primary key check (code ~ '^[A-Z2-9]{8,12}$'),
  venue_name text,
  dj_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  phones integer,
  report jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'sent', 'approved', 'declined')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);

create table if not exists public.dj_report_claims (
  id uuid primary key default gen_random_uuid(),
  code text not null references public.dj_reports(code) on delete cascade,
  track_start timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.dj_reports enable row level security;
alter table public.dj_report_claims enable row level security;
revoke all on public.dj_reports from anon, authenticated;
revoke all on public.dj_report_claims from anon, authenticated;

-- The report for a code, only once released and before it expires
create or replace function public.get_dj_report(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select r.report || jsonb_build_object('status', r.status, 'venue', r.venue_name, 'dj', r.dj_name,
                                        'start', r.starts_at, 'end', r.ends_at, 'phones', r.phones)
    from public.dj_reports r
   where r.code = upper(trim(p_code)) and r.status in ('sent', 'approved') and r.expires_at > now();
$$;

-- approve: the DJ is fine with it; decline: the report is emptied; claim: "this unidentified stretch is mine"
create or replace function public.respond_dj_report(p_code text, p_action text, p_track_start timestamptz default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare c text := upper(trim(p_code));
begin
  if not exists (select 1 from public.dj_reports where code = c and status in ('sent', 'approved') and expires_at > now()) then
    return false;
  end if;
  if p_action = 'approve' then
    update public.dj_reports set status = 'approved', responded_at = now() where code = c;
  elsif p_action = 'decline' then
    update public.dj_reports set status = 'declined', report = '{}'::jsonb, responded_at = now() where code = c;
    delete from public.dj_report_claims where code = c;
  elsif p_action = 'claim' and p_track_start is not null then
    insert into public.dj_report_claims (code, track_start) values (c, p_track_start);
  else
    return false;
  end if;
  return true;
end $$;

revoke all on function public.get_dj_report(text) from public;
revoke all on function public.respond_dj_report(text, text, timestamptz) from public;
grant execute on function public.get_dj_report(text) to anon, authenticated;
grant execute on function public.respond_dj_report(text, text, timestamptz) to anon, authenticated;
