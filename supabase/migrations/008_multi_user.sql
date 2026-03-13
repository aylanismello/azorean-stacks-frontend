-- ============================================================================
-- Migration 008: Multi-User Foundation
-- ============================================================================
-- Evolves Azorean Stacks from single-user to multi-user:
--   1. profiles table (extends Supabase Auth)
--   2. user_tracks junction (per-user curation of shared tracks)
--   3. user_id FK on seeds, taste_signals, discovery_runs
--   4. RLS policies for data isolation
--   5. Migrate existing data to founder user
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PROFILES TABLE (extends auth.users)
-- ---------------------------------------------------------------------------
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data ->> 'avatar_url', NEW.raw_user_meta_data ->> 'picture')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ---------------------------------------------------------------------------
-- 2. USER_TRACKS JUNCTION (per-user relationship to shared tracks)
-- ---------------------------------------------------------------------------
-- Tracks themselves remain global (a track is a track).
-- Each user has their own curation state for any track.
CREATE TABLE user_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'downloaded')),
  rating SMALLINT CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  notes TEXT,
  voted_at TIMESTAMPTZ,
  downloaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, track_id)
);

CREATE INDEX idx_user_tracks_user_status ON user_tracks(user_id, status);
CREATE INDEX idx_user_tracks_track ON user_tracks(track_id);
CREATE INDEX idx_user_tracks_user_voted ON user_tracks(user_id, voted_at DESC);

-- ---------------------------------------------------------------------------
-- 3. ADD user_id TO EXISTING TABLES
-- ---------------------------------------------------------------------------

-- Seeds: each user has their own seeds
ALTER TABLE seeds ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Taste signals: per-user taste graph
ALTER TABLE taste_signals ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
-- Drop old unique constraint, replace with user-scoped one
ALTER TABLE taste_signals DROP CONSTRAINT IF EXISTS taste_signals_signal_type_value_key;
ALTER TABLE taste_signals ADD CONSTRAINT taste_signals_user_signal_unique UNIQUE(user_id, signal_type, value);

-- Discovery runs: per-user (records who triggered the run)
ALTER TABLE discovery_runs ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX idx_seeds_user ON seeds(user_id);
CREATE INDEX idx_taste_signals_user ON taste_signals(user_id);
CREATE INDEX idx_discovery_runs_user ON discovery_runs(user_id);

-- ---------------------------------------------------------------------------
-- 4. CLEAN UP TRACKS TABLE
-- ---------------------------------------------------------------------------
-- Move per-user fields off the global tracks table.
-- Keep status/voted_at/downloaded_at temporarily for backward compat,
-- but new code should use user_tracks.
-- We'll mark them as deprecated via a comment.
COMMENT ON COLUMN tracks.status IS 'DEPRECATED: use user_tracks.status instead';
COMMENT ON COLUMN tracks.voted_at IS 'DEPRECATED: use user_tracks.voted_at instead';
COMMENT ON COLUMN tracks.downloaded_at IS 'DEPRECATED: use user_tracks.downloaded_at instead';

-- ---------------------------------------------------------------------------
-- 5. RLS POLICIES
-- ---------------------------------------------------------------------------

-- Drop old permissive policies
DROP POLICY IF EXISTS "allow all" ON tracks;
DROP POLICY IF EXISTS "allow all" ON seeds;
DROP POLICY IF EXISTS "allow all" ON discovery_runs;
DROP POLICY IF EXISTS "allow all" ON taste_signals;
DROP POLICY IF EXISTS "allow all" ON episodes;
DROP POLICY IF EXISTS "allow all" ON episode_seeds;

-- PROFILES: users can read any profile, update only their own
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- TRACKS: globally readable (shared catalog), insertable by authenticated users
-- Service role (engine) bypasses RLS for inserts
CREATE POLICY "tracks_select" ON tracks FOR SELECT USING (true);
CREATE POLICY "tracks_insert" ON tracks FOR INSERT WITH CHECK (true);
CREATE POLICY "tracks_update" ON tracks FOR UPDATE USING (true);

-- USER_TRACKS: users see/modify only their own
ALTER TABLE user_tracks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_tracks_select" ON user_tracks
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_tracks_insert" ON user_tracks
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "user_tracks_update" ON user_tracks
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "user_tracks_delete" ON user_tracks
  FOR DELETE USING (auth.uid() = user_id);

