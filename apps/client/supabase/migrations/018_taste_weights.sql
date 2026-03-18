-- ============================================================================
-- Migration 018: Taste Weights
-- ============================================================================
-- Stores the 5 scoring weights for the ranked queue algorithm.
-- tune-weights.ts inserts a new row whenever it recalculates.
-- The queue endpoint reads the latest row (ordered by created_at DESC).
-- Defaults sum to 100: proximity=30, quality=25, familiarity=20,
-- recency=15, co_occurrence=10.
-- ============================================================================

create table if not exists taste_weights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  seed_proximity float not null default 30.0,
  source_quality float not null default 25.0,
  artist_familiarity float not null default 20.0,
  recency float not null default 15.0,
  co_occurrence float not null default 10.0,
  created_at timestamptz not null default now()
);

create index if not exists idx_taste_weights_user_created
  on taste_weights(user_id, created_at desc);

-- RLS
alter table taste_weights enable row level security;

create policy "Users can read own taste weights"
  on taste_weights for select
  using (auth.uid() = user_id);

create policy "Service role manages taste weights"
  on taste_weights for all
  using (true)
  with check (true);
