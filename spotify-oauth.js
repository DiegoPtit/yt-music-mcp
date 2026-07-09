#!/usr/bin/env node
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CLIENT_ID = 'e7b7d49f4cfb4b4e8d387da1a70936dd';
const CLIENT_SECRET = '86565a8715ae4f49865ed22b329234eb';
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const CONFIG_DIR = path.join(process.env.HOME, '.config', 'yt-music-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'spotify.json');

function saveTokens(data) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  console.log('Tokens saved to', CONFIG_FILE);
}

function loadTokens() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {}
  return null;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error('Token exchange failed: ' + (await res.text()));
  return res.json();
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (error || !code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Auth failed: ${error || 'no code'}</h1>`);
          return;
        }
        try {
          const tokens = await exchangeCode(code);
          saveTokens({
            refresh_token: tokens.refresh_token,
            access_token: tokens.access_token,
            expires_at: Date.now() + tokens.expires_in * 1000,
          });
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>✅ Spotify connected! Close this tab.</h1>');
          console.log('✅ Spotify tokens saved!');
          server.close();
          resolve(true);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>Error: ${e.message}</h1>`);
        }
      }
    });
    server.listen(8888, '127.0.0.1', () => {
      console.log('Listening on http://127.0.0.1:8888/callback');
      const state = crypto.randomBytes(16).toString('hex');
      const scope = 'user-read-private user-read-email user-top-read user-read-currently-playing user-read-playback-state';
      const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        state,
        scope: 'user-read-private user-read-email',
      }).toString();
      console.log('\nOpen this URL in your browser:');
      console.log(authUrl);
      console.log('\nWaiting for authorization...');
      try { execSync(`xdg-open "${authUrl}" 2>/dev/null || open "${authUrl}" 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
    });
  });
}

const existing = loadTokens();
if (existing?.refresh_token) {
  console.log('Already have a refresh token. Delete', CONFIG_FILE, 'to re-authenticate.');
  process.exit(0);
}

startServer().catch(console.error);
