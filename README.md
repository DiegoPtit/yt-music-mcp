# yt-music-mcp

MCP server + listening history tracker for [th-ch/youtube-music](https://github.com/th-ch/youtube-music).

Control YouTube Music from opencode, Claude Desktop, or any MCP client. Play songs, create mixes, query listening stats, get recommendations based on your actual listening history — all backed by a SQLite database with genre, mood, and audio features (energy, danceability, valence, BPM, acousticness) enriched via Last.fm + Deezer audio analysis.

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
| `ytm_similar_to` | Similar songs by euclidean distance in 5D feature space (energy, danceability, valence, BPM, acousticness) — fallback to genre+artist |
| `ytm_obsessions` | Songs you are obsessing over (many plays in short period) |
| `ytm_revival` | Songs you used to love but haven't listened to in 30+ days |

### AI-Powered Tools (based on audio features)

| Tool | Description |
|------|-------------|
| `ytm_flow_state` | Flow state songs for coding/reading/terminal — filters by BPM, energy, excludes fatigued |
| `ytm_mood_playlist` | Playlist by mood: happy, chill, energetic, focused, sad — uses energy/valence/BPM/acousticness ranges |
| `ytm_burnout_report` | Detects song fatigue (declining progress trend) — auto-injected in session_next context |
| `ytm_smart_playlist` | K-means++ clustering in 5D feature space — cluster names: party, chill, energy, melancholic, etc. |
| `ytm_time_profile` | Listening profile by hour of day and time segment (madrugada/mañana/tarde/noche) |

### Smart Playlists (weather, vibe, party)

| Tool | Description |
|------|-------------|
| `ytm_session_next` | **Main recommendation engine** — accepts `mood`, `vibe`, `genre`, `bpmRange`, `energyLevel`, `mode=history/discover` |
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

When a song crosses the playback threshold, the tracker runs **two parallel enrichment pipelines** asynchronously:

### Pipeline 1: Last.fm (tags → mood)
- Fetches track + artist tags via `track.getInfo` and `artist.getInfo`
- Maps ~100 mood tags to energy/danceability/valence (0–1) via `MOOD_MAP`
- Extracts genre from prioritized list of ~50 known genres

### Pipeline 2: Deezer + Essentia.js (audio analysis)
- Searches Deezer API (no auth required) for the track
- Downloads 30-second MP3 preview
- Decodes to raw PCM via ffmpeg (22050Hz, mono, f32le)
- Analyzes with Essentia.js WASM + custom JS algorithms:
  - **BPM:** Autocorrelation + peak detection with harmonic skip
  - **Energy:** RMS × dynamic range factor
  - **Danceability:** Peak interval regularity (coefficient of variation)
  - **Valence:** Brightness variance + low-energy ratio
  - **Acousticness:** Spectral centroid + low-energy ratio
- Falls back to JS-only algorithms when Essentia WASM methods crash (RhythmExtractor2013, OnsetRate)

**Coverage:** 162/179 songs with energy/valence/danceability, 158 with acousticness (90%+).

---

## Why this repo?

- **Native API integration**: communicates with th-ch/youtube-music's built-in API server, no scraping
- **Real listening context**: recommendations and smart playlists use your actual history
- **Mood detection**: genre tags from Last.fm + audio analysis via Deezer/Essentia.js — energy, danceability, valence, BPM, acousticness
- **6 AI personalization tools**: flow state, mood playlists, burnout detection, smart clustering, time profiling, similarity search in 5D feature space
- **Dual purpose**: MCP server for AI agents + CLI for humans + web dashboard for visual browsing