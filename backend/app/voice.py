"""Independent, opt-in RunPod N-ATLAS ASR gateway for VoiceBridge AI Pay.

This module does not import, contact or modify the original VoiceBridge AI app.
All provider requests remain sandbox-demo-only and cannot authorize a payment.
"""
from __future__ import annotations

import base64
import binascii
import io
import os
import re
import wave

import httpx

MODEL_BY_LANGUAGE = {
    "en-NG": "NCAIR1/NigerianAccentedEnglish",
    "yo-NG": "NCAIR1/Yoruba-ASR",
    "ha-NG": "NCAIR1/Hausa-ASR",
    "ig-NG": "NCAIR1/Igbo-ASR",
}
RUNPOD_URL = re.compile(r"^https://api\.runpod\.ai/v2/[A-Za-z0-9_-]+$")
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
MAX_WAV_BYTES = 1_050_000  # 30 seconds of 16k mono PCM16 + WAV headers
class VoiceConfigurationError(Exception):
    pass


class VoiceValidationError(Exception):
    pass


class VoiceProviderError(Exception):
    pass


def validate_wav(encoded: str) -> bytes:
    if len(encoded) > 1_420_000:
        raise VoiceValidationError("Audio exceeds the demo length limit")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise VoiceValidationError("Audio must be valid base64 WAV") from exc
    if len(raw) < 44 or len(raw) > MAX_WAV_BYTES:
        raise VoiceValidationError("Audio must be a short WAV recording")
    try:
        with wave.open(io.BytesIO(raw), "rb") as wav:
            duration = wav.getnframes() / wav.getframerate() if wav.getframerate() else 0
            if (wav.getcomptype() != "NONE" or wav.getnchannels() != 1 or
                    wav.getsampwidth() != 2 or wav.getframerate() != 16000 or
                    duration < 0.4 or duration > 30.0):
                raise VoiceValidationError("Audio must be 0.4–30s, mono, PCM16, 16 kHz WAV")
            frames = wav.readframes(wav.getnframes())
            if len(frames) != wav.getnframes() * 2:
                raise VoiceValidationError("WAV recording was truncated")
    except (wave.Error, EOFError, OSError) as exc:
        raise VoiceValidationError("Invalid WAV audio") from exc
    return raw


def provider_config() -> tuple[str, str]:
    endpoint = os.getenv("NATLAS_ASR_RUNPOD_ENDPOINT", "").rstrip("/")
    key = os.getenv("NATLAS_ASR_RUNPOD_KEY", "")
    if not RUNPOD_URL.fullmatch(endpoint) or len(key) < 12:
        raise VoiceConfigurationError("Dedicated N-ATLAS ASR provider is not configured")
    return endpoint, key


class RunPodVoiceGateway:
    def __init__(self, endpoint: str, key: str, *, transport: httpx.AsyncBaseTransport | None = None):
        if not RUNPOD_URL.fullmatch(endpoint):
            raise VoiceConfigurationError("Invalid provider endpoint")
        if not key:
            raise VoiceConfigurationError("Missing provider key")
        self.endpoint = endpoint
        self.key = key
        self.transport = transport

    async def submit(self, audio_base64: str, language: str) -> dict:
        if language not in MODEL_BY_LANGUAGE:
            raise VoiceValidationError("Unsupported language")
        validate_wav(audio_base64)
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=25.0) as client:
                response = await client.post(
                    f"{self.endpoint}/run",
                    headers={"Authorization": f"Bearer {self.key}"},
                    json={"input": {"audio_base64": audio_base64, "language": language}},
                )
                response.raise_for_status()
                data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise VoiceProviderError("Voice provider unavailable") from exc
        if not isinstance(data, dict) or not isinstance(data.get("id"), str) or not JOB_ID.fullmatch(data["id"]):
            raise VoiceProviderError("Voice provider returned no valid job reference")
        return {"status": "processing", "job_id": data["id"], "language": language}

    async def status(self, job_id: str, language: str) -> dict:
        if not JOB_ID.fullmatch(job_id) or language not in MODEL_BY_LANGUAGE:
            raise VoiceValidationError("Invalid voice job")
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=15.0) as client:
                response = await client.get(
                    f"{self.endpoint}/status/{job_id}",
                    headers={"Authorization": f"Bearer {self.key}"},
                )
                response.raise_for_status()
                data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise VoiceProviderError("Voice provider status unavailable") from exc
        if not isinstance(data, dict) or data.get("id") not in (None, job_id):
            raise VoiceProviderError("Voice provider returned the wrong job")
        state = data.get("status")
        if state in ("IN_QUEUE", "IN_PROGRESS", "RUNNING"):
            return {"status": "processing"}
        if state in ("FAILED", "CANCELLED", "TIMED_OUT"):
            return {"status": "failed"}
        if state != "COMPLETED":
            raise VoiceProviderError("Unrecognized voice provider state")
        output = data.get("output")
        if not isinstance(output, dict) or output.get("model") != MODEL_BY_LANGUAGE[language] or (
            output.get("language") not in (None, language)
        ):
            raise VoiceProviderError("N-ATLAS model provenance was not verified")
        transcript = output.get("text")
        if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 1000:
            raise VoiceProviderError("Invalid N-ATLAS transcription")
        duration = output.get("duration_ms")
        if type(duration) is not int or duration < 400 or duration > 30_000:
            raise VoiceProviderError("Invalid N-ATLAS audio duration")
        return {
            "status": "completed",
            "language": language,
            "provider": "natlas",
            "model_id": MODEL_BY_LANGUAGE[language],
            "transcript": transcript.strip(),
            "duration_ms": duration,
        }
