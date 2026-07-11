#!/usr/bin/env node
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = parseInt(process.env.DASHBOARD_PORT) || 3456;
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

function localDateStr(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - 4 * 60);
  return d.toISOString().split('T')[0];
}

function parsePeriod(url) {
  const u = new URL(url, 'http://localhost');
  const p = u.searchParams.get('period') || 'week';
  const now = new Date();
  let startDate;
  if (p === 'today') startDate = localDateStr(now);
  else if (p === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - d.getDay());
    startDate = localDateStr(d);
  } else {
    const d = new Date(now); d.setDate(1);
    startDate = localDateStr(d);
  }
  const endDate = localDateStr(now);
  return { period: p, startDate, endDate, daysBack: p === 'today' ? 1 : p === 'week' ? 7 : 30 };
}

function periodSongs(period) {
  const { startDate, endDate } = period;
  return db.getDb().prepare(`
    SELECT s.*, COUNT(ld.id) as plays
    FROM songs s
    JOIN listen_dates ld ON s.videoId = ld.videoId
    WHERE DATE(ld.listenedAt, '-4 hours') >= ? AND DATE(ld.listenedAt, '-4 hours') <= ?
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
      const today2 = localDateStr(new Date());
      const sessionCount = db.getDb().prepare("SELECT COUNT(*) as c FROM sessions WHERE DATE(startTime, '-4 hours') = ?").get(today2).c;
      return { totalSongs: songs.length, totalPlays, totalMinutes: Math.round(totalMinutes / 60), likedSongs: 0, daysActive: 1, songsWithBpm: songs.filter(s => s.bpm).length, sessionCount };
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
    const today = localDateStr(new Date());
    const todayHourly = db.getDb().prepare(`
      SELECT CAST(strftime('%H', listenedAt, '-4 hours') AS INTEGER) as hour, COUNT(*) as count
      FROM listen_dates WHERE DATE(listenedAt, '-4 hours') = ?
      GROUP BY hour ORDER BY hour
    `).all(today);
    return {
      data: db.getHeatmapData(p.daysBack),
      hourly: db.getHourlyDistribution(),
      weekly: db.getWeeklyDistribution(),
      dayHour: db.getDayHourMatrix(p.daysBack),
      todayHourly,
    };
  },

  '/api/today': () => {
    const today = localDateStr(new Date());
    const songs = db.getDb().prepare(`
      SELECT s.*, COUNT(ld.id) as plays, MAX(ld.listenedAt) as lastListened
      FROM songs s JOIN listen_dates ld ON s.videoId = ld.videoId
      WHERE DATE(ld.listenedAt, '-4 hours') = ?
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
      const ytHost = process.env.YT_MUSIC_HOST || '0.0.0.0';
      const ytPort = process.env.YT_MUSIC_PORT || '26538';
      const res = await fetch(`http://${ytHost}:${ytPort}/api/v1/song`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { playing: false };
      const song = await res.json();
      if (!song?.videoId) return { playing: false };
      const dbSong = db.getDb().prepare('SELECT bpm FROM songs WHERE videoId = ?').get(song.videoId);
      let bpm = dbSong?.bpm || null;
      if (!bpm && song.songDuration) bpm = db.estimateBpm(song.songDuration);
      return { playing: true, title: song.title, artist: song.artist, videoId: song.videoId, bpm, elapsed: song.elapsedSeconds, duration: song.songDuration };
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

  '/api/correlations': (url) => {
    const p = parsePeriod(url);
    return db.getCorrelationMatrix(p.daysBack);
  },

  '/api/flow-profile': (url) => {
    const u = new URL(url, 'http://localhost');
    const app = u.searchParams.get('app') || 'coding';
    return db.getFlowProfile(app);
  },

  '/api/scatter': (url) => {
    const p = parsePeriod(url);
    const u = new URL(url, 'http://localhost');
    const x = u.searchParams.get('x') || 'bpm';
    const y = u.searchParams.get('y') || 'cpuLoad';
    return db.getScatterData(x, y, p.daysBack);
  },

  '/api/metrics': () => db.getContextMetricsHistory(200),

  '/api/hour-profiles': () => {
    const profiles = [];
    for (let h = 0; h < 24; h++) {
      const p = db.getHourProfile(h);
      if (p) profiles.push(p);
    }
    return profiles;
  },

  '/api/weather-profiles': () => {
    const conditions = ['clear', 'cloudy', 'rain', 'drizzle', 'thunderstorm', 'foggy', 'overcast'];
    return conditions.map(c => db.getWeatherProfile(c)).filter(Boolean);
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
