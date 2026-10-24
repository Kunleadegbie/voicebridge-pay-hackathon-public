"""Durable, fail-closed N-ATLAS demonstration quota for VoiceBridge AI Pay only.

Requires a dedicated Upstash Redis REST database. Redis EVAL makes daily and
lifetime reservations atomic across Railway workers and restarts. No recordings,
passcodes, transcripts, or user identifiers are stored in Redis.

A reservation is intentionally NOT refunded when RunPod fails or times out:
it prevents retries and ambiguous provider responses from exceeding the budget.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import httpx

# Separate counters for each UTC calendar day and the total pilot lifetime.
# The stable hash tag ensures both keys are colocated for Redis deployments.
_KEY_PREFIX = "vbpay:{natlas-pilot}:"
_MAX_DAILY = 30
_MAX_TOTAL = 120

_RESERVE_SCRIPT = """
local day = tonumber(redis.call('GET', KEYS[1]) or '0')
local total = tonumber(redis.call('GET', KEYS[2]) or '0')
if day >= tonumber(ARGV[1]) or total >= tonumber(ARGV[2]) then
    return {0, day, total}
end
day = redis.call('INCR', KEYS[1])
if day == 1 then
    redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[3]))
end
total = redis.call('INCR', KEYS[2])
return {1, day, total}
"""

_READ_SCRIPT = """
return {
    tonumber(redis.call('GET', KEYS[1]) or '0'),
    tonumber(redis.call('GET', KEYS[2]) or '0')
}
"""


class VoiceQuotaUnavailable(Exception):
    """Redis quota is missing, misconfigured, or temporarily unreachable."""


class VoiceQuotaReached(Exception):
    """Daily or lifetime budget is exhausted."""


def _bounded_env(name: str, default: int, maximum: int) -> int:
    raw = os.getenv(name, str(default))
    if not re.fullmatch(r"[0-9]{1,3}", raw):
        raise VoiceQuotaUnavailable("Invalid voice quota configuration")
    value = int(raw)
    if not 1 <= value <= maximum:
        raise VoiceQuotaUnavailable("Invalid voice quota limit")
    return value


def _configuration() -> tuple[str, str, int, int]:
    url = os.getenv("VOICE_QUOTA_REDIS_REST_URL", "").rstrip("/")
    token = os.getenv("VOICE_QUOTA_REDIS_REST_TOKEN", "")
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or not re.fullmatch(r"[a-z0-9-]+\.upstash\.io", parts.hostname or "")
        or parts.netloc != parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
        or len(token) < 20
    ):
        raise VoiceQuotaUnavailable("Voice quota store is not configured")
    daily = _bounded_env("VOICE_DEMO_DAILY_LIMIT", 12, _MAX_DAILY)
    lifetime = _bounded_env("VOICE_DEMO_TOTAL_LIMIT", 48, _MAX_TOTAL)
    return url, token, daily, lifetime


def _keys(now: datetime) -> tuple[str, str, str, int]:
    instant = now.astimezone(timezone.utc)
    following_day = (instant.date() + timedelta(days=1))
    reset = datetime.combine(following_day, datetime.min.time(), tzinfo=timezone.utc)
    # Extra 24 hours for key cleanup; next day's key is always different.
    expires_at = int((reset + timedelta(days=1)).timestamp())
    day_key = _KEY_PREFIX + "daily:" + instant.strftime("%Y%m%d")
    return day_key, _KEY_PREFIX + "lifetime", reset.isoformat().replace("+00:00", "Z"), expires_at


async def _eval(url: str, token: str, script: str, keys: tuple[str, str], args: list[str]) -> list[int]:
    try:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=False, trust_env=False) as client:
            response = await client.post(
                url,
                headers={"Authorization": "Bearer " + token},
                json=["EVAL", script, "2", *keys, *args],
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise VoiceQuotaUnavailable("Voice quota store is unavailable") from exc
    values = payload.get("result") if isinstance(payload, dict) and "error" not in payload else None
    expected_length = 3 if args else 2
    if not isinstance(values, list) or len(values) != expected_length or any(
        type(value) is not int or value < 0 for value in values
    ):
        raise VoiceQuotaUnavailable("Invalid voice quota store response")
    return values


def _result(
    day_used: int, total_used: int, daily_limit: int, total_limit: int, reset_at: str
) -> dict[str, object]:
    day_remaining = max(0, daily_limit - day_used)
    lifetime_remaining = max(0, total_limit - total_used)
    remaining = min(day_remaining, lifetime_remaining)
    return {
        "status": "available" if remaining else "reached",
        "remaining": remaining,
        "daily_limit": daily_limit,
        "daily_used": day_used,
        "lifetime_remaining": lifetime_remaining,
        "reset_at_utc": reset_at,
    }


async def voice_quota_status(*, now: datetime | None = None) -> dict[str, object]:
    """Read-only: this never reserves capacity or contacts RunPod."""
    url, token, daily, lifetime = _configuration()
    keys = _keys(now or datetime.now(timezone.utc))
    counts = await _eval(url, token, _READ_SCRIPT, keys[:2], [])
    return _result(counts[0], counts[1], daily, lifetime, keys[2])


async def reserve_voice_quota(*, now: datetime | None = None) -> dict[str, object]:
    """Atomically reserve a single new job, or reject before contacting RunPod."""
    url, token, daily, lifetime = _configuration()
    keys = _keys(now or datetime.now(timezone.utc))
    values = await _eval(
        url, token, _RESERVE_SCRIPT, keys[:2],
        [str(daily), str(lifetime), str(keys[3])]
    )
    if values[0] not in (0, 1):
        raise VoiceQuotaUnavailable("Invalid quota reservation response")
    result = _result(values[1], values[2], daily, lifetime, keys[2])
    if values[0] == 0:
        raise VoiceQuotaReached("Voice demonstration submission capacity reached")
    return result
