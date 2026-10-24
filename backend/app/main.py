"""Stage 1: PayPal sandbox connectivity and controlled test-order creation.

This deliberately does NOT implement payment capture, real-money transfers, or AI.
All PayPal operations are sandbox-only and require a server-side demo access key.
"""

from __future__ import annotations

import os
import secrets
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Path
from pydantic import BaseModel, Field, ConfigDict

from .paypal import PayPalSandboxError, PayPalSandboxGateway
from .checkout import BuyerApprovalRequired, InvalidDemoOrder, PayPalSandboxCheckout
from .voice import (
    RunPodVoiceGateway, VoiceConfigurationError, VoiceProviderError,
    VoiceValidationError, provider_config, validate_wav,
)
from .voice_quota import (
    VoiceQuotaReached, VoiceQuotaUnavailable, reserve_voice_quota, voice_quota_status,
)

app = FastAPI(title="VoiceBridge AI Pay — Sandbox Backend", version="0.1.0")


class DemoOrderRequest(BaseModel):
    item_code: Literal["financial-literacy-demo"]


class WebCheckoutOrderRequest(DemoOrderRequest):
    # Explicit allowlist: PayPal may return ONLY to our two trusted frontend hosts.
    checkout_origin: Literal[
        "https://voicebridge-pay-hackathon-web.vercel.app",
        "https://voicebridgepay.chumcred.com",
    ]


def sandbox_gateway(x_demo_key: str | None = Header(default=None)) -> PayPalSandboxGateway:
    configured_key = os.getenv("DEMO_ACCESS_KEY", "")
    client_id = os.getenv("PAYPAL_CLIENT_ID", "")
    client_secret = os.getenv("PAYPAL_CLIENT_SECRET", "")
    if not (configured_key and client_id and client_secret):
        raise HTTPException(status_code=503, detail="Sandbox is not configured")
    if not x_demo_key or not secrets.compare_digest(configured_key, x_demo_key):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return PayPalSandboxGateway(client_id, client_secret)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "sandbox", "release": "stage-1"}


@app.get("/api/paypal/connectivity")
async def connectivity(gateway: PayPalSandboxGateway = Depends(sandbox_gateway)) -> dict[str, object]:
    try:
        await gateway.get_access_token()
    except PayPalSandboxError:
        raise HTTPException(status_code=502, detail="Sandbox authentication failed") from None
    return {"sandbox": True, "credentials_valid": True}


@app.post("/api/paypal/orders", status_code=201)
async def create_order(
    order: DemoOrderRequest,
    gateway: PayPalSandboxGateway = Depends(sandbox_gateway),
) -> dict[str, str | None]:
    try:
        result = await gateway.create_demo_order(order.item_code)
    except PayPalSandboxError:
        raise HTTPException(status_code=502, detail="Sandbox order creation failed") from None
    return {
        "order_id": result.order_id,
        "status": result.status,
        "approve_url": result.approve_url,
        "currency": result.currency,
        "amount": result.amount,
    }


# Developer-only, sandbox-only checkout verification. Never expose X-Demo-Key
# to the browser or use these as public customer-facing payment endpoints.
from typing import Annotated
from pydantic import Field

ORDER_ID_PATTERN = r"^[A-Z0-9]{8,36}$"


class CaptureConfirmation(BaseModel):
    confirm: Literal[True]


@app.get("/api/paypal/orders/{order_id}/status")
async def sandbox_order_status(
    order_id: Annotated[str, Path(pattern=ORDER_ID_PATTERN)],
    gateway: PayPalSandboxGateway = Depends(sandbox_gateway),
) -> dict:
    try:
        return (await PayPalSandboxCheckout(gateway).get_verified_order(order_id)).response()
    except InvalidDemoOrder:
        raise HTTPException(status_code=409, detail="Order is not a valid fixed-value sandbox demo") from None
    except PayPalSandboxError:
        raise HTTPException(status_code=502, detail="Sandbox order verification failed") from None


@app.post("/api/paypal/orders/{order_id}/capture")
async def sandbox_capture_order(
    order_id: Annotated[str, Path(pattern=ORDER_ID_PATTERN)],
    confirmation: CaptureConfirmation,
    gateway: PayPalSandboxGateway = Depends(sandbox_gateway),
) -> dict:
    try:
        return (await PayPalSandboxCheckout(gateway).capture_approved_order(order_id)).response()
    except BuyerApprovalRequired:
        raise HTTPException(status_code=409, detail="Buyer approval required before capture") from None
    except InvalidDemoOrder:
        raise HTTPException(status_code=409, detail="Order is not a valid fixed-value sandbox demo") from None
    except PayPalSandboxError:
        raise HTTPException(status_code=502, detail="Sandbox capture failed; verify order status before retrying") from None


# Stage 3D: service-to-service sandbox pilot, kept separate from DEMO_ACCESS_KEY.
# The CHECKOUT_SERVICE_KEY is NEVER sent to a browser. The Vercel serverless
# function authenticates to these endpoints and binds an order to an HttpOnly,
# signed browser cookie. Disabled by default until both hosts are configured.
def web_checkout_gateway(
    x_checkout_service_key: str | None = Header(default=None),
) -> PayPalSandboxGateway:
    if os.getenv("ENABLE_PUBLIC_DEMO_CHECKOUT") != "1":
        raise HTTPException(status_code=503, detail="Sandbox checkout is not enabled")
    expected = os.getenv("CHECKOUT_SERVICE_KEY", "")
    client_id = os.getenv("PAYPAL_CLIENT_ID", "")
    client_secret = os.getenv("PAYPAL_CLIENT_SECRET", "")
    if len(expected) < 48 or not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="Sandbox checkout is not configured")
    if not x_checkout_service_key or not secrets.compare_digest(expected, x_checkout_service_key):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return PayPalSandboxGateway(client_id, client_secret)


