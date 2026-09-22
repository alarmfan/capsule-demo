/**
 * Mini Time Capsule Backend Demo
 * ------------------------------
 * Demonstrates the core mechanism from the founder memo:
 *   - Server-side gated delivery (the server's clock is the only clock that matters)
 *   - Long, random, unguessable capsule IDs (no sequential /1, /2, /3 guessing)
 *   - Content is NEVER sent to the browser until the server itself confirms unlock time has passed
 *
 * Multi-contributor model:
 *   - A capsule holds an ordered list of "contributions" - each one is a message
 *     plus optional attachments from one contributor.
 *   - The CONTRIBUTE link lets anyone add a new contribution before unlock. That
 *     page never reads or displays existing contributions - it only accepts new
 *     ones - so contributors can only see their own content, never each other's.
 *   - The VIEW link (for whoever opens the vault after unlock) shows everything
 *     from everyone, combined, only after the server-side unlock check passes.
 *
 * Attachments are saved as real files in ./uploads, not embedded as base64 in
 * the JSON database - keeps the database small and fast even as they get larger.
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
const CODES_FILE = path.join(__dirname, 'codes.json');
const UIDS_FILE = path.join(__dirname, 'uids.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB per attachment - a demo-safe ceiling, not a production limit
const MAX_ATTACHMENTS_PER_CONTRIBUTION = 6;
const MAX_CONTRIBUTIONS = 20; // per capsule, for demo sanity
const MAX_TOTAL_REQUEST_BYTES = 100 * 1024 * 1024; // overall request ceiling, since several attachments can add up
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-only-change-me'; // set a real ADMIN_KEY env var on Render before sharing this
const MAX_CODE_ATTEMPTS = 8; // failed code guesses allowed per visitor within the window
const CODE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

if (ADMIN_KEY === 'dev-only-change-me') {
  console.warn('WARNING: ADMIN_KEY is not set - using an insecure default. Set a real ADMIN_KEY environment variable before sharing this deployment.');
}

// TEMPORARY: seed a couple of easy-to-type numeric codes for testing, since real
// codes will eventually come from generate-codes.js once you're printing real labels.
// Delete this block (and the resulting codes.json) once you switch to real codes.
if (!fs.existsSync(CODES_FILE)) {
  const seedCodes = {
    '12345678': { status: 'unclaimed', capsuleId: null, claimedAt: null, createdAt: Date.now() },
    '23456789': { status: 'unclaimed', capsuleId: null, claimedAt: null, createdAt: Date.now() },
  };
  fs.writeFileSync(CODES_FILE, JSON.stringify(seedCodes, null, 2));
  console.log('Seeded codes.json with test codes: 12345678, 23456789');
}

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

// --- Activation codes: one code per physical unit, printed under a scratch-off panel ---
function loadCodes() {
  if (!fs.existsSync(CODES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveCodes(codes) {
  fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2));
}

// --- NFC tag UID -> vault linking ---
// A tag's UID gets linked to a vault the moment that vault is created (via a
// valid activation code). Every subsequent tap of that same physical tag then
// goes straight to the vault - no code entry needed again.
function loadUids() {
  if (!fs.existsSync(UIDS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(UIDS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveUids(uids) {
  fs.writeFileSync(UIDS_FILE, JSON.stringify(uids, null, 2));
}
function normalizeUid(uid) {
  return (uid || '').trim().toUpperCase();
}

// Excludes visually ambiguous characters (0/O, 1/I/L) since these get hand-typed off a small printed label.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateActivationCode() {
  let code = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`; // e.g. AB3XY-92KLM
}

function normalizeCode(code) {
  return (code || '').trim().toUpperCase();
}

// Simple in-memory rate limiter for code-guessing attempts. Resets on server restart,
// which is an acceptable tradeoff for a demo - the goal is blunting scripted guessing,
// not airtight protection.
const codeAttempts = new Map(); // key -> { count, windowStart }
function getClientKey(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}
function isRateLimited(key) {
  const entry = codeAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > CODE_ATTEMPT_WINDOW_MS) {
    codeAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_CODE_ATTEMPTS;
}
function recordFailedAttempt(key) {
  const entry = codeAttempts.get(key);
  if (!entry || Date.now() - entry.windowStart > CODE_ATTEMPT_WINDOW_MS) {
    codeAttempts.set(key, { count: 1, windowStart: Date.now() });
  } else {
    entry.count++;
  }
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

// Saves one contribution's attachments to disk, returns their metadata.
// Throws { statusCode, error } on validation failure so callers can respond cleanly.
function saveAttachments(attachmentList, capsuleId, contributionIndex) {
  if (attachmentList.length > MAX_ATTACHMENTS_PER_CONTRIBUTION) {
    throw { statusCode: 400, error: `Too many attachments. Keep it to ${MAX_ATTACHMENTS_PER_CONTRIBUTION} or fewer per contribution.` };
  }
  const saved = [];
  for (let i = 0; i < attachmentList.length; i++) {
    const item = attachmentList[i];
    if (!item || !item.dataUrl) continue;

    const match = item.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw { statusCode: 400, error: `Attachment ${i + 1} was not a valid file upload` };
    }
    const mimeType = match[1];
    const buffer = Buffer.from(match[2], 'base64');

    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw { statusCode: 413, error: `Attachment ${i + 1} is too large. Keep each file under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` };
    }

    const ext = extensionFromFileName(item.fileName);
    const storedFileName = `${capsuleId}-c${contributionIndex}-${i}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, storedFileName), buffer);

    saved.push({
      storedFileName,
      originalFileName: item.fileName || storedFileName,
      mimeType,
      category: classifyMimeType(mimeType),
    });
  }
  return saved;
}

// Flattens all contributions' attachments into one ordered list, so the file
// endpoint can address any attachment in the capsule with a single flat index.
function flattenAttachments(capsule) {
  const flat = [];
  (capsule.contributions || []).forEach((contribution) => {
    (contribution.attachments || []).forEach((att) => flat.push(att));
  });
  return flat;
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

  // GET /api/uid/:uid -> checks whether this specific physical tag already has
  // a vault linked to it. This is what lets a tap skip straight to the vault
  // on every visit after the first, with no code entry.
  const uidMatch = pathname.match(/^\/api\/uid\/([^/]+)$/);
  if (req.method === 'GET' && uidMatch) {
    const uid = normalizeUid(decodeURIComponent(uidMatch[1]));
    const uids = loadUids();
    const entry = uids[uid];

    if (!entry) {
      return sendJSON(res, 200, { linked: false });
    }
    return sendJSON(res, 200, { linked: true, viewUrl: `/capsule.html?id=${entry.capsuleId}` });
  }

  // POST /api/codes/validate -> quick check before showing the rest of the setup form.
  // Does NOT claim the code - claiming only happens at actual vault creation, so a
  // code isn't burned just because someone checked it without finishing setup.
  if (req.method === 'POST' && pathname === '/api/codes/validate') {
    const clientKey = getClientKey(req);
    if (isRateLimited(clientKey)) {
      return sendJSON(res, 429, { valid: false, error: 'Too many attempts. Please wait a while and try again.' });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJSON(res, 400, { valid: false, error: 'Invalid request' });
    }

    const code = normalizeCode(body.code);
    const codes = loadCodes();
    const entry = codes[code];

    if (!entry || entry.status !== 'unclaimed') {
      recordFailedAttempt(clientKey);
      return sendJSON(res, 200, { valid: false, error: 'That code is invalid or has already been used.' });
    }

    return sendJSON(res, 200, { valid: true });
  }

  // POST /api/admin/codes/reset -> frees a code back to unclaimed, for support cases
  // (a code was used by someone other than the real buyer, a label was damaged, etc).
  // Protected by a shared key set via the ADMIN_KEY environment variable - not a full
  // login system, but enough that a stranger can't reset codes at will.
  if (req.method === 'POST' && pathname === '/api/admin/codes/reset') {
    const providedKey = req.headers['x-admin-key'];
    if (!providedKey || providedKey !== ADMIN_KEY) {
      return sendJSON(res, 401, { error: 'Invalid or missing admin key.' });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJSON(res, 400, { error: 'Invalid request body' });
    }

    const code = normalizeCode(body.code);
    const codes = loadCodes();
    const entry = codes[code];
    if (!entry) {
      return sendJSON(res, 404, { error: 'No such code.' });
    }

    const previousCapsuleId = entry.capsuleId || null;
    entry.status = 'unclaimed';
    entry.capsuleId = null;
    entry.claimedAt = null;
    saveCodes(codes);

    return sendJSON(res, 200, {
      reset: true,
      code,
      previouslyLinkedCapsuleId: previousCapsuleId, // the old vault still exists but is now orphaned from this code
    });
  }

  // POST /api/capsules -> create a new capsule with its first contribution
  if (req.method === 'POST' && pathname === '/api/capsules') {
    const clientKey = getClientKey(req);
    if (isRateLimited(clientKey)) {
      return sendJSON(res, 429, { error: 'Too many attempts. Please wait a while and try again.' });
    }

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
      const { code, uid, lockMessage, unlockAt, contributorName, message, attachments } = body;

      // Re-check the code here too, even though the frontend already called /validate -
      // never trust that a client-side step actually happened before this request arrived.
      const normalizedCode = normalizeCode(code);
      const codes = loadCodes();
      const codeEntry = codes[normalizedCode];
      if (!codeEntry || codeEntry.status !== 'unclaimed') {
        recordFailedAttempt(clientKey);
        return sendJSON(res, 403, { error: 'That activation code is invalid or has already been used.' });
      }

      // If a tag UID was passed along, make sure it isn't already linked to a
      // different vault before we go any further - defense in depth, since the
      // frontend should already have checked this via GET /api/uid/:uid first.
      const normalizedUid = uid ? normalizeUid(uid) : null;
      const uids = loadUids();
      if (normalizedUid && uids[normalizedUid]) {
        return sendJSON(res, 409, { error: 'This product is already linked to a vault.' });
      }

      const attachmentList = Array.isArray(attachments) ? attachments : [];

      if ((!message && attachmentList.length === 0) || !unlockAt) {
        return sendJSON(res, 400, { error: 'message (or at least one attachment) and unlockAt (ISO date string) are required' });
      }
      const unlockTimestamp = new Date(unlockAt).getTime();
      if (isNaN(unlockTimestamp)) {
        return sendJSON(res, 400, { error: 'unlockAt must be a valid date/time' });
      }

      const db = loadDB();
      const id = generateCapsuleId();

      let savedAttachments;
      try {
        savedAttachments = saveAttachments(attachmentList, id, 0);
      } catch (err) {
        return sendJSON(res, err.statusCode || 400, { error: err.error || 'Invalid attachment' });
      }

      db[id] = {
        lockMessage: lockMessage || null, // shown BEFORE unlock, e.g. "Don't open until Christmas!"
        unlockAt: unlockTimestamp,
        createdAt: Date.now(),
        viewCount: 0,
        activationCode: normalizedCode, // kept for support/audit trail
        contributions: [
          {
            contributorName: contributorName || null,
            message: message || null,
            attachments: savedAttachments,
            submittedAt: Date.now(),
          },
        ],
      };
      saveDB(db);

      // Claim the code only now that the capsule was actually created successfully.
      codeEntry.status = 'claimed';
      codeEntry.capsuleId = id;
      codeEntry.claimedAt = Date.now();
      saveCodes(codes);

      // Link the tag's UID to this vault, if one was provided, so every future
      // tap of this exact physical tag goes straight to the vault.
      if (normalizedUid) {
        uids[normalizedUid] = { capsuleId: id, linkedAt: Date.now() };
        saveUids(uids);
      }

      return sendJSON(res, 201, {
        id,
        viewUrl: `/capsule.html?id=${id}`,
        contributeUrl: `/contribute.html?id=${id}`,
      });
    } catch (e) {
      return sendJSON(res, 400, { error: 'Invalid request body' });
    }
  }

  // POST /api/capsules/:id/contribute -> add another contribution before unlock.
  // Deliberately does NOT return or reveal any existing contribution - this
  // endpoint only ever accepts new content, it never shows what's already inside.
  const contributeMatch = pathname.match(/^\/api\/capsules\/([a-f0-9]+)\/contribute$/);
  if (req.method === 'POST' && contributeMatch) {
    const id = contributeMatch[1];
    const db = loadDB();
    const capsule = db[id];

    if (!capsule) {
      return sendJSON(res, 404, { error: 'Capsule not found' });
    }
    if (Date.now() >= capsule.unlockAt) {
      return sendJSON(res, 403, { error: 'This vault has already unlocked - no more contributions can be added.' });
    }
    if ((capsule.contributions || []).length >= MAX_CONTRIBUTIONS) {
      return sendJSON(res, 400, { error: `This vault already has the maximum of ${MAX_CONTRIBUTIONS} contributions.` });
    }

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
      const { contributorName, message, attachments } = body;
      const attachmentList = Array.isArray(attachments) ? attachments : [];

      if (!message && attachmentList.length === 0) {
        return sendJSON(res, 400, { error: 'A message or at least one attachment is required' });
      }

      const contributionIndex = capsule.contributions.length;
      let savedAttachments;
      try {
        savedAttachments = saveAttachments(attachmentList, id, contributionIndex);
      } catch (err) {
        return sendJSON(res, err.statusCode || 400, { error: err.error || 'Invalid attachment' });
      }

      capsule.contributions.push({
        contributorName: contributorName || null,
        message: message || null,
        attachments: savedAttachments,
        submittedAt: Date.now(),
      });
      saveDB(db);

      return sendJSON(res, 201, { added: true });
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
      // Locked: no contribution content leaves the server at all. Just the teaser and countdown.
      return sendJSON(res, 200, {
        locked: true,
        lockMessage: capsule.lockMessage || null,
        unlockAt: capsule.unlockAt,
        secondsRemaining: Math.max(0, Math.floor((capsule.unlockAt - now) / 1000)),
        viewCount: capsule.viewCount,
      });
    } else {
      const flatAttachments = flattenAttachments(capsule);
      let flatCursor = 0;
      const contributions = (capsule.contributions || []).map((c) => {
        const attachmentsOut = (c.attachments || []).map(() => {
          const flatIndex = flatCursor;
          flatCursor++;
          const att = flatAttachments[flatIndex];
          return {
            category: att.category,
            originalFileName: att.originalFileName,
            mimeType: att.mimeType,
            fileUrl: `/api/capsules/${id}/file/${flatIndex}`,
          };
        });
        return {
          contributorName: c.contributorName || null,
          message: c.message || null,
          attachments: attachmentsOut,
        };
      });

      return sendJSON(res, 200, {
        locked: false,
        contributions,
        unlockAt: capsule.unlockAt,
        viewCount: capsule.viewCount,
      });
    }
  }

  // GET /api/capsules/:id/file/:index -> serves one attachment (flat index across
  // all contributions), gated exactly like the content itself
  const fileMatch = pathname.match(/^\/api\/capsules\/([a-f0-9]+)\/file\/(\d+)$/);
  if (req.method === 'GET' && fileMatch) {
    const id = fileMatch[1];
    const index = parseInt(fileMatch[2], 10);
    const db = loadDB();
    const capsule = db[id];

    if (!capsule) {
      res.writeHead(404);
      return res.end('Not found');
    }

    // Same server-side clock check as above - never trust anything from the request itself.
    const isUnlocked = Date.now() >= capsule.unlockAt;
    if (!isUnlocked) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Locked' }));
    }

    const flatAttachments = flattenAttachments(capsule);
    const attachment = flatAttachments[index];
    if (!attachment) {
      res.writeHead(404);
      return res.end('Not found');
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
