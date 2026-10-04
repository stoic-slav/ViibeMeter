-- Battery check: level (0-100) when a session starts and ends, and whether Low Power Mode was on.
alter table public.sessions
  add column if not exists battery_start_pct real,
  add column if not exists battery_end_pct real,
  add column if not exists low_power_mode boolean;
