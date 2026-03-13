# Azorean Stacks — Multi-User Architecture

## Overview

Azorean Stacks evolves from a single-user personal tool into a multi-user music discovery platform. The core insight: **tracks and episodes are shared global resources** (a track is a track, an NTS episode is an NTS episode), while **seeds, curation, and taste are personal**.

## Data Model

### Shared (Global)

| Table | Rationale |
|-------|-----------|
| `tracks` | A track exists once. Artist + title + source metadata are facts, not opinions. |
| `episodes` | NTS episodes are crawled once, available to all. No need to re-crawl per user. |
| `episode_seeds` | Links between episodes and seeds. Shared because episodes themselves are shared. |

### Per-User

| Table | Rationale |
|-------|-----------|
| `seeds` | Each user adds their own seed tracks. Two users may seed the same track — that's fine. |
| `user_tracks` | Junction table: each user has their own status (pending/approved/rejected), rating, and notes for any track. |
| `taste_signals` | Derived from each user's voting patterns. Completely personal. |
| `discovery_runs` | Logged per-user so each person can see their own discovery history. |
| `profiles` | Extends Supabase Auth with display name and avatar. |

### The `user_tracks` Junction

This is the key design decision. Previously, `tracks.status` held curation state directly. Now:

- `tracks` stays clean — just metadata about the track itself
- `user_tracks` holds per-user: status, rating (1-5), notes, voted_at, downloaded_at
- When querying tracks for a user, LEFT JOIN `user_tracks` to get their curation state
- A track with no `user_tracks` row for a user = they haven't seen it yet

The old `tracks.status`, `tracks.voted_at`, and `tracks.downloaded_at` columns are preserved but deprecated. They'll be removed in a future migration once all code paths use `user_tracks`.

## Discovery Runs: Shared Crawl, Personal Queue

When User A seeds "Actress — Maze" and User B seeds the same track:

1. The engine crawls NTS once (or reuses cached episodes)
2. Discovered tracks are inserted into `tracks` (global, deduplicated)
3. `user_tracks` rows are created for both User A and User B with status='pending'
4. Each user curates independently — A might approve what B rejects

The `discovery_runs` table records who triggered each run, but the actual track data is shared.

## Auth Architecture

### Stack
- **Supabase Auth** — handles signup, login, session management, OAuth
- **`@supabase/ssr`** — cookie-based auth for Next.js (works with SSR + middleware)
- **Next.js Middleware** — protects all routes except /login, /signup, /auth/callback, and /api/*

### Flow
1. User signs up (email/password or Google OAuth)
2. Supabase Auth creates `auth.users` row
3. Database trigger auto-creates `profiles` row
4. Middleware checks session on every request, redirects to /login if unauthenticated
5. Client-side `AuthProvider` context makes user available to all components
6. API routes use server-side Supabase client to get the authenticated user

### API Routes
- `/api/*` routes are NOT protected by middleware (the engine uses service role keys)
- For user-facing API calls from the client, the Supabase client forwards the user's session cookie
- RLS policies enforce data isolation at the database level

## Row Level Security

| Table | Policy |
|-------|--------|
| `tracks` | Globally readable. Any authenticated user can insert (engine bypasses via service role). |
| `user_tracks` | Users can only CRUD their own rows (`auth.uid() = user_id`). |
| `seeds` | Users can only CRUD their own seeds. |
| `taste_signals` | Users can only see/modify their own signals. |
| `discovery_runs` | Users can only see their own runs. |
| `episodes` | Globally readable. |
| `profiles` | Globally readable. Users can only update their own. |

## Migration Strategy

### Preserving Founder Data

The migration adds nullable `user_id` columns. A `migrate_founder_data(founder_id)` function:

1. Assigns all orphaned seeds to the founder
2. Creates `user_tracks` rows from existing `tracks.status` + `tracks.voted_at`
3. Assigns orphaned taste_signals and discovery_runs

Run after the founder (you) creates their account:
```sql
SELECT migrate_founder_data('your-auth-user-id-here');
```

## Engine Changes Required

The engine scripts (discover.ts, download.ts, update-signals.ts) currently use a service role key and assume single-user. To become multi-user:

### discover.ts
- Accept `user_id` parameter (or derive from seed ownership)
- After inserting tracks into global `tracks` table, also insert `user_tracks` rows for the seed's owner
- If multiple users have the same seed, create `user_tracks` for each

### download.ts
- Downloads serve all users — no change to download logic itself
- Audio files in Supabase Storage remain shared (one copy per track)
- `user_tracks.status = 'downloaded'` updates per-user when their approved track gets downloaded

### update-signals.ts
- Must accept `user_id` and only process that user's `user_tracks` votes
- Upserts to `taste_signals` with the user's ID
- Can be triggered per-user or batch across all users

### status.ts
- Accept `user_id` to show per-user stats
- Query `user_tracks` instead of `tracks.status`

## Future: Social Graph

The `user_tracks` table naturally enables social features:

- "3 other users also approved this track" — `COUNT(*) FROM user_tracks WHERE track_id = X AND status = 'approved'`
- "Users with similar taste" — compare `user_tracks` voting overlap
- Collaborative filtering — recommend tracks approved by similar users
- Shared playlists — query tracks where multiple specified users approved

These are future features but the schema supports them without modification.
