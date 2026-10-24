# VoiceBridge AI Pay — PayPal AI Hackathon 2026

A **sandbox-only** voice-first accessible payments prototype by Chumcred Limited. It extends the *idea* of the existing VoiceBridge AI financial-literacy application without modifying or redeploying that original product.

## Verified cloud and PayPal milestones (16 October 2026)

- **Railway:** independently hosted FastAPI sandbox backend at `https://voicebridge-pay-hackathon-production.up.railway.app/health`.
- **Vercel:** independently hosted frontend at `https://voicebridge-pay-hackathon-web.vercel.app/`; backend connection previously verified.
- **Stage 3A:** live authentication to the official PayPal sandbox API verified.
- **Stage 3B:** fixed USD 5.00 sandbox order creation verified.
- **Stage 3C:** actual sandbox buyer approval and completed capture verified for order `2E2603450P696001B`; capture `4EL59183RV2282800`. The repeat read-only status check also confirmed `COMPLETED`.

No real money has moved. Do not describe a sandbox capture as a live financial transaction.


## Current Demonstration Capabilities — October 2026

VoiceBridge AI Pay is an independently deployed,
sandbox-only payment accessibility prototype.

### PayPal Sandbox

- PayPal Sandbox API authentication verified.
- USD 5.00 sandbox order creation tested.
- Sandbox buyer approval and completed capture verified.
- Payment status can be checked independently.
- Payments require deliberate user actions.
- No real-money transactions are processed.

### Voice and AI Capabilities

- Experimental browser speech recognition with
  device-dependent language support.
- Restricted N-ATLAS Nigerian English transcription
  testing completed.
- Dedicated RunPod N-ATLAS ASR gateway implemented.
- Upstash Redis-based demonstration quota controls.
- Yoruba, Hausa and Igbo N-ATLAS transcription
  remain pending verification.
- Text-based fallback for accessibility.

### Privacy and Security

- Privacy Notice review draft published.
- Restricted demonstration access.
- Server-side management of provider credentials.
- Speech cannot authorize payment capture.
- Financial Intelligence Assistant remains disabled.
- Production payment integration remains unchanged.

### Project Links

Hosted demonstration:
https://voicebridgepay.chumcred.com

Privacy Notice:
https://voicebridgepay.chumcred.com/privacy-notice.html


**Important:** Browser-native speech recognition is **not** N-ATLAS ASR; browser locale support and recognition quality vary. Hosted official N-ATLAS four-language ASR, actual AI intent handling, production customer authentication, durable payment ledger, webhook reconciliation and robust rate limits are pending. Do not claim these features work yet.

## Deployment

See [Stage 3D configuration and test checklist](docs/STAGE3D_VOICE_CHECKOUT.md). Checkout **must remain disabled** until both Railway and Vercel are configured securely and the user explicitly enables sandbox demonstrations.

Earlier cloud details: [Stage 2 deployment](docs/DEPLOYMENT_STAGE2.md).

## Local tests

Python from `backend/`:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pytest -q
```

Frontend from `web/` with Node.js 22:

```powershell
node --check app.js
node --check checkout.js
node --check payment-result.js
node --check api/checkout.js
npm test
```

Automated tests use mocked PayPal interactions and do not move real or sandbox funds.

## Security boundaries

- All PayPal REST operations are hardcoded to `api-m.sandbox.paypal.com`.
- The browser never receives PayPal Client Secret, `DEMO_ACCESS_KEY`, `CHECKOUT_SERVICE_KEY` or `CHECKOUT_SESSION_SECRET`.
- Customer speech or AI output **never initiates or confirms payment**.
- Buyer approval on PayPal is distinct from our server-side capture.
- The existing VoiceBridge AI production website, repository and credentials are unchanged.
- Review Chumcred's source licence and third-party N-ATLAS, speech and PayPal terms before open-sourcing or reusing original components.

See [ROADMAP](docs/ROADMAP.md) for later releases.
