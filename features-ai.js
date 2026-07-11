const db = require('./db');

const FEATURE_KEYS = ['energy', 'danceability', 'valence', 'bpm', 'acousticness'];

function songVector(s) {
  return [
    s.energy ?? 0.5,
    s.danceability ?? 0.5,
    s.valence ?? 0.5,
    ((s.bpm ?? 120) - 60) / 180,
    s.acousticness ?? 0.5,
  ];
}

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

// ------ 1. FLOW STATE MEJORADO ------
const FLOW_BPM_RANGES = {
  coding: { min: 80, max: 130 },
  browser: { min: 90, max: 140 },
  terminal: { min: 70, max: 120 },
  reading: { min: 60, max: 100 },
  default: { min: 80, max: 140 },
};

function getFlowStateSongs(appCategory, count = 10) {
  const range = FLOW_BPM_RANGES[appCategory] || FLOW_BPM_RANGES.default;
  const all = db.getAllSongs().filter(s => s.playCount > 0 && s.energy != null && s.bpm != null);

  const scored = all.map(s => {
    let score = 0;
    if (s.bpm >= range.min && s.bpm <= range.max) score += 3;
    else if (s.bpm >= range.min - 10 && s.bpm <= range.max + 10) score += 1;

    if (s.energy >= 0.35 && s.energy <= 0.7) score += 2;
    else if (s.energy < 0.35) score += 1;

    if (s.valence != null && s.valence >= 0.4) score += 1.5;

    if (s.acousticness != null && s.acousticness > 0.5) score += appCategory === 'reading' ? 2 : 1;

    if (s.likeState === 'LIKE') score += 1.5;

    const aff = db.computeAffinityScore(s.playCount, s.maxProgress, Math.max(0, (Date.now() - new Date(s.lastListened).getTime()) / 86400000));
    score += aff * 0.5;

    const burnout = db.computeBurnoutStatus(s.videoId);
    if (burnout.status === 'fatigued') score -= 8;
    if (burnout.status === 'declining') score -= 2;

    return { ...s, score, affinityScore: Math.round(aff * 100) / 100 };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count);
}

// ------ 2. MODO ÁNIMO ------
const MOOD_PROFILES = {
  happy: { energy: [0.6, 1], valence: [0.6, 1], bpm: [100, 160], acousticness: [0, 0.4] },
  chill: { energy: [0, 0.4], valence: [0.3, 0.8], bpm: [50, 100], acousticness: [0.4, 1] },
  energetic: { energy: [0.7, 1], valence: [0.3, 1], bpm: [120, 200], acousticness: [0, 0.3] },
  focused: { energy: [0.3, 0.65], valence: [0.3, 0.8], bpm: [70, 120], acousticness: [0.3, 1] },
  sad: { energy: [0, 0.4], valence: [0, 0.35], bpm: [40, 90], acousticness: [0.3, 1] },
};

function getMoodSongs(mood, count = 10) {
  const profile = MOOD_PROFILES[mood];
  if (!profile) return [];

  const all = db.getAllSongs().filter(s => s.playCount > 0 && s.energy != null);

  const scored = all.map(s => {
    let score = 0;
    const checks = [
      s.energy >= profile.energy[0] && s.energy <= profile.energy[1],
      s.valence != null && s.valence >= profile.valence[0] && s.valence <= profile.valence[1],
      s.bpm != null && s.bpm >= profile.bpm[0] && s.bpm <= profile.bpm[1],
      s.acousticness != null && s.acousticness >= profile.acousticness[0] && s.acousticness <= profile.acousticness[1],
    ];
    score = checks.filter(Boolean).length;

    if (checks.every(Boolean)) score += 2;
    if (s.likeState === 'LIKE') score += 1;
    if (score > 0) {
      const aff = db.computeAffinityScore(s.playCount, s.maxProgress, Math.max(0, (Date.now() - new Date(s.lastListened).getTime()) / 86400000));
      score += aff * 0.5;
    }
    return { ...s, score, affinityScore: score > 0 ? Math.round(db.computeAffinityScore(s.playCount, s.maxProgress, Math.max(0, (Date.now() - new Date(s.lastListened).getTime()) / 86400000)) * 100) / 100 : 0 };
  });

  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, count);
}

