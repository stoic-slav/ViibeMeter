-- A standby the app never ended (killed) is closed at the next launch as 'interrupted'.
alter table public.standby_nights drop constraint if exists standby_nights_end_reason_check;
alter table public.standby_nights add constraint standby_nights_end_reason_check
  check (end_reason in ('user', 'morning', 'max_duration', 'low_battery', 'session_ended', 'deleted', 'interrupted'));
