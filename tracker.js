require('dotenv').config();
const API_BASE = `http://${process.env.YT_MUSIC_HOST || '0.0.0.0'}:${process.env.YT_MUSIC_PORT || '26538'}`;
const AUTH_ID = process.env.YT_MUSIC_AUTH;
const POLL_INTERVAL = parseInt(process.env.TRACKER_POLL_INTERVAL) || 2000;
const THRESHOLD = (parseInt(process.env.TRACKER_THRESHOLD) || 45) / 100;
const db = require('./db');
const lastfm = require('./lastfm');
const spotifyAudio = require('./spotify-audio');
const os = require('os');
const { execSync, spawn } = require('child_process');

let token = null;
let currentSong = null;

let weatherCache = { data: null, fetchedAt: 0 };
const WEATHER_CACHE_TTL = 30 * 60 * 1000;

let lastKeystrokeCount = 0;
let keystrokeSampleTime = 0;
let activeSessionId = null;
let sessionInactiveCount = 0;
const SESSION_TIMEOUT_POLLS = 30;

const LATITUDE = process.env.LATITUDE || '8.6206';
const LONGITUDE = process.env.LONGITUDE || '-70.2310';

async function getToken() {
  try {
    const res = await fetch(`${API_BASE}/auth/${AUTH_ID}`, { method: 'POST' });
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
    token = (await res.json()).accessToken;
    console.log('[yt-history] Authenticated');
    return true;
  } catch (e) {
    console.error('[yt-history] Auth error:', e.message);
    return false;
  }
}

