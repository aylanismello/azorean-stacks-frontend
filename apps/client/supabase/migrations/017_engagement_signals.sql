-- ============================================================================
-- Migration 017: Engagement Signals
-- ============================================================================
-- Adds listen duration and action timing fields to user_tracks so the
-- weight tuning algorithm can distinguish genuine rejections from skip-at-5s.
-- ============================================================================

alter table user_tracks
  add column if not exists listen_pct integer check (listen_pct >= 0 and listen_pct <= 100),
  add column if not exists listen_duration_ms integer,
  add column if not exists action_delay_ms integer;

comment on column user_tracks.listen_pct is
  'Percentage (0-100) of track duration listened before action/navigation';
comment on column user_tracks.listen_duration_ms is
  'Total milliseconds listened before action';
comment on column user_tracks.action_delay_ms is
  'Milliseconds between track starting and user action (approve/reject/skip)';
