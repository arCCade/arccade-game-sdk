#!/usr/bin/env python3
"""Rebuilding period-report rows from ledger transaction trees — Python reference.

Reads the SAME two files the JavaScript and Java implementations do:

    test-vectors/cycle-trees.json   real TestNet transactions (LEDGER_EFFECTS)
    test-vectors/cycle-rows.json    the rows, leaves and root they must produce

That pairing is the point. A period anchor is evidence only if the rows behind
it derive from the stream an auditor reads, and that derivation is only
verifiable if anyone can run it in whatever language they already have. So the
rules live in a fixture, not in one implementation.

Run:  python3 tools/cycle_audit_reference.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from decimal import Decimal  # noqa: E402

from digest_reference import (  # noqa: E402
    amount_units, merkle_root, period_leaf,
)


def units(decimal_string: str) -> int:
    """Ledger amounts arrive as decimal STRINGS. Parsing via Decimal keeps the
    exact digits; float would lose them before amount_units could complain."""
    return amount_units(Decimal(decimal_string))

SDK_MODULE = "ArCCade.GameSdk.Cycle"

# Abort and expiry state no disposition; it follows from WHICH choice closed
# the cycle. Only settlement names one.
CLOSING_CHOICES = {
    "GameStake_Settle": None,
    "GameStake_Abort": "aborted",
    "GameStake_ExpireUnsettled": "expired-unsettled",
}

DISPOSITION_TAGS = {
    "ReturnedInFull": "returned-in-full",
    "ReturnedWithForfeit": "returned-with-forfeit",
    "ForfeitedInFull": "forfeited-in-full",
    "Aborted": "aborted",
    "ExpiredUnsettled": "expired-unsettled",
}

_TS = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$")


def iso_to_micros(iso: str) -> int:
    """ISO 8601 -> integer microseconds. Ledger stamps carry microseconds;
    anything that truncates to milliseconds stops matching Daml."""
    m = _TS.match(iso)
    if not m:
        raise ValueError(f"arccade-game-sdk: unparsable ledger timestamp: {iso}")
    import calendar
    y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
    seconds = calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0))
    frac = ((m.group(7) or "") + "000000")[:6]
    return seconds * 1_000_000 + int(frac)


def _exercised(tx):
    return [e["ExercisedEvent"] for e in tx.get("events", []) if "ExercisedEvent" in e]


def _created(tx):
    return [e["CreatedEvent"] for e in tx.get("events", []) if "CreatedEvent" in e]


def _is_sdk(node, entity):
    return f"{SDK_MODULE}:{entity}" in (node.get("templateId") or "")


def commit_facts(tx):
    """The entry half. None when this transaction is not a commit."""
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
        "committedUnits": units(a["terms"]["stakeAmount"]),
        "feeUnits": units(a["terms"]["feeAmount"]),
        "custodyTag": a["terms"]["custodyTag"],
    }


def closing_facts(tx):
    """The exit half. `unlockedUnits` is a cross-check when the unlock rode in
    the same transaction — it is not always there."""
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
        "unlockedUnits": (units(unlocked["createArgument"]["amount"]["initialAmount"])
                          if unlocked else None),
    }


def _exit_amounts(commit, closing):
    if closing["choice"] == "GameStake_Settle":
        arg = closing["argument"]
        tag = DISPOSITION_TAGS.get(arg.get("disposition"))
        if tag is None:
            raise ValueError(f"unknown disposition: {arg.get('disposition')!r}")
        return {
            "disposition": tag,
            "outcomeDigest": arg.get("outcomeDigest", ""),
            "returnedUnits": units(arg["returnedAmount"]),
            "forfeitedUnits": units(arg["forfeitedAmount"]),
            "payoutUnits": units(arg["payoutAmount"]),
        }
    # Unlocking a TimeLockedHolding always pays the owner in full and this
    # mechanic cannot forfeit, so an aborted or expired cycle returns the
    # stake and moves nothing else. The empty outcome digest is not a failure
    # to find one -- no outcome ever existed.
    return {
        "disposition": CLOSING_CHOICES[closing["choice"]],
        "outcomeDigest": "",
        "returnedUnits": commit["committedUnits"],
        "forfeitedUnits": 0,
        "payoutUnits": 0,
    }


LEAF_FIELDS = ("cycleId", "player", "gameCode", "concurrencyIndex", "entryDigest",
               "outcomeDigest", "committedUnits", "feeUnits", "returnedUnits",
               "forfeitedUnits", "payoutUnits", "disposition", "committedAtMicros",
               "settledAtMicros", "custodyTag")


def rows_from_transactions(transactions):
    """Joins the two halves BY STAKE CONTRACT ID.

    A closing choice does not repeat cycleId -- it lives on the contract being
    exercised -- so the commit's exerciseResult (that contract id) is the only
    thing linking the halves in the stream.
    """
    commits, closings = {}, {}
    for tx in transactions:
        c = commit_facts(tx)
        if c:
            commits[c["stakeContractId"]] = c
        z = closing_facts(tx)
        if z:
            closings[z["stakeContractId"]] = z

    rows, warnings = [], []
    for cid, commit in commits.items():
        closing = closings.get(cid)
        if closing is None:
            continue
        exit_ = _exit_amounts(commit, closing)
        if closing["unlockedUnits"] is not None and closing["unlockedUnits"] != exit_["returnedUnits"]:
            warnings.append({"cycleId": commit["cycleId"],
                             "kind": "returned-amount-disagrees-with-unlock",
                             "stated": str(exit_["returnedUnits"]),
                             "unlocked": str(closing["unlockedUnits"])})
        row = {k: commit.get(k, exit_.get(k)) for k in LEAF_FIELDS}
        row["settledAtMicros"] = closing["settledAtMicros"]
        rows.append(row)

    open_stakes = [k for k in commits if k not in closings]
    orphan_closings = [k for k in closings if k not in commits]
    # Deterministic order, or two honest implementations compute different roots.
    rows.sort(key=lambda r: (r["committedAtMicros"], r["cycleId"]))
    return rows, warnings, open_stakes, orphan_closings


def main() -> int:
    root_dir = Path(__file__).resolve().parent.parent
    trees = json.loads((root_dir / "test-vectors" / "cycle-trees.json").read_text())
    expected = json.loads((root_dir / "test-vectors" / "cycle-rows.json").read_text())

    txs = [t for c in trees["cases"] for t in (c["commitTransaction"], c["closingTransaction"])]
    rows, warnings, open_stakes, orphans = rows_from_transactions(txs)

    ok = True

    def check(label, got, want):
        nonlocal ok
        good = got == want
        ok = ok and good
        print(f"  {'OK ' if good else 'SAPMA'} {label}")
        if not good:
            print(f"        beklenen: {want}")
            print(f"        cikan   : {got}")

    got_rows = [{k: (str(v) if isinstance(v, int) and not isinstance(v, bool) else v)
                 for k, v in r.items()} for r in rows]
    check("satirlar", got_rows, expected["rows"])

    leaves = [period_leaf(r) for r in rows]
    check("yapraklar", leaves, expected["leaves"])
    check("merkle kok", merkle_root(leaves), expected["merkleRoot"])
    check("uyari yok", warnings, [])
    check("acik/oksuz yok", [open_stakes, orphans], [[], []])

    # Kapanis yollarinin ucu de fixture'da olmali; eksik bir yol, o yolu yanlis
    # kuran bir implementasyonun testten gecmesi demektir.
    check("uc kapanis yolu da kapsanmis",
          sorted(c["closingChoice"] for c in trees["cases"]),
          ["GameStake_Abort", "GameStake_ExpireUnsettled", "GameStake_Settle"])

    print(f"  {'OK ' if ok else 'SAPMA'} parite")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