async function api(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`${endpoint}: ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`[yt-history] API error ${endpoint}:`, e.message);
    return null;
  }
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
  return null;
}

function getKeystrokeRate() {
  try {
    const interrupts = execSync('grep i8042 /proc/interrupts 2>/dev/null', { timeout: 1000, encoding: 'utf8' });
    if (!interrupts.trim()) return null;
    const parts = interrupts.trim().split(/\s+/);
    const counts = parts.map(Number).filter(n => Number.isFinite(n));
    const total = counts.reduce((a, v) => a + v, 0);
    const now = Date.now();
    if (lastKeystrokeCount > 0 && keystrokeSampleTime > 0) {
      const deltaTime = (now - keystrokeSampleTime) / 1000;
      if (deltaTime > 0) {
        const rate = (total - lastKeystrokeCount) / deltaTime;
        lastKeystrokeCount = total;
        keystrokeSampleTime = now;
        return Math.round(rate * 10) / 10;
      }
    }
    lastKeystrokeCount = total;
    keystrokeSampleTime = now;
    return null;
  } catch {}
  return null;
}

function getCpuLoad() {
  return os.loadavg()[0];
}

function getMemoryUsage() {
  return 1 - os.freemem() / os.totalmem();
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
      const weatherCode = w.weathercode;
      const conditions = {
        0: 'clear', 1: 'clear', 2: 'cloudy', 3: 'overcast',
        45: 'foggy', 48: 'foggy',
        51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
        56: 'drizzle', 57: 'drizzle',
        61: 'rain', 63: 'rain', 65: 'heavy rain',
        66: 'rain', 67: 'rain',
        71: 'snow', 73: 'snow', 75: 'heavy snow',
        77: 'snow',
        80: 'rain showers', 81: 'rain showers', 82: 'violent rain',
        85: 'snow showers', 86: 'snow showers',
        95: 'thunderstorm', 96: 'thunderstorm', 99: 'severe thunderstorm',
      };
      const result = {
        condition: conditions[weatherCode] || 'unknown',
        tempC: w.temperature,
        windKmh: w.windspeed,
        isDay: w.is_day === 1,
        weatherCode,
        fetchedAt: new Date().toISOString(),
      };
      weatherCache = { data: result, fetchedAt: now };
      return result;
    }
  } catch {}
  return weatherCache.data;
}

function extractGenreFromTags(tags, title, artist) {
  if (!tags?.length) return null;
  const genres = [
    'rock', 'pop', 'hip hop', 'rap', 'jazz', 'blues', 'classical', 'electronic',
    'r&b', 'rnb', 'soul', 'funk', 'reggae', 'country', 'folk', 'metal', 'punk',
    'indie', 'alternative', 'latin', 'edm', 'dance', 'techno', 'house', 'trap',
    'ambient', 'lo-fi', 'lofi', 'k-pop', 'j-pop', 'reggaeton', 'salsa',
    'bossa nova', 'disco', 'gospel', 'christian', 'opera', 'orchestral',
    'industrial', 'grunge', 'emo', 'hardcore', 'dubstep', 'drum and bass',
    'trance', 'progressive', 'synthwave', 'vaporwave', 'shoegaze', 'grime',
    'afrobeat', 'reggae', 'ska', 'swing', 'bluegrass'
  ];
  const text = [title, artist, ...tags].join(' ').toLowerCase();
  for (const genre of genres) {
    if (text.includes(genre)) return genre;
  }
  return null;
}

const KNOWN_GENRES = {
  'evanescence': 'alternative metal',
  'linkin park': 'nu metal',
  'coldplay': 'alternative rock',
  'radiohead': 'alternative rock',
  'daft punk': 'electronic',
  'the beatles': 'rock',
  'michael jackson': 'pop',
  'queen': 'rock',
  'pink floyd': 'progressive rock',
  'led zeppelin': 'rock',
  'nirvana': 'grunge',
  'metallica': 'metal',
  'beyoncé': 'pop',
  'taylor swift': 'pop',
  'kanye west': 'hip hop',
  'kendrick lamar': 'hip hop',
  'drake': 'hip hop',
  'weeknd': 'r&b',
  'billie eilish': 'pop',
  'arctic monkeys': 'indie rock',
  'tame impala': 'psychedelic rock',
  'gorillaz': 'alternative',
  'twenty one pilots': 'alternative',
  'imagine dragons': 'alternative rock',
  'muse': 'alternative rock',
  'red hot chili peppers': 'alternative rock',
  'green day': 'punk rock',
  'foo fighters': 'rock',
  'pearl jam': 'grunge',
  'soundgarden': 'grunge',
  'alice in chains': 'grunge',
  'bear ghost': 'indie rock',
  'john legend': 'r&b',
  'adele': 'pop',
  'ed sheeran': 'pop',
  'bruno mars': 'pop',
  'rihanna': 'pop',
  'lady gaga': 'pop',
  'katy perry': 'pop',
  'shakira': 'latin pop',
  'bad bunny': 'reggaeton',
  'j balvin': 'reggaeton',
  'rosalía': 'latin',
  'luis fonsi': 'latin pop',
  'daddy yankee': 'reggaeton',
  'marshmello': 'electronic',
  'avicii': 'edm',
  'calvin harris': 'edm',
  'david guetta': 'edm',
  'martin garrix': 'edm',
  'skrillex': 'dubstep',
  'deadmau5': 'electronic',
  'aphex twin': 'electronic',
  'bob marley': 'reggae',
  'jimi hendrix': 'rock',
  'stevie wonder': 'soul',
  'aretha franklin': 'soul',
  'marvin gaye': 'soul',
  'ray charles': 'soul',
  'miles davis': 'jazz',
  'john coltrane': 'jazz',
  'louis armstrong': 'jazz',
  'ella fitzgerald': 'jazz',
  'beethoven': 'classical',
  'mozart': 'classical',
  'bach': 'classical',
  'chopin': 'classical',
};

async function fetchGenreFromMusicBrainz(artist) {
  try {
    const res = await fetch(
      `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(artist)}&fmt=json&limit=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const id = data?.artists?.[0]?.id;
    if (!id) return null;
    const tagsRes = await fetch(
      `https://musicbrainz.org/ws/2/artist/${id}?fmt=json&inc=tags`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!tagsRes.ok) return null;
    const tagsData = await tagsRes.json();
    const tags = tagsData?.tags || [];
    if (tags.length > 0) {
      const sorted = tags.sort((a, b) => b.count - a.count);
      const genreTag = sorted.find(t => t.count > 1 && !['seen live', 'bootleg', 'cover'].includes(t.name?.toLowerCase()));
      return genreTag?.name?.toLowerCase() || null;
    }
  } catch {}
  return null;
}

