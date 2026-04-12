-- ============================================
-- VibeMeter Validation Experiment Schema
-- ============================================

-- Sessions: one per social outing
create table public.sessions (
  id uuid default gen_random_uuid() primary key,
  device_id text not null,
  venue_name text,
  venue_type text check (venue_type in ('bar', 'club', 'house_party', 'concert', 'rooftop', 'restaurant', 'other')),
  started_at timestamptz not null,
  ended_at timestamptz,
  dwell_minutes integer,
  -- GPS context (no raw coords stored — only arrival/departure state)
  auto_detected boolean default false,
  venue_latitude double precision,
  venue_longitude double precision,
  device_model text,
  os_version text,
  app_version text default '0.1.0',
  created_at timestamptz default now()
);

-- Sensor windows: 1-minute aggregated readings
create table public.sensor_windows (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references public.sessions(id) on delete cascade not null,
  window_start timestamptz not null,
  window_end timestamptz not null,

  -- Audio signals
  avg_db numeric(5,1),
  max_db numeric(5,1),
  db_variance numeric(7,2),
  music_detected boolean,
  estimated_bpm integer,
  audio_classification text check (audio_classification in (
    'silent', 'talking', 'low_music', 'high_music', 'loud_music'
  )),
  bass_presence numeric(3,2),
  mid_high_ratio numeric(3,2),

  -- Motion signals
  accel_magnitude_avg numeric(6,3),
  accel_magnitude_max numeric(6,3),
  accel_variance numeric(8,4),
  gyro_activity_avg numeric(6,3),
  gyro_activity_max numeric(6,3),
  movement_classification text check (movement_classification in (
    'stationary', 'walking', 'swaying', 'dancing', 'jumping'
  )),

  -- Density signals (BLE)
  ble_device_count integer,
  ble_count_delta integer,
  ble_count_trend text check (ble_count_trend in (
    'filling', 'stable', 'thinning', 'unknown'
  )),

  -- GPS signals
  gps_is_at_venue boolean,
  gps_accuracy_meters numeric(5,1),

  -- Engagement signals (Tier 2 — nullable)
  screen_off_ratio numeric(3,2),
  camera_activations integer,

  -- Computed on-device
  computed_energy_score numeric(3,1),
  computed_density_score numeric(3,1),
  computed_movement_score numeric(3,1),
  computed_music_score numeric(3,1),
  computed_vibe_score numeric(3,1),

  created_at timestamptz default now()
);

-- Subjective ratings: user micro-prompts
create table public.subjective_ratings (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references public.sessions(id) on delete cascade not null,
  device_id text not null,
  rating integer check (rating between 1 and 5),
  rated_at timestamptz not null,
  nearest_window_id uuid references public.sensor_windows(id),
  response_time_ms integer,
  created_at timestamptz default now()
);

-- Indexes for analysis queries
create index idx_sensor_windows_session on public.sensor_windows(session_id, window_start);
create index idx_sensor_windows_time on public.sensor_windows(window_start);
create index idx_subjective_ratings_session on public.subjective_ratings(session_id);
create index idx_sessions_device on public.sessions(device_id);
create index idx_sessions_venue_type on public.sessions(venue_type);

-- RLS policies (permissive for validation — tighten for production)
alter table public.sessions enable row level security;
alter table public.sensor_windows enable row level security;
alter table public.subjective_ratings enable row level security;

create policy "Allow all session operations" on public.sessions
  for all using (true) with check (true);
create policy "Allow all sensor_window operations" on public.sensor_windows
  for all using (true) with check (true);
create policy "Allow all rating operations" on public.subjective_ratings
  for all using (true) with check (true);
