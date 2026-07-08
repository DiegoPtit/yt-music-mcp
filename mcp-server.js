#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const HISTORY_FILE = `${process.env.HOME}/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/listening-history.json`;
const API_BASE = 'http://0.0.0.0:26538';
const AUTH_ID = 'mr6o2iu4';

const fs = require('fs');

let token = null;

async function getToken() {
  if (token) return token;
  try {
    const res = await fetch(`${API_BASE}/auth/${AUTH_ID}`, { method: 'POST' });
    if (!res.ok) throw new Error(`Auth: ${res.status}`);
    token = (await res.json()).accessToken;
    return token;
  } catch (e) {
    throw new Error(`Cannot connect to YT Music API: ${e.message}`);
  }
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

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {}
  return { songs: [], byDate: {} };
}

function getTopGenres(songs, limit = 5) {
  const counts = {};
  songs.forEach(s => {
    const g = s.genre || 'Unknown';
    counts[g] = (counts[g] || 0) + (s.playCount || 1);
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([g, c]) => ({ genre: g, plays: c }));
}

function getTopArtists(songs, limit = 10) {
  const counts = {};
  songs.forEach(s => {
    counts[s.artist] = (counts[s.artist] || 0) + (s.playCount || 1);
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([a, c]) => ({ artist: a, plays: c }));
}

function getFavTags(songs) {
  const genres = getTopGenres(songs, 5);
  const artists = getTopArtists(songs, 10);
  const topSongs = songs.sort((a, b) => (b.playCount || 0) - (a.playCount || 0)).slice(0, 20);
  return { genres, artists, topSongs };
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
  { name: 'yt-music-control', version: '1.0.0' },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ytm_now',
      description: 'Get current playing song info (title, artist, album, progress, like state, etc.)',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_play_pause',
      description: 'Toggle play/pause',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_next',
      description: 'Skip to next song',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_previous',
      description: 'Go back to previous song',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_search',
      description: 'Search for songs, albums, or playlists on YouTube Music',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          type: { type: 'string', enum: ['song', 'video', 'album', 'playlist'], description: 'Type of results (default: song)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'ytm_play_song',
      description: 'Play a specific song by videoId or by search (title + artist)',
      inputSchema: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: 'YouTube video ID' },
          query: { type: 'string', description: 'Search query (title + artist) to find and play' },
        },
      },
    },
    {
      name: 'ytm_queue',
      description: 'Get current queue',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_queue_add',
      description: 'Add a song to the queue',
      inputSchema: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: 'YouTube video ID to add' },
          position: { type: 'string', enum: ['end', 'next'], description: 'Where to insert (default: end)' },
        },
        required: ['videoId'],
      },
    },
    {
      name: 'ytm_queue_clear',
      description: 'Clear the queue',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_like',
      description: 'Like the current song',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_dislike',
      description: 'Dislike the current song',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_volume',
      description: 'Set volume (0-100)',
      inputSchema: {
        type: 'object',
        properties: {
          volume: { type: 'number', minimum: 0, maximum: 100, description: 'Volume level 0-100' },
        },
        required: ['volume'],
      },
    },
    {
      name: 'ytm_seek',
      description: 'Seek to a position in the current song (in seconds)',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Position in seconds' },
        },
        required: ['seconds'],
      },
    },
    {
      name: 'ytm_history',
      description: 'Get listening history with stats, top songs, genre breakdown, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of songs to return (default: 20)' },
          sort: { type: 'string', enum: ['recent', 'plays', 'liked'], description: 'Sort order' },
        },
      },
    },
    {
      name: 'ytm_stats',
      description: 'Get listening statistics (total songs, plays, genres, top artists)',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ytm_recommend',
      description: 'Get song recommendations based on your listening history',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of recommendations (default: 5)' },
          genre: { type: 'string', description: 'Filter by genre (optional)' },
          mood: { type: 'string', enum: ['energetic', 'chill', 'focus', 'happy', 'sad'], description: 'Mood filter (optional)' },
        },
      },
    },
    {
      name: 'ytm_play_recommendation',
      description: 'Play a recommended song from the recommendation list',
      inputSchema: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: 'Video ID from recommendation to play' },
        },
        required: ['videoId'],
      },
    },
    {
      name: 'ytm_mix',
      description: 'Create a custom mix: clear queue, play first song, then queue the rest in order. Pass songs in DESIRED ORDER (first = play now, rest = next up)',
      inputSchema: {
        type: 'object',
        properties: {
          songs: {
            type: 'array',
            description: 'Array of songs in desired playback order. First song plays now, rest are queued as next-up',
            items: {
              type: 'object',
              properties: {
                videoId: { type: 'string', description: 'YouTube video ID' },
                title: { type: 'string', description: 'Song title (for display, optional)' },
                artist: { type: 'string', description: 'Artist name (for display, optional)' },
              },
              required: ['videoId'],
            },
          },
        },
        required: ['songs'],
      },
    },
    {
      name: 'ytm_playlist_start',
      description: 'Start playing a playlist or radio based on a song or search query',
      inputSchema: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: 'Start a radio from this videoId' },
          query: { type: 'string', description: 'Or search and play first result' },
          type: { type: 'string', enum: ['song', 'playlist', 'album'], description: 'Type of result to play' },
        },
      },
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
              title: song.title,
              artist: song.artist,
              album: song.album,
              duration: song.songDuration,
              elapsed: song.elapsedSeconds,
              progress: `${Math.round(song.elapsedSeconds / song.songDuration * 100)}%`,
              isPaused: song.isPaused,
              likeState: like?.state,
              views: song.views,
              mediaType: song.mediaType,
              videoId: song.videoId,
              url: song.url,
            }, null, 2),
          }],
        };
      }

      case 'ytm_play_pause': {
        await api('/api/v1/toggle-play', { method: 'POST' });
        return { content: [{ type: 'text', text: 'Toggled play/pause' }] };
      }

      case 'ytm_next': {
        await api('/api/v1/next', { method: 'POST' });
        return { content: [{ type: 'text', text: 'Skipped to next song' }] };
      }

      case 'ytm_previous': {
        await api('/api/v1/previous', { method: 'POST' });
        return { content: [{ type: 'text', text: 'Went to previous song' }] };
      }

      case 'ytm_search': {
        const data = await api('/api/v1/search', {
          method: 'POST',
          timeout: 10000,
          body: { query: args.query, params: args.type || 'song' },
        });
        const songs = extractSearchResults(data);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ query: args.query, total: songs.length, results: songs.slice(0, 20) }, null, 2),
          }],
        };
      }

      case 'ytm_play_song': {
        if (args.videoId) {
          const validId = await resolveVideoId(args.videoId);
          if (!validId)
            return { content: [{ type: 'text', text: `videoId inválido: ${args.videoId}` }], isError: true };
          const result = await playVideoById(validId);
          if (result.info) return { content: [{ type: 'text', text: `Reproduciendo: ${result.info.title} - ${result.info.artist}` }] };
          return { content: [{ type: 'text', text: `No se pudo reproducir ese video en YouTube Music (probá con una búsqueda por nombre)` }], isError: true };
        }
        if (!args.query)
          return { content: [{ type: 'text', text: 'Provee videoId o query' }], isError: true };
        const search = await api('/api/v1/search', {
          method: 'POST', timeout: 10000,
          body: { query: args.query, params: 'song' },
        });
        const results = extractSearchResults(search);
        if (results.length === 0)
          return { content: [{ type: 'text', text: `Sin resultados para: ${args.query}` }], isError: true };
        for (const r of results) {
          const validId = await resolveVideoId(r.videoId);
          if (!validId) continue;
          const result = await playVideoById(validId);
          if (result.info) return { content: [{ type: 'text', text: `Reproduciendo: ${result.info.title} - ${result.info.artist}` }] };
        }
        return { content: [{ type: 'text', text: `No se pudo reproducir ningún resultado de búsqueda` }], isError: true };
      }

      case 'ytm_queue': {
        const queue = await api('/api/v1/queue');
        return { content: [{ type: 'text', text: JSON.stringify(queue, null, 2) }] };
      }

      case 'ytm_queue_add': {
        await api('/api/v1/queue', {
          method: 'POST',
          body: { videoId: args.videoId, insertPosition: args.position === 'next' ? 'INSERT_AFTER_CURRENT_VIDEO' : 'INSERT_AT_END' },
        });
        return { content: [{ type: 'text', text: `Added ${args.videoId} to queue` }] };
      }

      case 'ytm_queue_clear': {
        await api('/api/v1/queue', { method: 'DELETE' });
        return { content: [{ type: 'text', text: 'Queue cleared' }] };
      }

      case 'ytm_like': {
        await api('/api/v1/like', { method: 'POST' });
        return { content: [{ type: 'text', text: 'Liked current song' }] };
      }

      case 'ytm_dislike': {
        await api('/api/v1/dislike', { method: 'POST' });
        return { content: [{ type: 'text', text: 'Disliked current song' }] };
      }

      case 'ytm_volume': {
        await api(`/api/v1/volume?volume=${args.volume}`, { method: 'POST' });
        return { content: [{ type: 'text', text: `Volume set to ${args.volume}` }] };
      }

      case 'ytm_seek': {
        await api('/api/v1/seek-to', { method: 'POST', body: { seconds: args.seconds } });
        return { content: [{ type: 'text', text: `Seeked to ${args.seconds}s` }] };
      }

      case 'ytm_history': {
        const h = loadHistory();
        let songs = [...h.songs];
        const sort = args.sort || 'recent';
        if (sort === 'plays') songs.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
        else if (sort === 'liked') songs = songs.filter(s => s.likeState === 'LIKE').sort((a, b) => new Date(b.lastListened) - new Date(a.lastListened));
        else songs.sort((a, b) => new Date(b.lastListened) - new Date(a.lastListened));
        const limit = args.limit || 20;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              total: h.songs.length,
              totalPlays: h.songs.reduce((a, s) => a + (s.playCount || 0), 0),
              days: Object.keys(h.byDate).length,
              songs: songs.slice(0, limit),
            }, null, 2),
          }],
        };
      }

      case 'ytm_stats': {
        const h = loadHistory();
        const songs = h.songs;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              totalSongs: songs.length,
              totalPlays: songs.reduce((a, s) => a + (s.playCount || 0), 0),
              likedSongs: songs.filter(s => s.likeState === 'LIKE').length,
              daysActive: Object.keys(h.byDate).length,
              topGenres: getTopGenres(songs),
              topArtists: getTopArtists(songs),
              topSongs: songs.sort((a, b) => (b.playCount || 0) - (a.playCount || 0)).slice(0, 10).map(s => ({
                title: s.title,
                artist: s.artist,
                plays: s.playCount,
                genre: s.genre,
                liked: s.likeState === 'LIKE',
              })),
            }, null, 2),
          }],
        };
      }

      case 'ytm_recommend': {
        const h = loadHistory();
        const songs = h.songs;
        if (songs.length === 0) {
          return { content: [{ type: 'text', text: 'No history yet. Listen to some songs first!' }] };
        }

        const tags = getFavTags(songs);
        const topGenre = args.genre || tags.genres[0]?.genre;
        const topArtists = tags.artists.slice(0, 5);

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
            const data = await api('/api/v1/search', {
              method: 'POST',
              timeout: 10000,
              body: { query: q, params: 'song' },
            });
            const items = extractSearchResults(data);
            const fresh = items.filter(r => r.videoId && !knownIds.has(r.videoId));
            results.push(...fresh.slice(0, 5));
          } catch {}
        }

        const seen = new Set();
        const unique = results.filter(r => {
          if (seen.has(r.videoId)) return false;
          seen.add(r.videoId);
          return true;
        }).slice(0, args.count || 5);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              basedOn: {
                genre: topGenre,
                topArtists: topArtists.map(a => a.artist),
                mood: args.mood || null,
              },
              recommendations: unique.map(r => ({
                title: r.title,
                artist: r.artist,
                videoId: r.videoId,
                album: r.album,
                duration: r.duration,
              })),
            }, null, 2),
          }],
        };
      }

      case 'ytm_play_recommendation': {
        const validId = await resolveVideoId(args.videoId);
        if (!validId)
          return { content: [{ type: 'text', text: `videoId inválido: ${args.videoId}` }], isError: true };
        const result = await playVideoById(validId);
        if (result.info) return { content: [{ type: 'text', text: `Reproduciendo: ${result.info.title} - ${result.info.artist}` }] };
        return { content: [{ type: 'text', text: `Error al reproducir recomendación` }], isError: true };
      }

      case 'ytm_mix': {
        const songs = args.songs;
        if (!songs || songs.length < 2)
          return { content: [{ type: 'text', text: 'Necesitás al menos 2 canciones para un mix' }], isError: true };

        const first = songs[0];
        const rest = songs.slice(1);

        const validFirst = await resolveVideoId(first.videoId);
        if (!validFirst)
          return { content: [{ type: 'text', text: `videoId inválido: ${first.videoId}` }], isError: true };

        await api('/api/v1/queue', { method: 'DELETE' });
        await sleep(600);

        await api('/api/v1/queue', {
          method: 'POST',
          body: { videoId: validFirst, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' },
        });
        await sleep(600);

        const qCheck = await api('/api/v1/queue');
        if (!qCheck?.items?.length) return { content: [{ type: 'text', text: 'No se pudo encolar la primera canción' }], isError: true };

        await api('/api/v1/next', { method: 'POST' });
        await sleep(3000);

        let queued = 0;
        let failed = 0;
        for (let i = rest.length - 1; i >= 0; i--) {
          const s = rest[i];
          const vid = await resolveVideoId(s.videoId);
          if (!vid) { failed++; continue; }
          await api('/api/v1/queue', {
            method: 'POST',
            body: { videoId: vid, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' },
          });
          await sleep(400);
          queued++;
        }

        const info = await api('/api/v1/song');
        const label = info ? `${info.title} - ${info.artist}` : (first.title || first.videoId);
        return {
          content: [{ type: 'text', text: `Mix creado: "${label}" + ${queued} canciones encoladas${failed ? ` (${failed} fallaron)` : ''}` }],
        };
      }

      case 'ytm_playlist_start': {
        if (args.videoId) {
          const validId = await resolveVideoId(args.videoId);
          if (!validId)
            return { content: [{ type: 'text', text: `videoId inválido: ${args.videoId}` }], isError: true };
          const result = await playVideoById(validId);
          if (result.info) return { content: [{ type: 'text', text: `Reproduciendo: ${result.info.title} - ${result.info.artist}` }] };
          return { content: [{ type: 'text', text: `Error al reproducir` }], isError: true };
        }
        if (args.query) {
          const data = await api('/api/v1/search', {
            method: 'POST', timeout: 10000,
            body: { query: args.query, params: args.type || 'song' },
          });
          const songs = extractSearchResults(data);
          if (songs.length === 0)
            return { content: [{ type: 'text', text: 'Sin resultados' }], isError: true };
          for (const s of songs) {
            const validId = await resolveVideoId(s.videoId);
            if (!validId) continue;
            const result = await playVideoById(validId);
            if (result.info) return { content: [{ type: 'text', text: `Reproduciendo: ${result.info.title} - ${result.info.artist}` }] };
          }
          return { content: [{ type: 'text', text: 'No se pudo reproducir ningún resultado' }], isError: true };
        }
        return { content: [{ type: 'text', text: 'Provee videoId o query' }], isError: true };
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
    {
      name: 'music-recommendation',
      description: 'Get personalized music recommendations',
      arguments: [
        { name: 'genre', description: 'Preferred genre (optional)', required: false },
        { name: 'mood', description: 'Current mood (optional)', required: false },
      ],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'music-recommendation') {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Recommend music${args?.genre ? ` in genre: ${args.genre}` : ''}${args?.mood ? ` for mood: ${args.mood}` : ''}`,
          },
        },
      ],
    };
  }
  throw new Error(`Unknown prompt: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
