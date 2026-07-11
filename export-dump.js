#!/usr/bin/env node
require('dotenv').config();
const db = require('./db');
const fs = require('fs');
const path = require('path');

function parseRange() {
  const args = process.argv.slice(2);
  const now = new Date();
  let startDate, endDate = now.toISOString().split('T')[0];
  let label = 'all-time';

  if (args[0] === ':today') {
    startDate = endDate;
    label = 'today';
  } else if (args[0] === ':day') {
    const n = parseInt(args[1]) || 0;
    const d = new Date(now); d.setDate(d.getDate() - n);
    startDate = d.toISOString().split('T')[0];
    label = n === 0 ? 'today' : `last-${n}-days`;
  } else if (args[0] === ':week') {
    const n = parseInt(args[1]) || 0;
    const d = new Date(now); d.setDate(d.getDate() - n * 7);
    startDate = d.toISOString().split('T')[0];
    label = n === 0 ? 'this-week' : `last-${n}-weeks`;
  } else if (args[0] === ':month') {
    const n = parseInt(args[1]) || 0;
    const d = new Date(now); d.setMonth(d.getMonth() - n);
    startDate = d.toISOString().split('T')[0];
    label = n === 0 ? 'this-month' : `last-${n}-months`;
  } else {
    startDate = null;
  }

  return { startDate, endDate, label };
}

const { startDate: rangeStart, endDate: rangeEnd, label } = parseRange();

function fetchSongs() {
  if (!rangeStart) return db.getAllSongs();
  const rows = db.getDb().prepare(`
    SELECT s.*, COUNT(ld.id) as playsInPeriod, MAX(ld.listenedAt) as lastInPeriod
    FROM songs s
    JOIN listen_dates ld ON s.videoId = ld.videoId
    WHERE DATE(ld.listenedAt) >= ? AND DATE(ld.listenedAt) <= ?
    GROUP BY s.videoId ORDER BY playsInPeriod DESC
  `).all(rangeStart, rangeEnd);
  return rows;
}

function fetchListenDates() {
  if (!rangeStart) return db.getDb().prepare('SELECT * FROM listen_dates ORDER BY listenedAt').all();
  return db.getDb().prepare('SELECT * FROM listen_dates WHERE DATE(listenedAt) >= ? AND DATE(listenedAt) <= ? ORDER BY listenedAt').all(rangeStart, rangeEnd);
}

const songs = fetchSongs();
const listenDates = fetchListenDates();

const artistMap = {};
const genreMap = {};
let totalDuration = 0;
let totalListens = 0;

for (const s of songs) {
  const plays = s.playsInPeriod || s.playCount;
  totalListens += plays;

  if (!artistMap[s.artist]) artistMap[s.artist] = { artist: s.artist, songCount: 0, totalPlays: 0, totalDuration: 0, songs: [], first: s.firstListened, last: s.lastListened };
  artistMap[s.artist].songCount++;
  artistMap[s.artist].totalPlays += plays;
  artistMap[s.artist].totalDuration += (s.duration || 0) * plays;
  if (s.firstListened < artistMap[s.artist].first) artistMap[s.artist].first = s.firstListened;
  if ((s.lastInPeriod || s.lastListened) > artistMap[s.artist].last) artistMap[s.artist].last = s.lastInPeriod || s.lastListened;
  artistMap[s.artist].songs.push(s.title);

  if (s.genre) {
    if (!genreMap[s.genre]) genreMap[s.genre] = { genre: s.genre, songCount: 0, totalPlays: 0 };
    genreMap[s.genre].songCount++;
    genreMap[s.genre].totalPlays += plays;
  }

  totalDuration += (s.duration || 0) * plays;
}

const topArtists = Object.values(artistMap).sort((a, b) => b.totalPlays - a.totalPlays);
const topGenres = Object.values(genreMap).sort((a, b) => b.totalPlays - a.totalPlays);

const likeStates = { LIKE: 0, DISLIKE: 0, INDIFFERENT: 0 };
for (const s of songs) {
  likeStates[s.likeState] = (likeStates[s.likeState] || 0) + 1;
}

