/**
 * Discovery source interface — shared contract for all discovery sources.
 */

export interface SourceEpisode {
  url: string;        // canonical URL
  title: string;
  date: string | null; // ISO date or YYYY-MM-DD
  showName?: string;  // e.g. "Love Injection"
}

export interface SourceTrack {
  artist: string;
  title: string;
  timestamp?: string; // e.g. "00:05:23"
}

export interface DiscoverySource {
  name: string; // "nts" | "lotradio"

  // Given a seed track, find episodes that might contain it or related tracks
  searchForSeed(artist: string, title: string): Promise<SourceEpisode[]>;

  // Get the full tracklist for an episode
  getTracklist(episodeUrl: string): Promise<SourceTrack[]>;

  // Get artwork for an episode
  getArtwork(episodeUrl: string): Promise<string | null>;
}
