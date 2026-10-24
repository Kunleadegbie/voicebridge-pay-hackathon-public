# VoiceBridge AI Pay — Stage 2 cloud deployment

The deployed application **does not depend on a laptop or local tunnel**. GitHub stores source, Railway hosts FastAPI and Vercel hosts the frontend and its server-side status check.

## Folder structure

- `backend/app/`: PayPal sandbox FastAPI implementation.
- `backend/tests/`: mocked unit and API tests.
- `backend/Dockerfile`, `backend/railway.json`: Railway build and service health check.
- `web/`: Vercel frontend, server-side status endpoint and tests.
- `docs/`: setup and deployment notes.

The Stage 2 branch is based on the Stage 1 branch. Merge the Stage 1 draft PR to main first, and then Stage 2 to main, after reviewing the code. Deploy from main once both are present.

## Railway — backend

1. Visit https://railway.com/new and deploy from your GitHub repository `Kunleadegbie/voicebridge-pay-hackathon`. Do not connect your existing `voicebridge-ai` application.
2. Under the new Railway service Settings, set **Root Directory** to `/backend`. Railway should detect the Dockerfile there. If Railway does not pick up the config file automatically, set **Config File** to `/backend/railway.json`.
3. In **Variables**, securely enter these three values:
   - `PAYPAL_CLIENT_ID` — Sandbox Client ID.
   - `PAYPAL_CLIENT_SECRET` — Sandbox Client Secret.
   - `DEMO_ACCESS_KEY` — a long, unpredictable key for private tests only.
4. Do not manually set `PORT`: Railway provides it.
5. Deploy the main branch after the reviewed PRs are merged. In Settings → Networking, select **Generate Domain**.
6. Open `https://YOUR-RAILWAY-DOMAIN/health`. Expected JSON is `{"status":"ok","mode":"sandbox","release":"stage-1"}`. This tests hosting, **not PayPal authentication**.

Keep developer test API keys and PayPal secrets **only on the server**. Never enter them into Vercel's frontend code, GitHub, a screenshot or a chat.

## Vercel — frontend

1. Visit https://vercel.com/new and import the **same** hackathon GitHub repository.
2. Set Root Directory to `web` and Framework Preset to **Other**; no custom build command is necessary.
3. Add `BACKEND_URL=https://YOUR-RAILWAY-DOMAIN` under Project Settings → Environment Variables. This URL is public and contains no credentials; the Vercel Function reads it server-side.
4. Deploy from main, open the resulting site, and select **Check cloud connection**.
5. If you add or change `BACKEND_URL` after an existing deployment, redeploy for the updated environment setting to take effect.

The website should report **Connected** if the Vercel Function can reach the Railway health endpoint. This does **not** mean that payment capture or voice AI is complete.

## Verify laptop independence

Once both services work, shut down your laptop and open the Vercel URL from your phone using mobile data. The site and its cloud check should still work, subject to cloud provider availability.

## Current boundaries

- Frontend: informational Stage 2 deployment preview and health check. No payment or voice commands yet.
- Backend: PayPal sandbox OAuth and controlled US$5 order creation for private testing, but no payment approval/capture yet.
- No managed database or hosted N-ATLAS processing has been configured in this stage.
- Review Railway/Vercel costs and hosting settings; no provider can guarantee uninterrupted uptime.
