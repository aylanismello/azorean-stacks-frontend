-- Episodes: every episode/mix the engine has crawled
create table episodes (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  title text,
  source text not null,       -- 'nts', '1001tracklists'
  aired_date text,            -- from NTS metadata, text for partial dates
  crawled_at timestamptz default now()
);

-- Many-to-many: which seeds led to discovering each episode
create table episode_seeds (
  episode_id uuid not null references episodes(id) on delete cascade,
  seed_id uuid not null references seeds(id) on delete cascade,
  discovered_at timestamptz default now(),
  primary key (episode_id, seed_id)
);

-- FK on tracks linking to their source episode
alter table tracks add column episode_id uuid references episodes(id);

-- Indexes
create index idx_episodes_source on episodes(source);
create index idx_episodes_crawled on episodes(crawled_at desc);
create index idx_tracks_episode on tracks(episode_id);

-- RLS (open, same as existing tables)
alter table episodes enable row level security;
alter table episode_seeds enable row level security;
create policy "allow all" on episodes for all using (true) with check (true);
create policy "allow all" on episode_seeds for all using (true) with check (true);

-- RPC for track status rollup per episode
create or replace function episode_track_stats()
returns table(episode_id uuid, total bigint, pending bigint, approved bigint, rejected bigint) as $$
  select
    t.episode_id,
    count(*) as total,
    count(*) filter (where t.status = 'pending') as pending,
    count(*) filter (where t.status in ('approved', 'downloaded')) as approved,
    count(*) filter (where t.status = 'rejected') as rejected
  from tracks t
  where t.episode_id is not null
  group by t.episode_id
$$ language sql stable;

-- Backfill: create episodes from existing tracks' source_url
insert into episodes (url, title, source, crawled_at)
select distinct on (source_url)
  source_url, source_context, source, min(created_at)
from tracks
where source_url is not null
group by source_url, source_context, source
on conflict (url) do nothing;

-- Backfill: link existing tracks to their episodes
update tracks t
set episode_id = e.id
from episodes e
where t.source_url = e.url and t.episode_id is null;