// ------ 3. BURNOUT DETECTION ------
function getBurnoutReport() {
  const all = db.getAllSongs().filter(s => s.playCount > 2);
  const fatigued = [];
  const declining = [];
  const healthy = [];

  for (const s of all) {
    const status = db.computeBurnoutStatus(s.videoId);
    if (status.status === 'fatigued') fatigued.push({ title: s.title, artist: s.artist, videoId: s.videoId, playCount: s.playCount, lastListened: s.lastListened, slope: status.slope });
    else if (status.status === 'declining') declining.push({ title: s.title, artist: s.artist, videoId: s.videoId, playCount: s.playCount, lastListened: s.lastListened, slope: status.slope });
    else healthy.push({ title: s.title, artist: s.artist, videoId: s.videoId, playCount: s.playCount });
  }

  fatigued.sort((a, b) => a.slope - b.slope);
  declining.sort((a, b) => a.slope - b.slope);

  const recentTrend = analyzeTrend(db.getContextMetricsHistory(50));

  return {
    totalFatigued: fatigued.length,
    totalDeclining: declining.length,
    totalHealthy: healthy.length,
    fatigueRate: all.length > 0 ? Math.round(((fatigued.length + declining.length) / all.length) * 100) : 0,
    fatiguedSongs: fatigued.slice(0, 5),
    decliningSongs: declining.slice(0, 5),
    recentTrend,
    recommendation: getBurnoutRecommendation(fatigued.length, declining.length, recentTrend),
  };
}

function analyzeTrend(history) {
  if (!history || history.length < 5) return { status: 'insufficient_data' };

  const recent = history.slice(-10);
  const energies = recent.map(r => r.energy).filter(e => e != null);
  if (energies.length < 3) return { status: 'insufficient_data' };

  const firstHalf = energies.slice(0, Math.floor(energies.length / 2));
  const secondHalf = energies.slice(Math.floor(energies.length / 2));
  const avgFirst = firstHalf.reduce((a, v) => a + v, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, v) => a + v, 0) / secondHalf.length;
  const delta = avgSecond - avgFirst;

  return {
    status: delta < -0.1 ? 'fatigue_trend' : delta > 0.1 ? 'energizing_trend' : 'stable',
    avgEnergyFirstHalf: parseFloat(avgFirst.toFixed(3)),
    avgEnergySecondHalf: parseFloat(avgSecond.toFixed(3)),
    delta: parseFloat(delta.toFixed(3)),
    sampleSize: energies.length,
  };
}

function getBurnoutRecommendation(fatigued, declining, trend) {
  if (fatigued > 3) {
    return `⚠️ ${fatigued} songs showing fatigue. Consider mixing in fresh discoveries instead of repeating favorites.`;
  }
  if (declining > 5) {
    return `${declining} songs showing declining interest. Try exploring new genres or artists.`;
  }
  if (trend.status === 'fatigue_trend' && fatigued > 0) {
    return 'Recent listening energy is trending down with some fatigue. Consider a short discovery session.';
  }
  if (trend.status === 'energizing_trend') {
    return 'Your listening energy is trending up — great momentum for exploring new music!';
  }
  return 'Healthy listening patterns. Keep enjoying your music!';
}

// ------ 4. PLAYLIST INTELIGENTE ------
function kMeansPP(vectors, k) {
  const n = vectors[0].length;
  const centroids = [[...vectors[Math.floor(Math.random() * vectors.length)]]];
  for (let c = 1; c < k; c++) {
    const dists = vectors.map(v => Math.min(...centroids.map(cent => euclidean(v, cent))));
    const sq = dists.map(d => d * d);
    const total = sq.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < sq.length; i++) {
      r -= sq[i];
      if (r <= 0) { centroids.push([...vectors[i]]); break; }
    }
    if (centroids.length === c) centroids.push([...vectors[Math.floor(Math.random() * vectors.length)]]);
  }
  return centroids;
}

