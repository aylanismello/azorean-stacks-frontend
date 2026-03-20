# Azorean Stacks — Source of Truth

## Purpose

A.F.M (Fluindo) is a DJ who produces music for his mix show. He needs to constantly discover new tracks on the bleeding edge of the underground. The core insight: **if a DJ on NTS played a song I like, they probably played other songs I'd like too.**

Azorean Stacks automates this by:
1. Taking songs A.F.M already likes ("seeds")
2. Finding NTS radio episodes where those songs were played
3. Pulling every other track from those episodes
4. Ranking them by likelihood A.F.M will want to DJ them
5. Letting him listen, vote, and discover

## Data Pipeline

```
Seeds (manual input)
  ↓
Discover (find NTS episodes containing seed tracks)
  ↓
Episodes + Tracklists (scraped from NTS)
  ↓
Tracks (individual songs extracted from episodes)
  ↓
Enrichment (find Spotify/YouTube URLs for each track)
  ↓
Download (grab audio via yt-dlp, store in Supabase Storage)
  ↓
Scoring (rank tracks by taste profile)
  ↓
Player (serve ranked tracks for listening + voting)
  ↓
Feedback loop (votes update taste signals → better scoring)
```

## Seeds

A **seed** is a track A.F.M likes. Added manually via Spotify URL or playlist import.

- `seeds` table: `id`, `user_id`, `track_id`, `artist`, `title`, `source` ("manual" or "re-seed"), `active`
- A **re-seed** is a track discovered through the pipeline that A.F.M liked enough to plant as a new seed. It feeds back into discovery.

### Seed → Episode matching

Two match types:
- **full match**: the exact seed track (artist + title) appears in the episode's tracklist
- **artist match**: a different track by the same artist appears in the episode's tracklist

Stored in `episode_seeds` table with `match_type`.

## Engine (runner.sh)

A persistent bash loop running on the Mac mini. Runs continuously with 5-second sleep between cycles.

### What runs each cycle:

1. **watcher.ts** (background process)
   - Subscribes to Supabase Realtime
   - Watches for new seeds being added
   - Auto-triggers discovery for new seeds
   - Monitors health, reconnects on disconnect

2. **discover** (per cycle)
   - For each active seed, searches NTS for matching episodes
   - Scrapes episode tracklists
   - Inserts tracks into `tracks` table via `episode_tracks` junction
   - Validates match type before ingesting

3. **download** (per cycle, 55-minute window)
   - Finds tracks with Spotify/YouTube URLs but no local audio
   - Downloads via yt-dlp to local file, uploads to Supabase Storage
   - Concurrency: 15 parallel downloads
   - Max 200 tracks per cycle

### Periodic/manual scripts (NOT in the main loop):

- **update-signals.ts** — Pre-computes `taste_score` for all pending tracks. Should be run periodically.
- **tune-weights.ts** — Adjusts the 5 dynamic weights based on voting history.
- **radar-curator.ts** — Curator-based discovery (experimental)
- **backfill-*.ts** — One-time data repair scripts

## Scoring Systems

### ⚠️ CURRENT STATE: Two separate systems that should be unified

#### System 1: Pre-computed taste_score (FYP / genre views)

**Where:** `update-signals.ts` → writes to `tracks.taste_score` column
**Used by:** `/api/tracks?order_by=taste_score` (FYP, genre stacks)

| Signal | Weight | Description |
|--------|--------|-------------|
| Artist | 25% | Tracks by artists you've approved before score higher |
| Genre | 30% | Tracks in genres you've approved score higher |
| Seed affinity | 20% | Tracks from high-performing seeds score higher |
| Curator | 15% | Tracks from curators (DJs) whose episodes you've liked |
| Episode density | 10% | Tracks from episodes where you approved multiple tracks |

#### System 2: Real-time ranked queue (Seed stacks)

**Where:** `/api/stacks/[id]/queue/route.ts` → computed per request
**Used by:** Seed stack play view

| Signal | Default | Description |
|--------|---------|-------------|
| Seed proximity | 30 pts | full_match > artist_match > unknown |
| Source quality | 25 pts | Episode approval rate from past voting |
| Artist familiarity | 20 pts | Artist appears in other approved tracks |
| Recency | 15 pts | Newer discoveries get a slight boost |
| Co-occurrence | 10 pts | Artist appeared across multiple seed episodes |

Plus: negative penalties (rejected artist -10, bad episode -15, bad curator -5) and momentum (3+ approvals +15, 3+ skips -10).

## User Actions (Voting)

| Action | Status | Effect |
|--------|--------|--------|
| ❤️ Like | `approved` | Positive signal for artist, genre, seed, curator |
| ⭐ Super-like | `approved` + `super_liked` | Strongest positive. Auto-syncs to Spotify. |
| ❌ Reject | `rejected` | Negative signal. Audio deleted. Artist/episode penalized. |
| → Skip | `skipped` | Weak negative. "Not now." |
| ⚠️ Bad source | `bad_source` | NOT a taste signal. Wrong audio. Filtered until re-downloaded. |
| 👂 Listened | `listened` | Auto at 80% playback, no action. Soft skip. |
| 🌿 Re-seed | new seed | Feeds back into discovery. Irreversible. |

Mutually exclusive (except re-seed). Changing vote is allowed.

## UI Indicators

- 🌱 = seed (exact or artist match)
- 🌿 = re-seed
- Vote buttons show filled with vivid color when returning to voted tracks
- Tracklist shows vote status per track (hearts, stars, X's, arrows)

## Spotify Integration

- "Azorean Stacks" playlist — all approved tracks
- "Azorean Super Likes" playlist — only super-liked tracks

## Technical Details

- Next.js (App Router) + Bun + Supabase
- Vercel (client), Mac mini (engine)
- Local dev: `cd apps/client && bun run dev` → localhost:3004
- Test account: see CLAUDE.md (not committed to git)
- Always `npx next build` before push
- Use `Array.from()` not `[...Set]`

## Open Questions

1. Unify the two scoring systems? (Probably yes)
2. Keep real-time session adaptation? (Probably simplify — small dataset, caused bugs)
3. How often recalculate taste_score? (After each voting session? Daily?)
4. Add audio features (BPM, energy) for DJ-relevant ranking?
