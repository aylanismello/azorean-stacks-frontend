"use client";

import { useState } from "react";

interface SeedFormProps {
  onSubmit: (input: string) => Promise<void>;
}

export function SeedForm({ onSubmit }: SeedFormProps) {
  const [mode, setMode] = useState<"manual" | "spotify">("manual");
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [spotifyUrl, setSpotifyUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = mode === "spotify"
    ? spotifyUrl.trim().length > 0
    : title.trim().length > 0 && artist.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const input = mode === "spotify"
        ? spotifyUrl.trim()
        : `${artist.trim()} — ${title.trim()}`;
      await onSubmit(input);
      setTitle("");
      setArtist("");
      setSpotifyUrl("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Mode tabs */}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setMode("manual")}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            mode === "manual"
              ? "bg-accent/15 text-accent"
              : "text-muted/60 hover:text-muted"
          }`}
        >
          Track
        </button>
        <button
          type="button"
          onClick={() => setMode("spotify")}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
            mode === "spotify"
              ? "bg-green-400/15 text-green-400"
              : "text-muted/60 hover:text-muted"
          }`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
          Spotify
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 flex-1">
        {mode === "manual" ? (
          <>
            <input
              type="text"
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="flex-1 min-w-0 px-4 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50 transition-colors"
            />
            <span className="text-xs text-muted/40 flex-shrink-0">by</span>
            <input
              type="text"
              placeholder="Artist"
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              className="flex-1 min-w-0 px-4 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50 transition-colors"
            />
          </>
        ) : (
          <input
            type="text"
            placeholder="https://open.spotify.com/track/..."
            value={spotifyUrl}
            onChange={(e) => setSpotifyUrl(e.target.value)}
            className="flex-1 px-4 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-green-400/50 transition-colors"
          />
        )}
        <button
          type="submit"
          disabled={!canSubmit || submitting}
          className="px-5 py-2.5 bg-accent text-surface-0 rounded-lg text-sm font-medium hover:bg-accent-bright transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {submitting ? "..." : "Add"}
        </button>
      </form>
    </div>
  );
}
