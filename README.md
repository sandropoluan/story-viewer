# Instagram Story Viewer

REST API that marks Instagram stories as seen for a given user.

**Manual implementation** – no third-party Instagram libraries. Uses `www.instagram.com` directly. When Instagram changes endpoints, update `src/instagram-manual.ts`.

## Prerequisites

- Node.js 20+ (use `nvm use 20`)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure credentials**

   ```bash
   cp .env.example .env
   ```

   **Option A – Session** (from a prior successful login)

   1. Log in once with password – session is saved to `ig-session.json`.
   2. Future runs reuse it. Copy to another machine via `IG_SESSION` or `IG_SESSION_FILE`.
   3. Call `GET /session/export` to get the session after a successful login.

   **Option B – Username + password** (may be blocked by Instagram)

   Set `IG_USERNAME` and `IG_PASSWORD` in `.env`. If blocked, wait 24h and try again.

   **Option C – Browser cookies** (often rejected by mobile API)

   Set `IG_BROWSER_COOKIES` to JSON from instagram.com. Web cookies are frequently rejected by `i.instagram.com`.

3. **Run in development**

   ```bash
   npm run dev
   ```

4. **Build and run for production**

   ```bash
   npm run build
   npm start
   ```

## Deploy on Vercel (free plan)

1. **Push your code** to GitHub (or GitLab/Bitbucket).

2. **Import** the repo at [vercel.com/new](https://vercel.com/new).

3. **Set environment variable** in Vercel Project Settings → Environment Variables:
   - `IG_BROWSER_COOKIES` = your cookies JSON (or `IG_SESSION` = base64-encoded session from `GET /session/export`)

   > Paste the full JSON array from Cookie-Editor. It can be long (4–8 KB); Vercel supports it.

4. **Deploy** – Vercel runs `npm run build` and deploys.

**Limits on free plan:**

- 10 second timeout per request. Marking 1–5 stories is usually fine; large batches may timeout.
- Cookies must be in env vars (no local file). Re-export when cookies expire (~1–2 weeks).

**Endpoints after deploy:**

- `https://your-app.vercel.app/stories/seen?targetUsername=natgeo`
- `https://your-app.vercel.app/health`
- `https://your-app.vercel.app/session/export`

## API

### Mark stories as seen

```
GET /stories/seen?targetUsername=natgeo
```

**Response (200)**

```json
{
  "targetUsername": "natgeo",
  "storiesFound": 3,
  "markedAsSeen": 3,
  "items": [
    { "id": "123456", "takenAt": "2026-03-21T10:00:00.000Z", "mediaType": "photo" },
    { "id": "123457", "takenAt": "2026-03-21T11:00:00.000Z", "mediaType": "video" }
  ]
}
```

### Export session (for cookie/session-based auth)

```
GET /session/export
```

Returns the current session as JSON and base64. Use this to populate `IG_SESSION` or `IG_SESSION_FILE` so you can avoid repeated password logins.

### Health check

```
GET /health
```

## Disclaimer

This tool uses an unofficial Instagram API. Use responsibly and at your own risk.