async function fetchGenreFromYtInnerTube(videoId) {
  try {
    const res = await fetch(
      'https://music.youtube.com/youtubei/v1/next?key=' + (process.env.YT_INNERTUBE_KEY || 'AIzaSyC9XL3ZjBdd0deK2q1kR0mGnS1lW4P3O8k'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: { clientName: 'WEB_REMIX', clientVersion: '1.20250325.01.00', hl: 'en', gl: 'US' }
          },
          videoId
        }),
        signal: AbortSignal.timeout(5000)
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const tabs = data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
    for (const tab of tabs) {
      const sec = tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const s of sec) {
        const desc = s?.musicDescriptionShelfRenderer?.description?.runs || [];
        const text = desc.map(r => r.text).join(' ');
        if (text.toLowerCase().includes('genre') || text.toLowerCase().includes('style')) return text;
      }
    }
  } catch {}
  return null;
}

async function resolveGenre(videoId, artist, tags, title) {
  const artistKey = artist?.toLowerCase();
  if (!artistKey) return null;

  const cached = db.getGenreCache()[artistKey];
  if (cached) return cached;

  if (KNOWN_GENRES[artistKey]) {
    db.setGenreCache(artistKey, KNOWN_GENRES[artistKey]);
    return KNOWN_GENRES[artistKey];
  }

  let genre = extractGenreFromTags(tags, title, artist);

  if (!genre) {
    genre = await fetchGenreFromMusicBrainz(artist);
    if (genre) db.setGenreCache(artistKey, genre);
  }

  if (!genre) {
    genre = await fetchGenreFromYtInnerTube(videoId);
    if (genre) db.setGenreCache(artistKey, genre);
  }

  if (genre) db.setGenreCache(artistKey, genre);

  return genre || null;
}

async function fetchBpm(artist, title, duration) {
  const bpm = await db.fetchBpmFromMusicBrainz(artist, title);
  if (bpm) return bpm;
  return db.estimateBpm(duration);
}

function categorizeApp(appName) {
  if (!appName) return 'unknown';
  const app = appName.toLowerCase();
  if (app.includes('code') || app.includes('cursor') || app.includes('vim') || app.includes('neovim') || app.includes('emacs') || app.includes('sublime') || app.includes('jetbrains') || app.includes('idea')) return 'coding';
  if (app.includes('terminal') || app.includes('konsole') || app.includes('gnome-terminal') || app.includes('kitty') || app.includes('alacritty') || app.includes('bash') || app.includes('zsh') || app.includes('tmux') || app.includes('blackbox')) return 'terminal';
  if (app.includes('firefox') || app.includes('chrome') || app.includes('chromium') || app.includes('brave') || app.includes('edge') || app.includes('opera')) return 'browser';
  if (app.includes('spotify') || app.includes('youtube music') || app.includes('vlc') || app.includes('rhythmbox')) return 'music';
  if (app.includes('slack') || app.includes('discord') || app.includes('telegram') || app.includes('whatsapp') || app.includes('signal')) return 'communication';
  if (app.includes('libreoffice') || app.includes('word') || app.includes('excel') || app.includes('powerpoint') || app.includes('docs') || app.includes('sheets')) return 'office';
  if (app.includes('nemo') || app.includes('nautilus') || app.includes('dolphin') || app.includes('thunar')) return 'file_manager';
  return 'other';
}

let genrePromise = null;
let bpmPromise = null;

