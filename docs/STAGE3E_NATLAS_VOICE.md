# Stage 3E-A — Dedicated N-ATLAS speech-to-text lab

**Status:** Code prepared in an isolated VoiceBridge AI Pay feature branch.
**Not live:** Real N-ATLAS transcription requires an independently configured
RunPod Serverless ASR endpoint, credentials and explicit operator enablement.
Do not claim voice transcription, AI decision assistance, or TTS is working
until a four-language end-to-end test verifies the provider.

## Why it is isolated

The original VoiceBridge AI is a separate product, with its own running
N-ATLAS inference endpoints, voice quota and availability. This Stage 3E
adapter **does not contact** voicebridge.chumcred.com, import its services,
change its GitHub repository or reuse its private credentials. The four
official NCAIR1 ASR model IDs were mapped from Chumcred's original source;
the original service implementation was not copied into this product.

The browser sends a short mono 16-kHz PCM16 WAV recording only after
explicit microphone and privacy actions. Vercel checks origin, per-demo
passcode and consent and then calls Railway with a distinct service key.
Railway calls a dedicated RunPod ASR endpoint and returns an opaque job
reference. A short-lived signed, host-only HttpOnly cookie binds status
polling to that one job. The browser only receives sanitized N-ATLAS text
and model provenance on verified completion.

N-ATLAS transcripts **must never** change payment amounts or trigger
order creation, buyer approval or capture. PayPal remains a completely
separate and deliberately controlled flow.

## Required settings (keep feature OFF until explicitly approved)

Create dedicated RunPod ASR worker from Chumcred-approved source using
the official NCAIR1 models. Verify the terms, model access and deployment
expenses independently; it might be necessary to configure HF model
authorization. **Avoid pointing this demo at the existing live VoiceBridge
ASR service** without explicitly deciding to share capacity and cost.

Configure Railway production environment:
- \`NATLAS_ASR_RUNPOD_ENDPOINT\` = https://api.runpod.ai/v2/YOUR_ENDPOINT_ID
- \`NATLAS_ASR_RUNPOD_KEY\` = dedicated private RunPod API key (never expose)
- \`VOICE_SERVICE_KEY\` = new independent random 64-character value
- \`ENABLE_NATLAS_VOICE\` = \`1\` **only** for supervised paid-provider testing

Configure Vercel production environment (server side, no NEXT_PUBLIC_/VITE_):
- \`VOICE_SERVICE_KEY\` = same key as Railway, entirely separate from
  \`CHECKOUT_SERVICE_KEY\`
- \`VOICE_DEMO_PASSCODE\` = an independent, difficult-to-guess test passcode,
  minimum 12 characters, provided privately to authorized testers
- \`CHECKOUT_SESSION_SECRET\` = the existing Vercel-only session signing key;
  voice signatures are domain-separated from checkout signatures
- \`BACKEND_URL\` = unchanged dedicated Railway backend URL (must match
  exact canonical hostname in source)
- \`ENABLE_NATLAS_VOICE\` = \`1\` **only** after Railway provider is ready

Redeploy both services when changing production variables.

Do not paste, screenshot, email or commit private keys. Do not enable the
voice pilot before confirming RunPod billing and capacity. Vercel and Railway
must use the same \`VOICE_SERVICE_KEY\`. Use a NEW key, not the PayPal demo key.

## Four-language speech recognition contract

| Language | Model ID |
| --- | --- |
| Nigerian English \`en-NG\` | \`NCAIR1/NigerianAccentedEnglish\` |
| Yoruba \`yo-NG\` | \`NCAIR1/Yoruba-ASR\` |
| Hausa \`ha-NG\` | \`NCAIR1/Hausa-ASR\` |
| Igbo \`ig-NG\` | \`NCAIR1/Igbo-ASR\` |

RunPod worker contract (matches original Chumcred worker design):
- \`POST {endpoint}/run\` with \`{"input":{"audio_base64":"...","language":"en-NG"}}\`.
  A successful queued response must contain a valid \`id\`.
- \`GET {endpoint}/status/{id}\`. Process
  \`IN_QUEUE\`, \`IN_PROGRESS\`, \`RUNNING\`, \`COMPLETED\`, \`FAILED\`,
  \`CANCELLED\`, \`TIMED_OUT\`.
- On \`COMPLETED\`, the output must contain \`text\`, the **exact official model
  ID** for the selected language, valid \`duration_ms\` and matching language
  when reported. Otherwise the gateway refuses to label it N-ATLAS.

File rules: 16 kHz, mono, uncompressed PCM 16-bit WAV only, 0.4–30 seconds,
and no more than about 1.05 MB WAV. The browser locally records up to
25 seconds, converts to WAV and validates the encoding before submission.

## Example guarded test

1. Confirm both Railway and Vercel are deployed and the feature is enabled
   only for a controlled session.
2. Open \`https://voicebridgepay.chumcred.com/\` and find
   **Stage 3E-A — Restricted N-ATLAS Speech Lab**.
3. Select a language, enter the private demo passcode, tap
   **Start short recording**, say a nonsensitive sample and press
   **Stop recording**.
4. Review and check the separate privacy-consent checkbox.
5. Press **Transcribe using N-ATLAS** once. The client must **never**
   submit PayPal orders or auto-trigger capture on a voice result.
6. Wait or press **Check transcription status**. Confirm the returned text,
   exact model ID and selected language.
7. Test all four languages, then separately Windows, iPhone and iPad.
   iOS microphone gain/noise handling requires dedicated field validation.
8. Switch \`ENABLE_NATLAS_VOICE=0\` on both hosts when finished testing.

## Known pilot limitations

- This is a **transcription lab**, not a speech-based payment command agent.
- Before the reviewed quota upgrade is deliberately configured and deployed,
  the live pilot still uses a **12 new jobs per backend process** counter.
  The proposed persistent quota is described in the upgrade section below.
- Test-only access passcode, not full user login.
- No voice-driven financial advice, LLM classification, translated
  confirmation or production TTS.
- Audio is processed through dedicated Vercel/Railway and a third-party
  RunPod provider upon explicit user consent. Do not record sensitive data.
- A browser may suspend async polling during long RunPod cold starts.
  The user can manually check with the signed cookie within 12 minutes.
- Do not generalize the original prototype's test counts to this new app.



## Stage 3E-A quota upgrade (review branch; not activated)

This extension replaces the unsafe 12-jobs-per-process limit with **atomic,
shared, persistent** reservations using a *new dedicated* Upstash Redis REST
database. The original VoiceBridge AI and PayPal sandbox checkout are not
changed. The existing RunPod worker, HF token and checkout secrets are not
moved or modified.

**Deployment gate:** Do not merge or redeploy before the quota database is
created and its credentials are stored privately in Railway. Without a
configured and reachable quota store, **new voice submissions fail closed**
with HTTP 503. Existing voice-job status lookups continue to work. Nothing
auto-creates a database or incurs Redis/RunPod costs just by merging source.

### Set up a separate Redis database for VoiceBridge AI Pay

1. Create or use a dedicated Upstash Redis database for the **hackathon app
   only**. Review provider availability, data-handling terms and pricing first.
2. In Railway, **VoiceBridge-Pay-Hackathon → voicebridge-pay-hackathon →
   Variables**, add these as private production environment variables:
   - `VOICE_QUOTA_REDIS_REST_URL`: exact Upstash Redis HTTPS REST URL
     (`https://YOUR-DATABASE.upstash.io`).
   - `VOICE_QUOTA_REDIS_REST_TOKEN`: the database's private REST token
     (not its read-only token).
   - `VOICE_DEMO_DAILY_LIMIT=12` (default; valid range 1–30).
   - `VOICE_DEMO_TOTAL_LIMIT=48` (default; valid range 1–120).
