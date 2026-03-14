# The Stacks — Discovery Engine

Agent-side scripts for music discovery. Finds tracks via NTS Radio, 1001Tracklists, and Spotify, pushes candidates to Supabase, and handles downloads.

## Setup

```bash
cd azorean-stacks-engine
cp .env.example .env  # fill in credentials
bun install
```

Requires `yt-dlp` for the download pipeline:
```bash
brew install yt-dlp
```

## Scripts

### Discover tracks
```bash
bun run discover                    # all adapters
bun run discover --source nts       # NTS only
bun run discover --source spotify   # Spotify only
bun run discover --source 1001      # 1001Tracklists only
bun run discover --limit 20         # cap candidates
```

### Download approved tracks
```bash
bun run download
```

### Add a seed manually
```bash
bun run manual-seed "Floating Points - Ratio"
bun run manual-seed "Burial" "Archangel"
```

### Import a tracklist
```bash
bun run import-tracklist "https://www.nts.live/shows/floating-points/episodes/..."
bun run import-tracklist "https://www.1001tracklists.com/tracklist/..." --seed "Artist - Title"
```

### Update taste signals
```bash
bun run update-signals
```

## Adapters

| Adapter | Source | Method |
|---------|--------|--------|
| `nts` | NTS Radio | API search → episode tracklists → co-occurrence |
| `1001` | 1001Tracklists | HTML scraping → sibling tracks |
| `spotify` | Spotify | Recommendations + related artists |
| `bandcamp` | Bandcamp | Stubbed for future |

## Persistent Service

The engine can run as a persistent macOS service via `launchd`, cycling discover → download with 30-minute pauses.

### Architecture

```
launchd (com.azorean.stacks-engine)
  └─ runner.sh (loop)
       ├─ bun run discover
       ├─ sleep 30min
       ├─ bun run download
       ├─ sleep 30min
       └─ repeat
```

Each loop iteration runs scripts fresh from disk — editing source code takes effect on the next cycle (hot reload).

### Install & Start

```bash
# Install the CLI
ln -sf ~/.openclaw/workspace/repos/azorean-stacks/azorean-stacks-engine/azorean-engine ~/.local/bin/azorean-engine

# Start the service
azorean-engine start
```

### Commands

```bash
azorean-engine start      # load launchd plist, start running
azorean-engine stop       # unload plist, stop service
azorean-engine restart    # stop + start
azorean-engine status     # show running state, PID, last cycle info
azorean-engine logs       # tail -f the log
azorean-engine logs -n 50 # last 50 log lines
```

### Log & Status Files

| File | Purpose |
|------|---------|
| `~/.openclaw/logs/azorean-engine.log` | Timestamped runner output (auto-truncated to 10k lines) |
| `~/.openclaw/data/azorean-engine-status.json` | Machine-readable cycle status |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key |
| `SPOTIFY_CLIENT_ID` | For Spotify adapter | Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | For Spotify adapter | Spotify app client secret |
