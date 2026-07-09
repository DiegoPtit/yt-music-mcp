#!/usr/bin/env node
const db = require('./db');

const args = process.argv.slice(2);
const cmd = args[0];

function fmt(n) { return String(n).padStart(2, '0'); }
function shortDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${fmt(d.getMonth() + 1)}-${fmt(d.getDate())}`;
}
function shortTime(iso) {
  const d = new Date(iso);
  return `${fmt(d.getHours())}:${fmt(d.getMinutes())}`;
}
function fmtDuration(sec) {
  if (!sec) return '0:00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${fmt(s)}`;
}

switch (cmd) {
  case 'list':
  case 'ls': {
    const sortBy = args[1] === 'plays' ? 'playCount' : 'lastListened';
    let songs = db.getAllSongs();
    if (sortBy === 'playCount') songs.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
    else songs.sort((a, b) => new Date(b.lastListened) - new Date(a.lastListened));
    songs.forEach(s => {
      const like = s.likeState === 'LIKE' ? ' ♥' : s.likeState === 'DISLIKE' ? ' ⊘' : '';
      const genre = s.genre ? ` [${s.genre}]` : '';
      const bpm = s.bpm ? ` ${s.bpm}bpm` : '';
      console.log(`${s.title} - ${s.artist}${genre}${bpm}${like} (${s.playCount}x, last: ${shortDate(s.lastListened)})`);
    });
    break;
  }

  case 'date':
  case 'day': {
    const target = args[1] || shortDate(new Date().toISOString());
    const rows = db.getDb().prepare(`
      SELECT s.* FROM songs s
      JOIN listen_dates ld ON s.videoId = ld.videoId
      WHERE DATE(ld.listenedAt) = ?
      GROUP BY s.videoId ORDER BY MAX(ld.listenedAt) DESC
    `).all(target);
    console.log(`\nSongs listened on ${target}:`);
    rows.forEach(s => console.log(`  ${s.title} - ${s.artist} (${s.playCount}x)`));
    break;
  }

  case 'stats':
  case 'st': {
    const stats = db.getStats();
    const top = db.getTopSongs(10);
    console.log(`Total songs: ${stats.totalSongs}`);
    console.log(`Total listens (>60%): ${stats.totalPlays}`);
    console.log(`Total minutes: ${stats.totalMinutes}`);
    console.log(`Liked: ${stats.likedSongs}`);
    console.log(`Days with history: ${stats.daysActive}`);
    console.log(`Songs with BPM: ${stats.songsWithBpm}`);
    console.log(`\nTop 10:`);
    top.forEach((s, i) => {
      const b = s.bpm ? ` ${s.bpm}bpm` : '';
      console.log(`  ${i + 1}. ${s.title} - ${s.artist}${b} (${s.playCount}x)`);
    });
    break;
  }

  case 'export':
  case 'json': {
    const songs = db.getAllSongs();
    console.log(JSON.stringify({ songs, total: songs.length }, null, 2));
    break;
  }

  case 'genres':
  case 'g': {
    const byGenre = db.getTopGenres(50);
    byGenre.forEach(g => {
      console.log(`${g.genre}: ${g.songCount} songs, ${g.plays} plays`);
    });
    break;
  }

  case 'search':
  case 's': {
    const q = args.slice(1).join(' ');
    if (!q) { console.log('Usage: yt-history search <query>'); break; }
    const results = db.searchSongs(q);
    results.forEach(s => {
      const like = s.likeState === 'LIKE' ? ' ♥' : '';
      const bpm = s.bpm ? ` ${s.bpm}bpm` : '';
      console.log(`${s.title} - ${s.artist}${bpm}${like} (${s.playCount}x)`);
    });
    if (!results.length) console.log('No matches');
    break;
  }

  case 'top': {
    const n = parseInt(args[1]) || 10;
    const top = db.getTopSongs(n);
    top.forEach((s, i) => {
      const like = s.likeState === 'LIKE' ? ' ♥' : '';
      const genre = s.genre ? ` [${s.genre}]` : '';
      const bpm = s.bpm ? ` ${s.bpm}bpm` : '';
      console.log(`${i + 1}. ${s.title} - ${s.artist}${genre}${bpm}${like} (${s.playCount}x)`);
    });
    break;
  }

  case 'watch':
  case 'w': {
    let lastCount = db.getStats().totalSongs;
    console.log('Watching for new songs (Ctrl+C to stop)...');
    const poll = () => {
      try {
        const cur = db.getStats().totalSongs;
        if (cur > lastCount) {
          const songs = db.getAllSongs();
          const diff = songs.slice(0, cur - lastCount);
          diff.reverse().forEach(s => {
            const like = s.likeState === 'LIKE' ? ' ♥' : '';
            const genre = s.genre ? ` [${s.genre}]` : '';
            const bpm = s.bpm ? ` ${s.bpm}bpm` : '';
            console.log(`[${shortDate(s.lastListened)} ${shortTime(s.lastListened)}] ✓ ${s.title} - ${s.artist}${genre}${bpm}${like}`);
          });
          lastCount = cur;
        }
      } catch {}
      setTimeout(poll, 3000);
    };
    poll();
    break;
  }

  case 'bpm': {
    const target = args.slice(1).join(' ').toLowerCase();
    if (!target) {
      const top = db.getDb().prepare('SELECT title, artist, bpm, playCount FROM songs WHERE bpm IS NOT NULL ORDER BY playCount DESC LIMIT 20').all();
      top.forEach(s => console.log(`${s.title} - ${s.artist}: ${s.bpm}bpm (${s.playCount}x)`));
    } else {
      const results = db.searchSongs(target).filter(s => s.bpm);
      results.forEach(s => console.log(`${s.title} - ${s.artist}: ${s.bpm}bpm (${s.playCount}x)`));
      if (!results.length) console.log('No matches with BPM data');
    }
    break;
  }

  case 'obsessions':
  case 'obs': {
    const threshold = parseInt(args[1]) || 3;
    const days = parseInt(args[2]) || 3;
    const obs = db.getObsessions(threshold, days);
    console.log(`Obsessions (>=${threshold} plays in ${days} days):`);
    obs.forEach(s => console.log(`  ${s.title} - ${s.artist} (${s.recentPlays}x, ${s.genre || 'no genre'})`));
    if (!obs.length) console.log('  None found');
    break;
  }

  case 'revival':
  case 'rev': {
    const days = parseInt(args[1]) || 30;
    const songs = db.getSongsNotListenedSince(days);
    console.log(`Songs not listened in ${days}+ days (${songs.length} total):`);
    songs.slice(0, 10).forEach((s, i) => console.log(`  ${i + 1}. ${s.title} - ${s.artist} (${s.playCount}x, last: ${shortDate(s.lastListened)})`));
    break;
  }

  case 'heatmap': {
    const days = parseInt(args[1]) || 30;
    const data = db.getHeatmapData(days);
    const hourly = db.getHourlyDistribution();
    console.log(`Heatmap (last ${days} days):`);
    data.forEach(d => console.log(`  ${d.date}: ${'█'.repeat(Math.min(d.count, 20))} ${d.count} plays`));
    console.log(`\nHourly distribution:`);
    hourly.forEach(h => console.log(`  ${String(h.hour).padStart(2, '0')}:00 ${'█'.repeat(Math.min(h.count, 20))} ${h.count}`));
    break;
  }

  case 'help':
  default:
    console.log(`
Usage: yt-history <command> [args]

Commands:
  list|ls [plays]         List all songs (sorted by date or plays)
  date|day [YYYY-MM-DD]   Show songs for a specific date
  stats|st                Show listening statistics
  genres|g                Show genre breakdown
  top [n] [plays]         Show top N songs
  search|s <query>        Search songs by title/artist
  export|json             Export full history as JSON
  watch|w                 Watch for new songs in real-time
  bpm [query]             Show BPM data (optionally filter by search)
  obsessions|obs [n] [d]  Show obsessions (n plays in d days)
  revival|rev [days]      Show songs not listened in N+ days
  heatmap [days]          Show listening heatmap and hourly distribution
  help                    Show this help
`);
}

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
