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
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB per attachment - a demo-safe ceiling, not a production limit
const MAX_ATTACHMENTS = 6; // per capsule, for demo sanity
const MAX_TOTAL_REQUEST_BYTES = 100 * 1024 * 1024; // overall request ceiling, since several attachments can add up

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Last line of defense: log and keep running instead of crashing the whole server
// on an error that somehow escapes the per-request try/catch below.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server kept running):', err);
});

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
    const LIMIT = MAX_TOTAL_REQUEST_BYTES * 1.4; // headroom for base64 overhead + JSON wrapper

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
  try {
    await handleRequest(req, res);
  } catch (e) {
    // Safety net: without this, ANY unexpected error in a single request
    // (a malformed URL, a bot probing the server, anything) crashes the
    // entire process and takes the whole demo down for everyone.
    console.error('Unhandled request error:', e);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: 'Internal server error' });
    } else {
      res.end();
    }
  }
});

async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // POST /api/capsules -> create a new capsule
  if (req.method === 'POST' && pathname === '/api/capsules') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      if (e.message === 'PAYLOAD_TOO_LARGE') {
        return sendJSON(res, 413, { error: `Attachments too large in total. Keep combined uploads under ${MAX_TOTAL_REQUEST_BYTES / (1024 * 1024)}MB.` });
      }
      return sendJSON(res, 400, { error: 'Invalid request body' });
    }

    try {
      const { lockMessage, unlockMessage, unlockAt, attachments } = body;
      // attachments (optional) = [{ dataUrl: "data:<mime>;base64,<data>", fileName: "video.mp4" }, ...]

      const attachmentList = Array.isArray(attachments) ? attachments : [];

      if ((!unlockMessage && attachmentList.length === 0) || !unlockAt) {
        return sendJSON(res, 400, { error: 'unlockMessage (or at least one attachment) and unlockAt (ISO date string) are required' });
      }
      if (attachmentList.length > MAX_ATTACHMENTS) {
        return sendJSON(res, 400, { error: `Too many attachments. Keep it to ${MAX_ATTACHMENTS} or fewer per capsule.` });
      }
      const unlockTimestamp = new Date(unlockAt).getTime();
      if (isNaN(unlockTimestamp)) {
        return sendJSON(res, 400, { error: 'unlockAt must be a valid date/time' });
      }

      const db = loadDB();
      const id = generateCapsuleId();

      const savedAttachments = [];
      for (let i = 0; i < attachmentList.length; i++) {
        const item = attachmentList[i];
        if (!item || !item.dataUrl) continue;

        const match = item.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          return sendJSON(res, 400, { error: `Attachment ${i + 1} was not a valid file upload` });
        }
        const mimeType = match[1];
        const base64Data = match[2];
        const buffer = Buffer.from(base64Data, 'base64');

        if (buffer.length > MAX_UPLOAD_BYTES) {
          return sendJSON(res, 413, { error: `Attachment ${i + 1} is too large. Keep each file under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` });
        }

        const ext = extensionFromFileName(item.fileName);
        const storedFileName = `${id}-${i}${ext}`; // -i keeps filenames unique within a capsule
        fs.writeFileSync(path.join(UPLOADS_DIR, storedFileName), buffer);

        savedAttachments.push({
          storedFileName,
          originalFileName: item.fileName || storedFileName,
          mimeType,
          category: classifyMimeType(mimeType), // 'image' | 'video' | 'document'
        });
      }

      db[id] = {
        lockMessage: lockMessage || null, // shown BEFORE unlock, e.g. "Don't open until Christmas!"
        unlockMessage: unlockMessage || null, // shown AFTER unlock
        attachments: savedAttachments, // metadata only - actual files live in /uploads
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
        attachments: (capsule.attachments || []).map((att, i) => ({
          category: att.category,
          originalFileName: att.originalFileName,
          mimeType: att.mimeType,
          fileUrl: `/api/capsules/${id}/file/${i}`,
        })),
        unlockAt: capsule.unlockAt,
        viewCount: capsule.viewCount,
      });
    }
  }

  // GET /api/capsules/:id/file/:index -> serves one attachment, gated exactly like the content itself
  const fileMatch = pathname.match(/^\/api\/capsules\/([a-f0-9]+)\/file\/(\d+)$/);
  if (req.method === 'GET' && fileMatch) {
    const id = fileMatch[1];
    const index = parseInt(fileMatch[2], 10);
    const db = loadDB();
    const capsule = db[id];
    const attachment = capsule && capsule.attachments && capsule.attachments[index];

    if (!attachment) {
      res.writeHead(404);
      return res.end('Not found');
    }

    // Same server-side clock check as above - never trust anything from the request itself.
    const isUnlocked = Date.now() >= capsule.unlockAt;
    if (!isUnlocked) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Locked' }));
    }

    const filePath = path.join(UPLOADS_DIR, attachment.storedFileName);
    fs.stat(filePath, (statErr, stats) => {
      if (statErr) {
        res.writeHead(404);
        return res.end('Not found');
      }

      const mimeType = attachment.mimeType || 'application/octet-stream';
      const disposition = `inline; filename="${attachment.originalFileName}"`;
      const range = req.headers.range;

      if (range) {
        // Mobile Safari requires range request support to play video/audio at all,
        // not just for scrubbing - without this, playback silently fails.
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stats.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
          'Content-Disposition': disposition,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stats.size,
          'Accept-Ranges': 'bytes',
          'Content-Type': mimeType,
          'Content-Disposition': disposition,
        });
        fs.createReadStream(filePath).pipe(res);
      }
    });
    return;
  }

  // Everything else -> serve static demo frontend
  if (req.method === 'GET') {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(404);
  res.end('Not found');
}

server.listen(PORT, () => {
  console.log(`\nTime capsule demo running at http://localhost:${PORT}`);
  console.log(`Create a capsule at http://localhost:${PORT}/ and open the generated link.\n`);
});