function kMeans(vectors, k, maxIter = 10) {
  if (vectors.length === 0) return [];
  const n = vectors[0].length;
  const centroids = kMeansPP(vectors, k);
  let assignments = new Array(vectors.length).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    for (let i = 0; i < vectors.length; i++) {
      let bestD = Infinity;
      for (let j = 0; j < centroids.length; j++) {
        const d = euclidean(vectors[i], centroids[j]);
        if (d < bestD) { bestD = d; assignments[i] = j; }
      }
    }
    const newCentroids = Array.from({ length: k }, () => new Array(n).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i];
      for (let d = 0; d < n; d++) newCentroids[c][d] += vectors[i][d];
      counts[c]++;
    }
    let changed = false;
    for (let j = 0; j < k; j++) {
      if (counts[j] > 0) {
        for (let d = 0; d < n; d++) newCentroids[j][d] /= counts[j];
      } else {
        newCentroids[j] = [...vectors[Math.floor(Math.random() * vectors.length)]];
        changed = true;
      }
    }
    if (!changed) {
      const moved = centroids.some((c, j) => euclidean(c, newCentroids[j]) > 0.001);
      centroids.splice(0, centroids.length, ...newCentroids);
      if (!moved) break;
    } else {
      centroids.splice(0, centroids.length, ...newCentroids);
    }
  }
  return { assignments, centroids };
}

