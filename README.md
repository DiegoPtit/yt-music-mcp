# yt-music-mcp

MCP server + listening history tracker for [th-ch/youtube-music](https://github.com/th-ch/youtube-music).

Control YouTube Music from opencode, Claude Desktop, or any MCP client. Play songs, create mixes, query listening stats, get recommendations based on your actual listening history — all backed by a SQLite database with genre, mood, and BPM enrichment via Last.fm.

---

## Prerequisite

**th-ch/youtube-music** with the **api-server** plugin enabled.

The api-server exposes an HTTP API. The MCP server cannot connect without it.

From the YT Music UI: `Plugins → api-server → enabled`. Or add it in `config.json`:

```json
"plugins": {
  "api-server": {
    "enabled": true,
    "port": 26538
  }
}
```

---

## Installation

```bash
git clone https://github.com/DiegoPtit/yt-music-mcp
cd yt-music-mcp
npm install
cp .env.example .env    # then edit .env with your secrets
```

### Environment variables

All secrets and configuration go in `.env` (not tracked in git):

```env
YT_MUSIC_HOST=0.0.0.0
YT_MUSIC_PORT=26538
YT_MUSIC_AUTH=your_api_server_auth

LASTFM_API_KEY=your_lastfm_api_key
LASTFM_API_SECRET=your_lastfm_api_secret

SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback

DASHBOARD_PORT=3456
TRACKER_THRESHOLD=45
TRACKER_POLL_INTERVAL=2000
```

See `.env.example` for the full list.

### Register with opencode

Add this to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "yt-music": {
      "type": "local",
      "command": ["node", "/path/to/yt-music-mcp/mcp-server.js"],
      "enabled": true,
      "timeout": 15000
    }
  }
}
```

For other MCP clients (Claude Desktop, etc.), configure the command `node /path/to/yt-music-mcp/mcp-server.js`.

---

## MCP Server Tools

### Playback

| Tool | Description |
|------|-------------|
| `ytm_now` | Current song: title, artist, album, progress, like state |
| `ytm_play_pause` | Toggle play/pause |
| `ytm_next` | Next track |
| `ytm_previous` | Previous track |
| `ytm_play_song` | Play by `videoId` or by `query` (search + play) |
| `ytm_mix` | Create a mix: clear queue, play first song, queue the rest in order |
| `ytm_playlist_start` | Start a playlist/radio by `videoId` or `query` |
| `ytm_seek` | Seek to position (seconds) |
| `ytm_volume` | Volume 0–100 |

### Queue

| Tool | Description |
|------|-------------|
| `ytm_queue` | View current queue |
| `ytm_queue_add` | Add song to queue (`position`: `end` or `next`) |
| `ytm_queue_clear` | Clear the queue |

### Interaction

| Tool | Description |
|------|-------------|
| `ytm_like` | Like the current song |
| `ytm_dislike` | Dislike the current song |
| `ytm_search` | Search for songs, albums, playlists |
| `ytm_search_and_play` | Search + play in one step, returns metadata |

### History & Stats

| Tool | Description |
|------|-------------|
| `ytm_history` | Listening history (sortable: `recent`, `plays`, `liked`) |
| `ytm_stats` | Statistics: total songs, genres, top artists |
| `ytm_recommend` | Recommendations based on your actual listening history |
| `ytm_wrapped` | Weekly/monthly wrapped summary (like Spotify Wrapped) |
| `ytm_similar_to` | Similar songs from your history (same artist + same genre) |
| `ytm_obsessions` | Songs you are obsessing over (many plays in short period) |
| `ytm_revival` | Songs you used to love but haven't listened to in 30+ days |

### Smart Playlists

| Tool | Description |
|------|-------------|
| `ytm_vibe_play` | Auto-mix based on current hour/day patterns from your history |
| `ytm_discover_weekly` | Discover new songs from your top genres on YT Music |
| `ytm_weather_play` | Playlist by vibe (morning/afternoon/night/rainy/sunny/chill) |
| `ytm_fiesta_mode` | Boost volume + crossfade if recent songs are high-energy |
| `ytm_lyrics` | Get synced lyrics for the current song (via YT Music) |

---

## Listening History Tracker

`tracker.js` connects to the YT Music api-server and automatically records every song that exceeds the configured **threshold** (default 45%).

### Per-song data tracked:

- `title`, `artist`, `album`, `duration`
- `genre`, `energy`, `danceability`, `valence` (enriched via Last.fm tags)
- `bpm` (from MusicBrainz tags or duration-based heuristic)
- `likeState` (LIKE / DISLIKE / INDIFFERENT)
- `playCount`, `listenDates[]` with timestamps
- Max playback progress

### Start the tracker:

```bash
node tracker.js
```

Or as a systemd user service:

```bash
systemctl --user enable --now $(pwd)/systemd/yt-music-history.service
```

---

## Dashboard

A Vue 3 web dashboard with a 9-slide carousel:

```bash
npm run dashboard
# Opens at http://localhost:3456
```

**Slides:** Overview stats, Top Songs, Top Artists, Top Genres, Today (live), Heatmap (weekly/monthly or hourly), Hourly Distribution, Obsessions, Revival.

Period selector: `today` / `week` / `month`.

---

## CLI: `yt-history`

```bash
npm run yt-history stats          # General statistics
npm run yt-history list           # Songs sorted by date
npm run yt-history list plays     # Songs sorted by play count
npm run yt-history top 10         # Top 10 most played
npm run yt-history genres         # Genre breakdown
npm run yt-history search <q>     # Search history
npm run yt-history date YYYY-MM-DD  # Songs from a specific date
npm run yt-history watch          # Real-time monitor
npm run yt-history export         # Full JSON export
npm run yt-history bpm            # BPM data
npm run yt-history obsessions     # Obsessions detection
npm run yt-history revival        # Forgotten songs
npm run yt-history heatmap        # Listening heatmap
```

---

## Architecture

```
th-ch/youtube-music (api-server :26538)
        │
        ├── tracker.js ───→ SQLite (listening-history.db)
        │                       │
        │                       └── Last.fm API (genre, energy, mood)
        │
        └── mcp-server.js ──→ opencode / Claude / any MCP client
                │
                ├── dashboard-server.js ──→ Vue 3 frontend (:3456)
                └── yt-history.js (CLI)
```

The tracker, MCP server, and dashboard are independent processes. Use any combination.

---

## Data Enrichment

When a song crosses the playback threshold, the tracker:

1. **Records** it to SQLite (`songs` + `listen_dates` tables)
2. **Enriches** via Last.fm API — fetches track/artist tags, maps mood tags to energy/danceability/valence (0–1 scale), extracts genre
3. **Estimates BPM** — tries MusicBrainz recording tags first, falls back to duration-based heuristic
4. **Updates genre** cache for future lookups

All enrichment runs asynchronously — the tracker never blocks on external APIs.

---

## Why this repo?

- **Native API integration**: communicates with th-ch/youtube-music's built-in API server, no scraping
- **Real listening context**: recommendations and smart playlists use your actual history
- **Mood detection**: genre tags from Last.fm map to estimated energy, danceability, and valence
- **Dual purpose**: MCP server for AI agents + CLI for humans + web dashboard for visual browsing