const hourDist = {};
const dayDist = {};
const dateDist = {};
for (const ld of listenDates) {
  const d = new Date(ld.listenedAt);
  const h = d.getHours();
  hourDist[h] = (hourDist[h] || 0) + 1;
  const day = d.toLocaleDateString('en', { weekday: 'long' });
  dayDist[day] = (dayDist[day] || 0) + 1;
  const dateKey = ld.listenedAt.slice(0, 10);
  dateDist[dateKey] = (dateDist[dateKey] || 0) + 1;
}

const avgMood = (() => {
  const withEnergy = songs.filter(s => s.energy != null);
  if (!withEnergy.length) return null;
  const avg = (key) => Math.round(withEnergy.reduce((a, s) => a + (s[key] ?? 0), 0) / withEnergy.length * 100) / 100;
  const avgE = avg('energy'), avgV = avg('valence');
  const avgD = avg('danceability'), avgA = avg('acousticness');
  const avgBpm = withEnergy.reduce((a, s) => a + (s.bpm || 0), 0) / withEnergy.length;
  return {
    avgEnergy: avgE,
    avgDanceability: avgD,
    avgValence: avgV,
    avgAcousticness: avgA,
    avgBpm: Math.round(avgBpm),
    moodLabel: (() => {
      if (avgE >= 0.6 && avgV >= 0.6) return 'energetic & happy';
      if (avgE >= 0.6 && avgV < 0.4) return 'intense / dark';
      if (avgE < 0.4 && avgV >= 0.6) return 'chill & pleasant';
      if (avgE < 0.4 && avgV < 0.4) return 'melancholic / mellow';
      if (avgE >= 0.5) return 'moderately energetic';
      return 'relaxed';
    })(),
  };
})();

const DEST = path.join(process.env.HOME, 'Descargas', `yt-music-history-${label}-${new Date().toISOString().split('T')[0]}.json`);

const dump = {
  meta: {
    exportedAt: new Date().toISOString(),
    period: label,
    ...(rangeStart ? { dateRange: { start: rangeStart, end: rangeEnd } } : { dateRange: { first: songs.length ? songs[songs.length - 1].firstListened : null, last: songs.length ? songs[0].lastListened : null } }),
    source: 'yt-music-mcp (th-ch/youtube-music tracker)',
    totalSongs: songs.length,
    totalListens,
    totalListeningTimeMinutes: Math.round(totalDuration / 60),
    daysWithActivity: Object.keys(dateDist).length,
    totalArtists: topArtists.length,
    totalGenres: topGenres.length,
  },

  topArtistsOverall: topArtists.slice(0, 10).map(a => ({
    rank: topArtists.indexOf(a) + 1,
    artist: a.artist,
    songs: a.songCount,
    totalPlays: a.totalPlays,
    estimatedMinutes: Math.round(a.totalDuration / 60),
    topTitles: a.songs.slice(0, 5),
  })),

  topGenresOverall: topGenres.slice(0, 10).map(g => ({
    rank: topGenres.indexOf(g) + 1,
    genre: g.genre,
    songs: g.songCount,
    totalPlays: g.totalPlays,
  })),

  everySong: songs.map((s, i) => ({
    entry: i + 1,
    title: s.title,
    artist: s.artist,
    album: s.album || null,
    durationSeconds: s.duration || null,
    genre: s.genre || null,
    ...(s.energy != null ? {
      audioFeatures: {
        energy: s.energy,
        danceability: s.danceability,
        valence: s.valence,
        bpm: s.bpm,
        acousticness: s.acousticness,
      }
    } : { bpm: s.bpm || null }),
    popularity: s.spotifyPopularity || null,
    stats: {
      totalPlays: s.playCount,
      ...(s.playsInPeriod ? { playsInPeriod: s.playsInPeriod } : {}),
      liked: s.likeState === 'LIKE',
      disliked: s.likeState === 'DISLIKE',
      maxProgressPercent: Math.round((s.maxProgress || 0) * 100),
    },
    dates: {
      firstListened: s.firstListened,
      lastListened: s.lastListened,
      ...(s.lastInPeriod ? { lastInPeriod: s.lastInPeriod } : {}),
    },
    youtubeId: s.videoId,
  })),

  listeningPatterns: {
    byHour: Object.entries(hourDist)
      .sort((a, b) => a[0] - b[0])
      .map(([hour, count]) => ({
        hour: `${String(hour).padStart(2, '0')}:00`,
        plays: count,
        peak: count === Math.max(...Object.values(hourDist)),
        label: (() => { const h = parseInt(hour); if (h < 6) return 'late night'; if (h < 12) return 'morning'; if (h < 18) return 'afternoon'; return 'evening'; })(),
      })),
    byDayOfWeek: Object.entries(dayDist).map(([day, count]) => ({ day, plays: count })),
    mostActiveDay: Object.entries(dateDist).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([date, plays]) => ({ date, plays })),
  },

  likeBreakdown: {
    liked: likeStates.LIKE,
    disliked: likeStates.DISLIKE,
    indifferent: likeStates.INDIFFERENT,
    likedPercent: Math.round((likeStates.LIKE / songs.length) * 100) || 0,
  },
};