function getSmartPlaylist(clusterName, count = 10) {
  const all = db.getAllSongs().filter(s => s.playCount > 0 && s.energy != null && s.bpm != null);
  if (all.length === 0) return [];

  const vectors = all.map(s => songVector(s));
  const k = Math.min(4, all.length);
  const { assignments, centroids } = kMeans(vectors, k);

  const clusterNames = assignClusterNames(centroids);
  const available = [...new Set(clusterNames.filter(Boolean))];

  if (!clusterName) {
    return { availableClusters: available };
  }

  const targetClusterIndex = clusterNames.findIndex(n => n && n.toLowerCase() === clusterName.toLowerCase());
  if (targetClusterIndex === -1) return { availableClusters: available };

  const clusterSongs = all.filter((s, i) => assignments[i] === targetClusterIndex);
  const scored = clusterSongs.map(s => {
    const aff = db.computeAffinityScore(s.playCount, s.maxProgress, Math.max(0, (Date.now() - new Date(s.lastListened).getTime()) / 86400000));
    return { ...s, affinityScore: Math.round(aff * 100) / 100, score: aff };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count);
}

function assignClusterNames(centroids) {
  return centroids.map(c => {
    const e = c[0], d = c[1], v = c[2], b = c[3], a = c[4];
    if (e > 0.65 && d > 0.55 && b > 0.35) return 'party';
    if (e > 0.6 && b > 0.4 && a < 0.35) return 'energy';
    if (e < 0.4 && v > 0.5 && a > 0.4) return 'chill';
    if (e < 0.3 && v < 0.35) return 'melancholic';
    if (e < 0.5 && b < 0.25 && a > 0.5) return 'acoustic';
    if (e > 0.5 && e < 0.75 && b > 0.3 && b < 0.5) return 'balanced';
    if (d > 0.5 && v > 0.5) return 'groovy';
    if (e > 0.5 && a > 0.4) return 'warm';
    if (e > 0.6 && d > 0.5 && v < 0.4) return 'intense';
    return 'eclectic';
  });
}

// ------ 5. PERFIL TEMPORAL ------
function getTimeProfile() {
  const all = db.getAllSongs().filter(s => s.energy != null);
  if (all.length < 3) return { error: 'Not enough data' };

  const metrics = db.getContextMetricsHistory(1000);
  if (!metrics || metrics.length < 10) return { error: 'Not enough listen dates for time profile' };

  const listenDates = metrics.filter(m => m.energy != null);

  const byHour = Array.from({ length: 24 }, () => []);
  for (const row of listenDates) {
    const hour = new Date(row.listenedAt).getHours();
    byHour[hour].push(row);
  }

  const hourlyProfiles = byHour.map((entries, hour) => {
    if (entries.length < 2) return null;
    const avg = (key) => entries.reduce((a, r) => a + (r[key] ?? 0), 0) / entries.length;
    return {
      hour,
      count: entries.length,
      avgEnergy: parseFloat(avg('energy').toFixed(3)),
      avgValence: parseFloat(avg('valence').toFixed(3)),
      avgBpm: Math.round(avg('bpm')),
    };
  }).filter(Boolean);

  const segments = [
    { name: 'early_morning', hours: [0, 1, 2, 3, 4, 5], label: 'Madrugada (0-6)' },
    { name: 'morning', hours: [6, 7, 8, 9, 10, 11], label: 'Mañana (6-12)' },
    { name: 'afternoon', hours: [12, 13, 14, 15, 16, 17], label: 'Tarde (12-18)' },
    { name: 'evening', hours: [18, 19, 20, 21, 22, 23], label: 'Noche (18-24)' },
  ];

  const segmentProfiles = segments.map(seg => {
    const entries = seg.hours.flatMap(h => byHour[h]).filter(Boolean);
    if (entries.length < 2) return null;
    const avg = (key) => entries.reduce((a, r) => a + (r[key] ?? 0), 0) / entries.length;
    return {
      segment: seg.name,
      label: seg.label,
      count: entries.length,
      avgEnergy: parseFloat(avg('energy').toFixed(3)),
      avgValence: parseFloat(avg('valence').toFixed(3)),
      avgBpm: Math.round(avg('bpm')),
    };
  }).filter(Boolean);

  const bestHour = hourlyProfiles.reduce((a, b) => (a.count > b.count ? a : b));

  return { hourlyProfiles, segmentProfiles, peakListeningHour: bestHour.hour };
}

// ------ 6. "ESTO SUENA COMO..." ------
function getSimilarSongs(videoId, count = 10) {
  const target = db.getSong(videoId);
  if (!target || target.energy == null || target.bpm == null) {
    if (target) return similarByGenreOrArtist(target);
    return [];
  }

  const targetVec = songVector(target);
  const all = db.getAllSongs().filter(s =>
    s.videoId !== videoId && s.playCount > 0 && s.energy != null && s.bpm != null
  );

  if (all.length === 0) return [];

  const scored = all.map(s => ({
    ...s,
    distance: euclidean(targetVec, songVector(s)),
    affinityScore: Math.round(db.computeAffinityScore(s.playCount, s.maxProgress, Math.max(0, (Date.now() - new Date(s.lastListened).getTime()) / 86400000)) * 100) / 100,
  }));

  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, count).map(s => ({
    title: s.title, artist: s.artist, videoId: s.videoId,
    genre: s.genre, bpm: s.bpm, energy: s.energy,
    danceability: s.danceability, valence: s.valence, acousticness: s.acousticness,
    distance: parseFloat(s.distance.toFixed(4)),
    affinityScore: s.affinityScore,
  }));
}

function similarByGenreOrArtist(song) {
  const all = db.getAllSongs().filter(s => s.videoId !== song.videoId && s.playCount > 0);
  const scored = all.map(s => {
    let score = 0;
    if (s.genre && song.genre && s.genre === song.genre) score += 3;
    if (s.artist === song.artist) score += 5;
    const aff = db.computeAffinityScore(s.playCount, s.maxProgress, Math.max(0, (Date.now() - new Date(s.lastListened).getTime()) / 86400000));
    score += aff;
    return { ...s, score, affinityScore: Math.round(aff * 100) / 100 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 10).map(s => ({
    title: s.title, artist: s.artist, videoId: s.videoId,
    genre: s.genre, affinityScore: s.affinityScore,
    reason: s.artist === song.artist ? 'same artist' : s.genre === song.genre ? 'same genre' : 'top pick',
  }));
}

// ------ EXPORT ------
module.exports = {
  getFlowStateSongs,
  getMoodSongs,
  getBurnoutReport,
  getSmartPlaylist,
  getTimeProfile,
  getSimilarSongs,
  MOOD_PROFILES,
  FEATURE_KEYS,
};