3. Do **not** put the Redis token in Vercel, web code, GitHub commits, URLs
   visible to users, or screenshots. Keep existing `VOICE_SERVICE_KEY`
   unchanged on both services.
4. Once GitHub CI checks pass and all variables are configured, a carefully
   supervised deployment can be considered. Do not change the original
   VoiceBridge AI Railway project or the RunPod endpoint.
5. Open the restricted speech lab, enter the same private demo passcode and
   click **Check demo capacity**. It is read-only: no microphone audio,
   RunPod work or payment action is initiated.
6. Verify the displayed remaining daily and overall counts; make just one
   low-risk supervised N-ATLAS test, then check the updated remaining count.
   Check PayPal sandbox independently afterward to confirm isolation.

### Counter behaviour and safety

- Shared across Railway instances and **survives process and deploy restarts**.
  A single Redis Lua `EVAL` transaction checks and increments both counters
  atomically; it never allows a request beyond either limit.
- The daily count resets at **00:00 UTC** (01:00 West Africa Time). The
  *separate lifetime counter* does **not** reset automatically. Both limits
  are shared across all passcode holders, not per-user.
- A submission reserves a slot **before** calling RunPod. If the provider
  fails or its response is uncertain, that slot is intentionally not refunded,
  preventing ambiguous retries from exceeding the allowed usage.
- Audio recordings, transcripts, API keys and passcodes are **not saved**
  in the Redis quota records. Only aggregate counter keys are stored.
- A missing or unavailable database, invalid configuration, invalid Redis
  response or denied request causes a safe failure. Never retry a failed
  submission automatically.
- The quota limits the **number of submitted jobs**, not the exact GPU spend.
  Continue monitoring RunPod charges and maintain 0 active workers / 1 maximum
  worker unless the operator deliberately decides otherwise.
- The *new* Redis database starts with zero counters. Prior process-local
  submissions are **not migrated**; track previously incurred provider
  usage separately. Do not claim the new lifetime total includes past work.
- This is a restricted pilot quota, **not** production user authentication,
  an individual per-account limit, or a finished financial transaction ledger.

### Release verification

Run `pytest -q` in `backend/`, and `npm test` in `web/`.
Automated tests use mocked Redis, RunPod and PayPal services; they cannot
confirm deployed Upstash credentials. Before enabling more test submissions,
verify backend 429 on exhaustion, 503 on Redis failure, client read-only
capacity reporting, expiry at UTC midnight, and no changes to PayPal
checkout flows.

## Next sub-stages

**3E-B:** Controlled multilingual financial-literacy understanding and
explainable speech intents, read-only as to financial operations; no LLM can
approve payments. Require provenance labels.

**3E-C:** Nigerian-language TTS, separate playback initiation with mobile
Safari controls, text fallbacks and audio usage quotas.

**3E-D:** Four-language quality/latency evaluation on real consenting users,
mobile tests, adverse-noise tests and failure-state recovery.

**After 3E:** persistent checkout/audit ledger, webhook verification,
stronger rate limits, fraud controls and explicit production readiness gate.
