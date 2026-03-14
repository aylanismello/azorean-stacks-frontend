-- Add taste_score column for ranking pending tracks by predicted preference
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS taste_score float DEFAULT 0;

-- Index for efficient ordering by taste_score
CREATE INDEX IF NOT EXISTS idx_tracks_taste_score ON tracks (taste_score DESC NULLS LAST) WHERE status = 'pending';

-- Index for genre filtering via JSONB containment
CREATE INDEX IF NOT EXISTS idx_tracks_genres ON tracks USING gin ((metadata->'genres'));
