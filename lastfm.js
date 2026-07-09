const API_KEY = 'cef8408e7417e5b23ff6fff7538a3061';
const API_SECRET = '92a5b1adbe4e2d092a59530bf9a2c19b';
const BASE = 'https://ws.audioscrobbler.com/2.0/';

const MOOD_MAP = {
  // High energy
  energetic:        { e: 0.85, d: 0.6, v: 0.7 },
  upbeat:           { e: 0.85, d: 0.7, v: 0.8 },
  powerful:         { e: 0.9,  d: 0.4, v: 0.5 },
  intense:          { e: 0.9,  d: 0.3, v: 0.3 },
  aggressive:       { e: 0.9,  d: 0.3, v: 0.2 },
  heavy:            { e: 0.9,  d: 0.2, v: 0.2 },
  loud:             { e: 0.85, d: 0.4, v: 0.4 },
  fast:             { e: 0.85, d: 0.7, v: 0.6 },
  wild:             { e: 0.9,  d: 0.7, v: 0.6 },
  excited:          { e: 0.85, d: 0.7, v: 0.85 },
  epic:             { e: 0.8,  d: 0.3, v: 0.5 },
  fiery:            { e: 0.9,  d: 0.5, v: 0.4 },
  explosive:        { e: 0.95, d: 0.4, v: 0.3 },

  // Medium-high energy
  rock:             { e: 0.75, d: 0.5, v: 0.5 },
  pop:              { e: 0.7,  d: 0.7, v: 0.8 },
  dance:            { e: 0.75, d: 0.9, v: 0.7 },
  electronic:       { e: 0.7,  d: 0.8, v: 0.5 },
  disco:            { e: 0.7,  d: 0.85, v: 0.8 },
  funk:             { e: 0.7,  d: 0.9, v: 0.85 },
  soul:             { e: 0.6,  d: 0.6, v: 0.7 },
  groovy:           { e: 0.65, d: 0.85, v: 0.75 },
  party:            { e: 0.8,  d: 0.9, v: 0.85 },
  fun:              { e: 0.75, d: 0.7, v: 0.85 },
  happy:            { e: 0.7,  d: 0.65, v: 0.9 },
  joyful:           { e: 0.7,  d: 0.6, v: 0.9 },

  // Medium energy
  alternative:      { e: 0.6,  d: 0.5, v: 0.4 },
  indie:            { e: 0.55, d: 0.5, v: 0.5 },
  folk:             { e: 0.4,  d: 0.4, v: 0.5 },
  country:          { e: 0.4,  d: 0.45, v: 0.6 },
  jazz:             { e: 0.35, d: 0.4, v: 0.4 },
  blues:            { e: 0.35, d: 0.3, v: 0.3 },
  reggae:           { e: 0.4,  d: 0.6, v: 0.6 },
  latin:            { e: 0.65, d: 0.8, v: 0.75 },
  hiphop:           { e: 0.65, d: 0.85, v: 0.5 },
  rap:              { e: 0.65, d: 0.8, v: 0.4 },
  rnb:              { e: 0.5,  d: 0.6, v: 0.55 },
  piano:            { e: 0.25, d: 0.2, v: 0.3 },
  acoustic:         { e: 0.25, d: 0.3, v: 0.4 },
  chill:            { e: 0.2,  d: 0.3, v: 0.5 },
  relaxing:         { e: 0.15, d: 0.2, v: 0.6 },
  calm:             { e: 0.15, d: 0.15, v: 0.5 },
  mellow:           { e: 0.2,  d: 0.25, v: 0.45 },
  smooth:           { e: 0.25, d: 0.3, v: 0.5 },
  warm:             { e: 0.3,  d: 0.25, v: 0.6 },
  romantic:         { e: 0.25, d: 0.3, v: 0.7 },
  dreamy:           { e: 0.2,  d: 0.2, v: 0.4 },
  ethereal:         { e: 0.2,  d: 0.15, v: 0.35 },

  // Low energy
  ambient:          { e: 0.1,  d: 0.1, v: 0.3 },
  classical:        { e: 0.2,  d: 0.1, v: 0.3 },
  instrumental:     { e: 0.2,  d: 0.15, v: 0.3 },
  lofi:             { e: 0.15, d: 0.2, v: 0.35 },
  sad:              { e: 0.15, d: 0.15, v: 0.15 },
  melancholic:      { e: 0.15, d: 0.15, v: 0.15 },
  depressive:       { e: 0.1,  d: 0.1, v: 0.1 },
  dark:             { e: 0.35, d: 0.2, v: 0.15 },
  mysterious:       { e: 0.25, d: 0.15, v: 0.2 },
  nocturnal:        { e: 0.2,  d: 0.2, v: 0.2 },
  rainy:            { e: 0.15, d: 0.15, v: 0.2 },
  sleepy:           { e: 0.1,  d: 0.1, v: 0.2 },
 温柔的:            { e: 0.15, d: 0.15, v: 0.5 },
  night:            { e: 0.2,  d: 0.2, v: 0.25 },
  gloomy:           { e: 0.15, d: 0.1, v: 0.1 },

  // Metal subgenres (high energy, low valence usually)
  metal:            { e: 0.85, d: 0.3, v: 0.2 },
  'nu metal':       { e: 0.85, d: 0.35, v: 0.25 },
  'death metal':    { e: 0.95, d: 0.2, v: 0.1 },
  'black metal':    { e: 0.95, d: 0.15, v: 0.1 },
  'power metal':    { e: 0.9,  d: 0.4, v: 0.5 },
  'symphonic metal':{ e: 0.8,  d: 0.3, v: 0.3 },
  metalcore:        { e: 0.9,  d: 0.3, v: 0.2 },
  hardcore:         { e: 0.95, d: 0.3, v: 0.15 },
  punk:             { e: 0.85, d: 0.4, v: 0.3 },
  grunge:           { e: 0.75, d: 0.35, v: 0.2 },
  emo:              { e: 0.65, d: 0.35, v: 0.15 },

  // Electronic subgenres
  techno:           { e: 0.8,  d: 0.85, v: 0.4 },
  house:            { e: 0.75, d: 0.9,  v: 0.6 },
  trance:           { e: 0.75, d: 0.7,  v: 0.5 },
  dubstep:          { e: 0.85, d: 0.5,  v: 0.3 },
  edm:              { e: 0.8,  d: 0.85, v: 0.65 },
  drumandbass:      { e: 0.85, d: 0.8,  v: 0.4 },
};

