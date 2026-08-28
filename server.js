/**
 * Mini Time Capsule Backend Demo
 * ------------------------------
 * Demonstrates the core mechanism from the founder memo:
 *   - Server-side gated delivery (the server's clock is the only clock that matters)
 *   - Long, random, unguessable capsule IDs (no sequential /1, /2, /3 guessing)
 *   - Content is NEVER sent to the browser until the server itself confirms unlock time has passed
 *
 * Attachments (photo, video, or document) are saved as real files in ./uploads,
 * not embedded as base64 in the JSON database - keeps the database small and fast
 * even as attachments get larger.
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
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB - a demo-safe ceiling, not a production limit

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

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
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    const LIMIT = MAX_UPLOAD_BYTES * 1.4; // headroom for base64 overhead + JSON wrapper

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMIT) {
        tooLarge = true;
        chunks = []; // stop holding data we're going to reject anyway
        return; // keep draining the stream so the connection can close cleanly
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Classify a MIME type into a simple category the frontend can render appropriately
function classifyMimeType(mimeType) {
  if (!mimeType) return 'document';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function extensionFromFileName(fileName) {
  const ext = path.extname(fileName || '');
  return ext || '';
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
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      if (e.message === 'PAYLOAD_TOO_LARGE') {
        return sendJSON(res, 413, { error: `Attachment too large. Keep test uploads under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` });
      }
      return sendJSON(res, 400, { error: 'Invalid request body' });
    }

    try {
      const { lockMessage, unlockMessage, unlockAt, attachment } = body;
      // attachment (optional) = { dataUrl: "data:<mime>;base64,<data>", fileName: "video.mp4" }

      if ((!unlockMessage && !attachment) || !unlockAt) {
        return sendJSON(res, 400, { error: 'unlockMessage (or an attachment) and unlockAt (ISO date string) are required' });
      }
      const unlockTimestamp = new Date(unlockAt).getTime();
      if (isNaN(unlockTimestamp)) {
        return sendJSON(res, 400, { error: 'unlockAt must be a valid date/time' });
      }

      const db = loadDB();
      const id = generateCapsuleId();

      let attachmentInfo = null;
      if (attachment && attachment.dataUrl) {
        const match = attachment.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          return sendJSON(res, 400, { error: 'Attachment was not a valid file upload' });
        }
        const mimeType = match[1];
        const base64Data = match[2];
        const buffer = Buffer.from(base64Data, 'base64');

        if (buffer.length > MAX_UPLOAD_BYTES) {
          return sendJSON(res, 413, { error: `Attachment too large. Keep test uploads under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` });
        }

        const ext = extensionFromFileName(attachment.fileName);
        const storedFileName = `${id}${ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, storedFileName), buffer);

        attachmentInfo = {
          storedFileName,
          originalFileName: attachment.fileName || storedFileName,
          mimeType,
          category: classifyMimeType(mimeType), // 'image' | 'video' | 'document'
        };
      }

      db[id] = {
        lockMessage: lockMessage || null, // shown BEFORE unlock, e.g. "Don't open until Christmas!"
        unlockMessage: unlockMessage || null, // shown AFTER unlock
        attachment: attachmentInfo, // metadata only - actual file lives in /uploads
        unlockAt: unlockTimestamp,
        createdAt: Date.now(),
        viewCount: 0,
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

    capsule.viewCount = (capsule.viewCount || 0) + 1;
    saveDB(db);

    const now = Date.now();
    const isUnlocked = now >= capsule.unlockAt;

    if (!isUnlocked) {
      // Locked: no attachment metadata, no file link, no content. Just the teaser and countdown.
      return sendJSON(res, 200, {
        locked: true,
        lockMessage: capsule.lockMessage || null,
        unlockAt: capsule.unlockAt,
        secondsRemaining: Math.max(0, Math.floor((capsule.unlockAt - now) / 1000)),
        viewCount: capsule.viewCount,
      });
    } else {
      return sendJSON(res, 200, {
        locked: false,
        unlockMessage: capsule.unlockMessage,
        attachment: capsule.attachment
          ? {
              category: capsule.attachment.category,
              originalFileName: capsule.attachment.originalFileName,
              mimeType: capsule.attachment.mimeType,
              fileUrl: `/api/capsules/${id}/file`,
            }
          : null,
        unlockAt: capsule.unlockAt,
        viewCount: capsule.viewCount,
      });
    }
  }

  // GET /api/capsules/:id/file -> serves the actual attachment, gated exactly like the content itself
  const fileMatch = pathname.match(/^\/api\/capsules\/([a-f0-9]+)\/file$/);
  if (req.method === 'GET' && fileMatch) {
    const id = fileMatch[1];
    const db = loadDB();
    const capsule = db[id];

    if (!capsule || !capsule.attachment) {
      res.writeHead(404);
      return res.end('Not found');
    }

    // Same server-side clock check as above - never trust anything from the request itself.
    const isUnlocked = Date.now() >= capsule.unlockAt;
    if (!isUnlocked) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Locked' }));
    }

    const filePath = path.join(UPLOADS_DIR, capsule.attachment.storedFileName);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': capsule.attachment.mimeType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${capsule.attachment.originalFileName}"`,
      });
      res.end(data);
    });
    return;
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
