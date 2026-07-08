const API_BASE = 'http://0.0.0.0:26538';
const AUTH_ID = 'mr6o2iu4';
const POLL_INTERVAL = 2000;
const THRESHOLD = 0.45;
const HISTORY_FILE = `${process.env.HOME}/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/listening-history.json`;
const GENRE_CACHE_FILE = `${process.env.HOME}/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/genre-cache.json`;

const fs = require('fs');
const path = require('path');

let token = null;
let currentSong = null;
let lastWrite = 0;
const WRITE_DEBOUNCE = 3000;

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { console.error(`[yt-history] Error loading ${path.basename(file)}:`, e.message); }
  return fallback;
}

const history = loadJson(HISTORY_FILE, { songs: [], byDate: {} });
const genreCache = loadJson(GENRE_CACHE_FILE, {});

function saveHistory() {
  const now = Date.now();
  if (now - lastWrite < WRITE_DEBOUNCE) return;
  lastWrite = now;
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`[yt-history] Saved ${history.songs.length} songs`);
}

function saveGenreCache() {
  fs.writeFileSync(GENRE_CACHE_FILE, JSON.stringify(genreCache, null, 2));
}

function debouncedSave() {
  const now = Date.now();
  if (now - lastWrite < WRITE_DEBOUNCE) return;
  saveHistory();
}

function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
  'daft punk': 'electronic',
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
      'https://music.youtube.com/youtubei/v1/next?key=AIzaSyC9XL3ZjBdd0deK2q1kR0mGnS1lW4P3O8k',
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

  const cached = genreCache[artistKey];
  if (cached) return cached;

  if (KNOWN_GENRES[artistKey]) {
    genreCache[artistKey] = KNOWN_GENRES[artistKey];
    saveGenreCache();
    return KNOWN_GENRES[artistKey];
  }

  let genre = extractGenreFromTags(tags, title, artist);

  if (!genre) {
    genre = await fetchGenreFromMusicBrainz(artist);
    if (genre) {
      genreCache[artistKey] = genre;
      saveGenreCache();
    }
  }

  if (!genre) {
    genre = await fetchGenreFromYtInnerTube(videoId);
    if (genre) {
      genreCache[artistKey] = genre;
      saveGenreCache();
    }
  }

  if (genre) {
    genreCache[artistKey] = genre;
    saveGenreCache();
  }

  return genre || null;
}

let genrePromise = null;

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
      views: views || 0,
      lastSeen: new Date().toISOString()
    };
    genrePromise = resolveGenre(videoId, artist, tags, title).then(g => {
      if (currentSong && currentSong.videoId === videoId) currentSong.genre = g;
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

    const listenDate = new Date().toISOString();
    const dkey = dateKey(listenDate);
    const existing = history.songs.find(s => s.videoId === videoId);

    if (existing) {
      existing.playCount = (existing.playCount || 0) + 1;
      existing.lastListened = listenDate;
      if (!existing.listenDates) existing.listenDates = [];
      existing.listenDates.push(listenDate);
      existing.maxProgress = Math.max(existing.maxProgress, currentSong.maxProgress);
      existing.likeState = currentSong.likeState;
      if (currentSong.genre && !existing.genre) existing.genre = currentSong.genre;
      if (currentSong.album && !existing.album) existing.album = currentSong.album;
      existing.views = views || existing.views;
      existing.timesCompleted = (existing.timesCompleted || 0) + 1;
      existing.mediaType = existing.mediaType || mediaType;
    } else {
      history.songs.push({
        videoId, title, artist,
        album: album || null,
        duration: songDuration,
        mediaType: mediaType || null,
        genre: currentSong.genre,
        likeState: currentSong.likeState,
        views: views || 0,
        playCount: 1,
        timesCompleted: 1,
        maxProgress: currentSong.maxProgress,
        firstListened: listenDate,
        lastListened: listenDate,
        listenDates: [listenDate]
      });
    }

    if (!history.byDate[dkey]) history.byDate[dkey] = [];
    if (!history.byDate[dkey].includes(videoId)) history.byDate[dkey].push(videoId);

    debouncedSave();
    const genreTag = currentSong.genre ? ` [${currentSong.genre}]` : '';
    const likeTag = currentSong.likeState === 'LIKE' ? ' ♥' : currentSong.likeState === 'DISLIKE' ? ' ⊘' : '';
    console.log(`[yt-history] ✓ ${title} - ${artist}${genreTag}${likeTag} (${Math.round(progress * 100)}%)`);
  }

  currentSong.progress = progress;
  setTimeout(poll, POLL_INTERVAL);
}

console.log('[yt-history] Starting YouTube Music history tracker');
console.log(`[yt-history] Threshold: ${THRESHOLD * 100}%, Poll: ${POLL_INTERVAL}ms`);
console.log(`[yt-history] Output: ${HISTORY_FILE}`);
poll();

process.on('SIGINT', () => { saveHistory(); process.exit(0); });
process.on('SIGTERM', () => { saveHistory(); process.exit(0); });