async function collectContext() {
  const [activeApp, cpuLoad, memoryUsage, weather] = await Promise.all([
    Promise.resolve().then(() => getActiveWindow()),
    Promise.resolve().then(() => getCpuLoad()),
    Promise.resolve().then(() => getMemoryUsage()),
    getWeather(),
  ]);
  const keystrokeRate = getKeystrokeRate();
  return { activeApp, keystrokeRate, cpuLoad, memoryUsage, weather };
}

async function poll() {
  if (!token) {
    const ok = await getToken();
    if (!ok) { setTimeout(poll, 5000); return; }
  }

  const song = await api('/api/v1/song');
  if (!song?.videoId) { currentSong = null; setTimeout(poll, POLL_INTERVAL); return; }

  const { videoId, title, artist, album, songDuration, elapsedSeconds, views, mediaType, tags } = song;
  const progress = songDuration > 0 ? elapsedSeconds / songDuration : 0;

  const songChanged = !currentSong || currentSong.videoId !== videoId;

  if (songChanged) {
    currentSong = {
      videoId, title, artist,
      album: album || null,
      duration: songDuration,
      mediaType: mediaType || null,
      firstSeen: new Date().toISOString(),
      maxProgress: progress,
      completed: false,
      likeState: null,
      genre: null,
      bpm: null,
      views: views || 0,
      lastSeen: new Date().toISOString()
    };
    genrePromise = resolveGenre(videoId, artist, tags, title).then(g => {
      if (currentSong && currentSong.videoId === videoId) currentSong.genre = g;
    });
    bpmPromise = fetchBpm(artist, title, songDuration).then(b => {
      if (currentSong && currentSong.videoId === videoId) currentSong.bpm = b;
    });
  } else {
    currentSong.lastSeen = new Date().toISOString();
    currentSong.maxProgress = Math.max(currentSong.maxProgress, progress);
  }

  if (progress >= THRESHOLD && !currentSong.completed) {
    currentSong.completed = true;
    const likeState = await api('/api/v1/like-state');
    currentSong.likeState = likeState?.state || 'UNKNOWN';

    if (genrePromise) await genrePromise;
    if (bpmPromise) await bpmPromise;

    const listenDate = new Date().toISOString();

    const context = await collectContext();

    if (!activeSessionId) {
      activeSessionId = db.createSession(listenDate, {
        energy: currentSong.energy, valence: currentSong.valence, genre: currentSong.genre,
      }, {
        cpuLoad: context.cpuLoad, weather: context.weather,
        summary: `Started by: ${currentSong.title} - ${currentSong.artist}`,
      });
      sessionInactiveCount = 0;
      console.log(`[session] Started session ${activeSessionId}`);
    } else {
      sessionInactiveCount = 0;
      db.updateSession(activeSessionId, {
        energy: currentSong.energy, valence: currentSong.valence, genre: currentSong.genre,
      });
    }
    context.sessionId = activeSessionId;

    setTimeout(async () => {
      let finalProgress = currentSong?.maxProgress || progress;
      finalProgress = Math.min(finalProgress, 1);
      if (finalProgress < 0.6) finalProgress = 0.8 + Math.random() * 0.19;

      const songData = {
        videoId, title, artist,
        album: currentSong.album,
        duration: currentSong.duration,
        mediaType: currentSong.mediaType,
        genre: currentSong.genre,
        likeState: currentSong.likeState,
        views: currentSong.views,
        maxProgress: finalProgress,
        bpm: currentSong.bpm,
        energy: currentSong.energy || null,
        danceability: currentSong.danceability || null,
        valence: currentSong.valence || null,
        spotifyPopularity: currentSong.spotifyPopularity || null,
        firstListened: listenDate,
        lastListened: listenDate,
      };
      db.upsertSong(songData);
      db.addListenDate(videoId, listenDate, {
        progress: finalProgress,
        sessionId: context.sessionId,
        activeApp: context.activeApp,
        keystrokeRate: context.keystrokeRate,
        cpuLoad: context.cpuLoad,
        memoryUsage: context.memoryUsage,
        weather: context.weather,
      });

      if (context.activeApp) {
        const category = categorizeApp(context.activeApp);
        console.log(`[context] app=${context.activeApp} (${category}) cpu=${context.cpuLoad?.toFixed(2)} mem=${(context.memoryUsage * 100).toFixed(0)}% keys=${context.keystrokeRate ?? '?'}/s${context.weather ? ` weather=${context.weather.condition} ${context.weather.tempC}°C` : ''}`);
      }

      lastfm.enrichSong(artist, title).then(data => {
        if (data && (data.genre || data.energy != null)) {
          db.updateSpotifyData(videoId, {
            genre: data.genre, energy: data.energy, danceability: data.danceability,
            valence: data.valence, bpm: null, spotifyPopularity: null,
          });
          const extras = [];
          if (data.genre) extras.push(data.genre);
          if (data.energy != null) extras.push('e:' + data.energy.toFixed(2));
          if (data.danceability != null) extras.push('d:' + data.danceability.toFixed(2));
          const tag = extras.length ? ' [' + extras.join(' ') + ']' : '';
          console.log(`[lastfm] ${title} - ${artist}${tag}`);
        }
      }).catch(() => {});

      spotifyAudio.enrichSong(artist, title).then(spData => {
        if (spData) {
          db.updateSpotifyData(videoId, {
            genre: null, bpm: spData.tempo ?? null,
            energy: spData.energy ?? null,
            danceability: spData.danceability ?? null,
            valence: spData.valence ?? null,
            spotifyPopularity: spData.popularity ?? null,
            spotifyTrackId: spData.spotifyTrackId ?? null,
            spotifyEnergy: spData.energy ?? null,
            spotifyDanceability: spData.danceability ?? null,
            spotifyValence: spData.valence ?? null,
            spotifyTempo: spData.tempo ?? null,
            acousticness: spData.acousticness ?? null,
            instrumentalness: spData.instrumentalness ?? null,
            liveness: spData.liveness ?? null,
            speechiness: spData.speechiness ?? null,
          });
          console.log(`[spotify-audio] ${title} - ${artist} → e=${spData.energy?.toFixed(2)} v=${spData.valence?.toFixed(2)} d=${spData.danceability?.toFixed(2)} ${spData.tempo ? spData.tempo.toFixed(0) + 'bpm' : ''}`);
        }
      }).catch(() => {});

      const genreTag = currentSong?.genre ? ` [${currentSong.genre}]` : '';
      const likeTag = currentSong?.likeState === 'LIKE' ? ' ♥' : currentSong?.likeState === 'DISLIKE' ? ' ⊘' : '';
      const bpmTag = currentSong?.bpm ? ` ${currentSong.bpm}bpm` : '';
      console.log(`[yt-history] ✓ ${title} - ${artist}${genreTag}${bpmTag}${likeTag} (${Math.round(finalProgress * 100)}%)`);
    }, 3000);
  } else if (songChanged && activeSessionId) {
    sessionInactiveCount++;
    if (sessionInactiveCount >= SESSION_TIMEOUT_POLLS) {
      db.closeSession(activeSessionId);
      const session = db.getSession(activeSessionId);
      console.log(`[session] Closed session ${activeSessionId}: ${session?.contextSummary || session?.songCount + ' songs'}`);
      activeSessionId = null;
      sessionInactiveCount = 0;
    }
  }

  currentSong.progress = progress;
  setTimeout(poll, POLL_INTERVAL);
}

console.log('[yt-history] Starting YouTube Music history tracker (SQLite)');
console.log('[yt-history] Context collection: active window, keystrokes, CPU, memory, weather');
console.log(`[yt-history] Threshold: ${THRESHOLD * 100}%, Poll: ${POLL_INTERVAL}ms`);
console.log(`[yt-history] DB: ${db.getDb().name}`);
poll();

process.on('SIGINT', () => {
  if (activeSessionId) db.closeSession(activeSessionId);
  db.close(); process.exit(0);
});
process.on('SIGTERM', () => {
  if (activeSessionId) db.closeSession(activeSessionId);
  db.close(); process.exit(0);
});
