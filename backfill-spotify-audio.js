require('dotenv').config();
const db = require('./db');
const deezerAudio = require('./deezer-audio');

async function main() {
  const songs = db.getSongsNeedingSpotifyAudio(300);
  const limit = Math.min(songs.length, 300);
  console.log(`Found ${songs.length} songs needing audio enrichment. Processing up to ${limit}...`);

  let enriched = 0;
  for (let i = 0; i < limit; i++) {
    const s = songs[i];
    process.stdout.write(`[${i + 1}/${limit}] ${s.title} - ${s.artist}... `);

    const data = await deezerAudio.enrichSong(s.artist, s.title);
    if (data) {
      db.updateSpotifyData(s.videoId, {
        genre: null,
        bpm: data.bpm ?? null,
        energy: data.energy ?? null,
        danceability: data.danceability ?? null,
        valence: data.valence ?? null,
        spotifyPopularity: data.popularity ?? null,
        spotifyTrackId: data.spotifyTrackId ?? null,
        spotifyEnergy: data.energy ?? null,
        spotifyDanceability: data.danceability ?? null,
        spotifyValence: data.valence ?? null,
        spotifyTempo: data.bpm ?? null,
        acousticness: data.acousticness ?? null,
        instrumentalness: null,
        liveness: null,
        speechiness: null,
      });
      enriched++;
      console.log(`✓ e=${data.energy?.toFixed(2) ?? '?'} v=${data.valence?.toFixed(2) ?? '?'} d=${data.danceability?.toFixed(2) ?? '?'} ${data.bpm ?? '?'}bpm`);
    } else {
      console.log('✗ no preview found');
    }

    if (i < limit - 1) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone. Enriched ${enriched}/${limit} songs.`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
