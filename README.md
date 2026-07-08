# yt-music-mcp

MCP server + listening history tracker for [th-ch/youtube-music](https://github.com/th-ch/youtube-music).

Control YouTube Music from opencode, Claude Desktop, or any MCP client. Play songs, create mixes, query listening stats, and get recommendations based on your actual listening history.

---

## Prerequisite

**th-ch/youtube-music** with the **api-server** plugin enabled.

The api-server exposes an HTTP API at `http://0.0.0.0:26538` (default). The MCP server cannot connect without it.

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
```

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

### History & Stats

| Tool | Description |
|------|-------------|
| `ytm_history` | Listening history (sortable: `recent`, `plays`, `liked`) |
| `ytm_stats` | Statistics: total songs, genres, top artists |
| `ytm_recommend` | Recommendations based on your actual listening history |

---

## Listening History Tracker

`tracker.js` connects to the YT Music api-server and automatically records every song that exceeds **45%** playback.

### Per-song data tracked:

- `title`, `artist`, `album`, `duration`
- `genre` (resolved via: local map → MusicBrainz → InnerTube → cache)
- `likeState` (LIKE / DISLIKE / INDIFFERENT)
- `playCount`, `timesCompleted`
- `listenDates[]` with timestamps for each threshold crossing
- Date-based classification (`byDate`)

### Start the tracker:

```bash
node tracker.js
```

Or as a systemd user service:

```bash
systemctl --user enable --now $(pwd)/systemd/yt-music-history.service
```

---

## CLI: `yt-history`

```bash
yt-history stats          # General statistics
yt-history list           # Songs sorted by date
yt-history list plays     # Songs sorted by play count
yt-history top 10         # Top 10 most played
yt-history genres         # Genre breakdown
yt-history search <q>     # Search history
yt-history date YYYY-MM-DD  # Songs from a specific date
yt-history watch          # Real-time monitor
yt-history export         # Full JSON export
```

---

## Mix Workflow

`ytm_mix` implements the empirically discovered workflow for creating properly ordered mixes:

1. Clear the queue
2. Play the first song
3. Queue remaining songs with `position=next` in **reverse order**

Each `queue_add` with `position=next` inserts immediately after the current track. By inserting from last to first, the final queue order matches the requested order.

---

## Architecture

```
th-ch/youtube-music (api-server :26538)
        │
        ├── tracker.js ───→ listening-history.json
        │
        └── mcp-server.js ──→ opencode / Claude / any MCP client
                                  │
                                  └── yt-history.js (CLI)
```

The tracker and MCP server are independent. Use either one or both.

---

## Why this repo?

- **Native API integration**: communicates with th-ch/youtube-music's built-in API server, no fragile scraping
- **Real listening context**: recommendations use your actual history, not generic charts
- **Exact mix ordering**: `ytm_mix` guarantees songs play in the order you specify
- **Dual purpose**: works as an MCP server for AI agents and as a CLI for humans
