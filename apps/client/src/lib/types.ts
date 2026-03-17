// =============================================================================
// Shared / Global Entities
// =============================================================================

export interface Track {
  id: string;
  artist: string;
  title: string;
  source: string;
  source_url: string | null;
  source_context: string | null;
  seed_track_id: string | null;
  preview_url: string | null;
  cover_art_url: string | null;
  download_url: string | null;
  storage_path: string | null;
  spotify_url: string | null;
  youtube_url: string | null;

  seed_track: { artist: string; title: string } | null;
  episode: { id: string; title: string | null; source: string; aired_date: string | null; artwork_url: string | null } | null;
  metadata: Record<string, unknown>;
  /** @deprecated Use UserTrack.status instead for multi-user */
  status: "pending" | "approved" | "rejected" | "skipped";
  created_at: string;
  /** @deprecated Use UserTrack.voted_at instead */
  voted_at: string | null;
  /** @deprecated Use UserTrack.downloaded_at instead */
  downloaded_at: string | null;
  dl_attempts: number;
  dl_failed_at: string | null;
  audio_url?: string | null;
  episode_id: string | null;

  // Seed status — null if not seeded, seed UUID if this track is a seed
  seed_id?: string | null;

  // Taste score computed by update-signals.ts (-1..1, 0 = unscored)
  taste_score?: number | null;

  // Joined from user_tracks when querying for a specific user
  user_track?: UserTrack | null;

  // Convenience alias — true when this user has super-liked the track
  super_liked?: boolean;

  // Set by API/page when this track is the seed that triggered the episode
  is_seed?: boolean;
  // Set when this track was discovered via a re-seed chain
  is_re_seed?: boolean;
}

export interface Episode {
  id: string;
  url: string;
  title: string | null;
  source: string;
  aired_date: string | null;
  crawled_at: string;
  skipped: boolean;
  seeds: Array<{ id: string; artist: string; title: string }>;
  track_stats: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
  };
}

export interface EpisodeTrack {
  id: string;
  artist: string;
  title: string;
  status: string;
  spotify_url: string | null;
  youtube_url: string | null;
  storage_path: string | null;
  cover_art_url: string | null;
  preview_url: string | null;
  audio_url?: string | null;
  dl_attempts: number;
  dl_failed_at: string | null;
}

// =============================================================================
// Per-User Entities
// =============================================================================

export interface Profile {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserTrack {
  id: string;
  user_id: string;
  track_id: string;
  status: "pending" | "approved" | "rejected" | "skipped";
  rating: number | null;
  notes: string | null;
  voted_at: string | null;
  downloaded_at: string | null;
  created_at: string;
  super_liked?: boolean;
}

export interface PipelineStatus {
  state: "queued" | "discovering" | "enriching" | "downloading" | "done" | "error";
  progress?: string;
  episode_title?: string;
  log?: Array<{ t: string; msg: string }>;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

export interface SeedStats {
  episodes: number;
  tracks: number;
  enriched: number;
  downloaded: number;
}

export interface Seed {
  id: string;
  user_id: string | null;
  track_id: string | null;
  artist: string;
  title: string;
  active: boolean;
  source?: "manual" | "re-seed" | null;
  created_at: string;
  discovery_count?: number;
  episodes?: Array<{ id: string; title: string | null; url: string; source: string; aired_date: string | null; match_type: string; matched_tracks?: { artist: string; title: string }[]; track_count?: number; enriched_count?: number }>;
  curated_count?: number;
  last_run?: { tracks_found: number; tracks_added: number; started_at: string } | null;
  pipeline_status?: PipelineStatus | null;
  stats?: SeedStats;
}

export interface Curator {
  id: string;
  name: string;
  slug: string;
  source: string;
  source_url: string | null;
  avatar_url: string | null;
  description: string | null;
  location: string | null;
  genres: string[];
  external_links: Array<{ name: string; url: string }>;
  enriched_at: string | null;
  created_at: string;
  // Computed
  episode_count: number;
  matched_episodes: number;
}

export interface DiscoveryRun {
  id: string;
  user_id: string | null;
  started_at: string;
  completed_at: string | null;
  seed_track_id: string | null;
  seed_id: string | null;
  sources_searched: string[] | null;
  tracks_found: number;
  tracks_added: number;
  notes: string | null;
}

export interface TasteSignal {
  id: string;
  user_id: string | null;
  signal_type: string;
  value: string;
  weight: number;
  sample_count: number;
  updated_at: string;
}

export interface Stats {
  total_reviewed: number;
  total_approved: number;
  total_rejected: number;
  approval_rate: number;
  total_pending: number;
  top_artists: { artist: string; count: number }[];
  source_breakdown: { source: string; count: number }[];
  recent_runs: DiscoveryRun[];
}

export interface PipelineEngineEvent {
  type: string;
  status: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface PipelineStats {
  super_likes: { total: number; downloaded: number; pending: number };
  watcher: { connected_at: string | null; last_event: string | null };
  last_events: PipelineEngineEvent[];
}

// =============================================================================
// Auth Types
// =============================================================================

export interface AuthUser {
  id: string;
  email: string | null;
  user_metadata: {
    full_name?: string;
    name?: string;
    avatar_url?: string;
    picture?: string;
  };
}