-- SEEDS: users see/modify only their own
CREATE POLICY "seeds_select" ON seeds FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "seeds_insert" ON seeds FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "seeds_update" ON seeds FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "seeds_delete" ON seeds FOR DELETE USING (auth.uid() = user_id);

-- TASTE_SIGNALS: users see/modify only their own
CREATE POLICY "taste_signals_select" ON taste_signals FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "taste_signals_insert" ON taste_signals FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "taste_signals_update" ON taste_signals FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "taste_signals_delete" ON taste_signals FOR DELETE USING (auth.uid() = user_id);

-- DISCOVERY_RUNS: users see only their own runs
CREATE POLICY "discovery_runs_select" ON discovery_runs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "discovery_runs_insert" ON discovery_runs FOR INSERT WITH CHECK (auth.uid() = user_id);

-- EPISODES: globally readable (shared crawl data)
CREATE POLICY "episodes_select" ON episodes FOR SELECT USING (true);
CREATE POLICY "episodes_insert" ON episodes FOR INSERT WITH CHECK (true);
CREATE POLICY "episodes_update" ON episodes FOR UPDATE USING (true);

-- EPISODE_SEEDS: globally readable
CREATE POLICY "episode_seeds_select" ON episode_seeds FOR SELECT USING (true);
CREATE POLICY "episode_seeds_insert" ON episode_seeds FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. UPDATED RPC: per-user episode track stats
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION episode_track_stats(p_user_id UUID DEFAULT NULL)
RETURNS TABLE(episode_id UUID, total BIGINT, pending BIGINT, approved BIGINT, rejected BIGINT) AS $$
  SELECT
    t.episode_id,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE COALESCE(ut.status, t.status) = 'pending') AS pending,
    COUNT(*) FILTER (WHERE COALESCE(ut.status, t.status) IN ('approved', 'downloaded')) AS approved,
    COUNT(*) FILTER (WHERE COALESCE(ut.status, t.status) = 'rejected') AS rejected
  FROM tracks t
  LEFT JOIN user_tracks ut ON ut.track_id = t.id AND ut.user_id = p_user_id
  WHERE t.episode_id IS NOT NULL
  GROUP BY t.episode_id
$$ LANGUAGE SQL STABLE;

-- ---------------------------------------------------------------------------
-- 7. FOUNDER DATA MIGRATION
-- ---------------------------------------------------------------------------
-- This runs as a DO block. The founder user must exist in auth.users first.
-- We use a placeholder approach: after the first user signs up, run:
--
--   SELECT migrate_founder_data('your-auth-user-id');
--
-- This function assigns all existing single-user data to the founder.
CREATE OR REPLACE FUNCTION migrate_founder_data(founder_id UUID)
RETURNS TEXT AS $$
DECLARE
  seed_count INT;
  track_count INT;
  signal_count INT;
  run_count INT;
BEGIN
  -- Assign orphaned seeds
  UPDATE seeds SET user_id = founder_id WHERE user_id IS NULL;
  GET DIAGNOSTICS seed_count = ROW_COUNT;

  -- Create user_tracks from existing tracks with votes
  INSERT INTO user_tracks (user_id, track_id, status, voted_at, downloaded_at)
  SELECT founder_id, id, status, voted_at, downloaded_at
  FROM tracks
  WHERE status != 'pending' OR voted_at IS NOT NULL
  ON CONFLICT (user_id, track_id) DO NOTHING;
  GET DIAGNOSTICS track_count = ROW_COUNT;

  -- Create user_tracks for pending tracks (user's queue)
  INSERT INTO user_tracks (user_id, track_id, status)
  SELECT founder_id, id, 'pending'
  FROM tracks
  WHERE status = 'pending' AND voted_at IS NULL
  ON CONFLICT (user_id, track_id) DO NOTHING;

  -- Assign orphaned taste signals
  UPDATE taste_signals SET user_id = founder_id WHERE user_id IS NULL;
  GET DIAGNOSTICS signal_count = ROW_COUNT;

  -- Assign orphaned discovery runs
  UPDATE discovery_runs SET user_id = founder_id WHERE user_id IS NULL;
  GET DIAGNOSTICS run_count = ROW_COUNT;

  RETURN format('Migrated: %s seeds, %s user_tracks, %s signals, %s runs',
    seed_count, track_count, signal_count, run_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
