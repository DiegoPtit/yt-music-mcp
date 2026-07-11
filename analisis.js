require('dotenv').config();
const db = require('./db');

const d = db.getDb();

console.log('═══════════════════════════════════════════');
console.log('     ANÁLISIS COMPLETO DE ESCUCHA');
console.log('═══════════════════════════════════════════\n');

// === GENERAL ===
const stats = db.getStats();
console.log(`📊 GENERAL`);
console.log(`   ${stats.totalSongs} canciones únicas · ${stats.totalPlays} reproducciones · ${stats.totalMinutes} min · ${stats.daysActive} días activos`);
console.log(`   ${stats.likedSongs} likes · ${stats.sessionCount} sesiones · ${stats.songsWithContext} escuchas con contexto`);
console.log();

// === TOP 10 AFINIDAD (TRUE AFFINITY) ===
console.log(`🎯 TOP 10 POR AFINIDAD REAL`);
console.log(`   (playCount^0.5 × avgProgress^1.5 × recencyBoost)`);
const affinity = db.getAffinityScores(0, 10);
affinity.forEach((s, i) => {
  const bar = '█'.repeat(Math.round(s.affinityScore * 5));
  console.log(`   ${i+1}. ${s.title} - ${s.artist}  ${bar} ${s.affinityScore.toFixed(2)}  (${s.playCount}x, ${Math.round(s.avgProgress*100)}%, hace ${s.daysSinceLastListened}d)`);
});
console.log();

// === TOP 5 QUEMADAS vs MÁS SANAS ===
console.log(`🔥 BURNOUT — CANCIONES FATIGADAS`);
const allSongs = db.getAllSongs();
const burnoutSongs = allSongs.map(s => {
  const b = db.computeBurnoutStatus(s.videoId);
  return { ...s, burnout: b };
}).filter(s => s.burnout.dataPoints >= 3).sort((a, b) => a.burnout.slope - b.burnout.slope);

const fatigued = burnoutSongs.filter(s => s.burnout.status === 'fatigued');
const healthy = burnoutSongs.filter(s => s.burnout.status === 'healthy').sort((a, b) => b.burnout.avgProgress - a.burnout.avgProgress);

if (fatigued.length > 0) {
  fatigued.slice(0, 5).forEach(s => {
    console.log(`   ⚠ ${s.title} - ${s.artist}  pendiente: ${s.burnout.slope}  avgProg: ${Math.round(s.burnout.avgProgress*100)}%  (${s.burnout.dataPoints} escuchas)`);
  });
} else {
  console.log(`   ✅ No hay canciones fatigadas todavía (necesitan ≥3 escuchas con progreso)`);
}
console.log(`   🏆 Más sanas:`);
healthy.slice(0, 3).forEach(s => {
  console.log(`      ${s.title} - ${s.artist}  avg: ${Math.round(s.burnout.avgProgress*100)}%  (${s.burnout.dataPoints} escuchas)`);
});
console.log();

// === SESIONES ===
console.log(`📅 SESIONES DE ESCUCHA`);
const sessions = db.getSessions(10);
sessions.forEach((s, i) => {
  const day = new Date(s.startTime).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
  const startH = new Date(s.startTime).getHours();
  const period = startH < 6 ? 'madrugada' : startH < 12 ? 'mañana' : startH < 18 ? 'tarde' : 'noche';
  console.log(`   ${i+1}. ${day} (${period}) — ${s.contextSummary || `${s.songCount} canciones`}`);
});
console.log();

// === ÚLTIMA SESIÓN (TRAYECTORIA) ===
const current = db.getCurrentSession();
if (current) {
  console.log(`🎵 SESIÓN ACTIVA — TRAYECTORIA EMOCIONAL`);
  const traj = db.getSessionTrajectory(current.id);
  if (traj.trajectory !== 'insufficient_data') {
    const emojiMap = { ramping_up: '🚀', winding_down: '🌙', calming: '🍃', energizing: '⚡', stable: '➡️' };
    console.log(`   ${emojiMap[traj.trajectory] || '🎧'} ${traj.songCount} canciones · trayectoria: ${traj.trajectory}`);
    if (traj.energySlope != null) console.log(`   📈 Energía: ${(traj.energy.slopeStart || 0) > 0 ? '+' : ''}${(traj.energy.slope * 100).toFixed(1)}%/escucha  (${(traj.energy.start * 100).toFixed(0)}% → ${(traj.energy.end * 100).toFixed(0)}%)`);
    if (traj.valence.slope != null) console.log(`   😊 Valencia: ${(traj.valence.slope * 100).toFixed(1)}%/escucha  (${(traj.valence.start * 100).toFixed(0)}% → ${(traj.valence.end * 100).toFixed(0)}%)`);
    if (traj.genres.length > 0) console.log(`   🎸 Géneros: ${traj.genres.join(' → ')}`);
  }
  console.log();
}

// === DISTRIBUCIÓN HORARIA ===
console.log(`⏰ DISTRIBUCIÓN HORARIA`);
const hourly = db.getHourlyDistribution();
const maxH = Math.max(...hourly.map(h => h.count));
const hourLabels = ['0','1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23'];
const hourMap = {};
hourly.forEach(h => { hourMap[h.hour] = h.count; });
hourLabels.forEach((h, i) => {
  const count = hourMap[i] || 0;
  const bar = count > 0 ? '░'.repeat(Math.max(1, Math.round(count / maxH * 20))) : '';
  console.log(`   ${String(i).padStart(2,'0')}:00 ${bar} ${count}`);
});
console.log();

// === TOP POR MOMENTO DEL DÍA ===
console.log(`🌤 CANCIÓN FAVORITA SEGÚN MOMENTO`);
const periodQueries = {
  madrugada: { start: 0, end: 6 },
  mañana: { start: 6, end: 12 },
  tarde: { start: 12, end: 18 },
  noche: { start: 18, end: 24 },
};
for (const [period, range] of Object.entries(periodQueries)) {
  const songsInPeriod = d.prepare(`
    SELECT s.title, s.artist, s.videoId, COUNT(*) as plays
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    WHERE CAST(strftime('%H', ld.listenedAt) AS INTEGER) >= ? AND CAST(strftime('%H', ld.listenedAt) AS INTEGER) < ?
    GROUP BY s.videoId ORDER BY plays DESC LIMIT 1
  `).all(range.start, range.end);
  if (songsInPeriod.length > 0) {
    const s = songsInPeriod[0];
    console.log(`   ${period.padStart(10)} → ${s.title} - ${s.artist} (${s.plays}x)`);
  }
}
console.log();

// === SAFE FAVORITES (lo que la IA debería recomendarte) ===
console.log(`🤖 SAFE FAVORITES (para recomendaciones IA)`);
const safe = db.getSafeFavorites(2, true, 5);
safe.forEach((s, i) => {
  console.log(`   ${i+1}. ${s.title} - ${s.artist}  (afinidad: ${s.affinityScore}, ${s.playCount}x, ${Math.round(s.avgProgress*100)}%)`);
});
console.log();

console.log('═══════════════════════════════════════════');

db.close();
