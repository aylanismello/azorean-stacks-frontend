-- Track download failures so the downloader can skip broken tracks
alter table tracks add column dl_attempts int not null default 0;
alter table tracks add column dl_failed_at timestamptz;

-- Index for the downloader queue query
create index idx_tracks_download_queue
  on tracks(created_at)
  where status in ('pending', 'approved') and storage_path is null and youtube_url is not null;
