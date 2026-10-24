from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_does_not_require_secrets():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["mode"] == "sandbox"


def test_sandbox_disabled_if_credentials_missing(monkeypatch):
    monkeypatch.delenv("PAYPAL_CLIENT_ID", raising=False)
    monkeypatch.delenv("PAYPAL_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("DEMO_ACCESS_KEY", raising=False)
    response = client.get("/api/paypal/connectivity")
    assert response.status_code == 503


def test_sandbox_rejects_wrong_access_key(monkeypatch):
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake-id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake-secret")
    monkeypatch.setenv("DEMO_ACCESS_KEY", "known-test-key")
    response = client.get("/api/paypal/connectivity", headers={"X-Demo-Key": "wrong"})
    assert response.status_code == 401


def test_invalid_item_cannot_set_amount(monkeypatch):
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "fake-id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "fake-secret")
    monkeypatch.setenv("DEMO_ACCESS_KEY", "known-test-key")
    response = client.post("/api/paypal/orders", json={"item_code": "USD100000"}, headers={"X-Demo-Key": "known-test-key"})
    assert response.status_code == 422
