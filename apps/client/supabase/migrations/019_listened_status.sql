-- Add 'listened' status to user_tracks
-- 'listened' means the user heard past 80% without taking an explicit action (soft skip)
-- This is a per-user state only — does NOT appear on the global tracks table

ALTER TABLE user_tracks DROP CONSTRAINT IF EXISTS user_tracks_status_check;
ALTER TABLE user_tracks ADD CONSTRAINT user_tracks_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'skipped', 'listened'));
