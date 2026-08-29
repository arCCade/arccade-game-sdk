#!/usr/bin/env python3
"""Rebuilding period-report rows from ledger transaction trees — fixture check.

The logic now lives in the installable package at ``python/arccade_game_sdk``
(``arccade_game_sdk.cycle_audit``); this file is the CI entry point and the
compatibility shim for anything that still imports ``tools.cycle_audit_reference``.

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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from arccade_game_sdk import (  # noqa: E402
    amount_units, merkle_root, period_leaf,
)
from arccade_game_sdk.cycle_audit import (  # noqa: E402
    CLOSING_CHOICES, DISPOSITION_TAGS, LEAF_FIELDS, REPORT_ORDER, SDK_MODULE,
    closing_facts, commit_facts, iso_to_micros, rows_from_transactions,
    to_leaf_row,
)

__all__ = [
    "units", "iso_to_micros", "commit_facts", "closing_facts",
    "rows_from_transactions", "to_leaf_row", "LEAF_FIELDS", "REPORT_ORDER",
    "SDK_MODULE", "CLOSING_CHOICES", "DISPOSITION_TAGS",
]


def units(decimal_string: str) -> int:
    """Ledger amounts arrive as decimal STRINGS. Kept as a named entry point
    because callers of this module used it directly."""
    return amount_units(decimal_string)


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

    # The published fixture states only the fifteen leaf fields; the rows carry
    # three more so a report can cite the transactions it was built from.
    got_rows = [{k: (str(v) if isinstance(v, int) and not isinstance(v, bool) else v)
                 for k, v in to_leaf_row(r).items()} for r in rows]
    check("satirlar", got_rows, expected["rows"])

    leaves = [period_leaf(r) for r in rows]
    check("yapraklar", leaves, expected["leaves"])
    check("merkle kok", merkle_root(leaves), expected["merkleRoot"])
    check("uyari yok", warnings, [])
    check("acik/oksuz yok", [open_stakes, orphans], [[], []])

    # All three closing paths must be in the fixture; a missing path means an
    # implementation that builds it wrongly still passes.
    check("uc kapanis yolu da kapsanmis",
          sorted(c["closingChoice"] for c in trees["cases"]),
          ["GameStake_Abort", "GameStake_ExpireUnsettled", "GameStake_Settle"])

    print(f"  {'OK ' if ok else 'SAPMA'} parite")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
