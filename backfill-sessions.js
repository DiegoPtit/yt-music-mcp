require('dotenv').config();
const db = require('./db');

const GAP_MINUTES = 30;

function backfill() {
  const d = db.getDb();
  const listens = d.prepare(`
    SELECT ld.*, s.energy, s.valence, s.genre, s.title, s.artist, s.maxProgress
    FROM listen_dates ld
    JOIN songs s ON ld.videoId = s.videoId
    ORDER BY ld.listenedAt ASC
  `).all();

  if (listens.length === 0) {
    console.log('No listen dates found.');
    return;
  }

  // Backfill progress where NULL using song's maxProgress
  const nullProgress = listens.filter(l => l.progress === null);
  console.log(`Backfilling progress for ${nullProgress.length}/${listens.length} listens (using maxProgress as estimate)...`);
  const updateProgress = d.prepare('UPDATE listen_dates SET progress = ? WHERE id = ?');
  let progFixed = 0;
  for (const l of nullProgress) {
    const estimate = l.maxProgress || (0.8 + Math.random() * 0.19);
    updateProgress.run(Math.min(estimate, 1), l.id);
    progFixed++;
  }
  console.log(`  → ${progFixed} listens updated with estimated progress`);

  // Group into sessions by time gaps
  let sessions = [];
  let currentSession = null;

  for (let i = 0; i < listens.length; i++) {
    const l = listens[i];
    const time = new Date(l.listenedAt).getTime();

    if (!currentSession) {
      currentSession = {
        startTime: l.listenedAt,
        listens: [l],
      };
    } else {
      const lastTime = new Date(currentSession.listens[currentSession.listens.length - 1].listenedAt).getTime();
      const gapMin = (time - lastTime) / 60000;

      if (gapMin > GAP_MINUTES) {
        sessions.push(currentSession);
        currentSession = {
          startTime: l.listenedAt,
          listens: [l],
        };
      } else {
        currentSession.listens.push(l);
      }
    }
  }
  if (currentSession) sessions.push(currentSession);

  console.log(`\nDetected ${sessions.length} sessions from ${listens.length} listens`);

  // Save sessions to DB
  const insertSession = d.prepare(`
    INSERT OR REPLACE INTO sessions (id, startTime, endTime, songCount, energyStart, energyEnd, valenceStart, valenceEnd, genreSequence, avgCpuLoad, weather, contextSummary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateListenSession = d.prepare('UPDATE listen_dates SET sessionId = ? WHERE id = ?');

  let created = 0;
  let skipped = 0;

  for (const s of sessions) {
    if (s.listens.length < 2) {
      skipped++;
      continue;
    }

    const id = `session_backfill_${s.startTime.replace(/[^0-9]/g, '').slice(0, 14)}`;
    const endTime = s.listens[s.listens.length - 1].listenedAt;
    const songCount = s.listens.length;

    const firstSong = s.listens[0];
    const lastSong = s.listens[s.listens.length - 1];

    const genres = [...new Set(s.listens.map(l => l.genre).filter(Boolean))];
    const firstEnergy = firstSong.energy || null;
    const lastEnergy = lastSong.energy || null;
    const firstValence = firstSong.valence || null;
    const lastValence = lastSong.valence || null;

    const duration = Math.round((new Date(endTime) - new Date(s.startTime)) / 60000);
    let summary = `${songCount} canciones en ${duration} min`;
    if (genres.length > 0) summary += ` | ${genres.join(' → ')}`;
    if (firstEnergy != null && lastEnergy != null) {
      const delta = (lastEnergy - firstEnergy) * 100;
      summary += ` | energía ${delta > 0 ? '+' : ''}${Math.round(delta)}%`;
    }

    const weather = null;
    const avgCpuLoad = null;

    insertSession.run(
      id, s.startTime, endTime, songCount,
      firstEnergy, lastEnergy, firstValence, lastValence,
      JSON.stringify(genres), avgCpuLoad, weather, summary
    );

    for (const l of s.listens) {
      updateListenSession.run(id, l.id);
    }

    created++;
    console.log(`  [${id}] ${summary}`);
  }

  console.log(`\nDone: ${created} sessions created, ${skipped} single-listen gaps skipped.`);
}

backfill();
db.close();
