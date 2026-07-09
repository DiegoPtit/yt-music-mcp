#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const API_BASE = 'http://0.0.0.0:26538';
const AUTH_ID = 'mr6o2iu4';
const db = require('./db');

let token = null;

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

async function resolveVideoId(videoId) {
  const valid = videoId && /^[\w-]{11}$/.test(videoId);
  if (!valid) return null;
  try {
    const res = await fetch(`https://music.youtube.com/youtubei/v1/player?key=AIzaSyC9XL3ZjBdd0deK2q1kR0mGnS1lW4P3O8k`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250325.01.00' } },
        videoId,
      }),
      signal: AbortSignal.timeout(3000),
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

const server = new Server(
  { name: 'yt-music-control', version: '2.0.0' },
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
      description: 'Add a song to the queue',
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
    { name: 'ytm_stats', description: 'Get listening statistics (total songs, plays, genres, top artists)', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'ytm_recommend',
      description: 'Get song recommendations based on your listening history',
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
      description: 'Create a custom mix: clear queue, play first song, then queue the rest in order.',
      inputSchema: { type: 'object', properties: {
        songs: { type: 'array', description: 'Songs in desired order (first = play now, rest = next up)', items: { type: 'object', properties: { videoId: { type: 'string' }, title: { type: 'string' }, artist: { type: 'string' } }, required: ['videoId'] } },
      }, required: ['songs'] },
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
      description: 'Find similar songs from your history based on a given song or artist',
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
      description: 'Auto-create a mix based on current hour/day patterns from your history',
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
      description: 'If recent songs are high-energy, enable crossfade and boost volume',
      inputSchema: { type: 'object', properties: {
        threshold: { type: 'number', description: 'BPM threshold for "high energy" (default: 120)' },
        volume: { type: 'number', description: 'Volume boost level 0-100 (default: 70)' },
      } },
    },
    {
      name: 'ytm_weather_play',
      description: 'Generate a playlist based on simulated weather (uses hour/day as proxy since no weather API)',
      inputSchema: { type: 'object', properties: {
        vibe: { type: 'string', enum: ['morning', 'afternoon', 'night', 'rainy', 'sunny', 'chill'], description: 'Vibe/mood for the playlist (default: auto from current hour)' },
        count: { type: 'number', description: 'Number of songs (default: 8)' },
      } },
    },
    {
      name: 'ytm_lyrics',
      description: 'Get synced lyrics for the current playing song (via YT Music if available)',
      inputSchema: { type: 'object', properties: {} },
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
        const data = await api('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: args.query, params: args.type || 'song' } });
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
        const search = await api('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: args.query, params: 'song' } });
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
            const data = await api('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: q, params: 'song' } });
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
        const mixSongs = args.songs;
        if (!mixSongs || mixSongs.length < 2) return { content: [{ type: 'text', text: 'Need at least 2 songs for a mix' }], isError: true };
        const first = mixSongs[0];
        const rest = mixSongs.slice(1);
        const validFirst = await resolveVideoId(first.videoId);
        if (!validFirst) return { content: [{ type: 'text', text: `Invalid videoId for first song: ${first.videoId}` }], isError: true };
        await api('/api/v1/queue', { method: 'DELETE' }); await sleep(600);
        await api('/api/v1/queue', { method: 'POST', body: { videoId: validFirst, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } }); await sleep(800);
        await api('/api/v1/next', { method: 'POST' }); await sleep(3000);
        const nowCheck = await api('/api/v1/song');
        if (!nowCheck || !nowCheck.videoId || nowCheck.videoId === 'unknown') return { content: [{ type: 'text', text: 'Failed to play first song' }], isError: true };
        let queued = 0, failed = 0;
        for (const s of rest) {
          const vid = await resolveVideoId(s.videoId);
          if (!vid) { failed++; continue; }
          await api('/api/v1/queue', { method: 'POST', body: { videoId: vid, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' } });
          await sleep(400); queued++;
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
          const data = await api('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: args.query, params: args.type || 'song' } });
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
        const data = await api('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: args.query, params: args.type || 'song' } });
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

      case 'ytm_similar_to': {
        let artist = args.artist;
        let genre = null;
        let bpm = null;
        if (args.videoId) {
          const song = db.getSong(args.videoId);
          if (song) { artist = song.artist; genre = song.genre; bpm = song.bpm; }
        }
        if (!artist) return { content: [{ type: 'text', text: 'Provide videoId or artist name' }], isError: true };
        const sameArtist = db.getSongsByArtist(artist, args.limit || 10).filter(s => !args.videoId || s.videoId !== args.videoId);
        let similar = [];
        if (genre && genre !== 'Unknown') {
          similar = db.getSongsByGenre(genre).filter(s => s.artist !== artist && !sameArtist.find(x => x.videoId === s.videoId));
        }
        const result = { artist, genre, bpm, sameArtist: sameArtist.slice(0, args.limit || 10), genreSimilar: similar.slice(0, args.limit || 10) };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
            const data = await api('/api/v1/search', { method: 'POST', timeout: 10000, body: { query: `${g.genre} new songs 2026`, params: 'song' } });
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
        const hour = new Date().getHours();
        const vibe = args.vibe || (hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'night');
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
        return { content: [{ type: 'text', text: `${vibe} playlist created: "${first.title} - ${first.artist}" + ${queued} songs` }] };
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
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name === 'music-recommendation') {
    return { messages: [{ role: 'user', content: { type: 'text', text: `Recommend music${req.params.arguments?.genre ? ` in genre: ${req.params.arguments.genre}` : ''}${req.params.arguments?.mood ? ` for mood: ${req.params.arguments.mood}` : ''}` } }] };
  }
  throw new Error(`Unknown prompt: ${req.params.name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
