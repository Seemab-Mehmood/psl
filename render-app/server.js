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

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(META_PATH)) {
  fs.writeFileSync(META_PATH, JSON.stringify({
    qrFile: 'qr-current.jpg',
    expiry: null,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function readMeta(){
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); }
  catch(e){ return { qrFile: 'qr-current.jpg', expiry: null, updatedAt: null }; }
}
function writeMeta(meta){
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
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
const sessions = new Map(); // ref -> { status, createdAt }

function makeRefCode(){
  let ref;
  do { ref = String(Math.floor(1000 + Math.random() * 9000)); }
  while (sessions.has(ref));
  return ref;
}
function cleanupExpired(){
  const now = Date.now();
  for (const [ref, s] of sessions.entries()){
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(ref);
  }
}
setInterval(cleanupExpired, 30 * 1000);

app.post('/api/create-session', (req, res) => {
  const ref = makeRefCode();
  sessions.set(ref, { status: 'PENDING', createdAt: Date.now() });
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

  const refMatch = notificationText.match(/\b\d{4}\b/);
  if (!refMatch) return res.status(400).send('No 4-digit ref code found in notification text');

  const ref = refMatch[0];
  const session = sessions.get(ref);
  if (!session) return res.status(404).send(`No pending session for ref ${ref}`);
  if (session.status !== 'PENDING') return res.status(409).send(`Session ${ref} already ${session.status}`);

  session.status = 'PAID';
  console.log(`[${new Date().toISOString()}] Session ${ref} marked PAID.`);
  res.status(200).send(`Session ${ref} unlocked`);
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
