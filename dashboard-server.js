#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = 3456;
const FRONTEND_PATH = path.join(__dirname, 'frontend', 'index.html');

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function error(res, msg, code) {
  res.writeHead(code || 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

function parsePeriod(url) {
  const u = new URL(url, 'http://localhost');
  const p = u.searchParams.get('period') || 'week';
  const now = new Date();
  let startDate;
  if (p === 'today') startDate = now.toISOString().split('T')[0];
  else if (p === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - d.getDay());
    startDate = d.toISOString().split('T')[0];
  } else {
    startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }
  const endDate = now.toISOString().split('T')[0];
  return { period: p, startDate, endDate, daysBack: p === 'today' ? 1 : p === 'week' ? 7 : 30 };
}

function periodSongs(period) {
  const { startDate, endDate } = period;
  return db.getDb().prepare(`
    SELECT s.*, COUNT(ld.id) as plays
    FROM songs s
    JOIN listen_dates ld ON s.videoId = ld.videoId
    WHERE DATE(ld.listenedAt) >= ? AND DATE(ld.listenedAt) <= ?
    GROUP BY s.videoId ORDER BY plays DESC
  `).all(startDate, endDate);
}

const router = {
  '/api/stats': (url) => {
    const p = parsePeriod(url);
    if (p.period === 'today') {
      const songs = periodSongs(p);
      const totalPlays = songs.reduce((a, s) => a + s.plays, 0);
      const totalMinutes = songs.reduce((a, s) => a + (s.duration || 0) * s.plays, 0);
      return { totalSongs: songs.length, totalPlays, totalMinutes: Math.round(totalMinutes / 60), likedSongs: 0, daysActive: 1, songsWithBpm: songs.filter(s => s.bpm).length };
    }
    return db.getStats();
  },

  '/api/top-songs': (url) => {
    const p = parsePeriod(url);
    const songs = periodSongs(p);
    return songs.slice(0, 10).map(s => ({
      title: s.title, artist: s.artist, plays: s.plays,
      genre: s.genre, videoId: s.videoId, bpm: s.bpm,
      energy: s.energy, danceability: s.danceability, valence: s.valence,
    }));
  },

  '/api/top-artists': (url) => {
    const p = parsePeriod(url);
    const songs = periodSongs(p);
    const map = {};
    songs.forEach(s => {
      if (!map[s.artist]) map[s.artist] = { artist: s.artist, plays: 0, songs: 0 };
      map[s.artist].plays += s.plays;
      map[s.artist].songs += 1;
    });
    return Object.values(map).sort((a, b) => b.plays - a.plays).slice(0, 10);
  },

  '/api/top-genres': (url) => {
    const p = parsePeriod(url);
    const songs = periodSongs(p);
    const map = {};
    songs.forEach(s => {
      const g = s.genre || 'Unknown';
      if (!map[g]) map[g] = { genre: g, plays: 0, songs: 0 };
      map[g].plays += s.plays;
      map[g].songs += 1;
    });
    return Object.values(map).sort((a, b) => b.plays - a.plays).slice(0, 10);
  },

  '/api/heatmap': (url) => {
    const p = parsePeriod(url);
    const today = new Date().toISOString().split('T')[0];
    const todayHourly = db.getDb().prepare(`
      SELECT CAST(strftime('%H', listenedAt) AS INTEGER) as hour, COUNT(*) as count
      FROM listen_dates WHERE DATE(listenedAt) = ?
      GROUP BY hour ORDER BY hour
    `).all(today);
    return {
      data: db.getHeatmapData(p.daysBack),
      hourly: db.getHourlyDistribution(),
      weekly: db.getWeeklyDistribution(),
      todayHourly,
    };
  },

  '/api/today': () => {
    const today = new Date().toISOString().split('T')[0];
    const songs = db.getDb().prepare(`
      SELECT s.*, COUNT(ld.id) as plays, MAX(ld.listenedAt) as lastListened
      FROM songs s JOIN listen_dates ld ON s.videoId = ld.videoId
      WHERE DATE(ld.listenedAt) = ?
      GROUP BY s.videoId ORDER BY plays DESC, MAX(ld.listenedAt) DESC
    `).all(today);
    return songs.map(s => ({
      videoId: s.videoId, title: s.title, artist: s.artist, genre: s.genre, bpm: s.bpm,
      plays: s.plays,
      lastListened: new Date(s.lastListened).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }));
  },

  '/api/now': async () => {
    try {
      const res = await fetch('http://0.0.0.0:26538/api/v1/song', { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { playing: false };
      const song = await res.json();
      if (!song?.videoId) return { playing: false };
      return { playing: true, title: song.title, artist: song.artist, videoId: song.videoId, elapsed: song.elapsedSeconds, duration: song.songDuration };
    } catch { return { playing: false }; }
  },

  '/api/obsessions': (url) => {
    const p = parsePeriod(url);
    const threshold = p.period === 'today' ? 1 : 3;
    const days = p.period === 'today' ? 1 : 7;
    const obs = db.getObsessions(threshold, days);
    return { obsessions: obs.slice(0, 10).map(s => ({ title: s.title, artist: s.artist, plays: s.recentPlays, genre: s.genre })) };
  },

  '/api/revival': () => {
    const songs = db.getSongsNotListenedSince(30);
    return { total: songs.length, songs: songs.slice(0, 10).map(s => ({ title: s.title, artist: s.artist, playCount: s.playCount, lastListened: s.lastListened })) };
  },
};

const server = http.createServer(async (req, res) => {
  const url = req.url;
  if (url === '/' || url === '/index.html') { serveFile(res, FRONTEND_PATH, 'text/html'); return; }
  if (url.startsWith('/api/')) {
    const handler = router[url.split('?')[0]];
    if (handler) { try { json(res, await handler(url)); } catch (e) { error(res, e.message, 500); } }
    else { error(res, 'Not found', 404); }
    return;
  }
  error(res, 'Not found', 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] Server running at http://0.0.0.0:${PORT}`);
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