async function api(method, params) {
  const query = new URLSearchParams({
    method,
    api_key: API_KEY,
    format: 'json',
    ...params,
  });
  try {
    const res = await fetch(`${BASE}?${query}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function getTrackInfo(artist, title) {
  const data = await api('track.getInfo', {
    artist,
    track: title.replace(/\[.*?\]|\(.*?\)/g, '').trim(),
    autocorrect: 1,
  });
  if (!data?.track) return null;
  return data.track;
}

async function getArtistInfo(artist) {
  const data = await api('artist.getInfo', { artist, autocorrect: 1 });
  if (!data?.artist) return null;
  return data.artist;
}

function extractTags(trackTags, artistTags) {
  const seen = new Set();
  const tags = [];
  const all = [...(trackTags || []), ...(artistTags || [])];
  for (const t of all) {
    const name = t.name?.toLowerCase().trim();
    if (name && !seen.has(name) && name.length < 30 && !name.includes(' ')) {
      seen.add(name);
      tags.push(name);
    }
  }
  return tags;
}

function estimateFeaturesFromTags(tags) {
  let energy = null, danceability = null, valence = null;
  const matched = [];

  for (const tag of tags) {
    const mood = MOOD_MAP[tag];
    if (mood) {
      matched.push(tag);
      if (energy == null || Math.abs(mood.e - 0.5) > Math.abs(energy - 0.5)) energy = mood.e;
      if (danceability == null || mood.d > danceability) danceability = mood.d;
      if (valence == null || Math.abs(mood.v - 0.5) > Math.abs(valence - 0.5)) valence = mood.v;
    }
  }

  // Average matched values instead of taking extremes
  if (matched.length > 1) {
    const eAvg = matched.reduce((a, t) => a + MOOD_MAP[t].e, 0) / matched.length;
    const dAvg = matched.reduce((a, t) => a + MOOD_MAP[t].d, 0) / matched.length;
    const vAvg = matched.reduce((a, t) => a + MOOD_MAP[t].v, 0) / matched.length;
    energy = Math.round(eAvg * 100) / 100;
    danceability = Math.round(dAvg * 100) / 100;
    valence = Math.round(vAvg * 100) / 100;
  }

  return { energy, danceability, valence };
}

function extractGenre(tags) {
  const genrePriority = [
    'rock', 'pop', 'metal', 'jazz', 'hip hop', 'hiphop', 'rap', 'electronic',
    'classical', 'r&b', 'rnb', 'soul', 'funk', 'reggae', 'country', 'blues',
    'folk', 'indie', 'punk', 'alternative', 'latin', 'edm', 'dance', 'techno',
    'house', 'ambient', 'lo-fi', 'lofi', 'metalcore', 'nu metal', 'grunge',
    'emo', 'hardcore', 'punk rock', 'indie rock', 'alternative rock',
    'synthwave', 'vaporwave', 'shoegaze', 'grime', 'afrobeat', 'reggaeton',
    'salsa', 'bossa nova', 'disco', 'gospel', 'christian', 'opera',
  ];
  for (const g of genrePriority) {
    if (tags.includes(g)) return g;
  }
  const firstLongTag = tags.find(t => t.length > 3 && !t.includes('seen') && !t.includes('favorite') && !t.includes('awesome'));
  return firstLongTag || null;
}

async function enrichSong(artist, title) {
  // Try with exact name first
  let track = await getTrackInfo(artist, title);
  // If not found, try with just the artist and first part of title
  if (!track && title.includes('(') || title.includes('[')) {
    const shortTitle = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
    if (shortTitle !== title) track = await getTrackInfo(artist, shortTitle);
  }

  const artistInfo = await getArtistInfo(artist);

  const trackTags = track?.toptags?.tag || [];
  const artistTags = artistInfo?.tags?.tag || [];
  const tags = extractTags(trackTags, artistTags);
  const features = estimateFeaturesFromTags(tags);
  const genre = extractGenre(tags);

  return {
    genre: genre || null,
    energy: features.energy,
    danceability: features.danceability,
    valence: features.valence,
    tags: tags.slice(0, 10),
  };
}

// Keep spotify module as fallback (it will return null without premium)
const spotify = require('./spotify');

async function enrichSongWithFallback(artist, title) {
  const lastfm = await enrichSong(artist, title);
  if (lastfm?.genre || lastfm?.energy != null) {
    return {
      genre: lastfm.genre,
      energy: lastfm.energy,
      danceability: lastfm.danceability,
      valence: lastfm.valence,
      spotifyPopularity: null,
      bpm: null,
    };
  }
  // Spotify fallback (will likely return null without premium)
  const sp = await spotify.enrichSong(artist, title);
  return sp;
}

module.exports = { enrichSong, enrichSongWithFallback, getTrackInfo, getArtistInfo };
