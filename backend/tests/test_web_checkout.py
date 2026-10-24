import os

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
PREFIX = "/api/internal/checkout"


def test_checkout_disabled_by_default(monkeypatch):
    monkeypatch.delenv("ENABLE_PUBLIC_DEMO_CHECKOUT", raising=False)
    monkeypatch.setenv("CHECKOUT_SERVICE_KEY", "x" * 64)
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake")
    r = client.post(
        f"{PREFIX}/orders",
        json={"item_code": "financial-literacy-demo"},
        headers={"X-Checkout-Service-Key": "x" * 64},
    )
    assert r.status_code == 503


def test_checkout_service_key_required(monkeypatch):
    monkeypatch.setenv("ENABLE_PUBLIC_DEMO_CHECKOUT", "1")
    monkeypatch.setenv("CHECKOUT_SERVICE_KEY", "secret" * 11)
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake")
    missing = client.get(f"{PREFIX}/orders/0RJ0235509873561P/status")
    wrong = client.get(
        f"{PREFIX}/orders/0RJ0235509873561P/status",
        headers={"X-Checkout-Service-Key": "not-the-correct-key"},
    )
    assert missing.status_code == 401
    assert wrong.status_code == 401


def test_checkout_requires_separate_config_and_no_browser_demo_key(monkeypatch):
    monkeypatch.setenv("ENABLE_PUBLIC_DEMO_CHECKOUT", "1")
    monkeypatch.delenv("CHECKOUT_SERVICE_KEY", raising=False)
    monkeypatch.setenv("DEMO_ACCESS_KEY", "not-a-service-key" * 4)
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake")
    r = client.get(
        f"{PREFIX}/orders/0RJ0235509873561P/status",
        headers={"X-Checkout-Service-Key": os.environ["DEMO_ACCESS_KEY"]},
    )
    assert r.status_code == 503


def test_checkout_fixed_item_only(monkeypatch):
    monkeypatch.setenv("ENABLE_PUBLIC_DEMO_CHECKOUT", "1")
    monkeypatch.setenv("CHECKOUT_SERVICE_KEY", "y" * 64)
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake")
    r = client.post(
        f"{PREFIX}/orders",
        json={"item_code": "variable-amount", "amount": "100.00"},
        headers={"X-Checkout-Service-Key": "y" * 64},
    )
    assert r.status_code == 422


def test_checkout_capture_requires_explicit_literal_true(monkeypatch):
    monkeypatch.setenv("ENABLE_PUBLIC_DEMO_CHECKOUT", "1")
    monkeypatch.setenv("CHECKOUT_SERVICE_KEY", "y" * 64)
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake")
    r = client.post(
        f"{PREFIX}/orders/0RJ0235509873561P/capture",
        json={"confirm": False},
        headers={"X-Checkout-Service-Key": "y" * 64},
    )
    assert r.status_code == 422
