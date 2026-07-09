require('dotenv').config();
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const CONFIG_FILE = path.join(process.env.HOME, '.config', 'yt-music-mcp', 'spotify.json');

let cachedTokens = null;

function loadTokens() {
  if (cachedTokens) return cachedTokens;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      cachedTokens = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return cachedTokens;
    }
  } catch {}
  return null;
}

async function refreshAccess() {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) return null;

  const auth = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');

  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + auth,
      },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(tokens.refresh_token),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('[spotify] Token refresh failed:', res.status, txt.slice(0, 200));
      return null;
    }
    const data = await res.json();
    const now = Date.now();
    const updated = {
      ...tokens,
      access_token: data.access_token,
      expires_at: now + (data.expires_in || 3600) * 1000,
    };
    if (data.refresh_token) updated.refresh_token = data.refresh_token;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
    cachedTokens = updated;
    return data.access_token;
  } catch (e) { console.error('[spotify] Refresh error:', e.message); return null; }
}

async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) return null;
  if (tokens.access_token && tokens.expires_at > Date.now() + 60000) return tokens.access_token;
  return refreshAccess();
}

async function searchTrack(artist, title) {
  const token = await getAccessToken();
  if (!token) return null;

  const cleanTitle = title.replace(/\[.*?\]|\(.*?\)/g, '').trim();
  // Try exact match first with field filters, fallback to plain query
  const queries = [
    `artist:${artist} track:${cleanTitle}`,
    `${cleanTitle} ${artist}`,
  ];

  for (const q of queries) {
    try {
      const res = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=3`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const tracks = data?.tracks?.items || [];
      if (tracks.length > 0) return tracks[0];
    } catch {}
  }
  return null;
}

async function getAudioFeatures(spotifyId) {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const res = await fetch(
      `https://api.spotify.com/v1/audio-features/${spotifyId}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function getArtistGenres(artistId) {
  const token = await getAccessToken();
  if (!token) return [];

  try {
    const res = await fetch(
      `https://api.spotify.com/v1/artists/${artistId}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data?.genres || [];
  } catch { return []; }
}

async function enrichSong(artist, title) {
  const track = await searchTrack(artist, title);
  if (!track) return null;

  const [features, genres] = await Promise.all([
    getAudioFeatures(track.id),
    track.artists?.[0]?.id ? getArtistGenres(track.artists[0].id) : [],
  ]);

  return {
    spotifyId: track.id,
    spotifyArtistId: track.artists?.[0]?.id || null,
    genre: genres[0] || null,
    genres: genres,
    danceability: features?.danceability || null,
    energy: features?.energy || null,
    valence: features?.valence || null,
    bpm: features?.tempo || null,
    spotifyPopularity: track.popularity || null,
  };
}

module.exports = { enrichSong, searchTrack, getAudioFeatures, getArtistGenres };
