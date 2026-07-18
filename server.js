/**
 * Mini Time Capsule Backend Demo
 * ------------------------------
 * Demonstrates the core mechanism from the founder memo:
 *   - Server-side gated delivery (the server's clock is the only clock that matters)
 *   - Long, random, unguessable capsule IDs (no sequential /1, /2, /3 guessing)
 *   - Content is NEVER sent to the browser until the server itself confirms unlock time has passed
 *
 * Deliberately zero dependencies (no npm install needed) so it runs anywhere with Node installed.
 * Run with:  node server.js
 * Then open: http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'capsules.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Tiny "database" (a JSON file on disk, loaded into memory) ---
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// --- Helpers ---
function generateCapsuleId() {
  // 16 random bytes -> 32 hex chars. Long and unguessable, unlike sequential IDs.
  return crypto.randomBytes(16).toString('hex');
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// --- Request handler ---
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // POST /api/capsules -> create a new capsule
  if (req.method === 'POST' && pathname === '/api/capsules') {
    try {
      const body = await readBody(req);
      const { message, unlockAt, photo } = body;

      if (!message || !unlockAt) {
        return sendJSON(res, 400, { error: 'message and unlockAt (ISO date string) are required' });
      }
      const unlockTimestamp = new Date(unlockAt).getTime();
      if (isNaN(unlockTimestamp)) {
        return sendJSON(res, 400, { error: 'unlockAt must be a valid date/time' });
      }

      const db = loadDB();
      const id = generateCapsuleId();
      db[id] = {
        message,
        photo: photo || null, // base64 data URL, optional
        unlockAt: unlockTimestamp,
        createdAt: Date.now(),
        viewCount: 0, // simple counter: how many times this capsule has been checked
      };
      saveDB(db);

      return sendJSON(res, 201, { id, viewUrl: `/capsule.html?id=${id}` });
    } catch (e) {
      return sendJSON(res, 400, { error: 'Invalid request body' });
    }
  }

  // GET /api/capsules/:id -> THE CORE MECHANISM
  // This is the server-side gate: the decision of "locked or not" is made here,
  // using the server's own clock (Date.now()), never anything the visitor's browser sends.
  const capsuleMatch = pathname.match(/^\/api\/capsules\/([a-f0-9]+)$/);
  if (req.method === 'GET' && capsuleMatch) {
    const id = capsuleMatch[1];
    const db = loadDB();
    const capsule = db[id];

    if (!capsule) {
      return sendJSON(res, 404, { error: 'Capsule not found' });
    }

    // Increment the view counter every time someone checks this capsule
    capsule.viewCount = (capsule.viewCount || 0) + 1;
    saveDB(db);

    const now = Date.now(); // <-- SERVER's clock. The visitor's device clock is never trusted or consulted.
    const isUnlocked = now >= capsule.unlockAt;

    if (!isUnlocked) {
      // Locked: content is NEVER included in this response. Only metadata needed for a countdown.
      return sendJSON(res, 200, {
        locked: true,
        unlockAt: capsule.unlockAt,
        secondsRemaining: Math.max(0, Math.floor((capsule.unlockAt - now) / 1000)),
        viewCount: capsule.viewCount,
      });
    } else {
      // Unlocked: now, and only now, does the content get sent.
      return sendJSON(res, 200, {
        locked: false,
        message: capsule.message,
        photo: capsule.photo || null,
        unlockAt: capsule.unlockAt,
        viewCount: capsule.viewCount,
      });
    }
  }

  // Everything else -> serve static demo frontend
  if (req.method === 'GET') {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\nTime capsule demo running at http://localhost:${PORT}`);
  console.log(`Create a capsule at http://localhost:${PORT}/ and open the generated link.\n`);
});
