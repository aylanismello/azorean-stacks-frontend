# Azorean Stacks

Music discovery engine — find tracks through NTS Radio, Lot Radio, and curator affinity.

## URLs

- **Production:** https://azorean-stacks.vercel.app/
- **Repo:** https://github.com/aylanismello/azorean-stacks

## Stack

- **Client:** Next.js (apps/client) — deployed on Vercel
- **Engine:** Bun scripts (apps/engine) — runs locally on Mac mini
- **Database:** Supabase (Postgres + Realtime + Storage)

## Local Dev

```bash
cd apps/client && bun run dev  # runs on port 3004
cd apps/engine && bun run scripts/watcher.ts  # seed/repair/radar engine
```

## Engine Scripts

| Script | Purpose |
|--------|---------|
| `watcher.ts` | Main daemon — seed discovery, track repair, super-like downloads, curator radar |
| `radar-curator.ts` | Autonomous discovery — finds trusted curators from voting patterns |
| `discover.ts` | Manual seed discovery run |
| `update-signals.ts` | Recompute taste scores from voting history |
| `fix-match-types.ts` | One-off: fix episode_seeds match_type from voting data |
| `crawl-lotradio.ts` | Backfill Lot Radio episode index |
