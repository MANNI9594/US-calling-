# Deployment Guide

## Two very different environments — don't mix them up

| | Where | Who touches it | What's allowed |
|---|---|---|---|
| **Development/deployment environment** | Your own laptop (not the office PC), or Claude Code, or any machine with normal internet access | You | Terminal, Docker, npm, git — whatever's needed to build and deploy |
| **Office client** | The locked-down office PC | You, daily | **Browser only.** Nothing is installed there, ever. |

If you don't have access to a laptop/terminal at all right now, skip straight to **Part 0** below — it's a fully click-only path using only GitHub's and Railway's web dashboards. No terminal, anywhere, at any point.

---

## Part 0 — No-CLI deployment path (browser only, works from the office PC too for these one-time setup clicks)

This produces the exact same running application as Part 1/2 below — it just avoids ever opening a terminal, by pushing every command that would normally run locally (`npm install`, `prisma generate`, `prisma db push`) into Railway's build servers instead, which run automatically.

### Step 1 — Put the code on GitHub (no `git` command needed)

1. Go to https://github.com and create a free account if you don't have one.
2. Click **New repository** (the `+` icon, top right). Name it e.g. `us-calling-master-manager`. Set it to **Private**. Click **Create repository**.
3. On the new repo's page, click **uploading an existing file** (or "Add file" → "Upload files").
4. Unzip the project zip on whatever computer you're using right now, then **drag the entire `us-calling-master-manager` folder** into the browser upload area. Modern browsers (Chrome/Edge) preserve the folder structure automatically — you don't need to select files one by one.
5. Scroll down, add a commit message like "Initial upload", click **Commit changes**.

You now have the whole project on GitHub with no `git` command ever run.

### Step 2 — Create the database and the app on Railway (no CLI)

1. Go to https://railway.app, sign up (you can sign up directly with your GitHub account — one click).
2. Click **New Project** → **Deploy from GitHub repo** → select the repo you just created.
3. Railway will try to build the whole repo. Open the new service's **Settings** tab and set **Root Directory** to `backend` (this tells Railway the Dockerfile lives in the `backend` folder, not the repo root).
4. Back in the project, click **New** → **Database** → **Add PostgreSQL**. Railway provisions it automatically.
5. Click into your backend service → **Variables** tab → **New Variable** → and add each of the following (click the "Add Reference" option for `DATABASE_URL` so it links live to the Postgres service instead of copy-pasting a value):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Reference → select the Postgres service's `DATABASE_URL` |
   | `SESSION_SECRET` | `dd3650bdde1760a0641c524f7e775a2668165f253d6bc151400b74de3d76f2f6` *(a real random value, already generated for you — safe to use once; if you ever want a fresh one, ask Claude to generate another)* |
   | `COOKIE_SECURE` | `true` |
   | `CORS_ORIGIN` | (temporary placeholder until a frontend exists) `https://placeholder.example.com` |
   | `STORAGE_PROVIDER` | `local` |
   | `STORAGE_LOCAL_PATH` | `/app/storage` |
   | `NODE_ENV` | `production` |
   | `PORT` | `4000` |

6. Still in the service, go to **Settings** → **Volumes** → **New Volume**. Mount path: `/app/storage`. This is what makes evidence images and uploaded workbooks survive a redeploy (see the checklist below — this step matters).
7. Railway automatically builds and deploys on every commit. Watch the **Deployments** tab; when it shows a green "Success", it's live.
8. In **Settings** → **Networking**, click **Generate Domain**. This gives you a public HTTPS URL like `https://us-calling-master-manager-production.up.railway.app`.

### Step 3 — Create your login (a web page, not `curl`)

Open `https://<your-railway-domain>/setup.html` in your browser. Fill in an email and a password (10+ characters) and click **Create my account**. That's it — no terminal, no `curl`. This page only works once; if you ever need to change the password later, that flow will be added in Phase 11 (or ask Claude to add a password-reset endpoint sooner).

### Step 4 — Confirm it's alive

Open `https://<your-railway-domain>/api/health` in your browser. You should see `{"status":"ok","database":"connected",...}`.

### Step 5 — Import your Master workbook (Phase 3, browser only)

Open `https://<your-railway-domain>/import.html`. Drag your Master `.xlsx` file onto the page (or click to choose it), click **Preview Import** to see what will happen (vessel counts, clean vs. ambiguous image counts, any duplicates) without changing anything yet, then click **Confirm & Import** to actually commit it. The page shows the result and keeps an import history at the bottom.

If your session has expired, this page redirects you to `/login.html` automatically.

That's the entire deployment and first real usage, done from a browser. Redeploying after a code update is the same loop: re-upload the changed files to GitHub (or use GitHub's web editor for small edits), Railway redeploys automatically — still zero CLI.

**One tradeoff, stated plainly:** this path uses `prisma db push` (applies the schema directly) instead of tracked migration files. That's the right call for a solo tool with no CLI access — you lose a formal migration history, not any data safety. If you ever do get access to a terminal later and want migration history going forward, that's a small one-time switch, not a rebuild.

---

## Part 1 — Local development (on your own machine, if/when you have one)

Prerequisites: Docker Desktop (or Docker Engine) installed on *your* machine — not the office PC.

