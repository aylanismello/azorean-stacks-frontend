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

  metadata: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "downloaded";
  created_at: string;
  voted_at: string | null;
  downloaded_at: string | null;
  dl_attempts: number;
  dl_failed_at: string | null;
  audio_url?: string | null;
  episode_id: string | null;
}

export interface Seed {
  id: string;
  track_id: string | null;
  artist: string;
  title: string;
  active: boolean;
  created_at: string;
  discovery_count?: number;
  episodes?: Array<{ id: string; title: string | null; url: string; source: string; aired_date: string | null }>;
  last_run?: { tracks_found: number; tracks_added: number; started_at: string } | null;
}

export interface DiscoveryRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  seed_track_id: string | null;
  sources_searched: string[] | null;
  tracks_found: number;
  tracks_added: number;
  notes: string | null;
}

export interface TasteSignal {
  id: string;
  signal_type: string;
  value: string;
  weight: number;
  sample_count: number;
  updated_at: string;
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
