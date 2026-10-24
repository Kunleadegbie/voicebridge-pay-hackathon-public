"""Tests for atomic, fail-closed N-ATLAS quota across dates and workers.

No network, RunPod request, private token, or PayPal call is used.
"""
import asyncio
import base64
import io
import json
import wave
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main, voice_quota
from app.main import app, voice_gateway
from app.voice import RunPodVoiceGateway

TEST_URL = "https://vbpay-test-account.upstash.io"
START = datetime(2026, 10, 18, 9, 0, tzinfo=timezone.utc)


def configure(monkeypatch, *, daily=2, total=3):
    monkeypatch.setenv("VOICE_QUOTA_REDIS_REST_URL", TEST_URL)
    monkeypatch.setenv("VOICE_QUOTA_REDIS_REST_TOKEN", "x" * 64)
    monkeypatch.setenv("VOICE_DEMO_DAILY_LIMIT", str(daily))
    monkeypatch.setenv("VOICE_DEMO_TOTAL_LIMIT", str(total))


def fake_redis(monkeypatch):
    """State is shared across all separately-created AsyncClient instances."""
    state = {}
    seen = []
    real_client = httpx.AsyncClient

    def responder(request):
        command = json.loads(request.content)
        seen.append(command)
        assert request.url.host == "vbpay-test-account.upstash.io"
        assert request.headers["authorization"] == "Bearer " + "x" * 64
        assert command[0] == "EVAL" and command[2] == "2"
        first, second = command[3:5]
        daily, lifetime = state.get(first, 0), state.get(second, 0)
        if len(command) == 5:
            return httpx.Response(200, json={"result": [daily, lifetime]})
        daily_limit, lifetime_limit = map(int, command[5:7])
        if daily >= daily_limit or lifetime >= lifetime_limit:
            return httpx.Response(200, json={"result": [0, daily, lifetime]})
        state[first], state[second] = daily + 1, lifetime + 1
        return httpx.Response(200, json={"result": [1, daily + 1, lifetime + 1]})

    def client_factory(**kwargs):
        return real_client(transport=httpx.MockTransport(responder), **kwargs)

    monkeypatch.setattr(voice_quota.httpx, "AsyncClient", client_factory)
    return state, seen


def test_atomic_daily_and_lifetime_reservation(monkeypatch):
    configure(monkeypatch)
    state, seen = fake_redis(monkeypatch)

    async def exercise():
        first = await voice_quota.voice_quota_status(now=START)
        assert first["remaining"] == 2
        assert first["daily_used"] == 0
        a = await voice_quota.reserve_voice_quota(now=START)
        b = await voice_quota.reserve_voice_quota(now=START)
        assert (a["remaining"], b["remaining"]) == (1, 0)
        with pytest.raises(voice_quota.VoiceQuotaReached):
            await voice_quota.reserve_voice_quota(now=START)
        later = START + timedelta(days=1)
        await voice_quota.reserve_voice_quota(now=later)
        assert (await voice_quota.voice_quota_status(now=later))["lifetime_remaining"] == 0
        with pytest.raises(voice_quota.VoiceQuotaReached):
            await voice_quota.reserve_voice_quota(now=later)
        assert (await voice_quota.voice_quota_status(now=START))["daily_used"] == 2

    asyncio.run(exercise())
    assert len([k for k in state if "daily:" in k]) == 2
    assert len(state) == 3
    assert any("EXPIREAT" in cmd[1] for cmd in seen)


def test_concurrent_reservations_never_exceed_limit(monkeypatch):
    configure(monkeypatch, daily=2, total=20)
    state, _ = fake_redis(monkeypatch)

    async def exercise():
        outcomes = await asyncio.gather(*[
            voice_quota.reserve_voice_quota(now=START)
            for _ in range(10)
        ], return_exceptions=True)
        assert sum(isinstance(item, dict) for item in outcomes) == 2
        assert sum(isinstance(item, voice_quota.VoiceQuotaReached) for item in outcomes) == 8

    asyncio.run(exercise())
    assert state[voice_quota._KEY_PREFIX + "lifetime"] == 2


def test_missing_or_invalid_quota_config_fails_closed(monkeypatch):
    monkeypatch.delenv("VOICE_QUOTA_REDIS_REST_URL", raising=False)
    monkeypatch.delenv("VOICE_QUOTA_REDIS_REST_TOKEN", raising=False)
    with pytest.raises(voice_quota.VoiceQuotaUnavailable):
        asyncio.run(voice_quota.reserve_voice_quota(now=START))
    configure(monkeypatch)
    monkeypatch.setenv("VOICE_QUOTA_REDIS_REST_URL", "https://internal.example")
    with pytest.raises(voice_quota.VoiceQuotaUnavailable):
        asyncio.run(voice_quota.voice_quota_status(now=START))
    monkeypatch.setenv("VOICE_QUOTA_REDIS_REST_URL", TEST_URL)
    monkeypatch.setenv("VOICE_DEMO_DAILY_LIMIT", "1000")
    with pytest.raises(voice_quota.VoiceQuotaUnavailable):
        asyncio.run(voice_quota.reserve_voice_quota(now=START))


def test_quota_server_error_fails_closed(monkeypatch):
    configure(monkeypatch)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        voice_quota.httpx, "AsyncClient",
        lambda **kwargs: real_client(
            transport=httpx.MockTransport(lambda request: httpx.Response(503)),
            **kwargs
        )
    )
    with pytest.raises(voice_quota.VoiceQuotaUnavailable):
        asyncio.run(voice_quota.reserve_voice_quota(now=START))


def wave_sample():
    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setnchannels(1)
        wav.setframerate(16000)
        wav.setsampwidth(2)
        wav.writeframes(b"\x01\x04" * 9600)
    return base64.b64encode(stream.getvalue()).decode("ascii")


def test_authenticated_capacity_route_is_read_only(monkeypatch):
    provider_calls = []
    gateway = RunPodVoiceGateway(
        "https://api.runpod.ai/v2/test-voice-worker", "fake-token",
        transport=httpx.MockTransport(lambda request: provider_calls.append(request))
    )
    app.dependency_overrides[voice_gateway] = lambda: gateway
    monkeypatch.setattr(main, "voice_quota_status", lambda: asyncio.sleep(
        0, result={
            "status": "available", "remaining": 2, "daily_limit": 12,
            "daily_used": 10, "lifetime_remaining": 31,
            "reset_at_utc": "2026-10-19T00:00:00Z",
        }
    ))
    try:
        client = TestClient(app)
        response = client.get("/api/internal/voice/capacity")
        assert response.status_code == 200
        assert response.json()["remaining"] == 2
        assert provider_calls == []
    finally:
        app.dependency_overrides.clear()


def test_exhausted_quota_blocks_new_runpod_job(monkeypatch):
    provider_calls = []
    gateway = RunPodVoiceGateway(
        "https://api.runpod.ai/v2/test-voice-worker", "fake-token",
        transport=httpx.MockTransport(lambda request: provider_calls.append(request))
    )
    app.dependency_overrides[voice_gateway] = lambda: gateway

    async def denied():
        raise voice_quota.VoiceQuotaReached()

    monkeypatch.setattr(main, "reserve_voice_quota", denied)
    try:
        response = TestClient(app).post("/api/internal/voice/submit", json={
            "language": "ha-NG", "audio_base64": wave_sample(),
            "confirm_privacy": True
        })
        assert response.status_code == 429
        assert provider_calls == []
    finally:
        app.dependency_overrides.clear()