```bash
git clone <your-repo>
cd us-calling-master-manager

# 1. Start Postgres (and optionally Adminer at http://localhost:8080)
docker compose up -d db

# 2. Configure the backend
cd backend
cp .env.example .env
# edit .env: at minimum set SESSION_SECRET to `openssl rand -hex 32`

# 3. Install dependencies and generate the Prisma client
npm install
npx prisma generate

# 4. Create the database schema
npx prisma migrate dev --name init
# This is also the point to add the partial unique index documented in
# docs/DATABASE.md (IMO number uniqueness) as a follow-up migration:
#   npx prisma migrate dev --name imo_partial_unique --create-only
#   (then paste the CREATE UNIQUE INDEX ... WHERE ... SQL into the generated file)

# 5. Run the test suite (includes tests against the real reference workbook)
REAL_MASTER_WORKBOOK_PATH=/path/to/your/master.xlsx npm test

# 6. Start the API in dev mode (auto-reloads on change)
npm run dev
# API now listening on http://localhost:4000

# 7. Create your one user account (one-time; the endpoint refuses once a user exists)
curl -X POST http://localhost:4000/api/auth/setup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"choose-something-long"}'
# ...or just open http://localhost:4000/setup.html in a browser instead of curl.
```

The frontend (Phase 6+) will be a separate Vite dev server; its README section will be added when that phase lands.

---

## Part 2 — Production deployment, CLI version (if you do have terminal access and want migration history)

The app needs exactly three things in production, none of them tied to a specific vendor:

1. A place to run the Docker container (`backend/Dockerfile`) continuously.
2. A managed PostgreSQL database.
3. Persistent file storage — either a persistent disk/volume (if using local storage) or an S3-compatible bucket.

### Option A — Railway (straightforward, generous free tier)

1. Create a new Railway project → "Deploy from GitHub repo" → point at this repo, root directory `backend`.
2. Add a PostgreSQL plugin from Railway's marketplace — it auto-populates a `DATABASE_URL` variable your service can reference.
3. Set the remaining environment variables (see the table below) in the service's Variables tab.
4. **Storage:** either
   - attach a Railway Volume mounted at `/app/storage` and set `STORAGE_PROVIDER=local`, `STORAGE_LOCAL_PATH=/app/storage`; or
   - use S3-compatible storage (Cloudflare R2 has a free tier) and set `STORAGE_PROVIDER=s3` plus the `STORAGE_S3_*` variables — no volume needed, recommended.
5. Railway builds from the `Dockerfile` automatically and runs `CMD` (which applies the schema via `prisma db push`, then starts the server) on every deploy. If you'd rather use tracked migrations instead, change the Dockerfile's `CMD` back to `npx prisma migrate deploy && node dist/index.js` and generate migrations locally first with `npx prisma migrate dev --name init`.
6. Railway gives you an HTTPS URL (`*.up.railway.app`) or lets you attach a custom domain — either way, `COOKIE_SECURE=true`.

### Option B — Render

1. New "Web Service" → connect the repo, root directory `backend`, environment "Docker".
2. Add a Render "PostgreSQL" instance; copy its internal connection string into `DATABASE_URL`.
3. For storage: Render Disks work like Railway Volumes (mount at `/app/storage`, `STORAGE_PROVIDER=local`), or use S3-compatible storage as above.
4. Set environment variables as below. Render auto-provisions HTTPS.

### Option C — Any other Docker host (Fly.io, DigitalOcean App Platform, a VPS with Docker + Caddy/nginx, etc.)

The same `Dockerfile` and `docker-compose.yml` work anywhere Docker runs. The only per-provider differences are: how you provision managed Postgres, how you attach a persistent volume (or skip that by using S3-compatible storage instead), and how HTTPS termination is configured. None of that requires touching application code.

### Environment variables reference

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | From your managed Postgres provider |
| `SESSION_SECRET` | Yes | `openssl rand -hex 32` — keep it secret, rotate it and all sessions invalidate |
| `COOKIE_SECURE` | Yes | `true` in production (HTTPS only) |
| `CORS_ORIGIN` | Yes | The exact URL the frontend is served from |
| `STORAGE_PROVIDER` | Yes | `local` or `s3` |
| `STORAGE_LOCAL_PATH` | If `local` | Must point at a persistent volume, not ephemeral container disk |
| `STORAGE_S3_BUCKET` / `_REGION` / `_ENDPOINT` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | If `s3` | `_ENDPOINT` only needed for non-AWS providers (R2/MinIO/B2) |
| `MAX_UPLOAD_SIZE_MB` | No | Default 50 |

### Post-deploy checklist

- [ ] Visit `/api/health` — confirms the app booted and can reach the database.
- [ ] Run the one-time setup by opening `/setup.html` in a browser (see Part 0, Step 3), once, to create your login.
- [ ] Confirm cookies are being set with `Secure` (browser devtools → Application → Cookies) — if not, double check `COOKIE_SECURE=true` and that the host is actually serving HTTPS.
- [ ] If using local-disk storage: upload a test file, then trigger a redeploy, then confirm the file is still retrievable — this is the check that your volume is actually persistent and not ephemeral container storage.

---

## Backups

Covered in full once Phase 10 lands. In brief: `[ BACKUP DATA ]` will produce a single downloadable archive containing a `pg_dump` of the database plus every file in the storage provider, so the accumulated Vessel Database (which is more valuable than any single Excel export) is never dependent on the hosting provider alone.
