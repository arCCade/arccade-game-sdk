"""The venue policy document and its consistency check.

The FULL TEXT of the policy in force is committed as a digest at every stake
(``GameStake.policyHash``). "Under which rules was this cycle opened" is then
answered by the cycle's own record rather than by whatever arCCade says later —
which only holds if the document is reproducible outside Daml.

Note the deliberate difference from an audit row: a policy is authored in
DECIMALS (``canon_decimal``) while a row carries units already converted
(``canon_int``). Applying one convention to both produces a policy digest no
stake can match.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping

from .digest import (amount_units, canon_bool, canon_decimal, canon_document,
                     canon_int, text_digest)

__all__ = ["POLICY_FIELDS", "VenuePolicy", "policy_document", "policy_digest",
           "valid_policy"]

# Document field name -> the snake_case and camelCase spellings a caller might use.
POLICY_FIELDS = (
    "min-stake-amount", "max-stake-amount", "min-platform-fee", "max-payout-amount",
    "min-lock-seconds", "max-lock-seconds", "min-cycle-seconds", "max-cycle-seconds",
    "cooldown-seconds", "abort-cooldown-seconds", "concurrency-limit",
    "require-custody-proof",
)


@dataclass(frozen=True)
class VenuePolicy:
    """A venue policy in Python-native field names."""

    min_stake_amount: Any
    max_stake_amount: Any
    min_platform_fee: Any
    max_payout_amount: Any
    min_lock_seconds: int
    max_lock_seconds: int
    min_cycle_seconds: int
    max_cycle_seconds: int
    cooldown_seconds: int
    abort_cooldown_seconds: int
    concurrency_limit: int
    require_custody_proof: bool


def _camel(name: str) -> str:
    head, *tail = name.split("-")
    return head + "".join(p.capitalize() for p in tail)


def _get(policy: Any, field: str) -> Any:
    """Reads a policy field under any of its three spellings.

    A policy arrives either as a mapping keyed by document field names (which is
    how the conformance manifest states it) or as a VenuePolicy; accepting both
    keeps the document definition in one place.
    """
    snake = field.replace("-", "_")
    if isinstance(policy, Mapping):
        for key in (field, snake, _camel(field)):
            if key in policy:
                return policy[key]
        raise KeyError(field)
    return getattr(policy, snake)


def policy_document(policy: Any) -> str:
    """The policy's canonical document.

    Field order here does not matter — ``canon_fields`` sorts by name — so a
    field added later does not change the v1 digest unless the schema version
    moves with it.
    """
    return canon_document("arccade-venue-policy", 1, [
        ("min-stake-amount", canon_decimal(_get(policy, "min-stake-amount"))),
        ("max-stake-amount", canon_decimal(_get(policy, "max-stake-amount"))),
        ("min-platform-fee", canon_decimal(_get(policy, "min-platform-fee"))),
        ("max-payout-amount", canon_decimal(_get(policy, "max-payout-amount"))),
        ("min-lock-seconds", canon_int(_get(policy, "min-lock-seconds"))),
        ("max-lock-seconds", canon_int(_get(policy, "max-lock-seconds"))),
        ("min-cycle-seconds", canon_int(_get(policy, "min-cycle-seconds"))),
        ("max-cycle-seconds", canon_int(_get(policy, "max-cycle-seconds"))),
        ("cooldown-seconds", canon_int(_get(policy, "cooldown-seconds"))),
        ("abort-cooldown-seconds", canon_int(_get(policy, "abort-cooldown-seconds"))),
        ("concurrency-limit", canon_int(_get(policy, "concurrency-limit"))),
        ("require-custody-proof", canon_bool(_get(policy, "require-custody-proof"))),
    ])


def policy_digest(policy: Any) -> str:
    return text_digest(policy_document(policy))


def valid_policy(policy: Any) -> bool:
    """A consistent policy. Used in Daml's ``ensure``, so an inconsistent policy
    cannot create a venue at all.

    THE CRITICAL RULE is ``minLockSeconds >= minCycleSeconds``. A lock that can
    expire mid-cycle is not a lock: the player could leave through
    ``OwnerExpireLockV2`` before the minimum duration was up, which would hollow
    out the minimum-ledger-lock commitment.
    """
    units = lambda f: amount_units(_get(policy, f))
    ints = lambda f: int(_get(policy, f))
    min_stake = units("min-stake-amount")
    max_stake = units("max-stake-amount")
    min_fee = units("min-platform-fee")
    max_payout = units("max-payout-amount")
    min_lock = ints("min-lock-seconds")
    max_lock = ints("max-lock-seconds")
    min_cycle = ints("min-cycle-seconds")
    max_cycle = ints("max-cycle-seconds")
    cooldown = ints("cooldown-seconds")
    abort_cooldown = ints("abort-cooldown-seconds")
    concurrency = ints("concurrency-limit")
    return (
        min_stake > 0
        and max_stake >= min_stake
        and min_fee >= 0
        and max_payout >= 0
        and min_lock > 0
        and max_lock >= min_lock
        and min_cycle > 0
        and max_cycle >= min_cycle
        and min_lock >= min_cycle
        and cooldown >= 0
        and abort_cooldown >= 0
        and concurrency > 0
    )