@app.post("/api/internal/checkout/orders", status_code=201)
async def web_create_order(
    order: WebCheckoutOrderRequest,
    gateway: PayPalSandboxGateway = Depends(web_checkout_gateway),
) -> dict[str, str | None]:
    try:
        result = await gateway.create_demo_order(
            order.item_code, checkout_origin=order.checkout_origin
        )
    except PayPalSandboxError:
        raise HTTPException(status_code=502, detail="Sandbox order creation failed") from None
    return {
        "order_id": result.order_id,
        "status": result.status,
        "approve_url": result.approve_url,
        "currency": result.currency,
        "amount": result.amount,
    }


@app.get("/api/internal/checkout/orders/{order_id}/status")
async def web_order_status(
    order_id: Annotated[str, Path(pattern=ORDER_ID_PATTERN)],
    gateway: PayPalSandboxGateway = Depends(web_checkout_gateway),
) -> dict:
    try:
        return (await PayPalSandboxCheckout(gateway).get_verified_order(order_id)).response()
    except InvalidDemoOrder:
        raise HTTPException(status_code=409, detail="Not a valid fixed-value sandbox order") from None
    except PayPalSandboxError:
        raise HTTPException(status_code=502, detail="Sandbox order verification failed") from None


@app.post("/api/internal/checkout/orders/{order_id}/capture")
async def web_capture_order(
    order_id: Annotated[str, Path(pattern=ORDER_ID_PATTERN)],
    confirmation: CaptureConfirmation,
    gateway: PayPalSandboxGateway = Depends(web_checkout_gateway),
) -> dict:
    try:
        return (await PayPalSandboxCheckout(gateway).capture_approved_order(order_id)).response()
    except BuyerApprovalRequired:
        raise HTTPException(status_code=409, detail="Buyer approval required before capture") from None
    except InvalidDemoOrder:
        raise HTTPException(status_code=409, detail="Not a valid fixed-value sandbox order") from None
    except PayPalSandboxError:
        raise HTTPException(status_code=502, detail="Sandbox capture failed; check status before retrying") from None



# Stage 3E: independent, disabled-by-default N-ATLAS voice transcription.
# This is completely separated from PayPal and the original VoiceBridge AI.
# No speech transcript or voice command can authorize or capture payment.
class VoiceAudioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    language: Literal["en-NG", "yo-NG", "ha-NG", "ig-NG"]
    audio_base64: str = Field(min_length=56, max_length=1_420_000)
    confirm_privacy: Literal[True]


def voice_gateway(
    x_voice_service_key: str | None = Header(default=None),
) -> RunPodVoiceGateway:
    if os.getenv("ENABLE_NATLAS_VOICE") != "1":
        raise HTTPException(status_code=503, detail="N-ATLAS voice pilot is disabled")
    expected = os.getenv("VOICE_SERVICE_KEY", "")
    if len(expected) < 48:
        raise HTTPException(status_code=503, detail="N-ATLAS voice gateway is not configured")
    if not x_voice_service_key or not secrets.compare_digest(x_voice_service_key, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        endpoint, key = provider_config()
        return RunPodVoiceGateway(endpoint, key)
    except VoiceConfigurationError:
        raise HTTPException(status_code=503, detail="Dedicated N-ATLAS provider is not configured") from None


@app.post("/api/internal/voice/submit", status_code=202)
async def voice_submit(
    body: VoiceAudioRequest,
    gateway: RunPodVoiceGateway = Depends(voice_gateway),
) -> dict:
    try:
        validate_wav(body.audio_base64)
        await reserve_voice_quota()
        return await gateway.submit(body.audio_base64, body.language)
    except VoiceValidationError:
        raise HTTPException(status_code=422, detail="Voice recording must be short, PCM16 mono 16kHz WAV") from None
    except VoiceQuotaReached:
        raise HTTPException(status_code=429, detail="Voice demo capacity reached") from None
    except VoiceQuotaUnavailable:
        raise HTTPException(status_code=503, detail="Voice demo capacity service unavailable") from None
    except VoiceProviderError:
        raise HTTPException(status_code=502, detail="N-ATLAS transcription service unavailable") from None


@app.get("/api/internal/voice/capacity")
async def voice_capacity(
    gateway: RunPodVoiceGateway = Depends(voice_gateway),
) -> dict:
    # Passcode and origin are checked independently by the Vercel proxy.
    # No audio submission, RunPod calls or quota reservation occurs here.
    try:
        return await voice_quota_status()
    except VoiceQuotaUnavailable:
        raise HTTPException(status_code=503, detail="Voice demo capacity service unavailable") from None


@app.get("/api/internal/voice/status/{job_id}")
async def voice_status(
    job_id: Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{8,128}$")],
    language: Literal["en-NG", "yo-NG", "ha-NG", "ig-NG"],
    gateway: RunPodVoiceGateway = Depends(voice_gateway),
) -> dict:
    try:
        return await gateway.status(job_id, language)
    except VoiceValidationError:
        raise HTTPException(status_code=422, detail="Invalid voice job") from None
    except VoiceProviderError:
        raise HTTPException(status_code=502, detail="N-ATLAS voice result could not be verified") from None
