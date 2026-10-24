"""Sandbox-only PayPal REST client.

Never accepts a caller-supplied PayPal base URL or monetary amount.
No raw API credentials, bearer tokens, or PayPal error bodies are logged or returned.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import httpx

SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com"
DEMO_CATALOG = {
    "financial-literacy-demo": {"name": "Financial literacy demo", "currency": "USD", "amount": "5.00"}
}


# Explicit HTTPS checkout landing pages hosted by our Vercel frontend.
# A browser return does not establish buyer approval or payment capture.
CHECKOUT_RETURN_URL = "https://voicebridge-pay-hackathon-web.vercel.app/payment-return.html"
CHECKOUT_CANCEL_URL = "https://voicebridge-pay-hackathon-web.vercel.app/payment-cancelled.html"

# Only these exact, trusted HTTPS frontends may receive sandbox return links.
# No arbitrary callback URLs are accepted from an end user's browser.
ALLOWED_CHECKOUT_ORIGINS = frozenset({
    "https://voicebridge-pay-hackathon-web.vercel.app",
    "https://voicebridgepay.chumcred.com",
})



class PayPalSandboxError(Exception):
    """Raised when PayPal Sandbox cannot complete a request."""


@dataclass(frozen=True)
class DemoOrder:
    order_id: str
    status: str
    approve_url: str | None
    currency: str
    amount: str


class PayPalSandboxGateway:
    def __init__(
        self,
        client_id: str,
        client_secret: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not client_id or not client_secret:
            raise ValueError("PayPal sandbox credentials are not configured")
        self.client_id = client_id
        self.client_secret = client_secret
        self.transport = transport

    async def get_access_token(self) -> str:
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=20.0) as client:
                response = await client.post(
                    f"{SANDBOX_BASE_URL}/v1/oauth2/token",
                    auth=(self.client_id, self.client_secret),
                    data={"grant_type": "client_credentials"},
                    headers={"Accept": "application/json"},
                )
            response.raise_for_status()
            data = response.json()
            token = data.get("access_token")
            if not isinstance(token, str) or not token:
                raise PayPalSandboxError("PayPal sandbox returned no usable access token")
            return token
        except (httpx.HTTPError, ValueError) as exc:
            raise PayPalSandboxError("PayPal sandbox authentication failed") from exc

    async def create_demo_order(self, item_code: str, *, checkout_origin: str | None = None) -> DemoOrder:
        item = DEMO_CATALOG.get(item_code)
        if item is None:
            raise ValueError("Unknown demo item")
        if checkout_origin is not None and checkout_origin not in ALLOWED_CHECKOUT_ORIGINS:
            raise ValueError("Unapproved sandbox checkout origin")
        # Older, private PowerShell tests retain the historical Vercel default.
        return_url = f"{checkout_origin}/payment-return.html" if checkout_origin else CHECKOUT_RETURN_URL
        cancel_url = f"{checkout_origin}/payment-cancelled.html" if checkout_origin else CHECKOUT_CANCEL_URL
        token = await self.get_access_token()
        payload: dict[str, Any] = {
            "intent": "CAPTURE",
            # Fix sandbox checkout review-page loop for known-price orders:
            # PayPal needs a return URL; PAY_NOW omits the merchant review step.
            # Capture remains a separate, guarded operation after approval.
            "payment_source": {
                "paypal": {
                    "experience_context": {
                        "return_url": return_url,
                        "cancel_url": cancel_url,
                        "user_action": "PAY_NOW",
                        "shipping_preference": "NO_SHIPPING",
                    }
                }
            },
            "purchase_units": [
                {
                    "description": item["name"],
                    "amount": {"currency_code": item["currency"], "value": item["amount"]},
                }
            ],
        }
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=20.0) as client:
                response = await client.post(
                    f"{SANDBOX_BASE_URL}/v2/checkout/orders",
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                        "PayPal-Request-Id": str(uuid4()),
                    },
                )
            response.raise_for_status()
            data = response.json()
            order_id = data.get("id")
            if not isinstance(order_id, str) or not order_id:
                raise PayPalSandboxError("PayPal sandbox returned no order ID")
            approval_links = [
                link.get("href")
                for link in data.get("links", [])
                if isinstance(link, dict) and link.get("rel") in ("approve", "payer-action")
            ]
            approve_url = next((u for u in approval_links if isinstance(u, str) and u.startswith("https://www.sandbox.paypal.com/")), None)
            return DemoOrder(
                order_id=order_id,
                status=str(data.get("status", "UNKNOWN")),
                approve_url=approve_url,
                currency=item["currency"],
                amount=item["amount"],
            )
        except (httpx.HTTPError, ValueError) as exc:
            raise PayPalSandboxError("PayPal sandbox order creation failed") from exc
