-- Many-to-many: tracks ↔ episodes
-- A track can appear on multiple episode tracklists.
-- Previously tracks.episode_id was a single FK (first-discovered-in).
-- This table captures ALL appearances.

create table episode_tracks (
  episode_id uuid not null references episodes(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  position smallint,  -- tracklist order (0-based, from NTS)
  created_at timestamptz default now(),
  primary key (episode_id, track_id)
);

create index idx_episode_tracks_track on episode_tracks(track_id);
create index idx_episode_tracks_episode on episode_tracks(episode_id);

-- RLS (open, same as other tables)
alter table episode_tracks enable row level security;
create policy "allow all" on episode_tracks for all using (true) with check (true);

-- Backfill from existing tracks.episode_id
insert into episode_tracks (episode_id, track_id)
select episode_id, id
from tracks
where episode_id is not null
on conflict do nothing;

-- Drop the old no-param overload from migration 002 (ambiguous with the default-param version)
drop function if exists episode_track_stats();

-- Replace episode_track_stats to use junction table (keep multi-user support from 008)
create or replace function episode_track_stats(p_user_id uuid default null)
returns table(episode_id uuid, total bigint, pending bigint, approved bigint, rejected bigint) as $$
  select
    et.episode_id,
    count(*) as total,
    count(*) filter (where coalesce(ut.status, t.status) = 'pending') as pending,
    count(*) filter (where coalesce(ut.status, t.status) in ('approved', 'downloaded')) as approved,
    count(*) filter (where coalesce(ut.status, t.status) = 'rejected') as rejected
  from episode_tracks et
  join tracks t on t.id = et.track_id
  left join user_tracks ut on ut.track_id = t.id and ut.user_id = p_user_id
  group by et.episode_id
$$ language sql stable;
