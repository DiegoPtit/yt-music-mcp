#!/usr/bin/env node
const db = require('./db');
const spotify = require('./spotify');

async function main() {
  const songs = db.getSongsWithoutSpotify(200);
  if (songs.length === 0) {
    console.log('All songs already enriched with Spotify data!');
    return;
  }

  console.log(`Enriching ${songs.length} songs...`);
  let done = 0, failed = 0;

  for (const s of songs) {
    const data = await spotify.enrichSong(s.artist, s.title);
    if (data) {
      db.updateSpotifyData(s.videoId, data);
      done++;
      const tag = data.genre ? ` [${data.genre}]` : '';
      console.log(`✓ ${s.title} - ${s.artist}${tag} e:${data.energy?.toFixed(2) || '?'} d:${data.danceability?.toFixed(2) || '?'}`);
    } else {
      failed++;
      console.log(`✗ ${s.title} - ${s.artist} (not found)`);
    }
    // Rate limit: 1 request per 200ms to avoid hitting Spotify rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nDone: ${done} enriched, ${failed} not found`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
