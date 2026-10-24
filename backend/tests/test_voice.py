import asyncio
import base64
import io
import json
import wave

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app, voice_gateway
from app.voice import (
    MODEL_BY_LANGUAGE, RunPodVoiceGateway, VoiceProviderError,
    VoiceValidationError, provider_config,
    validate_wav,
)

ENDPOINT = "https://api.runpod.ai/v2/test-voice-worker"
JOB = "VoiceJob123456"
CLIENT = TestClient(app)


def wav_base64(seconds=0.6, rate=16000, channels=1):
    out = io.BytesIO()
    with wave.open(out, "wb") as f:
        f.setnchannels(channels)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(b"\x01\x04" * (int(seconds * rate) * channels))
    return base64.b64encode(out.getvalue()).decode("ascii")


def test_wave_validation_rejects_bad_formats_and_too_long_recordings():
    assert validate_wav(wav_base64())
    for bad in ("not-base64?;", wav_base64(seconds=31), wav_base64(rate=8000),
                wav_base64(channels=2), wav_base64(seconds=0.1)):
        with pytest.raises(VoiceValidationError):
            validate_wav(bad)


def test_provider_config_refuses_ssrf_endpoints(monkeypatch):
    monkeypatch.setenv("NATLAS_ASR_RUNPOD_ENDPOINT", "https://evil.example/api")
    monkeypatch.setenv("NATLAS_ASR_RUNPOD_KEY", "very-long-test-key")
    with pytest.raises(Exception):
        provider_config()


@pytest.mark.parametrize("language", list(MODEL_BY_LANGUAGE))
def test_runpod_submit_and_model_verified_status(language):
    requests = []

    def responder(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url.host == "api.runpod.ai"
        assert request.headers["authorization"] == "Bearer fake-secret"
        if request.url.path.endswith("/run"):
            payload = json.loads(request.content)
            assert payload["input"]["language"] == language
            assert validate_wav(payload["input"]["audio_base64"])
            return httpx.Response(200, json={"id": JOB, "status": "IN_QUEUE"})
        return httpx.Response(200, json={
            "id": JOB, "status": "COMPLETED",
            "output": {
                "text": "This is a verified voice sample.",
                "language": language, "model": MODEL_BY_LANGUAGE[language],
                "duration_ms": 600
            },
        })

    fake = RunPodVoiceGateway(
        ENDPOINT, "fake-secret", transport=httpx.MockTransport(responder)
    )
    submission = asyncio.run(fake.submit(wav_base64(), language))
    assert submission == {"job_id": JOB, "status": "processing", "language": language}
    result = asyncio.run(fake.status(JOB, language))
    assert result["provider"] == "natlas"
    assert result["model_id"] == MODEL_BY_LANGUAGE[language]
    assert result["duration_ms"] == 600
    assert result["transcript"] == "This is a verified voice sample."
    assert len(requests) == 2


def test_wrong_model_never_claims_natlas():
    def responder(request):
        return httpx.Response(200, json={
            "id": JOB, "status": "COMPLETED",
            "output": {"text": "hi", "model": "spoofed-model", "duration_ms": 600}
        })

    gateway = RunPodVoiceGateway(ENDPOINT, "fake-secret", transport=httpx.MockTransport(responder))
    with pytest.raises(VoiceProviderError):
        asyncio.run(gateway.status(JOB, "yo-NG"))


def test_pending_or_failed_jobs_never_return_fake_transcript():
    for state, expected in [("IN_QUEUE", "processing"), ("FAILED", "failed")]:
        fake = RunPodVoiceGateway(
            ENDPOINT, "fake-secret",
            transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json={"id": JOB, "status": state})
            )
        )
        result = asyncio.run(fake.status(JOB, "en-NG"))
        assert result == {"status": expected}


def test_voice_routes_disabled_by_default(monkeypatch):
    monkeypatch.delenv("ENABLE_NATLAS_VOICE", raising=False)
    monkeypatch.setenv("VOICE_SERVICE_KEY", "v" * 64)
    resp = CLIENT.post("/api/internal/voice/submit", json={
        "language": "en-NG", "audio_base64": wav_base64(), "confirm_privacy": True
    }, headers={"X-Voice-Service-Key": "v" * 64})
    assert resp.status_code == 503


def test_voice_service_key_required_even_with_provider(monkeypatch):
    monkeypatch.setenv("ENABLE_NATLAS_VOICE", "1")
    monkeypatch.setenv("VOICE_SERVICE_KEY", "v" * 64)
    monkeypatch.setenv("NATLAS_ASR_RUNPOD_ENDPOINT", ENDPOINT)
    monkeypatch.setenv("NATLAS_ASR_RUNPOD_KEY", "very-long-test-key")
    for key in ("", "incorrect"):
        resp = CLIENT.get(
            f"/api/internal/voice/status/{JOB}?language=ha-NG",
            headers={"X-Voice-Service-Key": key}
        )
        assert resp.status_code == 401


def test_voice_never_accepts_sensitive_payment_related_arguments():
    gateway = RunPodVoiceGateway(
        ENDPOINT, "fake-secret",
        transport=httpx.MockTransport(
            lambda req: httpx.Response(200, json={"id": JOB, "status": "IN_QUEUE"})
        ),
    )
    app.dependency_overrides[voice_gateway] = lambda: gateway
    try:
        no_consent = CLIENT.post("/api/internal/voice/submit", json={
            "language": "en-NG", "audio_base64": wav_base64(), "confirm_privacy": False
        })
        assert no_consent.status_code == 422
        invented_amount = CLIENT.post("/api/internal/voice/submit", json={
            "language": "en-NG", "audio_base64": wav_base64(),
            "confirm_privacy": True, "amount": "50.00", "capture": True
        })
        # Refuse unexpected payment-related fields rather than ignoring them.
        assert invented_amount.status_code == 422
    finally:
        app.dependency_overrides.clear()


