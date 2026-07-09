require('dotenv').config();
const API_BASE = `http://${process.env.YT_MUSIC_HOST || '0.0.0.0'}:${process.env.YT_MUSIC_PORT || '26538'}`;
const AUTH_ID = process.env.YT_MUSIC_AUTH;
const POLL_INTERVAL = parseInt(process.env.TRACKER_POLL_INTERVAL) || 2000;
const THRESHOLD = (parseInt(process.env.TRACKER_THRESHOLD) || 45) / 100;
const db = require('./db');
const lastfm = require('./lastfm');

let token = null;
let currentSong = null;

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

let genrePromise = null;
let bpmPromise = null;

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
      db.addListenDate(videoId, listenDate);

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

      const genreTag = currentSong?.genre ? ` [${currentSong.genre}]` : '';
      const likeTag = currentSong?.likeState === 'LIKE' ? ' ♥' : currentSong?.likeState === 'DISLIKE' ? ' ⊘' : '';
      const bpmTag = currentSong?.bpm ? ` ${currentSong.bpm}bpm` : '';
      console.log(`[yt-history] ✓ ${title} - ${artist}${genreTag}${bpmTag}${likeTag} (${Math.round(finalProgress * 100)}%)`);
    }, 3000);
  }

  currentSong.progress = progress;
  setTimeout(poll, POLL_INTERVAL);
}

console.log('[yt-history] Starting YouTube Music history tracker (SQLite)');
console.log(`[yt-history] Threshold: ${THRESHOLD * 100}%, Poll: ${POLL_INTERVAL}ms`);
console.log(`[yt-history] DB: ${db.getDb().name}`);
poll();

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
