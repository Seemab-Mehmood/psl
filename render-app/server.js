/**
 * Paratha Shawarma Lassi — unified server.
 *
 * Serves:
 *  - the game itself (public/index.html)
 *  - the admin panel (public/admin.html) for uploading a fresh QR each month
 *  - the payment-gate API (create session / poll status / MCB webhook)
 *
 * Deploy this whole folder as a single Render Web Service:
 *   Build command: npm install
 *   Start command: node server.js
 *
 * Env vars to set on Render:
 *   ADMIN_PASSWORD   - password for the /admin.html panel (required, change from default!)
 *   WEBHOOK_SECRET   - shared secret your Android listener sends in x-webhook-secret
 *
 * IMPORTANT — Render's free/standard filesystem is ephemeral: a new deploy or
 * a restart wipes anything written at runtime, including an uploaded QR image.
 * That means whenever you push a new commit, or the service restarts after
 * being idle, the QR reverts to whatever's committed in public/qr-current.jpg
 * and data/qr-meta.json. Re-upload the QR after any redeploy, or (better)
 * add a Render persistent disk mounted at /data if you want uploads to
 * survive deploys — see the README in this zip for exact steps.
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
const SESSION_TTL_MS = 5 * 60 * 1000;
const EXPECTED_AMOUNT_STRINGS = ['100.00', '100', 'PKR 100', 'Rs. 100', 'Rs 100'];

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const META_PATH = path.join(DATA_DIR, 'qr-meta.json');
const ANALYTICS_PATH = path.join(DATA_DIR, 'analytics.json');
const PROMO_DAILY_LIMIT = 10;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(META_PATH)) {
  fs.writeFileSync(META_PATH, JSON.stringify({
    qrFile: 'qr-current.jpg',
    expiry: null,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}
if (!fs.existsSync(ANALYTICS_PATH)) {
  fs.writeFileSync(ANALYTICS_PATH, JSON.stringify({
    sessionsByDate: {},   // "YYYY-MM-DD" -> count of 2-min sessions played that day
    staffOverrides: [],   // [{ id, timestamp, reason, name?, refId?, receiptTimestamp?, note? }]
    promoByDate: {},      // "YYYY-MM-DD" -> number of free promo entries already handed out
  }, null, 2));
}

function readMeta(){
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); }
  catch(e){ return { qrFile: 'qr-current.jpg', expiry: null, updatedAt: null }; }
}
function writeMeta(meta){
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}
function readAnalytics(){
  try { return JSON.parse(fs.readFileSync(ANALYTICS_PATH, 'utf8')); }
  catch(e){ return { sessionsByDate: {}, staffOverrides: [], promoByDate: {} }; }
}
function writeAnalytics(a){
  fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(a, null, 2));
}
function todayKey(){
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, server clock
}

app.use(express.static(PUBLIC_DIR));

/* ---------------- Admin auth (simple in-memory token) ---------------- */
const validTokens = new Map(); // token -> expiresAt
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function makeToken(){
  const token = crypto.randomBytes(24).toString('hex');
  validTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}
function requireAdmin(req, res, next){
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const expiresAt = token && validTokens.get(token);
  if (!expiresAt || Date.now() > expiresAt){
    if (token) validTokens.delete(token);
    return res.status(401).json({ error: 'Not logged in or session expired.' });
  }
  next();
}
setInterval(()=>{
  const now = Date.now();
  for (const [t, exp] of validTokens.entries()) if (now > exp) validTokens.delete(t);
}, 60 * 1000);

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD){
    return res.json({ token: makeToken() });
  }
  res.status(401).json({ error: 'Incorrect password.' });
});

/* ---------------- QR info (public) + QR upload (admin only) ---------------- */
app.get('/api/qr-info', (req, res) => {
  const meta = readMeta();
  res.json({
    qrUrl: `/${meta.qrFile}?t=${Date.now()}`, // cache-bust so a new upload shows immediately
    expiry: meta.expiry,
    updatedAt: meta.updatedAt,
  });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)){
      return cb(new Error('Only PNG, JPG, or WEBP images are allowed.'));
    }
    cb(null, true);
  },
});

