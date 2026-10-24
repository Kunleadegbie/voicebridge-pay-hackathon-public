import asyncio
from urllib.parse import urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from app.checkout import BuyerApprovalRequired, InvalidDemoOrder, PayPalSandboxCheckout
from app.main import app, sandbox_gateway
from app.paypal import PayPalSandboxGateway

ORDER_ID = "0RJ0235509873561P"


def order(status="APPROVED", amount="5.00", capture=None):
    unit = {"amount": {"currency_code": "USD", "value": amount}}
    if capture is not None:
        unit["payments"] = {"captures": [capture]}
    return {"id": ORDER_ID, "intent": "CAPTURE", "status": status, "purchase_units": [unit]}


CAPTURE = {
    "id": "CAPTURE-DEMO-00001",
    "status": "COMPLETED",
    "amount": {"currency_code": "USD", "value": "5.00"},
}


def gateway_for(states, logs):
    def handler(req: httpx.Request):
        if req.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "mock-token"})
        logs.append({"method": req.method, "path": req.url.path, "headers": req.headers})
        if req.method == "GET":
            return httpx.Response(200, json=states["get"])
        if req.method == "POST":
            return httpx.Response(201, json=states["post"])
        return httpx.Response(405)
    return PayPalSandboxGateway("fake-id", "fake-secret", transport=httpx.MockTransport(handler))


def test_only_sandbox_hosts_and_preapproval_is_blocked():
    events = []
    client = PayPalSandboxCheckout(gateway_for({"get": order(status="CREATED")}, events))
    with pytest.raises(BuyerApprovalRequired):
        asyncio.run(client.capture_approved_order(ORDER_ID))
    assert len(events) == 1
    assert events[0]["method"] == "GET"
    assert urlparse("https://api-m.sandbox.paypal.com").hostname == "api-m.sandbox.paypal.com"


def test_capture_approved_order_and_stable_idempotency():
    events = []
    responses = {"get": order(), "post": order(status="COMPLETED", capture=CAPTURE)}
    checkout = PayPalSandboxCheckout(gateway_for(responses, events))
    receipt = asyncio.run(checkout.capture_approved_order(ORDER_ID))
    assert receipt.status == receipt.capture_status == "COMPLETED"
    assert receipt.amount == "5.00"
    assert receipt.capture_id == CAPTURE["id"]
    assert [e["method"] for e in events] == ["GET", "POST"]
    assert events[-1]["path"] == f"/v2/checkout/orders/{ORDER_ID}/capture"
    assert events[-1]["headers"]["PayPal-Request-Id"]
    assert events[-1]["headers"]["Authorization"] == "Bearer mock-token"


def test_completed_order_is_read_only_and_not_recaptured():
    events = []
    checkout = PayPalSandboxCheckout(gateway_for(
        {"get": order(status="COMPLETED", capture=CAPTURE)}, events
    ))
    receipt = asyncio.run(checkout.capture_approved_order(ORDER_ID))
    assert receipt.capture_status == "COMPLETED"
    assert [e["method"] for e in events] == ["GET"]


def test_rejects_amount_mismatch_before_capture():
    events = []
    checkout = PayPalSandboxCheckout(gateway_for({"get": order(amount="500.00")}, events))
    with pytest.raises(InvalidDemoOrder):
        asyncio.run(checkout.capture_approved_order(ORDER_ID))
    assert [e["method"] for e in events] == ["GET"]


def test_rejects_invalid_ids_without_calling_paypal():
    checkout = PayPalSandboxCheckout(PayPalSandboxGateway("fake", "fake"))
    with pytest.raises(InvalidDemoOrder):
        asyncio.run(checkout.get_verified_order("../wrong"))


def test_api_capture_requires_confirm_true(monkeypatch):
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake-id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake-secret")
    monkeypatch.setenv("DEMO_ACCESS_KEY", "private-demo-test")
    response = TestClient(app).post(
        f"/api/paypal/orders/{ORDER_ID}/capture",
        json={"confirm": False},
        headers={"X-Demo-Key": "private-demo-test"},
    )
    assert response.status_code == 422


