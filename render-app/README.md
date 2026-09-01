# Paratha Shawarma Lassi — Render deployment

This folder is a single Node/Express app that serves:
- the game (`public/index.html`)
- the staff admin panel to swap the payment QR each month (`public/admin.html`)
- the payment-gate API the game and your Android MCB listener talk to

## Deploy on Render

1. Push this folder to a GitHub repo (Render deploys from a repo, not a raw zip).
2. On Render: **New → Web Service** → connect that repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Instance type:** Free is fine to start.
4. Add environment variables (Render dashboard → Environment):
   - `ADMIN_PASSWORD` — password for `/admin.html`. **Change this from the code default.**
   - `WEBHOOK_SECRET` — long random string. Your Android automation must send this exact value in the `x-webhook-secret` header when it POSTs to `/api/mcb-webhook`.
5. Deploy. Your game will be live at the `.onrender.com` URL Render gives you (e.g. `https://paratha-shawarma-lassi.onrender.com`).
6. Point your Android listener's webhook action at `https://<your-app>.onrender.com/api/mcb-webhook`.

## Updating the QR every month

Go to `https://<your-app>.onrender.com/admin.html`, log in with `ADMIN_PASSWORD`, upload the new QR image and (optionally) set its expiry date. It goes live immediately — no redeploy needed.

## Important: ephemeral filesystem

Render's default disk is **ephemeral** — any file written while the app is running (like an uploaded QR) is wiped whenever the service redeploys or restarts (including automatic restarts after the free tier spins down from inactivity). That means:

- Whatever QR image is committed in `public/qr-current.jpg` (the one you gave me) is the fallback that comes back after every redeploy/restart.
- **Re-upload the current month's QR after any redeploy**, or better:
- Add a Render **persistent disk**: Render dashboard → your service → Disks → Add Disk, mount it at e.g. `/data`, then change `DATA_DIR`/`PUBLIC_DIR`-writing logic in `server.js` to write into that mounted path instead of the repo folder. This requires a paid Render plan (persistent disks aren't on the free tier).

For a once-a-month manual upload, just re-uploading after a redeploy is usually simpler than setting up a persistent disk — redeploys only happen when you push new code, not on every restart from inactivity (the committed QR survives inactivity restarts fine; it only resets on an actual new deploy).

## Local testing before you deploy

```
npm install
ADMIN_PASSWORD=test123 WEBHOOK_SECRET=test-secret node server.js
```

Then open `http://localhost:4000` for the game and `http://localhost:4000/admin.html` for the admin panel.

## Files

- `server.js` — Express app: static hosting + admin auth/upload + payment session API
- `public/index.html` — the game
- `public/admin.html` — staff QR-upload panel
- `public/qr-current.jpg` — the QR currently shown to players (replace via admin panel)
- `data/qr-meta.json` — stores the current QR's filename + expiry date
