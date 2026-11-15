-- Build 32: sessions started from an arrival or late-night nudge notification ("express start").
alter table public.sessions drop constraint if exists sessions_start_source_check;
alter table public.sessions add constraint sessions_start_source_check check (start_source in ('manual', 'standby', 'nudge'));
comment on column public.sessions.start_source is 'manual, standby (Going out prompt accepted) or nudge (arrival / late-night notification); null before build 24';
