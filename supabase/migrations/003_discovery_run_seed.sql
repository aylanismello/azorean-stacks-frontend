-- Add seed_id to discovery_runs so we can track which seed was used
alter table discovery_runs add column seed_id uuid references seeds(id);

-- Index for looking up runs by seed
create index idx_discovery_runs_seed on discovery_runs(seed_id);
