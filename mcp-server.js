#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const API_BASE = `http://${process.env.YT_MUSIC_HOST || '0.0.0.0'}:${process.env.YT_MUSIC_PORT || '26538'}`;
const AUTH_ID = process.env.YT_MUSIC_AUTH;
const LATITUDE = process.env.LATITUDE || '8.6206';
const LONGITUDE = process.env.LONGITUDE || '-70.2310';
const db = require('./db');
const features = require('./features-ai');

let token = null;

let weatherCache = { data: null, fetchedAt: 0 };
const WEATHER_CACHE_TTL = 30 * 60 * 1000;

let searchQueue = Promise.resolve();
function serializedSearch(endpoint, opts) {
  const task = searchQueue.then(() => api(endpoint, opts));
  searchQueue = task.catch(() => {});
  return task;
}

async function getToken() {
  if (token) return token;
  const res = await fetch(`${API_BASE}/auth/${AUTH_ID}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Auth: ${res.status}`);
  token = (await res.json()).accessToken;
  return token;
}

async function api(endpoint, opts = {}) {
  const t = await getToken();
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...opts.headers },
    method: opts.method || 'GET',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout || 5000),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${endpoint}: ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function resolveVideoId(videoId, opts = {}) {
  const valid = videoId && /^[\w-]{11}$/.test(videoId);
  if (!valid) return null;
  try {
    const res = await fetch(`https://music.youtube.com/youtubei/v1/player?key=${process.env.YT_INNERTUBE_KEY || 'AIzaSyC9XL3ZjBdd0deK2q1kR0mGnS1lW4P3O8k'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250325.01.00' } },
        videoId,
      }),
      signal: AbortSignal.timeout(opts.timeout || 3000),
    });
    const data = await res.json();
    return data?.videoDetails?.videoId || null;
  } catch { return null; }
}

async function playVideoById(videoId) {
  await api('/api/v1/queue', { method: 'DELETE' });
  await sleep(600);
  await api('/api/v1/queue', {
    method: 'POST',
    body: { videoId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' },
  });
  await sleep(600);
  const queue = await api('/api/v1/queue');
  const items = queue?.items || [];
  if (items.length === 0) return { error: 'queue_empty' };
  await api('/api/v1/next', { method: 'POST' });
  await sleep(3500);
  const info = await api('/api/v1/song');
  if (!info || info.videoId === 'unknown') return { error: 'no_song' };
  if (info.videoId !== videoId) return { error: 'wrong_song', info };
  return { info };
}

function extractSearchResults(data) {
  const results = [];
  function walk(obj, depth) {
    if (depth > 15) return;
    if (obj && typeof obj === 'object') {
      if (obj.musicResponsiveListItemRenderer) {
        const r = obj.musicResponsiveListItemRenderer;
        const cols = r.flexColumns || [];
        const lines = cols.map(col => {
          const runs = col.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          return runs.map(run => run.text).filter(Boolean);
        });
        const titleLine = lines[0] || [];
        const artistLine = lines[1] || [];
        const artistRaw = artistLine.join('');
        const typeMatch = artistRaw.match(/^(Canción|Video|Álbum|Episodio)\s*•\s*(.*?)(?:\s*•.*)?$/);
        const artist = typeMatch ? typeMatch[2].trim() : artistRaw.replace(/\s*\d+[MK]\s*(reproducciones|vistas).*$/, '').trim();
        const title = titleLine.join('').replace(/^(Canción|Video|Álbum|Episodio)\s*•\s*/, '').trim();
        const vid = r.playlistItemData?.videoId ||
          r.navigationEndpoint?.watchEndpoint?.videoId ||
          r.navigationEndpoint?.watchPlaylistEndpoint?.videoId ||
          r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
        if (vid && title) {
          results.push({ videoId: vid, title, artist, album: lines[2]?.join('') || '' });
        }
      }
      for (const v of Object.values(obj)) walk(v, depth + 1);
    } else if (Array.isArray(obj)) {
      obj.forEach(item => walk(item, depth + 1));
    }
  }
  walk(data, 0);
  const seen = new Set();
  return results.filter(r => { if (seen.has(r.videoId)) return false; seen.add(r.videoId); return true; });
}

function getActiveWindow() {
  try {
    const result = execSync('gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/FocusedWindow --method org.gnome.shell.extensions.FocusedWindow.Get 2>/dev/null', { timeout: 2000, encoding: 'utf8' });
    const match = result.match(/"title":"([^"]+)"/);
    if (match) return match[1].trim().toLowerCase();
  } catch {}
  try {
    const result = execSync('xdotool getactivewindow getwindowname 2>/dev/null', { timeout: 1000, encoding: 'utf8' });
    if (result.trim()) return result.trim().toLowerCase();
  } catch {}
  return 'unknown';
}

function getKeystrokeRate() {
  try {
    const interrupts = execSync('grep i8042 /proc/interrupts 2>/dev/null', { timeout: 1000, encoding: 'utf8' });
    if (!interrupts.trim()) return null;
    const parts = interrupts.trim().split(/\s+/);
    const counts = parts.map(Number).filter(n => Number.isFinite(n));
    return counts.reduce((a, v) => a + v, 0);
  } catch {}
  return null;
}

function categorizeApp(appName) {
  if (!appName || appName === 'unknown') return 'unknown';
  const app = appName.toLowerCase();
  if (app.includes('code') || app.includes('cursor') || app.includes('vim') || app.includes('neovim') || app.includes('emacs') || app.includes('sublime') || app.includes('jetbrains') || app.includes('idea')) return 'coding';
  if (app.includes('terminal') || app.includes('konsole') || app.includes('gnome-terminal') || app.includes('kitty') || app.includes('alacritty') || app.includes('bash') || app.includes('zsh') || app.includes('tmux') || app.includes('blackbox')) return 'terminal';
  if (app.includes('firefox') || app.includes('chrome') || app.includes('chromium') || app.includes('brave') || app.includes('edge') || app.includes('opera')) return 'browser';
  if (app.includes('spotify') || app.includes('youtube music') || app.includes('vlc') || app.includes('rhythmbox')) return 'music';
  if (app.includes('slack') || app.includes('discord') || app.includes('telegram') || app.includes('whatsapp') || app.includes('signal')) return 'communication';
  if (app.includes('libreoffice') || app.includes('word') || app.includes('excel') || app.includes('powerpoint') || app.includes('docs') || app.includes('sheets')) return 'office';
  return 'other';
}

async function getWeather() {
  const now = Date.now();
  if (weatherCache.data && (now - weatherCache.fetchedAt) < WEATHER_CACHE_TTL) {
    return weatherCache.data;
  }
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return weatherCache.data;
    const data = await res.json();
    if (data?.current_weather) {
      const w = data.current_weather;
      const conditions = {
        0: 'clear', 1: 'clear', 2: 'cloudy', 3: 'overcast',
        45: 'foggy', 48: 'foggy',
        51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
        61: 'rain', 63: 'rain', 65: 'heavy rain',
        71: 'snow', 73: 'snow', 75: 'heavy snow',
        80: 'rain showers', 81: 'rain showers', 82: 'violent rain',
        95: 'thunderstorm', 96: 'thunderstorm', 99: 'severe thunderstorm',
      };
      const result = {
        condition: conditions[w.weathercode] || 'unknown',
        tempC: w.temperature, windKmh: w.windspeed,
        isDay: w.is_day === 1, weatherCode: w.weathercode,
        fetchedAt: new Date().toISOString(),
      };
      weatherCache = { data: result, fetchedAt: now };
      return result;
    }
  } catch {}
  return weatherCache.data;
}

const server = new Server(
  { name: 'yt-music-control', version: '2.1.0' },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'ytm_now', description: 'Get current playing song info (title, artist, album, progress, like state, etc.)', inputSchema: { type: 'object', properties: {} } },
    { name: 'ytm_play_pause', description: 'Toggle play/pause', inputSchema: { type: 'object', properties: {} } },
    { name: 'ytm_next', description: 'Skip to next song', inputSchema: { type: 'object', properties: {} } },
    { name: 'ytm_previous', description: 'Go back to previous song', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'ytm_search',
      description: 'Search for songs, albums, or playlists on YouTube Music',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Search query' },
        type: { type: 'string', enum: ['song', 'video', 'album', 'playlist'], description: 'Type of results (default: song)' },
      }, required: ['query'] },
    },
    {
      name: 'ytm_play_song',
      description: 'Play a specific song by videoId or by search (title + artist)',
      inputSchema: { type: 'object', properties: {
        videoId: { type: 'string', description: 'YouTube video ID' },
        query: { type: 'string', description: 'Search query (title + artist) to find and play' },
      } },
    },
    { name: 'ytm_queue', description: 'Get current queue', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'ytm_queue_add',
      description: '[WHEN TO USE: User requests a SPECIFIC song to be added to the queue. Use ytm_session_next for automatic contextual recommendations.] Add a song to the queue',
      inputSchema: { type: 'object', properties: {
        videoId: { type: 'string', description: 'YouTube video ID to add' },
        position: { type: 'string', enum: ['end', 'next'], description: 'Where to insert (default: end)' },
      }, required: ['videoId'] },
    },
    { name: 'ytm_queue_clear', description: 'Clear the queue', inputSchema: { type: 'object', properties: {} } },
    { name: 'ytm_like', description: 'Like the current song', inputSchema: { type: 'object', properties: {} } },
    { name: 'ytm_dislike', description: 'Dislike the current song', inputSchema: { type: 'object', properties: {} } },
    { name: 'ytm_volume', description: 'Set volume (0-100)', inputSchema: { type: 'object', properties: { volume: { type: 'number', minimum: 0, maximum: 100 } }, required: ['volume'] } },
    { name: 'ytm_seek', description: 'Seek to a position in the current song (in seconds)', inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] } },
    {
      name: 'ytm_history',
      description: 'Get listening history with stats, top songs, genre breakdown, etc.',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'number', description: 'Number of songs to return (default: 20)' },
        sort: { type: 'string', enum: ['recent', 'plays', 'liked'], description: 'Sort order' },
      } },
    },
    { name: 'ytm_stats', description: 'Get listening statistics (total songs, plays, genres, top artists, sessions, context)', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'ytm_recommend',
      description: '[WHEN TO USE: User wants general discovery by genre/mood — finds NEW songs from YouTube Music not in your history. For contextual recommendations based on what is playing NOW, use ytm_session_next.] Get song recommendations based on your listening history',
      inputSchema: { type: 'object', properties: {
        count: { type: 'number', description: 'Number of recommendations (default: 5)' },
        genre: { type: 'string', description: 'Filter by genre (optional)' },
        mood: { type: 'string', enum: ['energetic', 'chill', 'focus', 'happy', 'sad'], description: 'Mood filter (optional)' },
      } },
    },
    {
      name: 'ytm_play_recommendation',
      description: 'Play a recommended song from the recommendation list',
      inputSchema: { type: 'object', properties: { videoId: { type: 'string', description: 'Video ID from recommendation to play' } }, required: ['videoId'] },
    },
    {
      name: 'ytm_mix',
      description: `[WHEN TO USE: User wants a specific list of songs in EXACT order (e.g. "play these 5 songs"). NOT for automatic recommendations.]
Create a custom mix: play songs in exact order. Accepts a songs array directly OR a payload JS file path.

When using "payload": write a .js file (e.g. /tmp/mix-payload.js) that exports an array:
  module.exports = [
    { videoId: "...", title: "...", artist: "..." },
    ...
  ];
The first song plays immediately, the rest queue after it.

The AI should write the payload file first (no timeout pressure), then call ytm_mix with the path.`,
      inputSchema: { type: 'object', properties: {
        songs: { type: 'array', description: 'Songs in desired order (first = play now, rest = next up). Not needed if payload is provided.', items: { type: 'object', properties: { videoId: { type: 'string' }, title: { type: 'string' }, artist: { type: 'string' } }, required: ['videoId'] } },
        payload: { type: 'string', description: 'Path to a .js file exporting the songs array (module.exports = [...]). The file is read and executed to get the song list.' },
        timeoutMs: { type: 'number', description: 'Per-song resolve timeout in ms (default: 5000). Increase for slow networks.' },
      } },
    },
    {
      name: 'ytm_playlist_start',
      description: 'Start playing a playlist or radio based on a song or search query',
      inputSchema: { type: 'object', properties: {
        videoId: { type: 'string', description: 'Start a radio from this videoId' },
        query: { type: 'string', description: 'Or search and play first result' },
        type: { type: 'string', enum: ['song', 'playlist', 'album'], description: 'Type of result to play' },
      } },
    },

    { name: 'ytm_search_and_play', description: 'Search + play in one step. Returns what it found and played.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string', enum: ['song', 'video', 'album', 'playlist'] } }, required: ['query'] } },
    {
      name: 'ytm_wrapped',
      description: 'Generate a weekly/monthly wrapped summary (like Spotify Wrapped)',
      inputSchema: { type: 'object', properties: {
        period: { type: 'string', enum: ['week', 'month'], description: 'Period to summarize (default: week)' },
      } },
    },
    {
      name: 'ytm_similar_to',
      description: `[USE WHEN: User says "recomiéndame algo parecido a esta canción" or "suena como..."]
Find songs similar to a given song by audio feature distance (energy, danceability, valence, BPM, acousticness). Uses euclidean distance in 5D feature space. Falls back to genre+artist if no audio features. 
PREFER THIS OVER ytm_obsessions or generic recommendations when user wants "algo que suene parecido".`,
      inputSchema: { type: 'object', properties: {
        videoId: { type: 'string', description: 'Find similar to this videoId' },
        artist: { type: 'string', description: 'Or find songs by the same artist/featured' },
        title: { type: 'string', description: 'Song title (used with artist for search)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      } },
    },
    {
      name: 'ytm_obsessions',
      description: 'Detect songs you are obsessing over (played many times in a short period)',
      inputSchema: { type: 'object', properties: {
        threshold: { type: 'number', description: 'Min plays to be an obsession (default: 3)' },
        days: { type: 'number', description: 'Lookback window in days (default: 3)' },
      } },
    },
    {
      name: 'ytm_vibe_play',
      description: '[WHEN TO USE: User wants a quick auto-generated mix based on time-of-day patterns. For contextual recommendations based on current song + session trajectory, use ytm_session_next.] Auto-create a mix based on current hour/day patterns from your history',
      inputSchema: { type: 'object', properties: {
        count: { type: 'number', description: 'Number of songs to queue (default: 10)' },
      } },
    },
    {
      name: 'ytm_discover_weekly',
      description: 'Discover new songs from your top genres that you have never heard on YT Music',
      inputSchema: { type: 'object', properties: {
        count: { type: 'number', description: 'Number of recommendations (default: 5)' },
      } },
    },
    {
      name: 'ytm_revival',
      description: 'Find songs you used to love but havent listened to in 30+ days',
      inputSchema: { type: 'object', properties: {
        days: { type: 'number', description: 'Days of inactivity (default: 30)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      } },
    },
    {
      name: 'ytm_fiesta_mode',
      description: '[WHEN TO USE: User explicitly says "fiesta", "party", "boost volume", or wants high-energy mode. Does NOT queue songs — only toggles settings.] If recent songs are high-energy, enable crossfade and boost volume',
      inputSchema: { type: 'object', properties: {
        threshold: { type: 'number', description: 'BPM threshold for "high energy" (default: 120)' },
        volume: { type: 'number', description: 'Volume boost level 0-100 (default: 70)' },
      } },
    },
    {
      name: 'ytm_weather_play',
      description: '[WHEN TO USE: Weather/temperature should influence the playlist. Uses real weather data. For contextual recommendations based on current song + session, use ytm_session_next.] Generate a playlist based on real weather from Open-Meteo (uses your LATITUDE/LONGITUDE from .env)',
      inputSchema: { type: 'object', properties: {
        vibe: { type: 'string', enum: ['morning', 'afternoon', 'night', 'rainy', 'sunny', 'chill', 'auto'], description: 'Vibe/mood for the playlist. "auto" uses real weather data (default: auto)' },
        count: { type: 'number', description: 'Number of songs (default: 8)' },
      } },
    },
    {
      name: 'ytm_lyrics',
      description: 'Get synced lyrics for the current playing song (via YT Music if available)',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_wait_for_song_change',
      description: `Wait for the current song to finish and the next one to start. THE AI SHOULD CALL THIS TOOL AFTER:
- Starting a mix or playlist (to know when each new song plays)
- When the user says "next song" or "skip"
- When you want to react to each song in real-time

How it works:
1. Gets the current song's remaining time (duration - elapsed)
2. Waits for the song to finish + 1 second
3. Polls until the song actually changes (every 5s)
4. Returns the new song metadata + the full queue context

The AI should use this to give brief personalized opinions about each
new song based on the user's history and preferences.`,
      inputSchema: { type: 'object', properties: {
        knownVideoId: { type: 'string', description: 'The current song videoId to track. The tool waits until this song is no longer playing.' },
        timeout: { type: 'number', description: 'Max total wait time in ms (default: 300000 = 5min). Increase for long songs.' },
      }, required: ['knownVideoId'] },
    },
    {
      name: 'get_peculiar_preferences',
      description: 'Get all saved song preferences for context. Use this at the start of a session to understand the user\'s personal connections to songs. Optionally filter by videoId, artist, or search query.',
      inputSchema: { type: 'object', properties: {
        videoId: { type: 'string', description: 'Get preference for a specific song' },
        artist: { type: 'string', description: 'Filter by artist' },
        search: { type: 'string', description: 'Search in title, artist, or any preference field' },
      } },
    },
    {
      name: 'register_peculiar_preferences',
      description: `Register why the user loves the currently playing song. THE AI MUST FOLLOW THIS WORKFLOW:

1. Run ytm_now to identify the current song (title, artist, videoId).
2. Run ytm_lyrics to get the synced lyrics.
3. Search the web for what the song means (lyric interpretations, artist intent, cultural context).
4. Ask the user questions to understand their connection across these dimensions:
   - EMOTIONAL: What emotion does this song trigger? Why does it resonate emotionally?
   - TECHNICAL: What stands out musically (melody, vocals, production, rhythm)?
   - PSYCHOLOGICAL: Deeper impact — does it reflect something in your life, change your perspective?
   - PARTICULAR: Any other observation the user wants to record.
5. Call this tool with all gathered data to save it.

The saved preferences are available for future AI sessions as user context — call get_peculiar_preferences at session start to retrieve them. Use them to personalize recommendations, understand taste, and reference past conversations about songs.`,
      inputSchema: { type: 'object', properties: {
        videoId: { type: 'string', description: 'YouTube video ID of the song' },
        title: { type: 'string', description: 'Song title' },
        artist: { type: 'string', description: 'Artist name' },
        emotional: { type: 'string', description: 'Emotional aspects — what emotion it triggers, why it resonates' },
        technical: { type: 'string', description: 'Technical aspects — melody, vocals, production, rhythm' },
        psychological: { type: 'string', description: 'Psychological impact — personal significance, perspective shifts' },
        particular: { type: 'string', description: 'Any other particular observation the user wants recorded' },
        meaning: { type: 'string', description: 'Song meaning from web research (lyric interpretations, artist intent)' },
        lyricsSnippet: { type: 'string', description: 'A meaningful lyrics snippet the user connected with' },
      }, required: ['videoId', 'title', 'artist'] },
    },
    {
      name: 'ytm_get_affinity_scores',
      description: 'Get songs ranked by True Affinity Score — combines play count, average progress, and recency. High affinity = songs you actually love, not just songs you played a lot while skipping.',
      inputSchema: { type: 'object', properties: {
        minScore: { type: 'number', description: 'Minimum affinity score to include (default: 0)' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
      } },
    },
    {
      name: 'ytm_get_safe_favorites',
      description: 'Get your favorite songs excluding ones showing signs of listening fatigue. Uses burnout detection to filter out songs you have been skipping recently.',
      inputSchema: { type: 'object', properties: {
        minAffinity: { type: 'number', description: 'Minimum affinity score (default: 2)' },
        excludeFatigued: { type: 'boolean', description: 'Exclude songs with burnout/fatigue (default: true)' },
        limit: { type: 'number', description: 'Max results (default: 30)' },
      } },
    },
    {
      name: 'ytm_get_sessions',
      description: 'List past listening sessions with metadata (duration, songs, energy trajectory, weather, context)',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'number', description: 'Number of sessions to return (default: 20)' },
        sessionId: { type: 'string', description: 'Get trajectory for a specific session ID' },
      } },
    },
    {
      name: 'ytm_analyze_current_session_trajectory',
      description: 'Analyze your current listening session — energy slope, valence curve, genre flow. Predicts the next song\'s optimal mood based on your historical session patterns.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_get_current_context',
      description: 'Get your current external context: active application, CPU load, memory usage, keyboard activity, and real weather data from your location.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_flow_state',
      description: `[USE WHEN: User wants flow state music for working/coding. Enhanced version with audio features.]
Returns songs from your library optimized for flow state. Filters by BPM range (80-130 for coding), moderate energy (0.35-0.7), high valence, excludes fatigued songs. Pass appCategory to tune: coding=80-130bpm, reading=60-100bpm, terminal=70-120bpm.`,
      inputSchema: { type: 'object', properties: {
        appCategory: { type: 'string', enum: ['coding', 'browser', 'terminal', 'reading'], description: 'App category (default: coding)' },
        count: { type: 'number', description: 'Number of songs (default: 10)' },
      } },
    },
    {
      name: 'ytm_mood_playlist',
      description: `[USE WHEN: User says "ponme musica alegre/triste/enfocada/energética/relajada"]
Returns songs matching a mood profile based on audio features (energy, valence, BPM, acousticness).
Moods: happy (high energy+valence), chill (low energy, low-med valence), energetic (high energy+high BPM), focused (med energy, med BPM, acoustic), sad (low energy+valence, low BPM).`,
      inputSchema: { type: 'object', properties: {
        mood: { type: 'string', enum: ['happy', 'chill', 'energetic', 'focused', 'sad'], description: 'Mood to match' },
        count: { type: 'number', description: 'Number of songs (default: 10)' },
      }, required: ['mood'] },
    },
    {
      name: 'ytm_burnout_report',
      description: `[RUN AUTOMATICALLY before ytm_session_next to detect if the user is fatigued from overplayed songs.]
Analyzes all songs for burnout patterns (declining listen progress over time). Returns fatigued songs, declining songs, recent energy trend, and a recommendation. The AI should consider this context when making recommendations.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_smart_playlist',
      description: `[USE WHEN: User wants an auto-generated playlist based on audio feature clustering.]
Clusters your library by audio features (energy, danceability, valence, BPM, acousticness) into genres like: party, energy, chill, melancholic, acoustic, groovy, intense, warm, balanced, eclectic. Pass a cluster name or call without one to see available clusters.`,
      inputSchema: { type: 'object', properties: {
        cluster: { type: 'string', description: 'Cluster name (e.g. "party", "chill", "energy", "melancholic"). Omit to list available clusters.' },
        count: { type: 'number', description: 'Number of songs (default: 10)' },
      } },
    },
    {
      name: 'ytm_time_profile',
      description: `[USE WHEN: User wants to know when they listen to what kind of music.]
Analyzes your listening habits by hour of day and time segments (madrugada/mañana/tarde/noche). Returns hourly profiles of avg energy, valence, BPM, danceability, and acousticness. Also identifies your peak listening hour.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_session_next',
      description: `[MAIN RECOMMENDATION ENGINE — USE THIS FOR CONTEXTUAL NEXT-SONG RECOMMENDATIONS]
Analyzes your current session (what you are listening to now), finds similar past sessions, cross-references external context (time, weather, app you are using), and queues the best next songs — either from your history OR provides a search brief for web discovery.

WHEN TO USE (PREFERRED OVER ytm_recommend, ytm_vibe_play, ytm_weather_play):
- After a song finishes (after ytm_wait_for_song_change returns)
- When user says "what should I listen to next" or "recommend something"
- When user says "play something for this vibe"
- Basically ANY time the AI needs to queue songs contextually

HOW IT WORKS (mode: 'history' — default):
1. Gets your current session and what is playing now
2. Finds past listening sessions similar to the current one (same hour, same music style)
3. Analyzes your energy trajectory and mood curve
4. Scores candidates by: similarity to past transitions, affinity, BPM/energy match, context (app, weather)
5. Excludes fatigued/burnt-out songs
6. Queues the best songs directly — instant, zero effort

HOW IT WORKS (mode: 'discover'):
1. Extracts a recommendation profile from context (desired BPM range, energy, genre vibe)
2. Returns a SEARCH BRIEF with specific web search queries and YTM search queries
3. YOU (the AI) must then:
   a. Search the web using the provided queries to find specific song recommendations
   b. For each found song, use ytm_search to locate it on YouTube Music
   c. Use ytm_queue_add to queue it
4. This gives MUCH better results than limiting discovery to YTM's internal search

PARAMETERS:
- mode="history": queues from your library (safe, proven favorites)
- mode="discover": returns a search brief; AI must use web_search + ytm_search + ytm_queue_add
- vibe/genre/bpmRange/energyLevel: optional hints to refine discover mode

When the user says things like "descubre algo nuevo", "algo que no haya escuchado", "sorpréndeme", "busca algo parecido" — ALWAYS use mode="discover" and follow the search brief.`,
      inputSchema: { type: 'object', properties: {
        count: { type: 'number', description: 'Number of songs to recommend (default: 4)' },
        mode: { type: 'string', enum: ['history', 'discover'], description: '"history" = from your library (default). "discover" = returns search brief for AI to execute.' },
        vibe: { type: 'string', description: 'Mood hint like "chill", "energetic", "focus", "happy", "sad", "rainy", "night" — refines profile' },
        mood: { type: 'string', enum: ['happy', 'chill', 'energetic', 'focused', 'sad'], description: 'Mood profile — maps to audio feature ranges (energy, valence, BPM, acousticness). Overrides vibe/energyLevel when set.' },
        genre: { type: 'string', description: 'Genre hint like "rock", "jazz", "electronic", "classical" — refines profile' },
        bpmRange: { type: 'string', description: 'e.g. "80-100" or "<100" or ">120" — desired tempo range' },
        energyLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: '"low" = <0.5, "medium" = 0.5-0.7, "high" = >0.7' },
      } },
    },
    {
      name: 'ytm_enter_flow_state',
      description: `[USE WHEN: User wants to get into "flow state" — coding/working and needs music that historically matches their peak productivity]
Analyzes historical context data (keystrokeRate, app category) and finds the BPM, energy, and valence range where you were MOST productive (highest keystroke rate). Then you (the AI) search the web for songs matching that profile and queue them.

WHEN TO USE:
- User says "ponme musica para concentrarme", "flow state", "modo trabajo", "para programar"
- User is coding/in terminal and wants productivity music
- After analyzing what music works best for their workflow

HOW IT WORKS:
1. Queries historical listen_dates for the requested app category (coding, terminal, browser)
2. Filters top 25% of sessions by keystrokeRate = "flow state" data points
3. Returns the BPM range, energy level, and genres that correlate with peak productivity
4. YOU (the AI) must then search the web for songs matching that profile and use ytm_search + ytm_queue_add to play them
5. OR use mode="history" to queue directly from the user's library`,
      inputSchema: { type: 'object', properties: {
        mode: { type: 'string', enum: ['search_brief', 'history'], description: '"search_brief" = returns flow profile + web search queries for AI to find songs (default). "history" = queues directly from user library matching flow profile.' },
        appCategory: { type: 'string', enum: ['coding', 'terminal', 'browser'], description: 'App category to analyze. Defaults to detected current app, or "coding".' },
        count: { type: 'number', description: 'Number of songs to recommend (default: 5)' },
      } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case 'ytm_now': {
        const song = await api('/api/v1/song');
        if (!song) return { content: [{ type: 'text', text: 'No song playing' }] };
        const like = await api('/api/v1/like-state');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: song.title, artist: song.artist, album: song.album,
              duration: song.songDuration, elapsed: song.elapsedSeconds,
              progress: `${Math.round(song.elapsedSeconds / song.songDuration * 100)}%`,
              isPaused: song.isPaused, likeState: like?.state,
              views: song.views, mediaType: song.mediaType, videoId: song.videoId,
              url: song.url,
            }, null, 2),
          }],
        };
      }

      case 'ytm_play_pause': { await api('/api/v1/toggle-play', { method: 'POST' }); return { content: [{ type: 'text', text: 'Toggled play/pause' }] }; }
      case 'ytm_next': { await api('/api/v1/next', { method: 'POST' }); return { content: [{ type: 'text', text: 'Skipped to next song' }] }; }
      case 'ytm_previous': { await api('/api/v1/previous', { method: 'POST' }); return { content: [{ type: 'text', text: 'Went to previous song' }] }; }

      case 'ytm_search': {
        const data = await serializedSearch('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: args.query, params: args.type || 'song' } });
        const songs = extractSearchResults(data);
        return { content: [{ type: 'text', text: JSON.stringify({ query: args.query, total: songs.length, results: songs.slice(0, 20) }, null, 2) }] };
      }

      case 'ytm_play_song': {
        if (args.videoId) {
          const validId = await resolveVideoId(args.videoId);
          if (!validId) return { content: [{ type: 'text', text: `Invalid videoId: ${args.videoId}` }], isError: true };
          const result = await playVideoById(validId);
          if (result.info) return { content: [{ type: 'text', text: `Playing: ${result.info.title} - ${result.info.artist}` }] };
          return { content: [{ type: 'text', text: `Could not play that video on YouTube Music (try searching by name instead)` }], isError: true };
        }
        if (!args.query) return { content: [{ type: 'text', text: 'Provide videoId or query' }], isError: true };
        const search = await serializedSearch('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: args.query, params: 'song' } });
        const results = extractSearchResults(search);
        if (results.length === 0) return { content: [{ type: 'text', text: `No results for: ${args.query}` }], isError: true };
        for (const r of results) {
          const validId = await resolveVideoId(r.videoId);
          if (!validId) continue;
          const result = await playVideoById(validId);
          if (result.info) return { content: [{ type: 'text', text: `Playing: ${result.info.title} - ${result.info.artist}` }] };
        }
        return { content: [{ type: 'text', text: `Could not play any search result` }], isError: true };
      }

      case 'ytm_queue': { const queue = await api('/api/v1/queue'); return { content: [{ type: 'text', text: JSON.stringify(queue, null, 2) }] }; }

      case 'ytm_queue_add': {
        await api('/api/v1/queue', { method: 'POST', body: { videoId: args.videoId, insertPosition: args.position === 'next' ? 'INSERT_AFTER_CURRENT_VIDEO' : 'INSERT_AT_END' } });
        return { content: [{ type: 'text', text: `Added ${args.videoId} to queue` }] };
      }

      case 'ytm_queue_clear': { await api('/api/v1/queue', { method: 'DELETE' }); return { content: [{ type: 'text', text: 'Queue cleared' }] }; }
      case 'ytm_like': { await api('/api/v1/like', { method: 'POST' }); return { content: [{ type: 'text', text: 'Liked current song' }] }; }
      case 'ytm_dislike': { await api('/api/v1/dislike', { method: 'POST' }); return { content: [{ type: 'text', text: 'Disliked current song' }] }; }
      case 'ytm_volume': { await api(`/api/v1/volume?volume=${args.volume}`, { method: 'POST' }); return { content: [{ type: 'text', text: `Volume set to ${args.volume}` }] }; }
      case 'ytm_seek': { await api('/api/v1/seek-to', { method: 'POST', body: { seconds: args.seconds } }); return { content: [{ type: 'text', text: `Seeked to ${args.seconds}s` }] }; }

      case 'ytm_history': {
        let songs = db.getAllSongs();
        const sort = args.sort || 'recent';
        if (sort === 'plays') songs.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
        else if (sort === 'liked') songs = songs.filter(s => s.likeState === 'LIKE').sort((a, b) => new Date(b.lastListened) - new Date(a.lastListened));
        else songs.sort((a, b) => new Date(b.lastListened) - new Date(a.lastListened));
        const limit = args.limit || 20;
        return { content: [{ type: 'text', text: JSON.stringify({ total: songs.length, totalPlays: songs.reduce((a, s) => a + (s.playCount || 0), 0), songs: songs.slice(0, limit) }, null, 2) }] };
      }

      case 'ytm_stats': {
        const stats = db.getStats();
        const topGenres = db.getTopGenres();
        const topArtists = db.getTopArtists();
        const topSongs = db.getTopSongs(10).map(s => ({ title: s.title, artist: s.artist, plays: s.playCount, genre: s.genre, liked: s.likeState === 'LIKE', bpm: s.bpm }));
        return { content: [{ type: 'text', text: JSON.stringify({ ...stats, topGenres, topArtists, topSongs }, null, 2) }] };
      }

      case 'ytm_recommend': {
        const songs = db.getAllSongs();
        if (songs.length === 0) return { content: [{ type: 'text', text: 'No history yet. Listen to some songs first!' }] };
        const topGenres = db.getTopGenres();
        const topArtists = db.getTopArtists(5);
        const topGenre = args.genre || topGenres[0]?.genre;
        let searchQueries = [];
        if (args.mood) {
          const moodMap = {
            energetic: ['energetic rock', 'upbeat pop', 'dance electronic'],
            chill: ['chill vibes', 'lo-fi', 'ambient'],
            focus: ['focus music', 'instrumental', 'study'],
            happy: ['happy pop', 'feel good', 'positive vibes'],
            sad: ['sad songs', 'melancholic', 'emotional'],
          };
          searchQueries = moodMap[args.mood] || [];
        } else if (topGenre && topGenre !== 'Unknown') {
          searchQueries = [`${topGenre} music mix`];
          topArtists.forEach(a => searchQueries.push(`${a.artist} mix`));
        } else {
          topArtists.forEach(a => searchQueries.push(`${a.artist} top songs`));
        }
        searchQueries = searchQueries.slice(0, 3);
        const results = [];
        const knownIds = new Set(songs.map(s => s.videoId));
        for (const q of searchQueries) {
          try {
            const data = await serializedSearch('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: q, params: 'song' } });
            const items = extractSearchResults(data);
            const fresh = items.filter(r => r.videoId && !knownIds.has(r.videoId));
            results.push(...fresh.slice(0, 5));
          } catch {}
        }
        const seen = new Set();
        const unique = results.filter(r => { if (seen.has(r.videoId)) return false; seen.add(r.videoId); return true; }).slice(0, args.count || 5);
        return { content: [{ type: 'text', text: JSON.stringify({ basedOn: { genre: topGenre, topArtists: topArtists.map(a => a.artist), mood: args.mood || null }, recommendations: unique.map(r => ({ title: r.title, artist: r.artist, videoId: r.videoId, album: r.album })) }, null, 2) }] };
      }

      case 'ytm_play_recommendation': {
        const validId = await resolveVideoId(args.videoId);
        if (!validId) return { content: [{ type: 'text', text: `Invalid videoId: ${args.videoId}` }], isError: true };
        const result = await playVideoById(validId);
        if (result.info) return { content: [{ type: 'text', text: `Playing: ${result.info.title} - ${result.info.artist}` }] };
        return { content: [{ type: 'text', text: `Error playing recommendation` }], isError: true };
      }

      case 'ytm_mix': {
        const resolveTimeout = args.timeoutMs || 5000;

        let mixSongs = args.songs;
        if (args.payload) {
          try {
            const payloadPath = path.resolve(args.payload);
            delete require.cache[require.resolve(payloadPath)];
            mixSongs = require(payloadPath);
            if (!Array.isArray(mixSongs)) throw new Error('payload must export an array');
          } catch (e) {
            return { content: [{ type: 'text', text: `Failed to load payload: ${e.message}` }], isError: true };
          }
        }

        if (!mixSongs || mixSongs.length < 2) return { content: [{ type: 'text', text: 'Need at least 2 songs for a mix' }], isError: true };

        const first = mixSongs[0];
        const rest = mixSongs.slice(1);

        const validFirst = await resolveVideoId(first.videoId, { timeout: resolveTimeout });
        if (!validFirst) return { content: [{ type: 'text', text: `Invalid videoId for first song: ${first.videoId}` }], isError: true };
        await api('/api/v1/queue', { method: 'DELETE' }); await sleep(300);
        await api('/api/v1/queue', { method: 'POST', body: { videoId: validFirst, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } }); await sleep(400);
        await api('/api/v1/next', { method: 'POST' });

        let nowCheck = null;
        for (let i = 0; i < 20; i++) {
          await sleep(500);
          nowCheck = await api('/api/v1/song');
          if (nowCheck && nowCheck.videoId && nowCheck.videoId !== 'unknown' && nowCheck.videoId === validFirst) break;
        }
        if (!nowCheck || !nowCheck.videoId || nowCheck.videoId === 'unknown') {
          return { content: [{ type: 'text', text: 'Failed to play first song' }], isError: true };
        }

        let queued = 0, failed = 0;
        for (const s of rest) {
          const vid = await resolveVideoId(s.videoId, { timeout: resolveTimeout });
          if (!vid) { failed++; continue; }
          await api('/api/v1/queue', { method: 'POST', body: { videoId: vid, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } });
          await sleep(300); queued++;
        }

        const info = await api('/api/v1/song');
        const label = info ? `${info.title} - ${info.artist}` : (first.title || first.videoId);
        return { content: [{ type: 'text', text: `Mix created: "${label}" + ${queued} songs queued${failed ? ` (${failed} failed)` : ''}` }] };
      }

      case 'ytm_playlist_start': {
        if (args.videoId) {
          const validId = await resolveVideoId(args.videoId);
          if (!validId) return { content: [{ type: 'text', text: `Invalid videoId: ${args.videoId}` }], isError: true };
          const result = await playVideoById(validId);
          if (result.info) return { content: [{ type: 'text', text: `Playing: ${result.info.title} - ${result.info.artist}` }] };
          return { content: [{ type: 'text', text: `Error playing` }], isError: true };
        }
        if (args.query) {
          const data = await serializedSearch('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: args.query, params: args.type || 'song' } });
          const songs = extractSearchResults(data);
          if (songs.length === 0) return { content: [{ type: 'text', text: 'No results' }], isError: true };
          for (const s of songs) {
            const validId = await resolveVideoId(s.videoId);
            if (!validId) continue;
            const result = await playVideoById(validId);
            if (result.info) return { content: [{ type: 'text', text: `Playing: ${result.info.title} - ${result.info.artist}` }] };
          }
          return { content: [{ type: 'text', text: 'Could not play any result' }], isError: true };
        }
        return { content: [{ type: 'text', text: 'Provide videoId or query' }], isError: true };
      }

      case 'ytm_search_and_play': {
        const data = await serializedSearch('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: args.query, params: args.type || 'song' } });
        const results = extractSearchResults(data);
        if (results.length === 0) return { content: [{ type: 'text', text: `No results for: ${args.query}` }], isError: true };
        for (const r of results) {
          const validId = await resolveVideoId(r.videoId);
          if (!validId) continue;
          const result = await playVideoById(validId);
          if (result.info) return { content: [{ type: 'text', text: JSON.stringify({ played: { title: result.info.title, artist: result.info.artist, videoId: result.info.videoId }, searchResults: results.slice(0, 5) }, null, 2) }] };
        }
        return { content: [{ type: 'text', text: 'Found results but could not play any' }], isError: true };
      }

      case 'ytm_wrapped': {
        const now = new Date();
        const period = args.period || 'week';
        let startDate;
        if (period === 'week') {
          const d = new Date(now); d.setDate(d.getDate() - d.getDay()); startDate = d.toISOString().split('T')[0];
        } else {
          startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        }
        const endDate = now.toISOString().split('T')[0];
        const stats = db.getStatsForPeriod(startDate, endDate);
        const heatmap = db.getHeatmapData(period === 'week' ? 7 : 30);
        const hourly = db.getHourlyDistribution();
        return { content: [{ type: 'text', text: JSON.stringify({ ...stats, heatmap, hourlyDistribution: hourly }, null, 2) }] };
      }

      case 'ytm_obsessions': {
        const obsessions = db.getObsessions(args.threshold || 3, args.days || 3);
        return { content: [{ type: 'text', text: JSON.stringify({ threshold: args.threshold || 3, days: args.days || 3, obsessions: obsessions.map(s => ({ title: s.title, artist: s.artist, recentPlays: s.recentPlays, genre: s.genre })) }, null, 2) }] };
      }

      case 'ytm_vibe_play': {
        const hour = new Date().getHours();
        const day = new Date().getDay();
        let vibeGenre;
        if (day === 0 || day === 6) {
          vibeGenre = hour < 12 ? 'indie rock' : hour < 18 ? 'pop' : 'electronic';
        } else {
          vibeGenre = hour < 12 ? 'alternative' : hour < 18 ? 'pop' : 'rock';
        }
        const genreSongs = db.getSongsByGenre(vibeGenre).filter(s => db.getSong(s.videoId)?.playCount > 1);
        const recentSongs = db.getRecentSongs(50).filter(s => s.genre === vibeGenre || !s.genre);
        const pool = [...genreSongs, ...recentSongs];
        const seen = new Set();
        const unique = pool.filter(s => { if (seen.has(s.videoId)) return false; seen.add(s.videoId); return true; });

        if (unique.length === 0) return { content: [{ type: 'text', text: 'Not enough history to build a vibe mix. Listen to more songs!' }], isError: true };

        const selected = unique.slice(0, Math.min(args.count || 10, 20));
        const first = selected[0];
        const rest = selected.slice(1);

        const validFirst = await resolveVideoId(first.videoId);
        if (!validFirst) return { content: [{ type: 'text', text: 'Could not play first song' }], isError: true };
        await api('/api/v1/queue', { method: 'DELETE' }); await sleep(600);
        await api('/api/v1/queue', { method: 'POST', body: { videoId: validFirst, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } }); await sleep(800);
        await api('/api/v1/next', { method: 'POST' }); await sleep(3000);
        const nowCheck = await api('/api/v1/song');
        if (!nowCheck || !nowCheck.videoId || nowCheck.videoId === 'unknown') return { content: [{ type: 'text', text: 'Failed to play first song' }], isError: true };
        let queued = 0;
        for (const s of rest) {
          const vid = await resolveVideoId(s.videoId);
          if (!vid) continue;
          await api('/api/v1/queue', { method: 'POST', body: { videoId: vid, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } });
          await sleep(400); queued++;
        }
        return { content: [{ type: 'text', text: `Vibe mix (${vibeGenre}, ${hour}h) created: "${first.title} - ${first.artist}" + ${queued} songs` }] };
      }

      case 'ytm_discover_weekly': {
        const topGenres = db.getTopGenres(3);
        if (topGenres.length === 0) return { content: [{ type: 'text', text: 'Not enough history yet' }], isError: true };
        const knownIds = new Set(db.getAllSongs().map(s => s.videoId));
        const results = [];
        for (const g of topGenres) {
          try {
            const data = await serializedSearch('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: `${g.genre} new songs 2026`, params: 'song' } });
            const items = extractSearchResults(data);
            const fresh = items.filter(r => r.videoId && !knownIds.has(r.videoId));
            results.push(...fresh.slice(0, 3));
          } catch {}
        }
        const seen = new Set();
        const unique = results.filter(r => { if (seen.has(r.videoId)) return false; seen.add(r.videoId); return true; }).slice(0, args.count || 5);
        return { content: [{ type: 'text', text: JSON.stringify({ basedOn: topGenres.map(g => g.genre), discoveries: unique }, null, 2) }] };
      }

      case 'ytm_revival': {
        const days = args.days || 30;
        const limit = args.limit || 10;
        const songs = db.getSongsNotListenedSince(days);
        const top = songs.slice(0, limit).map(s => ({ title: s.title, artist: s.artist, playCount: s.playCount, lastListened: s.lastListened, genre: s.genre, bpm: s.bpm }));
        const totalForgotten = songs.length;
        return { content: [{ type: 'text', text: JSON.stringify({ daysWithoutPlay: days, totalForgotten, songs: top }, null, 2) }] };
      }

      case 'ytm_fiesta_mode': {
        const threshold = args.threshold || 120;
        const targetVolume = args.volume || 70;
        const recent = db.getRecentSongs(5);
        const highEnergy = recent.filter(s => s.bpm && s.bpm >= threshold);
        if (highEnergy.length >= 3) {
          await api('/api/v1/volume?volume=' + targetVolume, { method: 'POST' });
          try { await api('/api/v1/crossfade', { method: 'POST' }); } catch {}
          return { content: [{ type: 'text', text: `Fiesta mode activated! ${highEnergy.length}/${recent.length} recent songs are high-energy (>=${threshold}bpm). Volume boosted to ${targetVolume}.` }] };
        }
        return { content: [{ type: 'text', text: `Not enough high-energy songs detected (${highEnergy.length}/${recent.length} >= ${threshold}bpm). Keep listening!` }] };
      }

      case 'ytm_weather_play': {
        const weather = await getWeather();
        const hour = new Date().getHours();

        let vibe = args.vibe || 'auto';
        if (vibe === 'auto') {
          if (weather) {
            const c = weather.condition;
            if (c.includes('rain') || c.includes('thunder') || c.includes('drizzle')) vibe = 'rainy';
            else if (c.includes('snow') || c.includes('fog')) vibe = 'chill';
            else if (c.includes('cloud') || c.includes('overcast')) vibe = hour < 12 ? 'morning' : 'afternoon';
            else if (weather.tempC > 30) vibe = 'sunny';
            else vibe = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'night';
          } else {
            vibe = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'night';
          }
        }

        const weatherNote = weather ? `${weather.condition}, ${weather.tempC}°C` : 'no weather data';

        const vibeGenres = {
          morning: ['pop', 'indie rock', 'alternative'],
          afternoon: ['rock', 'alternative', 'electronic'],
          night: ['electronic', 'ambient', 'r&b'],
          rainy: ['jazz', 'ambient', 'lo-fi', 'lofi'],
          sunny: ['pop', 'reggae', 'rock'],
          chill: ['ambient', 'lo-fi', 'lofi', 'jazz'],
        };
        const genres = vibeGenres[vibe] || vibeGenres.chill;
        const pool = [];
        for (const g of genres) {
          const songs = db.getSongsByGenre(g);
          pool.push(...songs);
        }
        const recent = db.getRecentSongs(100).filter(s => !s.genre || genres.includes(s.genre));
        pool.push(...recent);
        const seen = new Set();
        const unique = pool.filter(s => { if (seen.has(s.videoId)) return false; seen.add(s.videoId); return true; });
        if (unique.length === 0) return { content: [{ type: 'text', text: 'Not enough songs in history for this vibe' }], isError: true };
        const selected = unique.slice(0, Math.min(args.count || 8, 20));
        const first = selected[0]; const rest = selected.slice(1);
        const validFirst = await resolveVideoId(first.videoId);
        if (!validFirst) return { content: [{ type: 'text', text: 'Could not play' }], isError: true };
        await api('/api/v1/queue', { method: 'DELETE' }); await sleep(600);
        await api('/api/v1/queue', { method: 'POST', body: { videoId: validFirst, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } }); await sleep(800);
        await api('/api/v1/next', { method: 'POST' }); await sleep(3000);
        const nowCheck = await api('/api/v1/song');
        if (!nowCheck || !nowCheck.videoId || nowCheck.videoId === 'unknown') return { content: [{ type: 'text', text: 'Failed to play' }], isError: true };
        let queued = 0;
        for (const s of rest) {
          const vid = await resolveVideoId(s.videoId);
          if (!vid) continue;
          await api('/api/v1/queue', { method: 'POST', body: { videoId: vid, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } });
          await sleep(400); queued++;
        }
        return { content: [{ type: 'text', text: `Weather playlist (${vibe}, ${weatherNote}) created: "${first.title} - ${first.artist}" + ${queued} songs` }] };
      }

      case 'ytm_lyrics': {
        const song = await api('/api/v1/song');
        if (!song) return { content: [{ type: 'text', text: 'No song playing' }] };
        try {
          const data = await api('/api/v1/lyrics', { timeout: 5000 });
          if (!data) return { content: [{ type: 'text', text: `No synced lyrics available for "${song.title}"` }] };
          const lyrics = data.lyrics || data;
          return { content: [{ type: 'text', text: JSON.stringify({ title: song.title, artist: song.artist, elapsed: song.elapsedSeconds, lyrics: typeof lyrics === 'string' ? lyrics.substring(0, 2000) : lyrics }, null, 2) }] };
        } catch {
          return { content: [{ type: 'text', text: `No synced lyrics available for "${song.title}"` }] };
        }
      }

      case 'ytm_wait_for_song_change': {
        const targetVideoId = args.knownVideoId;
        const maxTimeout = args.timeout || 300000;
        const deadline = Date.now() + maxTimeout;

        let song = await api('/api/v1/song');
        if (!song?.videoId || song.videoId === 'unknown') {
          return { content: [{ type: 'text', text: 'No song currently playing' }], isError: true };
        }

        if (song.videoId !== targetVideoId) {
          const queue = await api('/api/v1/queue');
          return {
            content: [{ type: 'text', text: JSON.stringify({
              event: 'song_already_changed',
              nowPlaying: {
                title: song.title, artist: song.artist, videoId: song.videoId,
                album: song.album, duration: song.songDuration, elapsed: song.elapsedSeconds,
                progress: song.songDuration > 0 ? Math.round(song.elapsedSeconds / song.songDuration * 100) + '%' : '0%',
                isPaused: song.isPaused,
              },
              queue: {
                items: queue?.items?.slice(0, 10).map(i => ({ title: i.title, artist: i.artist, videoId: i.videoId })) || [],
                totalInQueue: queue?.items?.length || 0,
              },
            }, null, 2) }] };
        }

        const remaining = Math.max(1, (song.songDuration || 180) - (song.elapsedSeconds || 0)) + 1;
        const smartWait = Math.min(remaining * 1000, deadline - Date.now() - 5000);
        if (smartWait > 0) {
          await sleep(smartWait);
        }

        let newSong = null;
        let attempts = 0;
        while (Date.now() < deadline) {
          newSong = await api('/api/v1/song');
          attempts++;

          if (newSong?.videoId && newSong.videoId !== 'unknown' && newSong.videoId !== targetVideoId) {
            const queue = await api('/api/v1/queue');
            const history = db.getSong(targetVideoId);
            const prefs = db.getSongPreferences(newSong.videoId);
            return {
              content: [{ type: 'text', text: JSON.stringify({
                event: 'song_changed',
                previousSong: history ? { title: history.title, artist: history.artist, plays: history.playCount, genre: history.genre } : { videoId: targetVideoId },
                nowPlaying: {
                  title: newSong.title, artist: newSong.artist, videoId: newSong.videoId,
                  album: newSong.album, duration: newSong.songDuration, elapsed: newSong.elapsedSeconds,
                  progress: newSong.songDuration > 0 ? Math.round(newSong.elapsedSeconds / newSong.songDuration * 100) + '%' : '0%',
                  isPaused: newSong.isPaused,
                },
                userPreferences: prefs ? {
                  emotional: prefs.emotional, technical: prefs.technical,
                  psychological: prefs.psychological, particular: prefs.particular,
                  meaning: prefs.meaning, lyricsSnippet: prefs.lyricsSnippet,
                } : null,
                queue: {
                  items: queue?.items?.slice(0, 10).map(i => ({ title: i.title, artist: i.artist, videoId: i.videoId })) || [],
                  totalInQueue: queue?.items?.length || 0,
                  nextUp: queue?.items?.[0] ? { title: queue.items[0].title, artist: queue.items[0].artist, videoId: queue.items[0].videoId } : null,
                },
              }, null, 2) }] };
          }

          if (Date.now() + 6000 > deadline) break;
          await sleep(5000);
        }

        const finalSong = await api('/api/v1/song');
        const finalQueue = await api('/api/v1/queue');
        return {
          content: [{ type: 'text', text: JSON.stringify({
            event: 'timeout',
            totalWaitMs: maxTimeout,
            attemptsPolled: attempts,
            nowPlaying: finalSong ? {
              title: finalSong.title, artist: finalSong.artist, videoId: finalSong.videoId,
              duration: finalSong.songDuration, elapsed: finalSong.elapsedSeconds,
              isPaused: finalSong.isPaused,
            } : null,
            queue: {
              items: finalQueue?.items?.slice(0, 10).map(i => ({ title: i.title, artist: i.artist, videoId: i.videoId })) || [],
              totalInQueue: finalQueue?.items?.length || 0,
            },
          }, null, 2) }] };
      }

      case 'get_peculiar_preferences': {
        let prefs;
        if (args.videoId) {
          const p = db.getSongPreferences(args.videoId);
          prefs = p ? [p] : [];
        } else if (args.artist) {
          prefs = db.getDb().prepare('SELECT * FROM song_preferences WHERE artist LIKE ? ORDER BY updatedAt DESC').all(`%${args.artist}%`);
        } else if (args.search) {
          const q = `%${args.search}%`;
          prefs = db.getDb().prepare(`SELECT * FROM song_preferences WHERE title LIKE ? OR artist LIKE ? OR emotional LIKE ? OR technical LIKE ? OR psychological LIKE ? OR particular LIKE ? OR meaning LIKE ? ORDER BY updatedAt DESC`).all(q, q, q, q, q, q, q);
        } else {
          prefs = db.getAllPreferences();
        }
        return { content: [{ type: 'text', text: JSON.stringify({ total: prefs.length, preferences: prefs }, null, 2) }] };
      }

      case 'register_peculiar_preferences': {
        const pref = {
          videoId: args.videoId, title: args.title, artist: args.artist,
          emotional: args.emotional || null, technical: args.technical || null,
          psychological: args.psychological || null, particular: args.particular || null,
          meaning: args.meaning || null, lyricsSnippet: args.lyricsSnippet || null,
        };
        db.saveSongPreference(pref);
        return { content: [{ type: 'text', text: JSON.stringify({ saved: true, videoId: pref.videoId, title: pref.title, artist: pref.artist }, null, 2) }] };
      }

      case 'ytm_get_affinity_scores': {
        const minScore = args.minScore || 0;
        const limit = args.limit || 50;
        const scores = db.getAffinityScores(minScore, limit);
        return { content: [{ type: 'text', text: JSON.stringify({ total: scores.length, minScore, scores }, null, 2) }] };
      }

      case 'ytm_get_safe_favorites': {
        const minAffinity = args.minAffinity || 2;
        const excludeFatigued = args.excludeFatigued !== false;
        const limit = args.limit || 30;
        const favorites = db.getSafeFavorites(minAffinity, excludeFatigued, limit);

        const result = {
          minAffinity,
          excludeFatigued,
          total: favorites.length,
          favorites: favorites.map(f => ({
            title: f.title, artist: f.artist, videoId: f.videoId,
            genre: f.genre, affinityScore: f.affinityScore,
            playCount: f.playCount, avgProgress: f.avgProgress,
            energy: f.energy, valence: f.valence, bpm: f.bpm,
            lastListened: f.lastListened,
          })),
        };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'ytm_get_sessions': {
        if (args.sessionId) {
          const session = db.getSession(args.sessionId);
          if (!session) return { content: [{ type: 'text', text: `Session not found: ${args.sessionId}` }], isError: true };
          const trajectory = db.getSessionTrajectory(args.sessionId);
          return { content: [{ type: 'text', text: JSON.stringify({ session, trajectory }, null, 2) }] };
        }
        const limit = args.limit || 20;
        const sessions = db.getSessions(limit).map(s => ({
          id: s.id,
          startTime: s.startTime,
          endTime: s.endTime,
          duration: s.endTime ? Math.round((new Date(s.endTime) - new Date(s.startTime)) / 60000) + 'min' : 'in progress',
          songCount: s.songCount,
          energyStart: s.energyStart,
          energyEnd: s.energyEnd,
          summary: s.contextSummary,
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ total: sessions.length, sessions }, null, 2) }] };
      }

      case 'ytm_analyze_current_session_trajectory': {
        const current = db.getCurrentSession();
        if (!current) {
          return { content: [{ type: 'text', text: JSON.stringify({ event: 'no_active_session', suggestion: 'Start listening to music to begin a session' }, null, 2) }] };
        }

        const trajectory = db.getSessionTrajectory(current.id);
        const song = await api('/api/v1/song');
        const nowPlaying = song?.videoId ? { title: song.title, artist: song.artist, videoId: song.videoId } : null;

        let nextSongSuggestion = null;
        if (trajectory.trajectory !== 'insufficient_data' && trajectory.energySlope != null) {
          const energyDirection = trajectory.energySlope > 0 ? 'maintain_or_increase' : 'maintain_or_decrease';
          const valenceDirection = trajectory.valenceSlope > 0 ? 'positive' : 'neutral_to_positive';

          let suggestedGenres = [];
          if (current.genreSequence) {
            try { suggestedGenres = JSON.parse(current.genreSequence); } catch {}
          }
          const lastGenre = suggestedGenres[suggestedGenres.length - 1];

          nextSongSuggestion = {
            energyDirection,
            valenceDirection,
            trajectory: trajectory.trajectory,
            recentGenres: suggestedGenres.slice(-3),
            suggestedVibe: trajectory.trajectory === 'ramping_up' ? 'keep the energy going' :
                          trajectory.trajectory === 'winding_down' ? 'continue winding down or switch mood' :
                          trajectory.trajectory === 'calming' ? 'maintain chill vibe' :
                          trajectory.trajectory === 'energizing' ? 'ride the energy wave' : 'maintain the flow',
          };
          if (lastGenre) nextSongSuggestion.suggestedGenre = lastGenre;
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({
            session: {
              id: current.id,
              startedAt: current.startTime,
              songCount: current.songCount,
              weather: (() => { try { return JSON.parse(current.weather || 'null'); } catch { return null; } })(),
            },
            nowPlaying,
            trajectory,
            nextSongSuggestion,
          }, null, 2) }],
        };
      }

      case 'ytm_get_current_context': {
        const activeApp = getActiveWindow();
        const keystrokeCount = getKeystrokeRate();
        const cpuLoad = os.loadavg()[0];
        const memoryUsage = os.freemem() / os.totalmem();
        const weather = await getWeather();
        const song = await api('/api/v1/song');

        return {
          content: [{ type: 'text', text: JSON.stringify({
            timestamp: new Date().toISOString(),
            system: {
              cpuLoad1m: cpuLoad,
              cpuLoad5m: os.loadavg()[1],
              cpuLoad15m: os.loadavg()[2],
              memoryFree: Math.round(os.freemem() / 1024 / 1024) + 'MB',
              memoryTotal: Math.round(os.totalmem() / 1024 / 1024) + 'MB',
              memoryUsagePercent: Math.round((1 - memoryUsage) * 100) + '%',
              uptime: Math.round(os.uptime() / 3600) + 'h',
            },
            activity: {
              activeApp: { name: activeApp, category: categorizeApp(activeApp) },
              keystrokeCount: keystrokeCount,
              keystrokeNote: keystrokeCount != null ? `${keystrokeCount} total keyboard interrupts` : 'unavailable',
            },
            weather: weather || 'unavailable',
            nowPlaying: song?.videoId ? {
              title: song.title, artist: song.artist, videoId: song.videoId,
              progress: song.songDuration > 0 ? Math.round(song.elapsedSeconds / song.songDuration * 100) + '%' : '0%',
            } : 'no song playing',
            location: { latitude: LATITUDE, longitude: LONGITUDE },
          }, null, 2) }],
        };
      }

      case 'ytm_flow_state': {
        const fsApp = args.appCategory || 'coding';
        const fsCount = args.count || 10;
        const songs = features.getFlowStateSongs(fsApp, fsCount);
        if (songs.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No flow state songs found' }) }] };
        return { content: [{ type: 'text', text: JSON.stringify({
          appCategory: fsApp,
          bpmRange: '80-130',
          energyRange: '0.35-0.7',
          count: songs.length,
          songs: songs.map(s => ({ title: s.title, artist: s.artist, videoId: s.videoId, genre: s.genre, bpm: s.bpm, energy: s.energy, score: s.score })),
        }, null, 2) }] };
      }

      case 'ytm_mood_playlist': {
        const moodSongs = features.getMoodSongs(args.mood, args.count || 10);
        const profile = features.MOOD_PROFILES[args.mood];
        if (moodSongs.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ error: `No songs found for mood "${args.mood}"` }) }] };
        return { content: [{ type: 'text', text: JSON.stringify({
          mood: args.mood,
          featureProfile: { energy: profile.energy, valence: profile.valence, bpm: profile.bpm, acousticness: profile.acousticness },
          count: moodSongs.length,
          songs: moodSongs.map(s => ({ title: s.title, artist: s.artist, videoId: s.videoId, bpm: s.bpm, energy: s.energy, valence: s.valence, score: s.score })),
        }, null, 2) }] };
      }

      case 'ytm_burnout_report': {
        const report = features.getBurnoutReport();
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      }

      case 'ytm_smart_playlist': {
        const result = features.getSmartPlaylist(args.cluster, args.count || 10);
        if (result.availableClusters) {
          return { content: [{ type: 'text', text: JSON.stringify({
            info: 'Specify a cluster name to get songs. Available clusters:',
            clusters: result.availableClusters,
            hint: 'Try: ytm_smart_playlist({ cluster: "party" }) or "chill", "energy", "melancholic", "acoustic", "groovy", "intense", "warm", "balanced"',
          }, null, 2) }] };
        }
        if (result.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No songs in that cluster' }) }] };
        return { content: [{ type: 'text', text: JSON.stringify({
          cluster: args.cluster,
          count: result.length,
          songs: result.map(s => ({ title: s.title, artist: s.artist, videoId: s.videoId, bpm: s.bpm, energy: s.energy, valence: s.valence, danceability: s.danceability, score: s.score })),
        }, null, 2) }] };
      }

      case 'ytm_time_profile': {
        const profile2 = features.getTimeProfile();
        return { content: [{ type: 'text', text: JSON.stringify(profile2, null, 2) }] };
      }

      case 'ytm_similar_to': {
        const limit = args.limit || 10;
        let videoId = args.videoId;
        if (!videoId && args.artist && args.title) {
          const found = db.searchSongs(`${args.artist} ${args.title}`, 1);
          if (found.length > 0) videoId = found[0].videoId;
        }
        if (!videoId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Provide videoId or artist+title' }) }] };
        const similar = features.getSimilarSongs(videoId, limit);
        if (similar.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No similar songs found' }) }] };
        return { content: [{ type: 'text', text: JSON.stringify({
          source: db.getSong(videoId) ? `${db.getSong(videoId).title} - ${db.getSong(videoId).artist}` : videoId,
          method: similar[0].distance != null ? 'euclidean_5d' : 'genre_artist_fallback',
          count: similar.length,
          songs: similar,
        }, null, 2) }] };
      }

      case 'ytm_session_next': {
        const count = args.count || 3;
        const mode = args.mode || 'history';
        const weather = await getWeather();
        const hour = new Date().getHours();
        const activeApp = getActiveWindow();
        const appCategory = categorizeApp(activeApp);
        const currentSong = await api('/api/v1/song');

        const session = db.getCurrentSession();
        const sessionSongs = session ? db.getSessionSongs(session.id) : [];

        const currentGenre = currentSong?.videoId ? db.getSong(currentSong.videoId)?.genre : null;
        const currentBpm = currentSong?.videoId ? db.getSong(currentSong.videoId)?.bpm : null;
        const currentEnergy = currentSong?.videoId ? db.getSong(currentSong.videoId)?.energy : null;

        const allSongs = db.getAllSongs().filter(s => s.playCount > 0);
        const knownIds = new Set(allSongs.map(s => s.videoId));

        // --- DISCOVER MODE: search YTM for new music ---
        if (mode === 'discover') {
          const vibe = args.vibe || (
            weather?.condition?.includes('rain') ? 'chill' :
            weather?.condition === 'clear' && weather.tempC > 28 ? 'sunny' :
            hour < 6 ? 'chill' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'night'
          );
          const explicitGenre = args.genre || currentGenre || null;

          let moodProfile = null;
          if (args.mood && features.MOOD_PROFILES[args.mood]) {
            moodProfile = features.MOOD_PROFILES[args.mood];
          }

          const energyLevel = args.energyLevel || (
            moodProfile ? null :
            currentEnergy != null ? (currentEnergy < 0.45 ? 'low' : currentEnergy < 0.7 ? 'medium' : 'high') : 'medium'
          );

          let bpmMin = 60, bpmMax = 180;
          if (args.bpmRange) {
            const m = args.bpmRange.match(/(\d+)\s*-\s*(\d+)/);
            const lt = args.bpmRange.match(/<\s*(\d+)/);
            const gt = args.bpmRange.match(/>\s*(\d+)/);
            if (m) { bpmMin = parseInt(m[1]); bpmMax = parseInt(m[2]); }
            else if (lt) bpmMax = parseInt(lt[1]);
            else if (gt) bpmMin = parseInt(gt[1]);
          } else if (currentBpm) {
            bpmMin = Math.max(40, currentBpm - 20);
            bpmMax = currentBpm + 20;
          }

          if (moodProfile) {
            bpmMin = moodProfile.bpm[0];
            bpmMax = moodProfile.bpm[1];
          } else {
            if (energyLevel === 'low') { bpmMax = Math.min(bpmMax, 100); }
            if (energyLevel === 'high') { bpmMin = Math.max(bpmMin, 110); }
          }

          const topArtists = db.getTopArtists(5).map(a => a.artist);
          const topGenres = db.getTopGenres(5).map(g => g.genre);

          const webSearchQueries = [
            explicitGenre ? `best ${explicitGenre} songs ${vibe === 'chill' ? 'chill acoustic' : ''} 2026` : null,
            explicitGenre ? `underrated ${explicitGenre} songs similar to ${topArtists.slice(0,2).join(' ')}` : null,
            `${vibe} music recommendations like ${topArtists.slice(0,2).join(' and ')}`,
            energyLevel === 'low' ? `calm relaxing songs fans of ${topArtists[0]} would like` : null,
            `best ${vibe === 'night' ? 'late night' : vibe} songs ${new Date().getFullYear()} ${explicitGenre || topGenres[0] || ''}`,
          ].filter(Boolean).slice(0, 3);

          const burnoutCtx = features.getBurnoutReport();

          return { content: [{ type: 'text', text: JSON.stringify({
            mode: 'discover',
            burnoutContext: {
              fatiguedCount: burnoutCtx.totalFatigued,
              decliningCount: burnoutCtx.totalDeclining,
              fatigueRate: burnoutCtx.fatigueRate,
              advice: burnoutCtx.recommendation,
            },
            profile: { vibe, genre: explicitGenre, mood: args.mood || null, energyLevel: energyLevel || 'adaptive', bpmRange: `${bpmMin}-${bpmMax}`, featureRange: moodProfile || null },
            context: {
              currentSong: currentSong?.videoId ? `${currentSong.title} - ${currentSong.artist}` : 'none',
              hour: `${hour}:00`, weather: weather ? `${weather.condition} ${weather.tempC}°C` : 'unknown',
              activeApp: `${activeApp} (${appCategory})`,
              topArtists, topGenres,
            },
            searchBrief: {
              instruction: `Search the web using these queries, find 3-${count} specific songs. For each song found, use ytm_search + ytm_queue_add to play it. Prioritize songs not in the user's history (videoIds not in known set).`,
              webQueries: webSearchQueries,
            },
            executionHint: `1. Web search each query → get specific song titles + artists\n2. For each result, call ytm_search({ query: "song title artist" }) → get videoId\n3. Skip if videoId is already known (in history)\n4. Show the user the list of songs found and ASK: "las pongo después de la canción actual o arrancamos un mix ya?"\n5a. If "después" → call ytm_queue_add({ videoId, position: "next" }) for each\n5b. If "mix ya" → call ytm_mix({ videoIds: [...] }) or queue each with ytm_play_song for first one`,
          }, null, 2) }] };
        }

        // --- HISTORY MODE: recommend from library ---
        const hourRange = [Math.max(0, hour - 2), Math.min(23, hour + 2)];

        const similarSessions = db.getSessions(50).filter(s => {
          if (!s.startTime) return false;
          const sHour = new Date(s.startTime).getHours();
          const inHourRange = sHour >= hourRange[0] && sHour <= hourRange[1];
          if (!inHourRange) return false;
          if (!s.genreSequence) return true;
          try {
            const genres = JSON.parse(s.genreSequence);
            if (currentGenre && genres.length > 0) {
              return genres[0] === currentGenre || genres.includes(currentGenre);
            }
          } catch {}
          return true;
        }).slice(0, 5);

        const followUpIds = new Set();
        for (const s of similarSessions) {
          const songs = db.getSessionSongs(s.id);
          if (songs.length > 1) {
            songs.slice(1).forEach(song => {
              if (song.videoId) followUpIds.add(song.videoId);
            });
          }
        }

        const prevSongsIds = new Set(sessionSongs.map(s => s.videoId));
        const lastSong = sessionSongs[sessionSongs.length - 1] || {};

        const candidates = [];
        for (const s of allSongs) {
          if (knownIds.has(s.videoId) && !prevSongsIds.has(s.videoId)) {
            let score = 0;

            if (followUpIds.has(s.videoId)) score += 4;

            const burnout = db.computeBurnoutStatus(s.videoId);
            if (burnout.status === 'fatigued') score -= 10;
            if (burnout.status === 'declining') score -= 3;

            const affinity = db.computeAffinityScore(
              s.playCount, s.maxProgress,
              Math.max(0, (Date.now() - new Date(s.lastListened).getTime()) / 86400000)
            );
            score += affinity * 1.5;

            if (s.likeState === 'LIKE') score += 2;

            if (currentGenre && s.genre && s.genre === currentGenre) score += 2.5;
            if (currentBpm && s.bpm) {
              const bpmDiff = Math.abs(s.bpm - currentBpm);
              if (bpmDiff < 10) score += 2;
              else if (bpmDiff < 20) score += 1;
            }

            if (s.energy != null && lastSong.energy != null) {
              const energyDiff = Math.abs(s.energy - lastSong.energy);
              if (energyDiff < 0.15) score += 1.5;
            }

            if (appCategory === 'coding' && (s.genre === 'classical' || s.genre === 'ambient' || s.genre === 'lo-fi' || s.bpm && s.bpm < 100)) score += 1;
            if (appCategory === 'browser' && s.likeState === 'LIKE') score += 1;

            if (weather) {
              const wp = db.getWeatherProfile(
                weather.condition.includes('rain') ? 'rain' :
                weather.condition === 'clear' ? 'clear' :
                weather.condition.includes('cloud') ? 'cloudy' : null
              );
              if (wp && s.energy != null) {
                const delta = Math.abs(s.energy - wp.avgEnergy);
                if (delta < 0.1) score += 2;
                else if (delta > 0.3) score -= 1.5;
              }
            }

            const hp = db.getHourProfile(hour);
            if (hp && s.energy != null) {
              const hDelta = Math.abs(s.energy - hp.avgEnergy);
              if (hDelta < 0.1) score += 1.5;
              else if (hDelta > 0.3) score -= 1;
            }

            if (s.genre && !currentGenre) score += 1;

            candidates.push({
              videoId: s.videoId, title: s.title, artist: s.artist,
              genre: s.genre, bpm: s.bpm, energy: s.energy,
              affinityScore: Math.round(affinity * 100) / 100,
              score: Math.round(score * 10) / 10,
              reason: followUpIds.has(s.videoId) ? 'played in similar past sessions' : null,
            });
          }
        }

        candidates.sort((a, b) => b.score - a.score);
        const selected = candidates.slice(0, count);

        let queuedCount = 0;
        for (const s of selected) {
          try {
            const validId = await resolveVideoId(s.videoId, { timeout: 5000 });
            if (validId) {
              await api('/api/v1/queue', { method: 'POST', body: { videoId: validId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } });
              await sleep(200);
              queuedCount++;
            }
          } catch {}
        }

        const burnoutResult = features.getBurnoutReport();

        const result = {
          mode: 'history',
          queued: queuedCount,
          burnoutContext: {
            fatiguedCount: burnoutResult.totalFatigued,
            decliningCount: burnoutResult.totalDeclining,
            fatigueRate: burnoutResult.fatigueRate,
            trend: burnoutResult.recentTrend?.status || 'unknown',
            advice: burnoutResult.recommendation,
          },
          context: {
            hour: `${hour}:00`,
            weather: weather ? `${weather.condition} ${weather.tempC}°C` : 'unknown',
            activeApp: `${activeApp} (${appCategory})`,
            currentSong: currentSong?.videoId ? `${currentSong.title} - ${currentSong.artist}` : 'none',
            sessionId: session?.id || 'none',
            sessionLength: sessionSongs.length,
            similarSessionsFound: similarSessions.length,
          },
          recommendations: selected.map(s => ({
            title: s.title, artist: s.artist, genre: s.genre,
            confidence: s.score > 8 ? 'high' : s.score > 5 ? 'medium' : 'low',
            affinityScore: s.affinityScore,
            score: s.score,
            reason: s.reason || (
              s.genre && currentGenre && s.genre === currentGenre ? 'same genre as current' :
              s.likeState === 'LIKE' ? 'liked song' :
              s.affinityScore > 2 ? 'high affinity' : 'matches vibe'
            ),
          })),
        };

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'ytm_enter_flow_state': {
        const flowApp = args.appCategory || (() => {
          const app = getActiveWindow();
          return app.includes('code') || app.includes('vim') ? 'coding' :
                 app.includes('term') ? 'terminal' : 'coding';
        })();
        const count = args.count || 5;
        const mode = args.mode || 'search_brief';

        if (mode === 'history') {
          const flowProfile = db.getFlowProfile(flowApp);
          if (!flowProfile) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not enough data. Need ≥5 context-rich listens in ' + flowApp + ' app category.' }) }] };

          const candidates = db.getAffinityScores(0, 50).filter(s => {
            if (s.energy == null || s.bpm == null) return false;
            const bpmOk = s.bpm >= flowProfile.bpm.min && s.bpm <= flowProfile.bpm.max;
            const energyOk = s.energy >= flowProfile.energy.min && s.energy <= flowProfile.energy.max;
            return bpmOk && energyOk;
          }).slice(0, count);

          let queued = 0;
          for (const c of candidates) {
            try {
              const validId = await resolveVideoId(c.videoId, { timeout: 5000 });
              if (validId) {
                await api('/api/v1/queue', { method: 'POST', body: { videoId: validId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } });
                await sleep(200);
                queued++;
              }
            } catch {}
          }

          return { content: [{ type: 'text', text: JSON.stringify({
            mode: 'history',
            appCategory: flowApp,
            flowProfile,
            queued,
            recommendations: candidates.map(c => ({
              title: c.title, artist: c.artist, bpm: c.bpm, energy: c.energy, affinityScore: c.affinityScore,
            })),
          }, null, 2) }] };
        }

        // search_brief mode
        const flowProfile = db.getFlowProfile(flowApp);
        if (!flowProfile) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not enough data. Need ≥5 context-rich listens in ' + flowApp + ' app category.' }) }] };

        const webQueries = [
          `flow state music ${flowApp} ${flowProfile.bpm.avg}bpm`,
          `best songs for ${flowApp} productivity ${flowProfile.bpm.min}-${flowProfile.bpm.max}bpm`,
          flowProfile.genres.length ? `${flowProfile.genres.slice(0, 2).join(' ')} focus music` : 'instrumental focus music',
          `music similar to ${flowProfile.bpm.avg}bpm ${flowProfile.genres[0] || 'instrumental'} for deep work`,
        ].filter(Boolean);

        return { content: [{ type: 'text', text: JSON.stringify({
          mode: 'search_brief',
          appCategory: flowApp,
          flowProfile,
          searchBrief: {
            instruction: `Search the web for songs matching this flow profile. Then use ytm_search + ytm_queue_add to queue them.`,
            webQueries,
          },
          executionHint: `1. Web search for songs matching the flow profile\n2. ytm_search each result\n3. Show user what you found and ask if they want them queued\n4. ytm_queue_add with position "next"`,
        }, null, 2) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    { name: 'music-recommendation', description: 'Get personalized music recommendations', arguments: [{ name: 'genre', description: 'Preferred genre (optional)', required: false }, { name: 'mood', description: 'Current mood (optional)', required: false }] },
    { name: 'user-context', description: 'Get the user\'s personal music preferences context — their emotional/technical/psychological connections to songs they love. Call this at session start to personalize all interactions.', arguments: [] },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name === 'music-recommendation') {
    return { messages: [{ role: 'user', content: { type: 'text', text: `Recommend music${req.params.arguments?.genre ? ` in genre: ${req.params.arguments.genre}` : ''}${req.params.arguments?.mood ? ` for mood: ${req.params.arguments.mood}` : ''}` } }] };
  }
  if (req.params.name === 'user-context') {
    const prefs = db.getAllPreferences();
    const summary = {
      totalSaved: prefs.length,
      preferences: prefs.map(p => ({
        title: p.title, artist: p.artist,
        emotional: p.emotional, technical: p.technical,
        psychological: p.psychological, particular: p.particular,
        meaning: p.meaning, lyricsSnippet: p.lyricsSnippet,
        registeredAt: p.createdAt,
      })),
      note: 'This is the user\'s personal song preference context. Use it to personalize recommendations, understand their taste, and reference past conversations about songs.',
    };
    return { messages: [{ role: 'user', content: { type: 'text', text: JSON.stringify(summary, null, 2) } }] };
  }
  throw new Error(`Unknown prompt: ${req.params.name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
