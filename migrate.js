#!/usr/bin/env node
const db = require('./db');
const fs = require('fs');

const HISTORY_FILE = `${process.env.HOME}/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/listening-history.json`;

let history;
try {
  if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
} catch (e) {
  console.error('Error reading history:', e.message);
  process.exit(1);
}

if (!history?.songs?.length) {
  console.log('No songs to migrate');
  process.exit(0);
}

let migrated = 0;
let skipped = 0;

for (const s of history.songs) {
  const existing = db.getSong(s.videoId);
  if (existing) {
    skipped++;
    continue;
  }

  const bpm = db.estimateBpm(s.duration);
  db.getDb().prepare(`
    INSERT INTO songs (videoId, title, artist, album, duration, mediaType, genre, likeState, views, playCount, timesCompleted, maxProgress, bpm, firstListened, lastListened)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.videoId, s.title, s.artist, s.album || null,
    s.duration || null, s.mediaType || null,
    s.genre || null, s.likeState || 'INDIFFERENT',
    s.views || 0, s.playCount || 1, s.timesCompleted || 1,
    s.maxProgress || 1.0, bpm,
    s.firstListened, s.lastListened
  );

  if (s.listenDates?.length) {
    const insert = db.getDb().prepare('INSERT INTO listen_dates (videoId, listenedAt) VALUES (?, ?)');
    for (const d of s.listenDates) insert.run(s.videoId, d);
  }

  migrated++;
}

const GENRE_CACHE_FILE = `${process.env.HOME}/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/genre-cache.json`;
try {
  if (fs.existsSync(GENRE_CACHE_FILE)) {
    const jsonCache = JSON.parse(fs.readFileSync(GENRE_CACHE_FILE, 'utf-8'));
    const insert = db.getDb().prepare('INSERT OR REPLACE INTO genre_cache (artist, genre) VALUES (?, ?)');
    for (const [artist, genre] of Object.entries(jsonCache)) {
      insert.run(artist, genre);
    }
    console.log(`Migrated genre cache: ${Object.keys(jsonCache).length} artists`);
  }
} catch (e) { console.error('Error migrating genre cache:', e.message); }

console.log(`Migrated: ${migrated} songs, Skipped (already exist): ${skipped}`);
console.log(`Total in DB: ${db.getStats().totalSongs} songs`);
db.close();
