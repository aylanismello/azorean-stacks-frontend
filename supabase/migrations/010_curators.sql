-- ============================================================================
-- Migration 010: Curators (DJs / Show Hosts)
-- ============================================================================
-- A curator = an NTS show. When we crawl episode tracklists, the show
-- behind that episode becomes a curator in our system.
-- Tracks which DJs consistently surface music matching your seeds.

create table curators (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,            -- NTS show alias e.g. "floating-points"
  source text not null default 'nts',
  source_url text,                      -- https://www.nts.live/shows/floating-points
  avatar_url text,                      -- show artwork
  description text,
  location text,
  genres text[] default '{}',
  external_links jsonb default '[]',    -- [{name, url}, ...]
  metadata jsonb default '{}',
  enriched_at timestamptz,              -- last NTS API fetch
  created_at timestamptz default now()
);

create index idx_curators_slug on curators(slug);
create index idx_curators_source on curators(source);

-- RLS: globally readable
alter table curators enable row level security;
create policy "curators_select" on curators for select using (true);
create policy "curators_insert" on curators for insert with check (true);
create policy "curators_update" on curators for update using (true);

-- Link episodes to curators
alter table episodes add column curator_id uuid references curators(id);
create index idx_episodes_curator on episodes(curator_id);

-- Backfill: extract show slug from existing NTS episode URLs
-- URL pattern: https://www.nts.live/shows/{slug}/episodes/{episode-slug}
-- Step 1: create curator rows from distinct show slugs
insert into curators (name, slug, source, source_url)
select distinct
  -- Use slug as initial name (will be enriched later)
  replace(split_part(split_part(url, '/shows/', 2), '/', 1), '-', ' ') as name,
  split_part(split_part(url, '/shows/', 2), '/', 1) as slug,
  'nts' as source,
  'https://www.nts.live/shows/' || split_part(split_part(url, '/shows/', 2), '/', 1) as source_url
from episodes
where url like '%/shows/%/episodes/%'
  and split_part(split_part(url, '/shows/', 2), '/', 1) != ''
on conflict (slug) do nothing;

-- RPC: curator seed stats (how many episodes per curator matched user seeds)
create or replace function curator_seed_stats()
returns table(curator_id uuid, matched_episodes bigint) as $$
  select e.curator_id, count(distinct es.episode_id) as matched_episodes
  from episode_seeds es
  join episodes e on e.id = es.episode_id
  where e.curator_id is not null
  group by e.curator_id
$$ language sql stable;

-- Step 2: link episodes to their curators
update episodes e
set curator_id = c.id
from curators c
where e.url like '%/shows/%/episodes/%'
  and split_part(split_part(e.url, '/shows/', 2), '/', 1) = c.slug
  and e.curator_id is null;
