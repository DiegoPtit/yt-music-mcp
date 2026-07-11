const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = `${process.env.HOME}/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/listening-history.db`;

let db = null;

function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  initTables();
  return db;
}

function migrateColumns() {
  const existing = db.prepare("PRAGMA table_info(songs)").all().map(r => r.name);
  const cols = ['energy', 'danceability', 'valence', 'spotifyPopularity'];
  for (const col of cols) {
    if (!existing.includes(col)) {
      const type = col === 'spotifyPopularity' ? 'INTEGER' : 'REAL';
      db.exec(`ALTER TABLE songs ADD COLUMN ${col} ${type}`);
    }
  }
  const spotifyCols = [
    { name: 'spotifyTrackId', type: 'TEXT' },
    { name: 'spotifyEnergy', type: 'REAL' },
    { name: 'spotifyDanceability', type: 'REAL' },
    { name: 'spotifyValence', type: 'REAL' },
    { name: 'spotifyTempo', type: 'REAL' },
    { name: 'acousticness', type: 'REAL' },
    { name: 'instrumentalness', type: 'REAL' },
    { name: 'liveness', type: 'REAL' },
    { name: 'speechiness', type: 'REAL' },
  ];
  for (const col of spotifyCols) {
    if (!existing.includes(col.name)) {
      db.exec(`ALTER TABLE songs ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

function migrateListenDates() {
  const existing = db.prepare("PRAGMA table_info(listen_dates)").all().map(r => r.name);
  const cols = [
    { name: 'progress', type: 'REAL' },
    { name: 'sessionId', type: 'TEXT' },
    { name: 'activeApp', type: 'TEXT' },
    { name: 'keystrokeRate', type: 'REAL' },
    { name: 'cpuLoad', type: 'REAL' },
    { name: 'memoryUsage', type: 'REAL' },
    { name: 'weather', type: 'TEXT' },
  ];
  for (const col of cols) {
    if (!existing.includes(col.name)) {
      db.exec(`ALTER TABLE listen_dates ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

function initTables() {
  migrateColumns();
  migrateListenDates();
  db.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      videoId TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration INTEGER,
      mediaType TEXT,
      genre TEXT,
      likeState TEXT DEFAULT 'INDIFFERENT',
      views INTEGER DEFAULT 0,
      playCount INTEGER DEFAULT 1,
      timesCompleted INTEGER DEFAULT 1,
      maxProgress REAL DEFAULT 1.0,
      bpm REAL,
      energy REAL,
      danceability REAL,
      valence REAL,
      spotifyPopularity INTEGER,
      firstListened TEXT NOT NULL,
      lastListened TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS listen_dates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      videoId TEXT NOT NULL,
      listenedAt TEXT NOT NULL,
      progress REAL,
      sessionId TEXT,
      activeApp TEXT,
      keystrokeRate REAL,
      cpuLoad REAL,
      memoryUsage REAL,
      weather TEXT,
      FOREIGN KEY (videoId) REFERENCES songs(videoId)
    );
    CREATE TABLE IF NOT EXISTS genre_cache (
      artist TEXT PRIMARY KEY,
      genre TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listen_dates_videoId ON listen_dates(videoId);
    CREATE INDEX IF NOT EXISTS idx_listen_dates_listenedAt ON listen_dates(listenedAt);
    CREATE INDEX IF NOT EXISTS idx_listen_dates_sessionId ON listen_dates(sessionId);
    CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
    CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs(genre);
    CREATE TABLE IF NOT EXISTS song_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      videoId TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      emotional TEXT,
      technical TEXT,
      psychological TEXT,
      particular TEXT,
      meaning TEXT,
      lyricsSnippet TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      startTime TEXT NOT NULL,
      endTime TEXT,
      songCount INTEGER DEFAULT 0,
      energyStart REAL,
      energyEnd REAL,
      valenceStart REAL,
      valenceEnd REAL,
      genreSequence TEXT,
      avgCpuLoad REAL,
      weather TEXT,
      contextSummary TEXT
    );
  `);
}

function upsertSong(song) {
  const d = getDb();
  const exists = d.prepare('SELECT videoId FROM songs WHERE videoId = ?').get(song.videoId);
  if (exists) {
    d.prepare(`
      UPDATE songs SET
        playCount = playCount + 1,
        timesCompleted = timesCompleted + 1,
        lastListened = ?,
        maxProgress = MAX(maxProgress, ?),
        likeState = ?,
        views = MAX(views, ?),
        genre = COALESCE(?, genre),
        bpm = COALESCE(?, bpm),
        energy = COALESCE(?, energy),
        danceability = COALESCE(?, danceability),
        valence = COALESCE(?, valence),
        spotifyPopularity = COALESCE(?, spotifyPopularity)
      WHERE videoId = ?
    `).run(
      song.lastListened, song.maxProgress, song.likeState, song.views,
      song.genre, song.bpm, song.energy, song.danceability, song.valence, song.spotifyPopularity,
      song.videoId
    );
  } else {
    d.prepare(`
      INSERT INTO songs (videoId, title, artist, album, duration, mediaType, genre, likeState, views, playCount, timesCompleted, maxProgress, bpm, energy, danceability, valence, spotifyPopularity, firstListened, lastListened)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      song.videoId, song.title, song.artist, song.album, song.duration, song.mediaType,
      song.genre, song.likeState, song.views, song.maxProgress,
      song.bpm, song.energy, song.danceability, song.valence, song.spotifyPopularity,
      song.firstListened, song.lastListened
    );
  }
}

function updateSpotifyData(videoId, data) {
  getDb().prepare(`
    UPDATE songs SET
      genre = COALESCE(?, genre),
      bpm = COALESCE(?, bpm),
      energy = COALESCE(?, energy),
      danceability = COALESCE(?, danceability),
      valence = COALESCE(?, valence),
      spotifyPopularity = COALESCE(?, spotifyPopularity),
      spotifyTrackId = COALESCE(?, spotifyTrackId),
      spotifyEnergy = COALESCE(?, spotifyEnergy),
      spotifyDanceability = COALESCE(?, spotifyDanceability),
      spotifyValence = COALESCE(?, spotifyValence),
      spotifyTempo = COALESCE(?, spotifyTempo),
      acousticness = COALESCE(?, acousticness),
      instrumentalness = COALESCE(?, instrumentalness),
      liveness = COALESCE(?, liveness),
      speechiness = COALESCE(?, speechiness)
    WHERE videoId = ?
  `).run(
    data.genre ?? null,
    data.bpm ?? null,
    data.energy ?? null,
    data.danceability ?? null,
    data.valence ?? null,
    data.spotifyPopularity ?? null,
    data.spotifyTrackId ?? null,
    data.spotifyEnergy ?? null,
    data.spotifyDanceability ?? null,
    data.spotifyValence ?? null,
    data.spotifyTempo ?? null,
    data.acousticness ?? null,
    data.instrumentalness ?? null,
    data.liveness ?? null,
    data.speechiness ?? null,
    videoId
  );
}

function addListenDate(videoId, date, context = {}) {
  getDb().prepare(`
    INSERT INTO listen_dates (videoId, listenedAt, progress, sessionId, activeApp, keystrokeRate, cpuLoad, memoryUsage, weather)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    videoId, date,
    context.progress ?? null,
    context.sessionId ?? null,
    context.activeApp ?? null,
    context.keystrokeRate ?? null,
    context.cpuLoad ?? null,
    context.memoryUsage ?? null,
    context.weather ? JSON.stringify(context.weather) : null
  );
}

function getAllSongs() {
  return getDb().prepare('SELECT * FROM songs ORDER BY lastListened DESC').all();
}

function getSong(videoId) {
  return getDb().prepare('SELECT * FROM songs WHERE videoId = ?').get(videoId);
}

function getTopSongs(limit = 10) {
  return getDb().prepare('SELECT * FROM songs ORDER BY playCount DESC LIMIT ?').all(limit);
}

function getTopArtists(limit = 10) {
  return getDb().prepare(`
    SELECT artist, SUM(playCount) as playCount, COUNT(*) as songCount,
           MAX(lastListened) as lastListened
    FROM songs GROUP BY artist ORDER BY playCount DESC LIMIT ?
  `).all(limit);
}

function getTopGenres(limit = 10) {
  return getDb().prepare(`
    SELECT genre, SUM(playCount) as plays, COUNT(*) as songCount
    FROM songs WHERE genre IS NOT NULL GROUP BY genre ORDER BY plays DESC LIMIT ?
  `).all(limit);
}

function getStats() {
  const d = getDb();
  const totalSongs = d.prepare('SELECT COUNT(*) as c FROM songs').get().c;
  const totalPlays = d.prepare('SELECT COALESCE(SUM(playCount),0) as c FROM songs').get().c;
  const totalMinutes = d.prepare('SELECT COALESCE(SUM(duration * playCount),0) as c FROM songs WHERE duration IS NOT NULL').get().c;
  const likedSongs = d.prepare("SELECT COUNT(*) as c FROM songs WHERE likeState = 'LIKE'").get().c;
  const daysActive = d.prepare('SELECT COUNT(DISTINCT DATE(listenedAt)) as c FROM listen_dates').get().c;
  const totalBpm = d.prepare('SELECT COUNT(*) as c FROM songs WHERE bpm IS NOT NULL').get().c;
  const spotifyCount = d.prepare('SELECT COUNT(*) as c FROM songs WHERE energy IS NOT NULL').get().c;
  const sessionCount = d.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  const songsWithContext = d.prepare("SELECT COUNT(*) as c FROM listen_dates WHERE activeApp IS NOT NULL OR weather IS NOT NULL").get().c;
  return { totalSongs, totalPlays, totalMinutes: Math.round(totalMinutes / 60), likedSongs, daysActive, songsWithBpm: totalBpm, songsWithSpotify: spotifyCount, sessionCount, songsWithContext };
}

function getHeatmapData(days = 30) {
  return getDb().prepare(`
    SELECT DATE(listenedAt) as date, COUNT(*) as count
    FROM listen_dates
    WHERE listenedAt >= DATE('now', ?)
    GROUP BY DATE(listenedAt)
    ORDER BY date
  `).all(`-${days} days`);
}

function getHourlyDistribution() {
  return getDb().prepare(`
    SELECT CAST(strftime('%H', listenedAt) AS INTEGER) as hour, COUNT(*) as count
    FROM listen_dates
    GROUP BY hour ORDER BY hour
  `).all();
}

function getWeeklyDistribution() {
  return getDb().prepare(`
    SELECT CAST(strftime('%w', listenedAt) AS INTEGER) as day, COUNT(*) as count
    FROM listen_dates
    GROUP BY day ORDER BY day
  `).all();
}

function getDayHourMatrix(daysBack = 365) {
  return getDb().prepare(`
    SELECT CAST(strftime('%w', listenedAt) AS INTEGER) as dow,
           CAST(strftime('%H', listenedAt) AS INTEGER) as hour,
           COUNT(*) as count
    FROM listen_dates
    WHERE listenedAt >= DATE('now', ?)
    GROUP BY dow, hour ORDER BY dow, hour
  `).all(`-${daysBack} days`);
}

function getSongsByGenre(genre) {
  return getDb().prepare('SELECT * FROM songs WHERE genre = ? ORDER BY playCount DESC').all(genre);
}

function getSongsNotListenedSince(days) {
  return getDb().prepare(`
    SELECT * FROM songs
    WHERE lastListened < DATE('now', ?)
    ORDER BY playCount DESC
  `).all(`-${days} days`);
}

function getArtistsNotListenedSince(days) {
  return getDb().prepare(`
    SELECT artist, SUM(playCount) as playCount, COUNT(*) as songCount,
           MAX(lastListened) as lastListened
    FROM songs
    GROUP BY artist
    HAVING MAX(lastListened) < DATE('now', ?)
    ORDER BY playCount DESC
  `).all(`-${days} days`);
}

function getObsessions(threshold = 3, days = 3) {
  return getDb().prepare(`
    SELECT s.*, COUNT(ld.id) as recentPlays
    FROM songs s
    JOIN listen_dates ld ON s.videoId = ld.videoId
    WHERE ld.listenedAt >= DATE('now', ?)
    GROUP BY s.videoId
    HAVING recentPlays >= ?
    ORDER BY recentPlays DESC
  `).all(`-${days} days`, threshold);
}

function getRecentSongs(limit = 20) {
  return getDb().prepare('SELECT * FROM songs ORDER BY lastListened DESC LIMIT ?').all(limit);
}

function getSongsByArtist(artist, limit = 20) {
  return getDb().prepare('SELECT * FROM songs WHERE artist = ? ORDER BY playCount DESC LIMIT ?').all(artist, limit);
}

function getSongsInPeriod(startDate, endDate) {
  return getDb().prepare(`
    SELECT s.*, COUNT(ld.id) as playsInPeriod
    FROM songs s
    JOIN listen_dates ld ON s.videoId = ld.videoId
    WHERE DATE(ld.listenedAt) >= ? AND DATE(ld.listenedAt) <= ?
    GROUP BY s.videoId
    ORDER BY playsInPeriod DESC
  `).all(startDate, endDate);
}

function searchSongs(query, limit = 20) {
  const like = `%${query}%`;
  return getDb().prepare(`
    SELECT * FROM songs
    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
    ORDER BY playCount DESC LIMIT ?
  `).all(like, like, like, limit);
}

function getGenreCache() {
  const rows = getDb().prepare('SELECT * FROM genre_cache').all();
  const result = {};
  rows.forEach(r => { result[r.artist] = r.genre; });
  return result;
}

function setGenreCache(artist, genre) {
  getDb().prepare('INSERT OR REPLACE INTO genre_cache (artist, genre) VALUES (?, ?)').run(artist, genre);
}

function updateSongGenre(videoId, genre) {
  getDb().prepare('UPDATE songs SET genre = ? WHERE videoId = ? AND genre IS NULL').run(genre, videoId);
}

function updateSongBpm(videoId, bpm) {
  getDb().prepare('UPDATE songs SET bpm = ? WHERE videoId = ?').run(bpm, videoId);
}

function updateSongLikeState(videoId, state) {
  getDb().prepare('UPDATE songs SET likeState = ? WHERE videoId = ?').run(state, videoId);
}

function updateSongViews(videoId, views) {
  getDb().prepare('UPDATE songs SET views = MAX(views, ?) WHERE videoId = ?').run(views, videoId);
}

function close() {
  if (db) { db.close(); db = null; }
}

function estimateBpm(duration) {
  if (!duration || duration <= 0) return null;
  if (duration < 90) return 150 + Math.round(Math.random() * 30 - 15);
  if (duration < 120) return 140 + Math.round(Math.random() * 20 - 10);
  if (duration < 150) return 128 + Math.round(Math.random() * 16 - 8);
  if (duration < 180) return 120 + Math.round(Math.random() * 16 - 8);
  if (duration < 210) return 110 + Math.round(Math.random() * 14 - 7);
  if (duration < 240) return 100 + Math.round(Math.random() * 14 - 7);
  if (duration < 270) return 92 + Math.round(Math.random() * 12 - 6);
  if (duration < 300) return 85 + Math.round(Math.random() * 10 - 5);
  if (duration < 360) return 80 + Math.round(Math.random() * 10 - 5);
  return 75 + Math.round(Math.random() * 10 - 5);
}

async function fetchBpmFromMusicBrainz(artist, title) {
  try {
    const cleanTitle = title.replace(/\[.*?\]|\(.*?\)/g, '').trim();
    const res = await fetch(
      `https://musicbrainz.org/ws/2/recording/?query=artist:${encodeURIComponent(artist)}+AND+recording:${encodeURIComponent(cleanTitle)}&fmt=json&limit=3`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.recordings?.length) return null;
    for (const rec of data.recordings) {
      const tags = rec.tags || [];
      const bpmTag = tags.find(t => t.name?.toLowerCase().startsWith('bpm'));
      if (bpmTag) {
        const bpm = parseInt(bpmTag.name.replace(/[^0-9]/g, ''));
        if (bpm > 40 && bpm < 220) return bpm;
      }
    }
  } catch {}
  return null;
}

function getLikedSongs() {
  return getDb().prepare("SELECT * FROM songs WHERE likeState = 'LIKE' ORDER BY lastListened DESC").all();
}

function getStatsForPeriod(startDate, endDate) {
  const d = getDb();
  const songs = d.prepare(`
    SELECT s.*, COUNT(ld.id) as playsInPeriod
    FROM songs s
    JOIN listen_dates ld ON s.videoId = ld.videoId
    WHERE DATE(ld.listenedAt) >= ? AND DATE(ld.listenedAt) <= ?
    GROUP BY s.videoId ORDER BY playsInPeriod DESC
  `).all(startDate, endDate);

  const totalPlays = songs.reduce((a, s) => a + s.playsInPeriod, 0);
  const totalMinutes = songs.reduce((a, s) => a + (s.duration || 0) * s.playsInPeriod, 0);

  const artistPlays = {};
  const genrePlays = {};
  songs.forEach(s => {
    artistPlays[s.artist] = (artistPlays[s.artist] || 0) + s.playsInPeriod;
    if (s.genre) genrePlays[s.genre] = (genrePlays[s.genre] || 0) + s.playsInPeriod;
  });

  const topArtists = Object.entries(artistPlays)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([artist, plays]) => ({ artist, plays }));

  const topGenres = Object.entries(genrePlays)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([genre, plays]) => ({ genre, plays }));

  const topSongs = songs.slice(0, 10).map(s => ({
    title: s.title, artist: s.artist, plays: s.playsInPeriod,
    genre: s.genre, videoId: s.videoId,
  }));

  return {
    period: { start: startDate, end: endDate },
    totalSongs: songs.length,
    totalPlays,
    totalMinutes: Math.round(totalMinutes / 60),
    topArtists, topGenres, topSongs,
  };
}

