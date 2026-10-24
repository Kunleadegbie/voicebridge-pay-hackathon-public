"""Private developer-only PayPal sandbox buyer approval/capture verification.

This is NOT a consumer checkout session. Calls require the existing X-Demo-Key
protection in main.py, must remain sandbox-only, and only accept the fixed $5 demo.
Customer-bound sessions, durable order records, and webhooks are later milestones.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
from uuid import NAMESPACE_URL, uuid5

import httpx

from .paypal import DEMO_CATALOG, PayPalSandboxError, PayPalSandboxGateway, SANDBOX_BASE_URL

ORDER_ID_RE = re.compile(r"^[A-Z0-9]{8,36}$")
ITEM = DEMO_CATALOG["financial-literacy-demo"]


class InvalidDemoOrder(Exception):
    """Order does not match this fixed-value sandbox demonstration."""


class BuyerApprovalRequired(Exception):
    """The sandbox buyer has not approved this order."""


@dataclass(frozen=True)
class VerifiedOrder:
    order_id: str
    status: str
    currency: str
    amount: str
    capture_status: str | None = None
    capture_id: str | None = None

    def response(self) -> dict:
        return asdict(self)


def _verify_order_details(data: dict, expected_order_id: str) -> VerifiedOrder:
    if not isinstance(data, dict) or data.get("id") != expected_order_id or data.get("intent") != "CAPTURE":
        raise InvalidDemoOrder()
    units = data.get("purchase_units")
    if not isinstance(units, list) or len(units) != 1 or not isinstance(units[0], dict):
        raise InvalidDemoOrder()
    unit = units[0]
    amount = unit.get("amount")
    if not isinstance(amount, dict) or amount.get("currency_code") != ITEM["currency"]:
        raise InvalidDemoOrder()
    try:
        matches = Decimal(str(amount["value"])) == Decimal(ITEM["amount"])
    except (KeyError, InvalidOperation, TypeError, ValueError):
        raise InvalidDemoOrder() from None
    if not matches:
        raise InvalidDemoOrder()

    status = str(data.get("status", "UNKNOWN"))
    capture_id = capture_status = None
    payments = unit.get("payments", {})
    if not isinstance(payments, dict):
        raise InvalidDemoOrder()
    captures = payments.get("captures", [])
    if not isinstance(captures, list) or len(captures) > 1:
        raise InvalidDemoOrder()
    if captures:
        capture = captures[0]
        if not isinstance(capture, dict):
            raise InvalidDemoOrder()
        captured_amount = capture.get("amount", {})
        if not isinstance(captured_amount, dict) or captured_amount.get("currency_code") != ITEM["currency"]:
            raise InvalidDemoOrder()
        try:
            captured_matches = Decimal(str(captured_amount["value"])) == Decimal(ITEM["amount"])
        except (KeyError, InvalidOperation, TypeError, ValueError):
            raise InvalidDemoOrder() from None
        if not captured_matches:
            raise InvalidDemoOrder()
        capture_id = capture.get("id")
        capture_status = capture.get("status")
        if not isinstance(capture_id, str) or not isinstance(capture_status, str):
            raise InvalidDemoOrder()
    if status == "COMPLETED" and capture_status != "COMPLETED":
        raise InvalidDemoOrder()
    return VerifiedOrder(
        order_id=expected_order_id,
        status=status,
        currency=ITEM["currency"],
        amount=ITEM["amount"],
        capture_status=capture_status,
        capture_id=capture_id,
    )


class PayPalSandboxCheckout:
    def __init__(self, gateway: PayPalSandboxGateway) -> None:
        self.gateway = gateway

    async def _request(self, method: str, order_id: str, *, capture: bool = False) -> dict:
        if not ORDER_ID_RE.fullmatch(order_id):
            raise InvalidDemoOrder()
        token = await self.gateway.get_access_token()
        url = f"{SANDBOX_BASE_URL}/v2/checkout/orders/{order_id}"
        if capture:
            url += "/capture"
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if capture:
            # Stable idempotency value for retries of the same sandbox order.
            headers["PayPal-Request-Id"] = str(uuid5(NAMESPACE_URL, "voicebridge-demo-capture:" + order_id))
        try:
            async with httpx.AsyncClient(transport=self.gateway.transport, timeout=20.0) as client:
                response = await client.request(
                    method, url, headers=headers,
                    json={} if capture else None,
                )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise PayPalSandboxError("Invalid sandbox API response")
            return data
        except (httpx.HTTPError, ValueError) as exc:
            raise PayPalSandboxError("PayPal sandbox request failed") from exc

    async def get_verified_order(self, order_id: str) -> VerifiedOrder:
        data = await self._request("GET", order_id)
        return _verify_order_details(data, order_id)

    async def capture_approved_order(self, order_id: str) -> VerifiedOrder:
        before = await self.get_verified_order(order_id)
        if before.status == "COMPLETED" and before.capture_status == "COMPLETED":
            return before
        if before.status != "APPROVED":
            raise BuyerApprovalRequired()
        try:
            data = await self._request("POST", order_id, capture=True)
            after = _verify_order_details(data, order_id)
            if after.status == "COMPLETED" and after.capture_status == "COMPLETED":
                return after
        except (PayPalSandboxError, InvalidDemoOrder):
            # PayPal may have completed a capture even when its immediate
            # response fails, times out, or omits order details. Never issue a
            # second POST here: re-read PayPal's authoritative order instead.
            pass

        verified = await self.get_verified_order(order_id)
        if verified.status == "COMPLETED" and verified.capture_status == "COMPLETED":
            return verified
        raise PayPalSandboxError(
            "Sandbox capture outcome is uncertain; verify status before any retry"
        )
