#!/usr/bin/env node
const db = require('./db');
const lastfm = require('./lastfm');

async function main() {
  const songs = db.getSongsWithoutSpotify(500);
  if (songs.length === 0) {
    console.log('All songs already enriched!');
    return;
  }

  console.log(`Enriching ${songs.length} songs via Last.fm...`);
  let done = 0, failed = 0;

  for (const s of songs) {
    const data = await lastfm.enrichSong(s.artist, s.title);
    if (data && (data.genre || data.energy != null)) {
      db.updateSpotifyData(s.videoId, {
        genre: data.genre, energy: data.energy, danceability: data.danceability,
        valence: data.valence, bpm: null, spotifyPopularity: null,
      });
      done++;
      const tag = data.genre ? ` [${data.genre}]` : '';
      console.log(`✓ ${s.title} - ${s.artist}${tag} e:${data.energy?.toFixed(2) || '?'} d:${data.danceability?.toFixed(2) || '?'}`);
    } else {
      failed++;
      console.log(`✗ ${s.title} - ${s.artist}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone: ${done} enriched, ${failed} not found`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