if (avgMood) dump.moodProfile = avgMood;

// Audio feature distribution
const withFeatures = songs.filter(s => s.energy != null);
if (withFeatures.length > 0) {
  const fE = withFeatures.map(s => s.energy);
  const fV = withFeatures.filter(s => s.valence != null).map(s => s.valence);
  const fD = withFeatures.map(s => s.danceability ?? 0.5);
  const fB = withFeatures.filter(s => s.bpm != null).map(s => s.bpm);
  const fA = withFeatures.filter(s => s.acousticness != null).map(s => s.acousticness);
  const rng = (arr) => arr.length > 1 ? `${Math.min(...arr).toFixed(2)}-${Math.max(...arr).toFixed(2)}` : null;

  // Simple mood clusters
  const clusters = {
    energetic: withFeatures.filter(s => s.energy >= 0.7 && (s.valence ?? 0.5) >= 0.5).length,
    chill: withFeatures.filter(s => s.energy < 0.4 && (s.valence ?? 0.5) >= 0.5).length,
    melancholic: withFeatures.filter(s => s.energy < 0.4 && (s.valence ?? 0.5) < 0.4).length,
    intense: withFeatures.filter(s => s.energy >= 0.7 && (s.valence ?? 0.5) < 0.4).length,
    balanced: withFeatures.filter(s => s.energy >= 0.4 && s.energy < 0.7).length,
  };

  dump.audioFeatureProfile = {
    count: withFeatures.length,
    ranges: {
      energy: rng(fE),
      valence: rng(fV),
      danceability: rng(fD),
      bpm: rng(fB),
      acousticness: rng(fA),
    },
    clusters,
    acoustic: withFeatures.filter(s => (s.acousticness ?? 0) > 0.5).length,
    danceable: withFeatures.filter(s => (s.danceability ?? 0) > 0.5).length,
  };
}

fs.writeFileSync(DEST, JSON.stringify(dump, null, 2));
console.log(`Exported to ${DEST}`);
console.log(`  ${dump.meta.totalSongs} songs · ${dump.meta.totalListens} listens · ${dump.meta.totalArtists} artists · ${dump.meta.totalGenres} genres`);
if (dump.moodProfile) console.log(`  Mood: ${dump.moodProfile.moodLabel} (e:${dump.moodProfile.avgEnergy} d:${dump.moodProfile.avgDanceability} v:${dump.moodProfile.avgValence} a:${dump.moodProfile.avgAcousticness} ${dump.moodProfile.avgBpm}bpm)`);
if (dump.audioFeatureProfile) console.log(`  Audio features: ${dump.audioFeatureProfile.count} songs · clusters: ${Object.entries(dump.audioFeatureProfile.clusters).filter(([_,v]) => v > 0).map(([k,v]) => `${k}=${v}`).join(' ')}`);
console.log(`  ${dump.meta.totalListeningTimeMinutes} minutes over ${dump.meta.daysWithActivity} days`);