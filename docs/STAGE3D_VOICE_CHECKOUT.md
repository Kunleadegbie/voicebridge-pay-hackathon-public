# Stage 3D-A — Secure voice-first sandbox checkout pilot

Stage 3C was completed in a private PowerShell test: PayPal Order
`2E2603450P696001B`, USD 5.00, `COMPLETED`, capture
`4EL59183RV2282800`. This is historical evidence from the test operator;
no financial secrets belong in the repository.

## What this development slice adds

- Browser-facing, accessible fixed-price USD 5.00 sandbox checkout preview.
- An **optional, experimental browser-native** speech-recognition input box,
  selecting en-NG / yo-NG / ha-NG / ig-NG when the user's browser supports it.
  This is **NOT** N-ATLAS, not a reliable four-language ASR integration, and not
  an AI action parser; language availability and quality are browser-dependent.
- An optional English device-generated spoken summary (not multilingual TTS).
- A text fallback and an explicit, independent user review checkbox. Speech
  transcripts never change the amount or authorize/capture payments.
- Server-side Vercel `/api/checkout` proxy storing a short-lived
  HMAC-signed order ID in an HttpOnly, Secure, SameSite=Lax browser cookie.
  No JavaScript or browser request has access to PayPal secrets, the demo key,
  the service key, or the cookie contents.
- Separate, **disabled-by-default** Railway endpoints authenticated with a new
  `CHECKOUT_SERVICE_KEY`. The earlier developer `DEMO_ACCESS_KEY` remains
  Railway-only and is never duplicated into Vercel.
- Return page checks PayPal's actual order status, then requires another user
  click for sandbox capture. PayPal's backend re-verifies fixed USD 5.00,
  approval, and completed capture; retries have a stable idempotency key.
- Return page strips PayPal callback URL query parameters from the visible
  address bar. It does not treat a redirect as evidence of approval.
- Keeps the original `Kunleadegbie/voicebridge-ai` repository and production
  service entirely unchanged.

## Deployment checklist (only after code review and green CI)

Configure **Railway** `voicebridge-pay-hackathon` environment:

- Existing: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DEMO_ACCESS_KEY`.
- Add a NEW independently generated 64-character hex `CHECKOUT_SERVICE_KEY`.
- Add `ENABLE_PUBLIC_DEMO_CHECKOUT=1` after reviewing all safeguards.
- Redeploy and verify `/health` still works.

Configure **Vercel** `voicebridge-pay-hackathon-web` project (server-side
environment variables; **not** public/client-prefixed):

- Existing `BACKEND_URL=https://voicebridge-pay-hackathon-production.up.railway.app`.
- Add the SAME `CHECKOUT_SERVICE_KEY` stored on Railway.
- Add another, **different**, independently generated 64-character hex
  `CHECKOUT_SESSION_SECRET` (Vercel only).
- Add `ENABLE_PUBLIC_DEMO_CHECKOUT=1`.
- Redeploy; verify the new `/api/checkout` function is active.

To generate each key using Windows PowerShell without copying it into chat:

    $bytes=New-Object byte[] 32
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    [BitConverter]::ToString($bytes).Replace('-','')

Generate TWO different keys. Treat them as secrets and do not paste either
into source, GitHub, an end-user page, ChatGPT or screenshots. Do not reuse
`DEMO_ACCESS_KEY`.

Important: Vercel's POST origin restriction accepts only the two reviewed,
literal production HTTPS origins:
- `https://voicebridge-pay-hackathon-web.vercel.app`
- `https://voicebridgepay.chumcred.com`

It also checks that the request's Origin hostname matches its Host header.
The Vercel server sends the validated origin to Railway, whose typed request
schema and PayPal gateway strictly allowlist the same two HTTPS origins.
PayPal redirects to the **same host where the checkout began**, so that
the host-only signed session cookie is available on the return page.
These cookies deliberately do not travel between the custom and Vercel
hosts. Starting on one and manually switching to the other during checkout
will not preserve the session. Unknown Vercel preview domains fail closed.

## User test (sandbox only)

1. Load the Vercel homepage; choose a language, optionally try the browser
   speech preview, and review the fixed USD 5.00 text.
2. Check the explicit confirmation box and press Continue to PayPal Sandbox.
3. Sign in with a **Personal sandbox buyer account** and an existing sandbox
   test Visa; never supply a real card.
4. Complete PayPal buyer approval and return to the Vercel return page.
5. Press **Verify PayPal approval**. Expect `APPROVED`.
6. Press **Confirm simulated US$5.00 capture**. Expect both status values to
   become `COMPLETED` and a sanitized capture ID to appear.
7. Repeat on a mobile browser. If the speech API is absent or lacks a locale,
   the text fallback must still work.

## Security and completeness limitations — not a public production payment app

- All payment requests are PayPal Sandbox only; no real money is moved.
- The browser order capability is signed and time-limited, but **not backed by
  an independently durable transaction ledger or server-held identity**.
- There is no per-user/customer login, durable order table, PayPal webhook
  reconciliation, multi-device order recovery, robust rate limiting or fraud
  monitoring. Cookies can expire while a buyer is away; private developer
  status/capture remains a separate recovery path.
- Public opening of this pilot may allow abusive sandbox order generation,
  even though it cannot create live transactions. Keep
  `ENABLE_PUBLIC_DEMO_CHECKOUT` off when not actively demonstrating, and add
  managed rate limits, persistent audit records and bounded session/order
  quotas before distributing it widely.
- Browser microphone input can use the browser provider's recognition service.
  Do not capture sensitive information; disclose this clearly to testers.
- **Genuine four-language N-ATLAS transcription, multilingual playback, and
  intent/dialogue understanding are NOT implemented in this slice.** The next
  substage is to integrate an independently secured N-ATLAS voice service
  with provider credentials, per-language quality checks, asynchronous queueing,
  mobile input/playback, and traceable provenance. Do not claim it exists yet.
- Original VoiceBridge AI source is Chumcred-copyrighted and third-party
  providers have their own model/service terms. We did not copy code or
  credentials from its existing deployment.
