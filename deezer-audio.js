const { Essentia, EssentiaWASM } = require('essentia.js');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let essentiaInstance = null;
function getEssentia() {
  if (!essentiaInstance) {
    try {
      essentiaInstance = new Essentia(EssentiaWASM);
    } catch {
      return null;
    }
  }
  return essentiaInstance;
}

async function searchTrack(artist, title) {
  const clean = (s) => s.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  const query = encodeURIComponent(`artist:"${clean(artist)}" track:"${clean(title)}"`);
  const res = await fetch(
    `https://api.deezer.com/search?q=${query}&limit=3&output=json`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.data?.length) return data.data[0];

  const fallbackQuery = encodeURIComponent(`${clean(artist)} ${clean(title)}`);
  const res2 = await fetch(
    `https://api.deezer.com/search?q=${fallbackQuery}&limit=3&output=json`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res2.ok) return null;
  const data2 = await res2.json();
  return data2?.data?.[0] || null;
}

async function downloadPreview(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('Preview download failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function decodeToPcm(mp3Path, wavPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-v', 'quiet', '-i', mp3Path,
      '-ar', '22050', '-ac', '1', '-f', 'f32le',
      wavPath,
    ]);
    ff.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)));
    ff.on('error', reject);
  });
}

function analyzePcm(pcmPath, sampleRate = 22050) {
  const buf = fs.readFileSync(pcmPath);
  const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (samples.length < sampleRate) return null;

  const frameSize = 2048;
  const hopSize = 1024;

  let totalRms = 0;
  let lowEnergyFrames = 0, totalFrames = 0;
  let prevRms = 0;
  let peakFrames = [];
  const spectralCentroids = [];
  let highFreqEnergy = 0;

  const e = getEssentia();

  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const frame = samples.slice(start, start + frameSize);
    totalFrames++;

    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) sumSq += frame[i] * frame[i];
    const rms = Math.sqrt(sumSq / frameSize);
    totalRms += rms;

    if (rms < 0.08) lowEnergyFrames++;

    if (rms > prevRms * 1.3 && rms > 0.05) peakFrames.push(totalFrames);
    prevRms = rms;

    if (e) {
      try {
        const vec = e.arrayToVector(frame);
        const sc = e.SpectralCentroidTime(vec, sampleRate);
        const centroid = sc.centroid || sc.spectralCentroid || 0;
        spectralCentroids.push(centroid);
      } catch {}
    }

    let hfSum = 0;
    for (let i = 1; i < frameSize; i++) hfSum += Math.abs(frame[i] - frame[i - 1]);
    highFreqEnergy += hfSum / frameSize;
  }

  const avgRms = totalRms / totalFrames;
  const lowEnergyRatio = lowEnergyFrames / totalFrames;
  const avgSC = spectralCentroids.length > 0
    ? spectralCentroids.reduce((a, v) => a + v, 0) / spectralCentroids.length
    : 2000;

  const bpm = estimateBpmSimple(samples, sampleRate, peakFrames);
  const energy = Math.min(1, Math.max(0, avgRms * 2.5 * (0.5 + (1 - lowEnergyRatio) * 0.5)));
  const danceability = computeDanceabilitySimple(peakFrames, totalFrames, bpm);
  const brightnessVar = spectralCentroids.length > 1
    ? Math.sqrt(spectralCentroids.reduce((a, v) => a + (v - avgSC) ** 2, 0) / spectralCentroids.length) / avgSC
    : 0.5;
  const bpmConfidence = peakFrames.length >= 4 ? Math.min(1, (peakFrames.length / totalFrames) * 50) : 0.3;

  return {
    bpm: Math.round(Math.min(220, Math.max(40, bpm))),
    energy: parseFloat(Math.min(1, Math.max(0, energy)).toFixed(4)),
    danceability: parseFloat(Math.min(1, Math.max(0, danceability)).toFixed(4)),
    valence: parseFloat(Math.min(1, Math.max(0, (1 - brightnessVar) * 0.5 + (1 - lowEnergyRatio) * 0.3 + 0.2)).toFixed(4)),
    acousticness: parseFloat(Math.min(1, Math.max(0, (1 - Math.min(1, avgSC / 4000)) * 0.6 + (1 - bpmConfidence) * 0.2 + lowEnergyRatio * 0.4)).toFixed(4)),
  };
}

