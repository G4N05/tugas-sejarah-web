// Static site server + Leaderboard API (shared/online for all users)
// Leaderboard data is stored server-side in .data/leaderboard.json
// so every visitor sees the same scores, no matter their browser/device.

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const HOST = '0.0.0.0';

const DATA_DIR = path.join(__dirname, '.data');
const DATA_FILE = path.join(DATA_DIR, 'leaderboard.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadLeaderboard() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveLeaderboard(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// In-memory copy, kept in sync with disk. Shape: { [absen]: { name, maxScore, updatedAt } }
let leaderboard = loadLeaderboard();

function getSortedLeaderboard() {
  return Object.keys(leaderboard)
    .map((absen) => ({
      absen: parseInt(absen, 10),
      name: leaderboard[absen].name,
      score: leaderboard[absen].maxScore,
    }))
    .sort((a, b) => b.score - a.score || a.absen - b.absen);
}

// --- Realtime updates (Server-Sent Events) ---
const sseClients = new Set();

function broadcastLeaderboard() {
  const payload = `data: ${JSON.stringify(getSortedLeaderboard())}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

app.use(express.json());

// Get the full leaderboard (used for initial load)
app.get('/api/leaderboard', (req, res) => {
  res.json(getSortedLeaderboard());
});

// Live leaderboard stream - browser keeps this connection open and
// receives a fresh leaderboard automatically whenever anyone's score changes.
app.get('/api/leaderboard/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(getSortedLeaderboard())}\n\n`);
  sseClients.add(res);

  // Keep the connection alive through proxies that may time out idle connections.
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// Get a single student's saved score (used to show "already completed" state)
app.get('/api/score/:absen', (req, res) => {
  const entry = leaderboard[req.params.absen];
  res.json(entry ? { absen: parseInt(req.params.absen, 10), name: entry.name, score: entry.maxScore } : null);
});

// Submit a score. Only updates if it's higher than the stored one.
app.post('/api/score', (req, res) => {
  const { absen, name, score } = req.body || {};
  if (absen === undefined || absen === null || typeof name !== 'string' || typeof score !== 'number') {
    return res.status(400).json({ error: 'absen, name, and score are required' });
  }
  const key = String(absen);
  const existing = leaderboard[key];
  let updated = false;

  if (!existing || score > existing.maxScore) {
    leaderboard[key] = { name, maxScore: score, updatedAt: Date.now() };
    saveLeaderboard(leaderboard);
    updated = true;
    broadcastLeaderboard();
  }

  res.json({ ok: true, updated, maxScore: leaderboard[key].maxScore });
});

// Reset a student's score (used by the "Reset Skor & Main Ulang" button)
app.delete('/api/score/:absen', (req, res) => {
  const key = req.params.absen;
  if (leaderboard[key]) {
    delete leaderboard[key];
    saveLeaderboard(leaderboard);
    broadcastLeaderboard();
  }
  res.json({ ok: true });
});

// Block direct access to the server-side data folder before it can be served.
app.use((req, res, next) => {
  if (req.path === '/.data' || req.path.startsWith('/.data/')) {
    return res.status(404).end();
  }
  next();
});

// Static site files. dotfiles: 'ignore' makes sure hidden files/folders
// (like .data, where the leaderboard is stored) are never served directly.
app.use(express.static(__dirname, { dotfiles: 'ignore' }));

// Any other route falls back to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
