"use client";

import { useState } from "react";

interface SeedFormProps {
  onSubmit: (artist: string, title: string) => Promise<void>;
}

export function SeedForm({ onSubmit }: SeedFormProps) {
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!artist.trim() || !title.trim() || submitting) return;
    setSubmitting(true);
    await onSubmit(artist.trim(), title.trim());
    setArtist("");
    setTitle("");
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
      <input
        type="text"
        placeholder="Artist"
        value={artist}
        onChange={(e) => setArtist(e.target.value)}
        className="flex-1 px-4 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder:text-muted focus:outline-none focus:border-accent/50 transition-colors"
      />
      <input
        type="text"
        placeholder="Track title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="flex-1 px-4 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder:text-muted focus:outline-none focus:border-accent/50 transition-colors"
      />
      <button
        type="submit"
        disabled={!artist.trim() || !title.trim() || submitting}
        className="px-6 py-2.5 bg-accent text-surface-0 rounded-lg text-sm font-medium hover:bg-accent-bright transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
      >
        {submitting ? "Adding..." : "Add Seed"}
      </button>
    </form>
  );
}
