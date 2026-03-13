-- Enable pgvector
create extension if not exists vector;

-- Tracks: every track the agent discovers
create table tracks (
  id uuid primary key default gen_random_uuid(),
  artist text not null,
  title text not null,
  source text not null,
  source_url text,
  source_context text,
  seed_track_id uuid references tracks(id),
  preview_url text,
  cover_art_url text,
  download_url text,
  storage_path text,
  agent_reason text,
  metadata jsonb default '{}'::jsonb,
  embedding vector(1536),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'downloaded')),
  created_at timestamptz default now(),
  voted_at timestamptz,
  downloaded_at timestamptz
);

-- Seeds: tracks that serve as starting points for discovery
create table seeds (
  id uuid primary key default gen_random_uuid(),
  track_id uuid references tracks(id),
  artist text not null,
  title text not null,
  active boolean default true,
  created_at timestamptz default now()
);

-- Discovery runs: log of each time the agent runs discovery
create table discovery_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz default now(),
  completed_at timestamptz,
  seed_track_id uuid references tracks(id),
  sources_searched text[],
  tracks_found int default 0,
  tracks_added int default 0,
  notes text
);

-- Taste signals: aggregated patterns from votes
create table taste_signals (
  id uuid primary key default gen_random_uuid(),
  signal_type text not null,
  value text not null,
  weight float default 0,
  sample_count int default 0,
  updated_at timestamptz default now(),
  unique(signal_type, value)
);

-- Indexes
create index idx_tracks_status on tracks(status);
create index idx_tracks_created on tracks(created_at desc);
create index idx_tracks_artist_title on tracks(artist, title);
create index idx_seeds_active on seeds(active) where active = true;

-- RLS: open for v1 (single user, no auth)
alter table tracks enable row level security;
alter table seeds enable row level security;
alter table discovery_runs enable row level security;
alter table taste_signals enable row level security;

create policy "allow all" on tracks for all using (true) with check (true);
create policy "allow all" on seeds for all using (true) with check (true);
create policy "allow all" on discovery_runs for all using (true) with check (true);
create policy "allow all" on taste_signals for all using (true) with check (true);
