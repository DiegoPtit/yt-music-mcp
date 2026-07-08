#!/usr/bin/env node
const HISTORY_FILE = `${process.env.HOME}/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/listening-history.json`;
const fs = require('fs');

const args = process.argv.slice(2);
const cmd = args[0];

function load() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {}
  return { songs: [], byDate: {} };
}

const h = load();

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
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${fmt(s)}`;
}

switch (cmd) {
  case 'list':
  case 'ls': {
    const sortBy = args[1] === 'plays' ? 'playCount' : 'lastListened';
    const sorted = [...h.songs].sort((a, b) => {
      if (sortBy === 'playCount') return (b.playCount || 0) - (a.playCount || 0);
      return new Date(b.lastListened) - new Date(a.lastListened);
    });
    sorted.forEach(s => {
      const like = s.likeState === 'LIKE' ? ' ♥' : s.likeState === 'DISLIKE' ? ' ⊘' : '';
      const genre = s.genre ? ` [${s.genre}]` : '';
      console.log(`${s.title} - ${s.artist}${genre}${like} (${s.playCount}x, last: ${shortDate(s.lastListened)})`);
    });
    break;
  }

  case 'date':
  case 'day': {
    const target = args[1] || shortDate(new Date().toISOString());
    const ids = h.byDate[target] || [];
    console.log(`\nSongs listened on ${target}:`);
    ids.forEach(id => {
      const s = h.songs.find(x => x.videoId === id);
      if (s) console.log(`  ${s.title} - ${s.artist} (${s.playCount}x)`);
    });
    break;
  }

  case 'stats':
  case 'st': {
    const total = h.songs.length;
    const totalPlays = h.songs.reduce((a, s) => a + (s.playCount || 0), 0);
    const liked = h.songs.filter(s => s.likeState === 'LIKE').length;
    const top = [...h.songs].sort((a, b) => (b.playCount || 0) - (a.playCount || 0)).slice(0, 10);
    console.log(`Total songs: ${total}`);
    console.log(`Total listens (>60%): ${totalPlays}`);
    console.log(`Liked: ${liked}`);
    console.log(`Days with history: ${Object.keys(h.byDate).length}`);
    console.log(`\nTop 10:`);
    top.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.title} - ${s.artist} (${s.playCount}x)`);
    });
    break;
  }

  case 'export':
  case 'json': {
    console.log(JSON.stringify(h, null, 2));
    break;
  }

  case 'genres':
  case 'g': {
    const byGenre = {};
    h.songs.forEach(s => {
      const g = s.genre || 'Unknown';
      if (!byGenre[g]) byGenre[g] = { count: 0, plays: 0, songs: [] };
      byGenre[g].count++;
      byGenre[g].plays += s.playCount || 0;
      byGenre[g].songs.push(s.title);
    });
    Object.entries(byGenre)
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([g, data]) => {
        console.log(`${g}: ${data.count} songs, ${data.plays} plays`);
      });
    break;
  }

  case 'search':
  case 's': {
    const q = args.slice(1).join(' ').toLowerCase();
    if (!q) { console.log('Usage: yt-history search <query>'); break; }
    const results = h.songs.filter(s =>
      s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
    );
    results.forEach(s => {
      const like = s.likeState === 'LIKE' ? ' ♥' : '';
      console.log(`${s.title} - ${s.artist}${like} (${s.playCount}x)`);
    });
    if (!results.length) console.log('No matches');
    break;
  }

  case 'top': {
    const n = parseInt(args[1]) || 10;
    const by = args[2] || 'plays';
    const sorted = [...h.songs].sort((a, b) => (b.playCount || 0) - (a.playCount || 0)).slice(0, n);
    sorted.forEach((s, i) => {
      const like = s.likeState === 'LIKE' ? ' ♥' : '';
      const genre = s.genre ? ` [${s.genre}]` : '';
      console.log(`${i + 1}. ${s.title} - ${s.artist}${genre}${like} (${s.playCount}x)`);
    });
    break;
  }

  case 'watch':
  case 'w': {
    console.log('Watching for new songs (Ctrl+C to stop)...');
    const poll = () => {
      try {
        const cur = load();
        if (cur.songs.length > h.songs.length) {
          const diff = cur.songs.slice(h.songs.length);
          diff.forEach(s => {
            const like = s.likeState === 'LIKE' ? ' ♥' : '';
            const genre = s.genre ? ` [${s.genre}]` : '';
            console.log(`[${shortDate(s.lastListened)} ${shortTime(s.lastListened)}] ✓ ${s.title} - ${s.artist}${genre}${like}`);
          });
          h.songs = cur.songs;
        }
      } catch {}
      setTimeout(poll, 3000);
    };
    poll();
    break;
  }

  case 'help':
  default:
    console.log(`
Usage: yt-history <command> [args]

Commands:
  list|ls [plays]    List all songs (sorted by date or plays)
  date|day [YYYY-MM-DD]  Show songs for a specific date
  stats|st           Show listening statistics
  genres|g           Show genre breakdown
  top [n] [plays]    Show top N songs
  search|s <query>   Search songs by title/artist
  export|json        Export full history as JSON
  watch|w            Watch for new songs in real-time
  help               Show this help
`);
}
