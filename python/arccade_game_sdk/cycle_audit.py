"""Rebuilds period-report rows from the ledger's TRANSACTION TREE stream.

WHY THIS IS IN THE SDK. If the rows behind a period anchor come from the game's
own database, the anchor commits to arCCade's record of what happened — a
signature on our own bookkeeping. It is evidence only if the rows derive from
the same stream an auditor reads, and that derivation has to be runnable by
anyone, in whatever language they already have, or "verifiable" means
"verifiable by arCCade".

``test-vectors/cycle-trees.json`` holds real transactions captured from TestNet
and ``test-vectors/cycle-rows.json`` the rows they must produce. Every
implementation is pinned to that pair.

THE JOIN KEY IS THE STAKE CONTRACT ID, NOT THE CYCLE ID. A closing choice does
not repeat ``cycleId`` — it lives on the contract being exercised — so the
commit's ``exerciseResult`` (that contract id) is the only thing linking the two
halves in the stream.

WHAT IS DERIVED RATHER THAN READ. ``GameStake_Settle`` states the amounts and the
outcome digest. ``_Abort`` carries only a reason and ``_ExpireUnsettled`` carries
nothing, so for those two the amounts follow from the mechanic: unlocking a
TimeLockedHolding always pays the owner in full and settlement refuses a non-zero
forfeit on this mechanic. ``outcomeDigest`` is empty because no outcome ever
existed, not because we failed to find one.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, NamedTuple, Optional

from .digest import LEAF_FIELDS, amount_units, iso_to_micros

__all__ = [
    "REPORT_ORDER", "SDK_MODULE", "CLOSING_CHOICES", "DISPOSITION_TAGS",
    "iso_to_micros", "commit_facts", "closing_facts", "rows_from_transactions",
    "to_leaf_row", "AuditReport", "LEAF_FIELDS",
]

SDK_MODULE = "ArCCade.GameSdk.Cycle"

# Abort and expiry state no disposition; it follows from WHICH choice closed the
# cycle. Only settlement names one.
CLOSING_CHOICES = {
    "GameStake_Settle": None,
    "GameStake_Abort": "aborted",
    "GameStake_ExpireUnsettled": "expired-unsettled",
}

# Daml constructor -> the tag that goes into the canonical document.
DISPOSITION_TAGS = {
    "ReturnedInFull": "returned-in-full",
    "ReturnedWithForfeit": "returned-with-forfeit",
    "ForfeitedInFull": "forfeited-in-full",
    "Aborted": "aborted",
    "ExpiredUnsettled": "expired-unsettled",
}

# The canonical ordering a period report and its Merkle root must use.
#
# The collation is NAMED (decision D11). The previous wording said only
# "committedAtMicros, then cycleId", which left the tie-break open: one client
# broke ties with a locale-dependent collator and another with code-point order,
# and the same rows produced two different Merkle roots. Code point order is the
# defensible answer — it equals UTF-8 byte order and is trivial in all four
# implementations.
REPORT_ORDER = "committedAtMicros ascending, then cycleId ascending by Unicode code point"


class AuditReport(NamedTuple):
    """Unpacks as ``(rows, warnings, open_stakes, orphan_closings)``."""

    rows: list
    warnings: list
    open_stakes: list
    orphan_closings: list


def _units(decimal_string: str) -> int:
    """Ledger amounts arrive as decimal STRINGS. Parsing the digits directly
    keeps them exact; a float would lose them before amount_units could complain."""
    return amount_units(decimal_string)


def _exercised(tx: Mapping[str, Any]) -> list:
    return [e["ExercisedEvent"] for e in (tx.get("events") or []) if "ExercisedEvent" in e]


def _created(tx: Mapping[str, Any]) -> list:
    return [e["CreatedEvent"] for e in (tx.get("events") or []) if "CreatedEvent" in e]


def _is_sdk(node: Mapping[str, Any], entity: str) -> bool:
    return f"{SDK_MODULE}:{entity}" in (node.get("templateId") or "")


def commit_facts(tx: Mapping[str, Any]) -> Optional[dict]:
    """The entry half: the created GameStake, keyed by its contract id.
    None when this transaction is not a commit."""
    if not any(x.get("choice") == "Entitlement_Commit" and _is_sdk(x, "PlayerEntitlement")
               for x in _exercised(tx)):
        return None
    stake = next((c for c in _created(tx) if _is_sdk(c, "GameStake")), None)
    if stake is None:
        return None
    a = stake["createArgument"]
    return {
        "stakeContractId": stake["contractId"],
        "updateId": tx.get("updateId"),
        "venueId": a["venueId"],
        "cycleId": a["cycleId"],
        "player": a["player"],
        "gameCode": a["gameCode"],
        "concurrencyIndex": int(a["concurrencyIndex"]),
        "entryDigest": a["entryDigest"],
        "committedAtMicros": iso_to_micros(a["committedAt"]),
        "committedUnits": _units(a["terms"]["stakeAmount"]),
        "feeUnits": _units(a["terms"]["feeAmount"]),
        "custodyTag": a["terms"]["custodyTag"],
    }


def closing_facts(tx: Mapping[str, Any]) -> Optional[dict]:
    """The exit half. None when this transaction closes nothing.

    ``unlockedUnits`` is present only when the unlock rode in this transaction;
    it is a cross-check, not the source of truth. A settlement with no
    ``custodyRef``, and every expiry, leave the unlock to a separate transaction.
    """
    closing = next((x for x in _exercised(tx)
                    if _is_sdk(x, "GameStake") and x.get("choice") in CLOSING_CHOICES), None)
    if closing is None:
        return None
    unlocked = next((c for c in _created(tx)
                     if (c.get("templateId") or "").endswith(":Amulet")), None)
    return {
        "stakeContractId": closing["contractId"],
        "updateId": tx.get("updateId"),
        "choice": closing["choice"],
        "settledAtMicros": iso_to_micros(tx["effectiveAt"]),
        "argument": closing.get("choiceArgument") or {},
        "unlockedUnits": (_units(unlocked["createArgument"]["amount"]["initialAmount"])
                          if unlocked else None),
    }


def _exit_amounts(commit: Mapping[str, Any], closing: Mapping[str, Any]) -> dict:
    if closing["choice"] == "GameStake_Settle":
        arg = closing["argument"]
        tag = DISPOSITION_TAGS.get(arg.get("disposition"))
        if tag is None:
            raise ValueError(f"unknown disposition: {arg.get('disposition')!r}")
        return {
            "disposition": tag,
            "outcomeDigest": arg.get("outcomeDigest") or "",
            "returnedUnits": _units(arg["returnedAmount"]),
            "forfeitedUnits": _units(arg["forfeitedAmount"]),
            "payoutUnits": _units(arg["payoutAmount"]),
        }
    return {
        "disposition": CLOSING_CHOICES[closing["choice"]],
        "outcomeDigest": "",
        "returnedUnits": commit["committedUnits"],
        "forfeitedUnits": 0,
        "payoutUnits": 0,
    }


def rows_from_transactions(transactions: Iterable[Mapping[str, Any]]) -> AuditReport:
    """Joins commit and closing halves into report rows.

    Only CLOSED cycles produce rows: an open cycle has no exit half and belongs
    to no period yet. Unmatched halves are RETURNED SEPARATELY rather than
    dropped — silently discarding a commit whose closing fell outside the window
    is exactly the omission the anchor exists to make provable.
    """
    commits: dict = {}
    closings: dict = {}
    for tx in transactions:
        c = commit_facts(tx)
        if c:
            commits[c["stakeContractId"]] = c
        z = closing_facts(tx)
        if z:
            closings[z["stakeContractId"]] = z

    rows: list = []
    warnings: list = []
    for cid, commit in commits.items():
        closing = closings.get(cid)
        if closing is None:
            continue
        exit_ = _exit_amounts(commit, closing)
        if closing["unlockedUnits"] is not None and \
                closing["unlockedUnits"] != exit_["returnedUnits"]:
            # The created Amulet is an independent reading of what came back.
            # Reported rather than trusted.
            warnings.append({
                "cycleId": commit["cycleId"],
                "kind": "returned-amount-disagrees-with-unlock",
                "stated": exit_["returnedUnits"],
                "unlocked": closing["unlockedUnits"],
            })
        rows.append({
            "cycleId": commit["cycleId"],
            "player": commit["player"],
            "gameCode": commit["gameCode"],
            "concurrencyIndex": commit["concurrencyIndex"],
            "entryDigest": commit["entryDigest"],
            "outcomeDigest": exit_["outcomeDigest"],
            "committedUnits": commit["committedUnits"],
            "feeUnits": commit["feeUnits"],
            "returnedUnits": exit_["returnedUnits"],
            "forfeitedUnits": exit_["forfeitedUnits"],
            "payoutUnits": exit_["payoutUnits"],
            "disposition": exit_["disposition"],
            "committedAtMicros": commit["committedAtMicros"],
            "settledAtMicros": closing["settledAtMicros"],
            "custodyTag": commit["custodyTag"],
            # Not part of the leaf. Carried so a published report can cite the
            # two transactions each row was built from.
            "venueId": commit["venueId"],
            "commitUpdateId": commit["updateId"],
            "closingUpdateId": closing["updateId"],
        })

    open_stakes = [k for k in commits if k not in closings]
    orphan_closings = [k for k in closings if k not in commits]
    # Deterministic order, by code point, or two honest implementations compute
    # different roots over the same set. Python's tuple sort on str is already
    # code point order.
    rows.sort(key=lambda r: (r["committedAtMicros"], r["cycleId"]))
    return AuditReport(rows, warnings, open_stakes, orphan_closings)


def to_leaf_row(row: Mapping[str, Any]) -> dict:
    """Strips the reporting-only fields, leaving exactly what the leaf hashes."""
    return {k: row[k] for k in LEAF_FIELDS}
