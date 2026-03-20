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

## Architecture Decisions (decided 2026-03-19)

### 1. Player owns ALL state — page is a dumb view

GlobalPlayerProvider is the single source of truth for queue, current track, and playback. page.tsx has ZERO track state.

- Page fetches tracks from API → hands to provider via `setQueue()` → done
- TrackCard reads from `globalPlayer.currentTrack`
- Tracklist reads from `globalPlayer.queue`
- Voting calls API → provider updates the track in its own queue
- Navigation → player state survives (provider never unmounts)
- `next()` = index + 1. Tracklist and player are the same array. Always.

This is how Spotify works. Player is a global singleton. Pages are views.

### 2. Unified scoring — one algorithm, pre-computed

Merge both scoring systems into one. Pre-computed by the engine, stored per track.

Signals: artist affinity, genre affinity, seed proximity, curator trust, episode density, co-occurrence, negative signals (rejected artists/episodes).

Runs in the engine after voting sessions end (10min inactivity) and when new tracks are ingested. Not per-request. Not mid-session.

### 3. No real-time session adaptation

Zero client-side queue manipulation mid-session. No filtering, reordering, or momentum in the client. Skip what you don't like. Engine learns from skips for next session.

### 4. Queue diversity at sort-time only

Diversity rules applied server-side when building the batch:
- Max 2 consecutive same episode
- Max 2 consecutive same artist
- Genre spacing
- 20% exploration wildcards (medium-scored tracks for discovery)

Client plays them in order, as-is.

### 5. Batch size: 20, tracklist fully visible

20 tracks per batch. Full tracklist visible for auditing. No hiding.

### 6. Taste signals on all tracks

One scoring system = every track has components. No blank modal sections.

### 7. Full user isolation — votes only in user_tracks (future)

**Decision:** Stop writing vote statuses to `tracks.status`. All user opinions live in `user_tracks` only. `tracks.status` reflects pipeline state only (pending/downloaded/failed).

**Why:** Currently approve/reject/skip write to BOTH `tracks.status` (global) AND `user_tracks.status` (per-user), but bad_source/listened only write to `user_tracks`. This inconsistency causes bugs (bad_source tracks reappearing in FYP) and makes multi-user impossible — one user's reject changes the track for everyone.

**The model:**
- `tracks` = shared immutable pool. Pipeline state only.
- `seeds` = shared garden. Any user plants, everyone benefits from discovery.
- `user_tracks` = ALL user opinions (votes, scores, super_liked). Per-user.
- `taste_signals` = per-user taste profile (already has user_id).

**What changes:** Vote endpoint stops writing to `tracks.status`. All reads go through `user_tracks` for current user. Scoring engine uses `user_tracks` exclusively. Stats page reads from `user_tracks`.

**Status:** Not yet implemented. PR #122 is a bandaid (filters bad_source/listened on read). Full refactor is a separate task.

## Future Considerations

1. Audio features (BPM, energy, key) for DJ-relevant ranking
2. Lot Radio and other sources beyond NTS
3. Multi-user collaborative filtering
4. Playlist-aware scoring (DJ set flow)
