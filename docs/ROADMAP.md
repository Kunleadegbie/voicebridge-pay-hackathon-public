# VoiceBridge AI Pay — Competition Plan

## Stage 1 — Secure sandbox foundation (this branch)
- Independent repository; original VoiceBridge AI production application remains untouched.
- Sandbox-only OAuth token exchange.
- Controlled test-order creation at a server-defined USD 5.00 amount.
- Secret-guarded diagnostics and API endpoints.
- Mocked API tests, without external requests or real payments.

## Stage 2 — PayPal checkout and settlement confirmation
- Approve an order using a PayPal sandbox buyer account.
- Bind an order ID to server-side session/transaction state.
- Verify order state and the exact server-side amount before capture.
- Add idempotent capture and order-status retrieval; handle cancellation/failure.
- Validate return URLs, CSRF protection and authorization.

## Stage 3 — Voice and AI features
- Reuse only approved/licensed VoiceBridge components.
- Provide en-NG, yo-NG, ha-NG, ig-NG language selection and examples.
- Recognize user intent and ask for missing fields.
- Never execute a payment from unverified speech or AI output.
- Explicitly confirm recipient, amount and currency by deliberate user action.
- Show and speak verified PayPal sandbox status.

## Stage 4 — Evidence and submission
- Test Windows, iPhone and iPad plus other supported devices.
- Document threats, limitations, model attribution and accessible fallbacks.
- Publish suitable open-source license after reviewing rights.
- Provide test URL, public repo and demonstration video under 3 minutes.

This prototype is sandbox-only. No live payments are planned.