function getSongsWithoutSpotify(limit = 50) {
  return getDb().prepare("SELECT * FROM songs WHERE spotifyTrackId IS NULL AND energy IS NULL ORDER BY playCount DESC LIMIT ?").all(limit);
}

function getHighEnergySongs(threshold = 0.7, limit = 20) {
  return getDb().prepare('SELECT * FROM songs WHERE COALESCE(spotifyEnergy, energy) >= ? ORDER BY COALESCE(spotifyEnergy, energy) DESC LIMIT ?').all(threshold, limit);
}

function getSongsNeedingSpotifyAudio(limit = 50) {
  return getDb().prepare("SELECT * FROM songs WHERE spotifyTrackId IS NULL AND (energy IS NOT NULL OR bpm IS NOT NULL) ORDER BY playCount DESC LIMIT ?").all(limit);
}

function getHighDanceabilitySongs(threshold = 0.7, limit = 20) {
  return getDb().prepare('SELECT * FROM songs WHERE danceability >= ? ORDER BY danceability DESC LIMIT ?').all(threshold, limit);
}

function saveSongPreference(data) {
  const d = getDb();
  const now = new Date().toISOString();
  const existing = d.prepare('SELECT id FROM song_preferences WHERE videoId = ?').get(data.videoId);
  if (existing) {
    d.prepare(`
      UPDATE song_preferences SET
        emotional = ?, technical = ?, psychological = ?, particular = ?,
        meaning = ?, lyricsSnippet = ?, updatedAt = ?
      WHERE videoId = ?
    `).run(data.emotional, data.technical, data.psychological, data.particular,
      data.meaning, data.lyricsSnippet, now, data.videoId);
  } else {
    d.prepare(`
      INSERT INTO song_preferences (videoId, title, artist, emotional, technical, psychological, particular, meaning, lyricsSnippet, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(data.videoId, data.title, data.artist, data.emotional, data.technical,
      data.psychological, data.particular, data.meaning, data.lyricsSnippet, now, now);
  }
}

function getSongPreferences(videoId) {
  return getDb().prepare('SELECT * FROM song_preferences WHERE videoId = ?').get(videoId);
}

function getAllPreferences() {
  return getDb().prepare('SELECT * FROM song_preferences ORDER BY updatedAt DESC').all();
}

function getProgressHistory(videoId, limit = 20) {
  return getDb().prepare(`
    SELECT progress, listenedAt FROM listen_dates
    WHERE videoId = ? AND progress IS NOT NULL
    ORDER BY listenedAt DESC LIMIT ?
  `).all(videoId, limit);
}

function computeAffinityScore(playCount, avgProgress, daysSinceLastListen) {
  const countFactor = Math.pow(playCount, 0.5);
  const progressFactor = Math.pow(Math.min(avgProgress, 1), 1.5);
  const recencyBoost = 1 + 0.3 * Math.exp(-daysSinceLastListen / 30);
  return Math.round(countFactor * progressFactor * recencyBoost * 100) / 100;
}

function getAffinityScores(minScore = 0, limit = 50) {
  const d = getDb();
  const now = Date.now();
  const songs = d.prepare(`
    SELECT s.*, s.playCount as cnt, s.maxProgress as mp, s.lastListened as ll,
    (SELECT COALESCE(AVG(ld2.progress), s.maxProgress) FROM listen_dates ld2 WHERE ld2.videoId = s.videoId AND ld2.progress IS NOT NULL) as avgProg
    FROM songs s
    WHERE s.playCount > 0
    ORDER BY s.lastListened DESC
  `).all();

  return songs.map(s => {
    const daysSinceLast = Math.max(0, (now - new Date(s.ll).getTime()) / 86400000);
    const score = computeAffinityScore(s.cnt, s.avgProg || s.maxProgress || 0.5, daysSinceLast);
    return {
      videoId: s.videoId, title: s.title, artist: s.artist, genre: s.genre,
      playCount: s.cnt, maxProgress: s.mp, avgProgress: s.avgProg || s.maxProgress,
      affinityScore: score, daysSinceLastListened: Math.round(daysSinceLast),
      lastListened: s.ll, energy: s.energy, valence: s.valence, bpm: s.bpm,
    };
  }).filter(s => s.affinityScore >= minScore).sort((a, b) => b.affinityScore - a.affinityScore).slice(0, limit);
}

function computeBurnoutStatus(videoId) {
  const history = getProgressHistory(videoId, 15);
  if (history.length < 3) return { videoId, status: 'insufficient_data', slope: 0 };

  const values = history.map((h, i) => ({ x: i, y: h.progress }));
  const n = values.length;
  const sumX = values.reduce((s, v) => s + v.x, 0);
  const sumY = values.reduce((s, v) => s + v.y, 0);
  const sumXY = values.reduce((s, v) => s + v.x * v.y, 0);
  const sumX2 = values.reduce((s, v) => s + v.x * v.x, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0;
  const avgProgress = sumY / n;

  let status = 'healthy';
  if (slope < -0.02 && avgProgress < 0.7) status = 'fatigued';
  else if (slope < -0.01) status = 'declining';

  return { videoId, status, slope: Math.round(slope * 1000) / 1000, avgProgress: Math.round(avgProgress * 100) / 100, dataPoints: n };
}

function getSafeFavorites(minAffinity = 2, excludeFatigued = true, limit = 30) {
  const songs = getAffinityScores(minAffinity, 100);
  if (!excludeFatigued) return songs.slice(0, limit);

  return songs.filter(s => {
    const burnout = computeBurnoutStatus(s.videoId);
    return burnout.status !== 'fatigued';
  }).slice(0, limit);
}

function createSession(startTime, song, context = {}) {
  const d = getDb();
  const id = `session_${startTime.replace(/[^0-9]/g, '').slice(0, 14)}`;
  const energyStart = song.energy || null;
  const valenceStart = song.valence || null;
  d.prepare(`
    INSERT INTO sessions (id, startTime, songCount, energyStart, valenceStart, genreSequence, avgCpuLoad, weather, contextSummary)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(id, startTime, energyStart, valenceStart,
    JSON.stringify(song.genre ? [song.genre] : []),
    context.cpuLoad ?? null,
    context.weather ? JSON.stringify(context.weather) : null,
    context.summary || null
  );
  return id;
}

function updateSession(sessionId, song) {
  const d = getDb();
  const session = d.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return;

  let genres = [];
  try { genres = JSON.parse(session.genreSequence || '[]'); } catch {}
  if (song.genre && genres[genres.length - 1] !== song.genre) {
    genres.push(song.genre);
  }

  d.prepare(`
    UPDATE sessions SET
      songCount = songCount + 1,
      energyEnd = ?,
      valenceEnd = ?,
      genreSequence = ?
    WHERE id = ?
  `).run(song.energy || null, song.valence || null, JSON.stringify(genres), sessionId);
}

function closeSession(sessionId) {
  const d = getDb();
  const endTime = new Date().toISOString();
  d.prepare('UPDATE sessions SET endTime = ? WHERE id = ?').run(endTime, sessionId);
  const session = d.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (session) {
    const duration = session.endTime && session.startTime
      ? Math.round((new Date(session.endTime) - new Date(session.startTime)) / 60000)
      : 0;
    const genres = (() => { try { return JSON.parse(session.genreSequence || '[]'); } catch { return []; } })();
    let summary = `${session.songCount} canciones en ${duration} min`;
    if (genres.length > 0) summary += ` | ${genres.join(' → ')}`;
    if (session.energyStart != null && session.energyEnd != null) {
      const delta = (session.energyEnd - session.energyStart) * 100;
      summary += ` | energía ${delta > 0 ? '+' : ''}${Math.round(delta)}%`;
    }
    d.prepare('UPDATE sessions SET contextSummary = ? WHERE id = ?').run(summary, sessionId);
  }
}

function getSessions(limit = 20) {
  return getDb().prepare('SELECT * FROM sessions ORDER BY startTime DESC LIMIT ?').all(limit);
}

function getSession(sessionId) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

function getCurrentSession() {
  return getDb().prepare("SELECT * FROM sessions WHERE endTime IS NULL ORDER BY startTime DESC LIMIT 1").get();
}

function getSessionSongs(sessionId) {
  return getDb().prepare(`
    SELECT ld.*, s.title, s.artist, s.energy, s.valence, s.genre, s.bpm
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    WHERE ld.sessionId = ?
    ORDER BY ld.listenedAt ASC
  `).all(sessionId);
}

function getSessionTrajectory(sessionId) {
  const songs = getSessionSongs(sessionId);
  if (songs.length < 2) return { sessionId, songCount: songs.length, trajectory: 'insufficient_data' };

  const energyValues = songs.map(s => s.energy).filter(e => e != null);
  const valenceValues = songs.map(s => s.valence).filter(v => v != null);

  const calcSlope = (arr) => {
    if (arr.length < 3) return 0;
    const n = arr.length;
    const sumX = arr.reduce((s, _, i) => s + i, 0);
    const sumY = arr.reduce((s, v) => s + v, 0);
    const sumXY = arr.reduce((s, v, i) => s + i * v, 0);
    const sumX2 = arr.reduce((s, _, i) => s + i * i, 0);
    return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0;
  };

  const energySlope = energyValues.length >= 3 ? calcSlope(energyValues) : 0;
  const valenceSlope = valenceValues.length >= 3 ? calcSlope(valenceValues) : 0;

  let trajectory = 'stable';
  if (energySlope < -0.05 && valenceSlope < -0.05) trajectory = 'winding_down';
  else if (energySlope > 0.05 && valenceSlope > 0.05) trajectory = 'ramping_up';
  else if (energySlope < -0.05) trajectory = 'calming';
  else if (energySlope > 0.05) trajectory = 'energizing';

  return {
    sessionId,
    songCount: songs.length,
    trajectory,
    energySlope: Math.round(energySlope * 1000) / 1000,
    valenceSlope: Math.round(valenceSlope * 1000) / 1000,
    energy: { start: energyValues[0], end: energyValues[energyValues.length - 1], avg: energyValues.length ? Math.round(energyValues.reduce((a, v) => a + v, 0) / energyValues.length * 100) / 100 : null },
    valence: { start: valenceValues[0], end: valenceValues[valenceValues.length - 1], avg: valenceValues.length ? Math.round(valenceValues.reduce((a, v) => a + v, 0) / valenceValues.length * 100) / 100 : null },
    genres: [...new Set(songs.map(s => s.genre).filter(Boolean))],
    songs: songs.map(s => ({ title: s.title, artist: s.artist, genre: s.genre, energy: s.energy, valence: s.valence, listenedAt: s.listenedAt })),
  };
}

function getSongsWithContext(limit = 30) {
  return getDb().prepare(`
    SELECT ld.*, s.title, s.artist, s.genre, s.energy, s.valence, s.bpm
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    WHERE ld.activeApp IS NOT NULL OR ld.weather IS NOT NULL OR ld.cpuLoad IS NOT NULL
    ORDER BY ld.listenedAt DESC LIMIT ?
  `).all(limit);
}

function getContextRows(daysBack = 365) {
  return getDb().prepare(`
    SELECT s.bpm, s.energy, s.valence, s.danceability, s.genre,
           ld.keystrokeRate, ld.cpuLoad, ld.memoryUsage, ld.activeApp, ld.weather,
           CAST(strftime('%H', ld.listenedAt) AS INTEGER) as hour,
           CAST(strftime('%w', ld.listenedAt) AS INTEGER) as dayOfWeek
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    WHERE (ld.keystrokeRate IS NOT NULL OR ld.cpuLoad IS NOT NULL)
      AND s.bpm IS NOT NULL
      AND ld.listenedAt > DATE('now', ?)
    ORDER BY ld.listenedAt DESC
  `).all(`-${daysBack} days`);
}

function getCorrelationMatrix(periodDays = 365) {
  const rows = getContextRows(periodDays);
  if (rows.length < 5) return null;

  const variables = ['bpm', 'energy', 'valence', 'danceability', 'keystrokeRate', 'cpuLoad', 'memoryUsage', 'hour'];
  const labels = { bpm: 'BPM', energy: 'Energy', valence: 'Valence', danceability: 'Dance', keystrokeRate: 'Keys/s', cpuLoad: 'CPU', memoryUsage: 'RAM', hour: 'Hour' };
  const icons = { bpm: '🎵', energy: '⚡', valence: '😊', danceability: '💃', keystrokeRate: '⌨️', cpuLoad: '🖥️', memoryUsage: '🧠', hour: '🕐' };

  const matrix = {};
  for (const v1 of variables) {
    matrix[v1] = {};
    for (const v2 of variables) {
      if (v1 === v2) { matrix[v1][v2] = { r: 1, n: rows.length }; continue; }
      const pairs = rows.filter(r => r[v1] != null && r[v2] != null).map(r => ({ x: Number(r[v1]), y: Number(r[v2]) }));
      const n = pairs.length;
      if (n < 5) { matrix[v1][v2] = { r: 0, n }; continue; }
      const sumX = pairs.reduce((s, p) => s + p.x, 0);
      const sumY = pairs.reduce((s, p) => s + p.y, 0);
      const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
      const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
      const sumY2 = pairs.reduce((s, p) => s + p.y * p.y, 0);
      const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
      const r = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
      matrix[v1][v2] = { r: Math.round(Math.max(-1, Math.min(1, r)) * 1000) / 1000, n };
    }
  }

  return {
    variables: variables.map(v => ({ key: v, label: labels[v], icon: icons[v] })),
    matrix,
    sampleSize: rows.length,
  };
}

function getWeatherProfile(weatherCondition) {
  if (!weatherCondition) return null;
  const d = getDb();
  const rows = d.prepare(`
    SELECT s.energy, s.valence, s.bpm, s.danceability
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    WHERE ld.weather LIKE ? AND s.energy IS NOT NULL
    ORDER BY ld.listenedAt DESC LIMIT 100
  `).all(`%${weatherCondition}%`);
  if (rows.length < 3) return null;

  const energy = rows.map(r => r.energy).filter(Boolean);
  const valence = rows.map(r => r.valence).filter(Boolean);
  const bpm = rows.map(r => r.bpm).filter(Boolean);

  return {
    condition: weatherCondition,
    sampleSize: rows.length,
    avgEnergy: Math.round(energy.reduce((a, v) => a + v, 0) / energy.length * 100) / 100,
    avgValence: Math.round(valence.reduce((a, v) => a + v, 0) / valence.length * 100) / 100,
    avgBpm: bpm.length ? Math.round(bpm.reduce((a, v) => a + v, 0) / bpm.length) : null,
  };
}

function getHourProfile(hour) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT s.energy, s.valence, s.bpm, s.danceability
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    WHERE CAST(strftime('%H', ld.listenedAt) AS INTEGER) = ? AND s.energy IS NOT NULL
    ORDER BY ld.listenedAt DESC LIMIT 100
  `).all(hour);
  if (rows.length < 3) return null;

  const energy = rows.map(r => r.energy).filter(Boolean);
  const valence = rows.map(r => r.valence).filter(Boolean);
  const bpm = rows.map(r => r.bpm).filter(Boolean);

  return {
    hour,
    sampleSize: rows.length,
    avgEnergy: Math.round(energy.reduce((a, v) => a + v, 0) / energy.length * 100) / 100,
    avgValence: Math.round(valence.reduce((a, v) => a + v, 0) / valence.length * 100) / 100,
    avgBpm: bpm.length ? Math.round(bpm.reduce((a, v) => a + v, 0) / bpm.length) : null,
  };
}

function getFlowProfile(appCategory) {
  const d = getDb();
  // Map common app keywords to category
  const like = appCategory === 'coding'
    ? '%code%' : appCategory === 'terminal'
    ? '%term%' : appCategory === 'browser'
    ? '%firefox%' : `%${appCategory.slice(0, 4)}%`;

  const rows = d.prepare(`
    SELECT s.bpm, s.energy, s.valence, s.danceability, s.genre, ld.keystrokeRate, ld.activeApp
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    WHERE ld.activeApp LIKE ? AND ld.keystrokeRate IS NOT NULL AND s.bpm IS NOT NULL
    ORDER BY ld.keystrokeRate DESC
  `).all(like);

  if (rows.length < 5) return null;

  const sorted = [...rows].sort((a, b) => b.keystrokeRate - a.keystrokeRate);
  const topN = Math.max(5, Math.ceil(sorted.length * 0.25));
  const flowData = sorted.slice(0, topN);

  const bpmVals = flowData.map(r => r.bpm).filter(Boolean);
  const energyVals = flowData.map(r => r.energy).filter(Boolean);
  const valenceVals = flowData.map(r => r.valence).filter(Boolean);

  const avg = arr => arr.reduce((a, v) => a + v, 0) / arr.length;

  return {
    appCategory,
    sampleSize: rows.length,
    flowDataPoints: topN,
    bpm: {
      min: Math.round(Math.min(...bpmVals)),
      max: Math.round(Math.max(...bpmVals)),
      avg: Math.round(avg(bpmVals)),
    },
    energy: {
      min: Math.round(Math.min(...energyVals) * 100) / 100,
      max: Math.round(Math.max(...energyVals) * 100) / 100,
      avg: Math.round(avg(energyVals) * 100) / 100,
    },
    valence: {
      min: Math.round(Math.min(...valenceVals) * 100) / 100,
      max: Math.round(Math.max(...valenceVals) * 100) / 100,
      avg: Math.round(avg(valenceVals) * 100) / 100,
    },
    genres: [...new Set(flowData.map(r => r.genre).filter(Boolean))].slice(0, 5),
  };
}

function getScatterData(metricX, metricY, periodDays = 365) {
  const isSongMetric = ['bpm', 'energy', 'valence', 'danceability'].includes(metricX) || ['bpm', 'energy', 'valence', 'danceability'].includes(metricY);
  const rows = getDb().prepare(`
    SELECT ${['bpm', 'energy', 'valence', 'danceability'].map(c => `s.${c}`).join(', ')},
           ld.keystrokeRate, ld.cpuLoad, ld.memoryUsage,
           CAST(strftime('%H', ld.listenedAt) AS INTEGER) as hour
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    WHERE ${isSongMetric ? 's.bpm IS NOT NULL AND' : ''} (ld.cpuLoad IS NOT NULL OR ld.keystrokeRate IS NOT NULL)
      AND ld.listenedAt > DATE('now', ?)
    ORDER BY ld.listenedAt DESC
  `).all(`-${periodDays} days`);
  const pairs = rows
    .filter(r => r[metricX] != null && r[metricY] != null)
    .map(r => ({ x: Number(r[metricX]), y: Number(r[metricY]) }));
  if (pairs.length < 3) return null;

  // Compute regression line
  const n = pairs.length;
  const sumX = pairs.reduce((s, p) => s + p.x, 0);
  const sumY = pairs.reduce((s, p) => s + p.y, 0);
  const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
  const sumY2 = pairs.reduce((s, p) => s + p.y * p.y, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0;
  const intercept = (sumY - slope * sumX) / n;
  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  const pearsonR = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;

  const xMin = Math.min(...pairs.map(p => p.x));
  const xMax = Math.max(...pairs.map(p => p.x));

  return {
    metricX, metricY,
    n,
    points: pairs.slice(0, 500),
    regression: {
      slope: Math.round(slope * 1000) / 1000,
      intercept: Math.round(intercept * 1000) / 1000,
      r: Math.round(Math.max(-1, Math.min(1, pearsonR)) * 1000) / 1000,
      rSquared: Math.round(pearsonR * pearsonR * 1000) / 1000,
      line: [
        { x: xMin, y: Math.round((slope * xMin + intercept) * 1000) / 1000 },
        { x: xMax, y: Math.round((slope * xMax + intercept) * 1000) / 1000 },
      ],
    },
  };
}

function getContextMetricsHistory(limit = 100) {
  return getDb().prepare(`
    SELECT ld.listenedAt, s.title, s.artist, s.bpm, s.energy, s.valence,
           ld.keystrokeRate, ld.cpuLoad, ld.memoryUsage, ld.activeApp, ld.progress
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    WHERE ld.keystrokeRate IS NOT NULL
    ORDER BY ld.listenedAt DESC LIMIT ?
  `).all(limit);
}

module.exports = {
  getDb, upsertSong, addListenDate, getAllSongs, getSong,
  getTopSongs, getTopArtists, getTopGenres, getStats,
  getHeatmapData, getHourlyDistribution, getWeeklyDistribution, getDayHourMatrix,
  getSongsByGenre, getSongsNotListenedSince, getArtistsNotListenedSince,
  getObsessions, getRecentSongs, getSongsByArtist, getSongsInPeriod,
  searchSongs, getGenreCache, setGenreCache, updateSongGenre,
  updateSongBpm, updateSongLikeState, updateSongViews,
  close, estimateBpm, fetchBpmFromMusicBrainz,
  getLikedSongs, getStatsForPeriod, updateSpotifyData,
  getSongsWithoutSpotify, getHighEnergySongs, getHighDanceabilitySongs, getSongsNeedingSpotifyAudio,
  saveSongPreference, getSongPreferences, getAllPreferences,
  getProgressHistory, computeAffinityScore, getAffinityScores,
  computeBurnoutStatus, getSafeFavorites,
  createSession, updateSession, closeSession,
  getSessions, getSession, getCurrentSession,
  getSessionSongs, getSessionTrajectory,
  getSongsWithContext,
  getCorrelationMatrix, getFlowProfile, getWeatherProfile,
  getHourProfile, getScatterData, getContextMetricsHistory,
};
