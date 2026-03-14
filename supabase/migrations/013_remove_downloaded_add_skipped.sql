-- Remove "downloaded" as a status (it's orthogonal — use downloaded_at/storage_path instead)
-- Add "skipped" status (neutral: listened but no opinion)

-- 1. Migrate any tracks with status='downloaded' → 'approved'
UPDATE tracks SET status = 'approved' WHERE status = 'downloaded';
UPDATE user_tracks SET status = 'approved' WHERE status = 'downloaded';

-- 2. Drop old CHECK and add new one on tracks
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_status_check;
ALTER TABLE tracks ADD CONSTRAINT tracks_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'skipped'));

-- 3. Drop old CHECK and add new one on user_tracks
ALTER TABLE user_tracks DROP CONSTRAINT IF EXISTS user_tracks_status_check;
ALTER TABLE user_tracks ADD CONSTRAINT user_tracks_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'skipped'));

-- 4. Update the episode_track_stats view to handle new statuses
CREATE OR REPLACE VIEW episode_track_stats AS
SELECT
  et.episode_id,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE COALESCE(ut.status, t.status) = 'pending') AS pending,
  COUNT(*) FILTER (WHERE COALESCE(ut.status, t.status) = 'approved') AS approved,
  COUNT(*) FILTER (WHERE COALESCE(ut.status, t.status) = 'rejected') AS rejected,
  COUNT(*) FILTER (WHERE COALESCE(ut.status, t.status) = 'skipped') AS skipped
FROM episode_tracks et
JOIN tracks t ON t.id = et.track_id
LEFT JOIN user_tracks ut ON ut.track_id = t.id
GROUP BY et.episode_id;
