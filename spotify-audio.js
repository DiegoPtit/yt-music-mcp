require('dotenv').config();
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64'),
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('Spotify token error: ' + res.status);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function searchTrack(artist, title) {
  const token = await getToken();
  const query = encodeURIComponent(`artist:${artist} track:${title}`);
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${query}&type=track&limit=3`,
    { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.tracks?.items?.length) {
    const fallbackQuery = encodeURIComponent(`${artist} ${title}`);
    const res2 = await fetch(
      `https://api.spotify.com/v1/search?q=${fallbackQuery}&type=track&limit=3`,
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(4000) }
    );
    if (!res2.ok) return null;
    const data2 = await res2.json();
    return data2?.tracks?.items?.[0] || null;
  }
  return data.tracks.items[0];
}

async function getAudioFeatures(spotifyTrackId) {
  const token = await getToken();
  const res = await fetch(
    `https://api.spotify.com/v1/audio-features/${spotifyTrackId}`,
    { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) return null;
  return res.json();
}

async function enrichSong(artist, title) {
  try {
    const track = await searchTrack(artist, title);
    if (!track?.id) return null;
    const features = await getAudioFeatures(track.id);
    if (!features) return { spotifyTrackId: track.id, popularity: track.popularity || null };
    return {
      spotifyTrackId: track.id,
      popularity: track.popularity || null,
      energy: features.energy,
      danceability: features.danceability,
      valence: features.valence,
      tempo: features.tempo,
      acousticness: features.acousticness,
      instrumentalness: features.instrumentalness,
      liveness: features.liveness,
      speechiness: features.speechiness,
    };
  } catch {
    return null;
  }
}

module.exports = { enrichSong, searchTrack, getAudioFeatures, getToken };
