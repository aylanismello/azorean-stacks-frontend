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
  agent_reason: string | null;
  metadata: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "downloaded";
  created_at: string;
  voted_at: string | null;
  downloaded_at: string | null;
}

export interface Seed {
  id: string;
  track_id: string | null;
  artist: string;
  title: string;
  active: boolean;
  created_at: string;
  discovery_count?: number;
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