app.post('/api/admin/upload-qr', requireAdmin, upload.single('qrImage'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  const extByMime = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp' };
  const ext = extByMime[req.file.mimetype] || '.jpg';
  const filename = `qr-current${ext}`;

  // Remove any previously saved qr-current.* so we don't accumulate old formats
  for (const oldExt of ['.png', '.jpg', '.jpeg', '.webp']){
    const p = path.join(PUBLIC_DIR, `qr-current${oldExt}`);
    if (fs.existsSync(p) && p !== path.join(PUBLIC_DIR, filename)) fs.unlinkSync(p);
  }
  fs.writeFileSync(path.join(PUBLIC_DIR, filename), req.file.buffer);

  const expiry = (req.body && req.body.expiry) ? req.body.expiry : null;
  writeMeta({ qrFile: filename, expiry, updatedAt: new Date().toISOString() });

  res.json({ ok: true, qrUrl: `/${filename}?t=${Date.now()}`, expiry });
});

/* ---------------- Payment sessions ---------------- */
const sessions = new Map(); // ref -> { status, createdAt, name, normName }
const usedTxIds = new Set(); // Tx ID replay protection

function makeRefCode(){
  let ref;
  do { ref = String(Math.floor(1000 + Math.random() * 9000)); }
  while (sessions.has(ref));
  return ref;
}
function normalizeName(str){
  return String(str || '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, '')   // strip punctuation/digits
    .replace(/\s+/g, ' ')
    .trim();
}
function cleanupExpired(){
  const now = Date.now();
  for (const [ref, s] of sessions.entries()){
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(ref);
  }
}
setInterval(cleanupExpired, 30 * 1000);

app.post('/api/create-session', (req, res) => {
  const rawName = (req.body && req.body.name || '').toString().slice(0, 60);
  const normName = normalizeName(rawName);
  if (normName.length < 2){
    return res.status(400).json({ error: 'Please enter the name on your bank account.' });
  }
  const ref = makeRefCode();
  sessions.set(ref, { status: 'PENDING', createdAt: Date.now(), name: rawName, normName });
  res.json({ ref, expiresInMs: SESSION_TTL_MS });
});

app.get('/api/session-status/:ref', (req, res) => {
  const s = sessions.get(req.params.ref);
  if (!s) return res.status(404).json({ status: 'UNKNOWN' });
  if (s.status === 'PENDING' && Date.now() - s.createdAt > SESSION_TTL_MS) s.status = 'EXPIRED';
  res.json({ status: s.status });
});

app.post('/api/mcb-webhook', (req, res) => {
  const secret = req.get('x-webhook-secret');
  if (secret !== WEBHOOK_SECRET) return res.status(401).send('Unauthorized');

  const { notificationText } = req.body || {};
  if (!notificationText || typeof notificationText !== 'string'){
    return res.status(400).send('Missing notificationText');
  }

  const looksLikeCredit = /received|credit/i.test(notificationText);
  const amountMatches = EXPECTED_AMOUNT_STRINGS.some(a => notificationText.includes(a));
  if (!looksLikeCredit || !amountMatches){
    return res.status(400).send('Notification did not match a 100 PKR credit');
  }

  // Replay protection: MCB Live notifications include a Tx ID unique to
  // that transfer. If we've already processed this exact transaction
  // (e.g. MacroDroid firing twice on the same SMS), don't double-credit.
  const txMatch = notificationText.match(/Tx\s*ID[:\s]*([A-Za-z0-9]+)/i);
  const txId = txMatch ? txMatch[1] : null;
  if (txId && usedTxIds.has(txId)){
    return res.status(409).send(`Tx ID ${txId} already processed`);
  }

  // Primary match: sender name. MCB Live's "received from <NAME> <BANK> ..."
  // wording doesn't separate name from bank, so instead of trying to parse
  // the name out precisely, pull the whole "received from ... in your"
  // segment and check whether a pending session's name appears inside it.
  const segMatch = notificationText.match(/received from\s+(.+?)\s+in your\b/i);
  const searchText = normalizeName(segMatch ? segMatch[1] : notificationText);

  let matchRef = null, matchSession = null;
  for (const [ref, s] of sessions.entries()){
    if (s.status !== 'PENDING') continue;
    if (s.normName && searchText.includes(s.normName)){
      if (!matchSession || s.createdAt < matchSession.createdAt){
        matchRef = ref; matchSession = s;
      }
    }
  }

  if (!matchSession){
    return res.status(404).send('No pending session matched the sender name in this credit');
  }

  matchSession.status = 'PAID';
  if (txId) usedTxIds.add(txId);
  console.log(`[${new Date().toISOString()}] Session ${matchRef} marked PAID (name match: "${matchSession.name}", Tx ID: ${txId || 'n/a'}).`);
  res.status(200).send(`Session ${matchRef} unlocked (name match)`);
});

/* ---------------- Session + staff-override analytics ---------------- */

// Called by the game client the moment a 2-min session actually starts,
// so admin can see how many sessions ran each day.
app.post('/api/log-session', (req, res) => {
  const a = readAnalytics();
  const day = todayKey();
  a.sessionsByDate[day] = (a.sessionsByDate[day] || 0) + 1;
  writeAnalytics(a);
  res.json({ ok: true, today: a.sessionsByDate[day] });
});

// Public so the staff-override screen can show "X of 10 promo entries left
// today" live, before staff commits to that reason.
app.get('/api/promo-status', (req, res) => {
  const a = readAnalytics();
  const day = todayKey();
  const used = a.promoByDate[day] || 0;
  res.json({ date: day, used, limit: PROMO_DAILY_LIMIT, remaining: Math.max(0, PROMO_DAILY_LIMIT - used) });
});

// Every successful staff override must record WHY, so admin can cross-check
// later. Three reasons: a manually-verified receipt (name/ref/timestamp),
// a free promo entry (capped per day), or a free-text "other".
app.post('/api/log-staff-override', (req, res) => {
  const { reason, name, refId, ts, note } = req.body || {};
  const validReasons = ['receipt', 'promo', 'other'];
  if (!validReasons.includes(reason)) return res.status(400).json({ error: 'Invalid reason.' });

  const a = readAnalytics();
  const day = todayKey();

  if (reason === 'promo'){
    const used = a.promoByDate[day] || 0;
    if (used >= PROMO_DAILY_LIMIT){
      return res.status(409).json({ error: `All ${PROMO_DAILY_LIMIT} promo entries for today are already used.` });
    }
    a.promoByDate[day] = used + 1;
  }

  if (reason === 'receipt' && (!name || !refId)){
    return res.status(400).json({ error: 'Name and reference ID are required for a manual receipt.' });
  }

  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    timestamp: new Date().toISOString(),
    reason,
    name: reason === 'receipt' ? String(name || '').slice(0, 80) : undefined,
    refId: reason === 'receipt' ? String(refId || '').slice(0, 80) : undefined,
    receiptTimestamp: reason === 'receipt' ? String(ts || '').slice(0, 60) : undefined,
    note: reason === 'other' ? String(note || '').slice(0, 300) : undefined,
  };
  a.staffOverrides.unshift(entry);
  a.staffOverrides = a.staffOverrides.slice(0, 500); // cap history so the file doesn't grow forever
  writeAnalytics(a);
  res.json({ ok: true, entry, promoRemaining: reason === 'promo' ? (PROMO_DAILY_LIMIT - a.promoByDate[day]) : undefined });
});

/* ---------------- Admin: stats + full staff-override log ---------------- */
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const a = readAnalytics();
  const day = todayKey();
  res.json({
    sessionsByDate: a.sessionsByDate,
    todaySessions: a.sessionsByDate[day] || 0,
    promo: { date: day, used: a.promoByDate[day] || 0, limit: PROMO_DAILY_LIMIT },
    overridesToday: a.staffOverrides.filter(o => o.timestamp.slice(0, 10) === day).length,
    overridesTotal: a.staffOverrides.length,
  });
});
app.get('/api/admin/staff-overrides', requireAdmin, (req, res) => {
  const a = readAnalytics();
  res.json({ overrides: a.staffOverrides });
});

/* ---------------- Fallback to the game for any unmatched route ---------------- */
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Paratha Shawarma Lassi running on port ${PORT}`);
  if (ADMIN_PASSWORD === 'changeme123') console.log('⚠️  ADMIN_PASSWORD is still the default — set it in Render env vars.');
  if (WEBHOOK_SECRET === 'CHANGE_ME_TO_A_LONG_RANDOM_STRING') console.log('⚠️  WEBHOOK_SECRET is still the default — set it in Render env vars.');
});