function estimateBpmSimple(samples, sampleRate, peakFrames) {
  if (peakFrames.length >= 4) {
    const intervals = [];
    for (let i = 1; i < peakFrames.length; i++) {
      intervals.push(peakFrames[i] - peakFrames[i - 1]);
    }
    const avgInterval = intervals.reduce((a, v) => a + v, 0) / intervals.length;
    const secondsPerFrame = 1024 / sampleRate;
    const avgIntervalSec = avgInterval * secondsPerFrame;
    if (avgIntervalSec > 0) {
      const bpm = Math.round(60 / avgIntervalSec);
      if (bpm > 160) {
        for (let skip = 2; skip <= 4; skip++) {
          const skipIntervals = [];
          for (let i = skip; i < peakFrames.length; i += skip) {
            skipIntervals.push(peakFrames[i] - peakFrames[i - skip]);
          }
          const avgSkip = skipIntervals.reduce((a, v) => a + v, 0) / skipIntervals.length;
          const skipBpm = Math.round(60 / (avgSkip * secondsPerFrame));
          if (skipBpm >= 50 && skipBpm <= 150) return skipBpm;
        }
      }
      return bpm;
    }
  }

  const hopSize = 1024;
  const energy = [];
  for (let start = 0; start + hopSize <= samples.length; start += hopSize) {
    let sumSq = 0;
    for (let i = 0; i < hopSize; i++) sumSq += samples[start + i] * samples[start + i];
    energy.push(Math.sqrt(sumSq / hopSize));
  }

  const n = energy.length;
  const half = Math.floor(n / 2);
  const minLag = Math.floor(20 * sampleRate / 60 / hopSize);
  const maxLag = Math.floor(200 * sampleRate / 60 / hopSize);
  let bestLag = 0, bestCorr = 0;

  for (let lag = minLag; lag <= Math.min(maxLag, half - 1); lag++) {
    let corr = 0;
    for (let i = 0; i < half; i++) {
      corr += energy[i] * energy[i + lag];
    }
    corr /= half;
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  if (bestLag > 0) {
    const secPerFrame = hopSize / sampleRate;
    let bpm = Math.round(60 / (bestLag * secPerFrame));
    if (bpm >= 40 && bpm <= 220) {
      // Prefer lower BPM (avoid octave doubling)
      const halfLag = Math.round(bestLag * 2);
      if (halfLag <= maxLag) {
        let halfCorr = 0;
        for (let i = 0; i < half; i++) halfCorr += energy[i] * energy[i + halfLag];
        halfCorr /= half;
        if (halfCorr > bestCorr * 0.8) return Math.round(bpm / 2);
      }
      return bpm;
    }
  }

  return 120;
}

function computeDanceabilitySimple(peakFrames, totalFrames, bpm) {
  const bpmScore = bpm >= 80 && bpm <= 140 ? 0.7 : bpm >= 60 && bpm <= 160 ? 0.5 : 0.3;
  let regularityScore = 0.3;
  if (peakFrames.length >= 4) {
    const intervals = [];
    for (let i = 1; i < peakFrames.length; i++) intervals.push(peakFrames[i] - peakFrames[i - 1]);
    const mean = intervals.reduce((a, v) => a + v, 0) / intervals.length;
    const variance = Math.sqrt(intervals.reduce((a, v) => a + (v - mean) ** 2, 0) / intervals.length);
    const cv = variance / mean;
    regularityScore = Math.max(0, 0.8 - cv * cv * 1.5);
  }
  const peakRatio = peakFrames.length / totalFrames;
  const densityScore = Math.min(peakRatio * 50, 1);
  return Math.min(1, regularityScore * 0.45 + bpmScore * 0.35 + densityScore * 0.2);
}

async function enrichSong(artist, title) {
  const tmpDir = '/tmp/deezer-audio';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const safeName = (artist + '-' + title).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
  const mp3Path = path.join(tmpDir, safeName + '.mp3');
  const pcmPath = path.join(tmpDir, safeName + '.pcm');

  try {
    const track = await searchTrack(artist, title);
    if (!track?.preview) return null;

    await downloadPreview(track.preview, mp3Path);
    const dur = track.duration || 30;

    await decodeToPcm(mp3Path, pcmPath);
    const features = analyzePcm(pcmPath);

    if (!features) return null;

    return {
      spotifyTrackId: String(track.id),
      popularity: track.rank || null,
      bpm: features.bpm,
      energy: features.energy,
      danceability: features.danceability,
      valence: features.valence,
      acousticness: features.acousticness,
      duration: dur,
      deezerId: track.id,
    };
  } finally {
    try { fs.unlinkSync(mp3Path); } catch {}
    try { fs.unlinkSync(pcmPath); } catch {}
  }
}

module.exports = { enrichSong, searchTrack };
