"""The multi-tenant layer — isolation, namespacing, keys and quota.

Applications using this SDK do NOT run their own validator; they run through
arCCade's participant and are given a key. That makes arCCade an infrastructure
provider rather than a game studio, and it creates three duties:

  1. ISOLATION. Tenant A cannot move tenant B's venue, players or assets. They
     stand on the same participant, so this is THIS LAYER'S duty, not the
     ledger's.
  2. NAMESPACING. Tenant A cannot mint tenant B's item. Because third parties
     cannot run their own registry, every item's ``instrumentId.admin`` is
     arCCade's registry party — all tenants' items share one admin. Without a
     prefix, tenant A could mint ``"sword-of-dawn"`` on top of tenant B's.
  3. QUOTA. Economic deterrence is not the only defence against spam; a
     per-tenant write quota is the administrative one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
from typing import Any, Iterable, Mapping, Optional

__all__ = [
    "assert_valid_tenant_id", "namespaced_instrument_id", "parse_instrument_id",
    "assert_tenant_owns_instrument", "assert_tenant_legs",
    "generate_tenant_key", "hash_tenant_key", "verify_tenant_key",
    "tenant_id_from_key", "TenantQuota", "KEY_PREFIX",
]

# Tenant id: lowercase letters, digits and hyphens; 3-32 characters.
_TENANT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")

KEY_PREFIX = "ags_"


def assert_valid_tenant_id(tenant_id: str) -> str:
    if not isinstance(tenant_id, str) or not _TENANT_ID_RE.match(tenant_id):
        raise ValueError(
            "gecersiz kiraci kimligi (3-32 karakter, [a-z0-9-], tire ile "
            f"baslayip bitemez): {tenant_id!r}"
        )
    if "--" in tenant_id:
        raise ValueError(f"kiraci kimliginde ardisik tire olamaz: {tenant_id}")
    return tenant_id


def namespaced_instrument_id(registry_party: str, tenant_id: str, local_id: str) -> dict:
    """``instrumentId.id`` = ``<tenantId>/<localId>``.

    ``/`` is the separator because both ``:`` (tag separator) and ``|`` (list
    separator) carry meaning in the digest encoding; ``/`` does not.
    """
    assert_valid_tenant_id(tenant_id)
    if not isinstance(local_id, str) or len(local_id) == 0 or len(local_id) > 96:
        raise ValueError(f"gecersiz item kimligi (1-96 karakter): {local_id!r}")
    if "/" in local_id:
        raise ValueError(f"item kimliginde '/' olamaz (ad alani ayiricisi): {local_id}")
    if ":" in local_id or "|" in local_id:
        raise ValueError(f"item kimliginde ':' veya '|' olamaz: {local_id}")
    return {"admin": registry_party, "id": f"{tenant_id}/{local_id}"}


def parse_instrument_id(instrument_id: Mapping[str, Any]) -> dict:
    """Splits a namespaced id. ``tenantId`` is None for namespace-less assets (CC)."""
    raw = instrument_id["id"]
    i = raw.find("/")
    if i < 0:
        return {"tenantId": None, "localId": raw}
    return {"tenantId": raw[:i], "localId": raw[i + 1:]}


def assert_tenant_owns_instrument(tenant_id: str, instrument_id: Mapping[str, Any]) -> str:
    """THE ISOLATION CHECK — run it on every tenant call.

    Every instrument a tenant touches must be either in its own namespace or
    namespace-less (shared, like CC).
    """
    assert_valid_tenant_id(tenant_id)
    owner = parse_instrument_id(instrument_id)["tenantId"]
    if owner is not None and owner != tenant_id:
        raise ValueError(
            f'kiraci izolasyonu ihlali: "{tenant_id}" kiracisi "{owner}" '
            f'kiracisinin varligina dokunamaz ({instrument_id["id"]})'
        )
    return tenant_id


def assert_tenant_legs(tenant_id: str, legs: Any) -> str:
    """Checks every leg of a trade or transfer for isolation."""
    values = legs.values() if isinstance(legs, Mapping) else [v for _, v in legs]
    for leg in values:
        assert_tenant_owns_instrument(tenant_id, leg["instrumentId"])
    return tenant_id


# ------------------------------------------------------------------- keys

def generate_tenant_key(tenant_id: str) -> dict:
    """A new SDK key.

    The returned ``secret`` is shown to the tenant ONCE and not stored; only the
    ``hash`` is kept server-side. A lost key is replaced, never recovered.
    """
    assert_valid_tenant_id(tenant_id)
    raw = base64.urlsafe_b64encode(os.urandom(24)).decode("ascii").rstrip("=")
    secret = f"{KEY_PREFIX}{tenant_id}_{raw}"
    return {"tenantId": tenant_id, "secret": secret, "hash": hash_tenant_key(secret)}


def hash_tenant_key(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def verify_tenant_key(secret: Any, expected_hash: Any) -> bool:
    """Constant-time key check.

    A plain ``==`` can leak the key's characters through response time, so the
    comparison goes through ``hmac.compare_digest``. Note that the suite can pin
    the VALUE behaviour here but not the timing property; that exclusion is
    recorded in the conformance README with no mitigation.
    """
    if not isinstance(secret, str) or not isinstance(expected_hash, str):
        return False
    a = hash_tenant_key(secret)
    if len(a) != len(expected_hash):
        return False
    return hmac.compare_digest(a, expected_hash)


def tenant_id_from_key(secret: Any) -> Optional[str]:
    """Reads the tenant id out of a key. NOT A SUBSTITUTE for verification."""
    if not isinstance(secret, str) or not secret.startswith(KEY_PREFIX):
        return None
    rest = secret[len(KEY_PREFIX):]
    i = rest.find("_")
    if i < 0:
        return None
    candidate = rest[:i]
    try:
        assert_valid_tenant_id(candidate)
    except ValueError:
        return None
    return candidate


# ------------------------------------------------------------------ quota

class TenantQuota:
    """Per-tenant write quota — the administrative defence against spam.

    Economic deterrence (every write burns real CC and a real network fee) is
    the first defence but not sufficient on its own: a well-capitalised tenant
    can produce a volume that is economically legitimate and operationally
    harmful. The clock is INJECTED (``now_ms``), which is what makes this
    deterministic enough to pin in the conformance suite.
    """

    def __init__(self, window_seconds: int = 60, max_writes: int = 60,
                 store: Optional[dict] = None) -> None:
        self.window_seconds = window_seconds
        self.max_writes = max_writes
        self.store = store if store is not None else {}

    def consume(self, tenant_id: str, now_ms: int, cost: int = 1) -> dict:
        assert_valid_tenant_id(tenant_id)
        window_ms = self.window_seconds * 1000
        bucket = self.store.get(tenant_id) or {"start": now_ms, "used": 0}
        if now_ms - bucket["start"] >= window_ms:
            bucket["start"] = now_ms
            bucket["used"] = 0
        reset_at = bucket["start"] + window_ms
        if bucket["used"] + cost > self.max_writes:
            self.store[tenant_id] = bucket
            # A refused call does not consume: otherwise a client retrying under
            # the cap would push itself further out of it.
            return {"allowed": False,
                    "remaining": max(0, self.max_writes - bucket["used"]),
                    "resetAt": reset_at}
        bucket["used"] += cost
        self.store[tenant_id] = bucket
        return {"allowed": True,
                "remaining": self.max_writes - bucket["used"],
                "resetAt": reset_at}
