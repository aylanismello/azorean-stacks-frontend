#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";

const args = Bun.argv.slice(2);

if (args.length === 0) {
  console.log(`Usage: bun run scripts/manual-seed.ts "Artist - Title"`);
  console.log(`       bun run scripts/manual-seed.ts "Artist" "Title"`);
  process.exit(1);
}

let artist: string;
let title: string;

if (args.length === 1) {
  const parts = args[0].split(" - ");
  if (parts.length < 2) {
    console.error('Invalid format. Use "Artist - Title" or provide two arguments.');
    process.exit(1);
  }
  artist = parts[0].trim();
  title = parts.slice(1).join(" - ").trim();
} else {
  artist = args[0].trim();
  title = args.slice(1).join(" ").trim();
}

if (!artist || !title) {
  console.error("Both artist and title are required.");
  process.exit(1);
}

async function main() {
  const db = getSupabase();
  console.log(`Adding seed: ${artist} - ${title}`);

  // Check for existing track to link
  const { data: existingTrack } = await db
    .from("tracks")
    .select("id")
    .ilike("artist", artist)
    .ilike("title", title)
    .limit(1)
    .maybeSingle();

  const { data, error } = await db
    .from("seeds")
    .insert({
      artist,
      title,
      track_id: existingTrack?.id || null,
      active: true,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to add seed: ${error.message}`);

  console.log(`Seed added: ${data.id}`);
  console.log(`  Artist: ${data.artist}`);
  console.log(`  Title: ${data.title}`);
  console.log(`  Linked track: ${data.track_id || "none"}`);
  console.log(`  Active: ${data.active}`);
}

main().catch((err) => {
  console.error("Failed to add seed:", err);
  process.exit(1);
});
