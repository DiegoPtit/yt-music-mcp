#!/usr/bin/env node
require('dotenv').config();
const db = require('./db');
const fs = require('fs');
const path = require('path');

const DEST = path.join(process.env.HOME, 'Descargas', `yt-music-history-${new Date().toISOString().split('T')[0]}.json`);

const songs = db.getAllSongs();
const listenDates = db.getDb().prepare('SELECT * FROM listen_dates ORDER BY listenedAt').all();

const artistMap = {};
const genreMap = {};
let totalDuration = 0;

for (const s of songs) {
  if (!artistMap[s.artist]) artistMap[s.artist] = { artist: s.artist, songCount: 0, totalPlays: 0, totalDuration: 0, songs: [], firstListened: s.firstListened, lastListened: s.lastListened };
  artistMap[s.artist].songCount++;
  artistMap[s.artist].totalPlays += s.playCount;
  artistMap[s.artist].totalDuration += (s.duration || 0) * s.playCount;
  if (s.firstListened < artistMap[s.artist].first) artistMap[s.artist].first = s.firstListened;
  if (s.lastListened > artistMap[s.artist].last) artistMap[s.artist].last = s.lastListened;
  artistMap[s.artist].songs.push(s.title);

  if (s.genre) {
    if (!genreMap[s.genre]) genreMap[s.genre] = { genre: s.genre, songCount: 0, totalPlays: 0 };
    genreMap[s.genre].songCount++;
    genreMap[s.genre].totalPlays += s.playCount;
  }

  totalDuration += (s.duration || 0) * s.playCount;
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
  return {
    avgEnergy: Math.round(withEnergy.reduce((a, s) => a + s.energy, 0) / withEnergy.length * 100) / 100,
    avgDanceability: Math.round(withEnergy.reduce((a, s) => a + s.danceability, 0) / withEnergy.length * 100) / 100,
    avgValence: Math.round(withEnergy.reduce((a, s) => a + s.valence, 0) / withEnergy.length * 100) / 100,
    moodLabel: (() => {
      const e = withEnergy.reduce((a, s) => a + s.energy, 0) / withEnergy.length;
      const v = withEnergy.reduce((a, s) => a + s.valence, 0) / withEnergy.length;
      if (e >= 0.6 && v >= 0.6) return 'energetic & happy';
      if (e >= 0.6 && v < 0.4) return 'intense / dark';
      if (e < 0.4 && v >= 0.6) return 'chill & pleasant';
      if (e < 0.4 && v < 0.4) return 'melancholic / mellow';
      if (e >= 0.5) return 'moderately energetic';
      return 'relaxed';
    })(),
  };
})();

const dump = {
  meta: {
    exportedAt: new Date().toISOString(),
    source: 'yt-music-mcp (th-ch/youtube-music tracker)',
    totalSongs: songs.length,
    totalListens: songs.reduce((a, s) => a + s.playCount, 0),
    totalListeningTimeMinutes: Math.round(totalDuration / 60),
    daysWithActivity: Object.keys(dateDist).length,
    totalArtists: topArtists.length,
    totalGenres: topGenres.length,
    dateRange: {
      first: songs.length ? songs[songs.length - 1].firstListened : null,
      last: songs.length ? songs[0].lastListened : null,
    },
  },

  moodProfile: avgMood,

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
    bpm: s.bpm || null,
    ...(s.energy != null ? {
      mood: {
        energy: s.energy,
        danceability: s.danceability,
        valence: s.valence,
      }
    } : {}),
    stats: {
      totalPlays: s.playCount,
      liked: s.likeState === 'LIKE',
      disliked: s.likeState === 'DISLIKE',
      maxProgressPercent: Math.round((s.maxProgress || 0) * 100),
    },
    dates: {
      firstListened: s.firstListened,
      lastListened: s.lastListened,
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
        label: (() => {
          const h = parseInt(hour);
          if (h < 6) return 'late night';
          if (h < 12) return 'morning';
          if (h < 18) return 'afternoon';
          return 'evening';
        })(),
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

fs.writeFileSync(DEST, JSON.stringify(dump, null, 2));
console.log(`Exported to ${DEST}`);
console.log(`  ${dump.meta.totalSongs} songs · ${dump.meta.totalListens} listens · ${dump.meta.totalArtists} artists · ${dump.meta.totalGenres} genres`);
if (dump.moodProfile) console.log(`  Mood profile: ${dump.moodProfile.moodLabel} (e:${dump.moodProfile.avgEnergy} d:${dump.moodProfile.avgDanceability} v:${dump.moodProfile.avgValence})`);
console.log(`  ${dump.meta.totalListeningTimeMinutes} minutes · ${dump.meta.daysWithActivity} days`);