def test_api_capture_requires_private_key(monkeypatch):
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake-id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake-secret")
    monkeypatch.setenv("DEMO_ACCESS_KEY", "private-demo-test")
    response = TestClient(app).post(
        f"/api/paypal/orders/{ORDER_ID}/capture",
        json={"confirm": True},
        headers={"X-Demo-Key": "wrong-key"},
    )
    assert response.status_code == 401


def test_api_pending_buyer_approval_returns_409(monkeypatch):
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake-id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake-secret")
    monkeypatch.setenv("DEMO_ACCESS_KEY", "private-demo-test")
    events = []
    fake = gateway_for({"get": order(status="CREATED")}, events)
    app.dependency_overrides[sandbox_gateway] = lambda: fake
    try:
        response = TestClient(app).post(
            f"/api/paypal/orders/{ORDER_ID}/capture", json={"confirm": True}
        )
        assert response.status_code == 409
        assert len(events) == 1
    finally:
        app.dependency_overrides.clear()


def test_api_return_contains_no_paypal_buyer_information():
    events = []
    fake = gateway_for({"get": order(status="COMPLETED", capture=CAPTURE)}, events)
    app.dependency_overrides[sandbox_gateway] = lambda: fake
    try:
        response = TestClient(app).get(f"/api/paypal/orders/{ORDER_ID}/status")
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"order_id", "status", "currency", "amount", "capture_status", "capture_id"}
    finally:
        app.dependency_overrides.clear()


def test_capture_reconciles_failed_post_from_read_only_completed_order():
    """PayPal completed the capture although its POST response was a 502."""
    events = []
    get_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal get_count
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "mock-token"})
        events.append(request.method)
        if request.method == "GET":
            get_count += 1
            if get_count == 1:
                return httpx.Response(200, json=order())
            return httpx.Response(200, json=order(status="COMPLETED", capture=CAPTURE))
        if request.method == "POST":
            return httpx.Response(502, json={"message": "unreliable capture response"})
        return httpx.Response(405)

    gateway = PayPalSandboxGateway("fake", "fake", transport=httpx.MockTransport(handler))
    result = asyncio.run(PayPalSandboxCheckout(gateway).capture_approved_order(ORDER_ID))
    assert result.status == result.capture_status == "COMPLETED"
    assert result.capture_id == CAPTURE["id"]
    assert events == ["GET", "POST", "GET"]
    assert events.count("POST") == 1


def test_capture_reconciles_incomplete_post_body_after_real_completion():
    """The immediate PayPal POST result can lack detail present in the GET."""
    events = []
    get_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal get_count
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "mock-token"})
        events.append(request.method)
        if request.method == "GET":
            get_count += 1
            return httpx.Response(200, json=order(
                status="APPROVED" if get_count == 1 else "COMPLETED",
                capture=None if get_count == 1 else CAPTURE
            ))
        if request.method == "POST":
            return httpx.Response(201, json={"id": ORDER_ID, "status": "COMPLETED"})
        return httpx.Response(405)

    gateway = PayPalSandboxGateway("fake", "fake", transport=httpx.MockTransport(handler))
    result = asyncio.run(PayPalSandboxCheckout(gateway).capture_approved_order(ORDER_ID))
    assert result.capture_id == CAPTURE["id"]
    assert events == ["GET", "POST", "GET"]


def test_capture_uncertain_when_recheck_is_still_approved_no_second_post():
    events = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "mock-token"})
        events.append(request.method)
        if request.method == "GET":
            return httpx.Response(200, json=order())
        if request.method == "POST":
            return httpx.Response(503, json={"message": "pending"})
        return httpx.Response(405)

    gateway = PayPalSandboxGateway("fake", "fake", transport=httpx.MockTransport(handler))
    with pytest.raises(Exception) as exc:
        asyncio.run(PayPalSandboxCheckout(gateway).capture_approved_order(ORDER_ID))
    assert "uncertain" in str(exc.value).lower()
    assert events == ["GET", "POST", "GET"]
