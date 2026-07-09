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
  const cols = ['energy', 'danceability', 'valence', 'spotifyPopularity'];
  const existing = db.prepare("PRAGMA table_info(songs)").all().map(r => r.name);
  for (const col of cols) {
    if (!existing.includes(col)) {
      const type = col === 'spotifyPopularity' ? 'INTEGER' : 'REAL';
      db.exec(`ALTER TABLE songs ADD COLUMN ${col} ${type}`);
    }
  }
}

function initTables() {
  migrateColumns();
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
      FOREIGN KEY (videoId) REFERENCES songs(videoId)
    );
    CREATE TABLE IF NOT EXISTS genre_cache (
      artist TEXT PRIMARY KEY,
      genre TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listen_dates_videoId ON listen_dates(videoId);
    CREATE INDEX IF NOT EXISTS idx_listen_dates_listenedAt ON listen_dates(listenedAt);
    CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
    CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs(genre);
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
      energy = ?,
      danceability = ?,
      valence = ?,
      spotifyPopularity = ?
    WHERE videoId = ?
  `).run(data.genre, data.bpm, data.energy, data.danceability, data.valence, data.spotifyPopularity, videoId);
}

function addListenDate(videoId, date) {
  getDb().prepare('INSERT INTO listen_dates (videoId, listenedAt) VALUES (?, ?)').run(videoId, date);
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
  return { totalSongs, totalPlays, totalMinutes: Math.round(totalMinutes / 60), likedSongs, daysActive, songsWithBpm: totalBpm, songsWithSpotify: spotifyCount };
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
  return getDb().prepare('SELECT * FROM songs WHERE energy IS NULL ORDER BY playCount DESC LIMIT ?').all(limit);
}

function getHighEnergySongs(threshold = 0.7, limit = 20) {
  return getDb().prepare('SELECT * FROM songs WHERE energy >= ? ORDER BY energy DESC LIMIT ?').all(threshold, limit);
}

function getHighDanceabilitySongs(threshold = 0.7, limit = 20) {
  return getDb().prepare('SELECT * FROM songs WHERE danceability >= ? ORDER BY danceability DESC LIMIT ?').all(threshold, limit);
}

module.exports = {
  getDb, upsertSong, addListenDate, getAllSongs, getSong,
  getTopSongs, getTopArtists, getTopGenres, getStats,
  getHeatmapData, getHourlyDistribution, getWeeklyDistribution,
  getSongsByGenre, getSongsNotListenedSince, getArtistsNotListenedSince,
  getObsessions, getRecentSongs, getSongsByArtist, getSongsInPeriod,
  searchSongs, getGenreCache, setGenreCache, updateSongGenre,
  updateSongBpm, updateSongLikeState, updateSongViews,
  close, estimateBpm, fetchBpmFromMusicBrainz,
  getLikedSongs, getStatsForPeriod, updateSpotifyData,
  getSongsWithoutSpotify, getHighEnergySongs, getHighDanceabilitySongs,
};
