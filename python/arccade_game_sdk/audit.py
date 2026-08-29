"""The period anchor — the package's only mechanism that proves OMISSION.

WHY IT EXISTS. The price of two writes per cycle is that the outcome travels in
the settlement's exercise node and is invisible in the flat stream. If an auditor
sees a lock on Scan and cannot find that cycle in arCCade's report, the only way
to prove it is a commitment over the WHOLE report. That is the anchor: one write
per period, a Merkle root over 100% of that period's cycles, and a digest chained
to the previous period.

WHAT IS PROVEN AND WHAT IS DECLARED — the distinction matters and is not hidden:

  PROVEN (Daml recomputes it; the venue cannot lie)
    merkleRootHex, anchorDigest, cycleCount, committedUnits, feeUnits,
    returnedUnits, forfeitedUnits, payoutUnits

  DECLARED (arrives as an argument; the contract cannot check it)
    reportUri, reportDigest, prevAnchorDigest, qualifyingTxCount,
    nonQualifyingTxCount

Until now NO SHIPPED CLIENT could reproduce ``anchorDocument``: Daml decided the
anchor and the live TestNet anchor sat on disk with nothing able to re-derive it
outside the ledger. This module closes that.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

from .digest import canon_document, canon_int, canon_text, text_digest

__all__ = ["ANCHOR_FIELDS", "anchor_document", "anchor_digest", "anchor_totals"]

ANCHOR_FIELDS = (
    "venueId", "periodId", "periodStartMicros", "periodEndMicros", "cycleCount",
    "committedUnits", "feeUnits", "returnedUnits", "forfeitedUnits",
    "payoutUnits", "qualifyingTxCount", "nonQualifyingTxCount", "merkleRootHex",
    "reportDigest", "prevAnchorDigest",
)


def anchor_document(anchor: Mapping[str, Any]) -> str:
    """The anchor's canonical text. ``anchorDigest`` is its sha256, and the next
    link in the chain carries that value as ``prevAnchorDigest``."""
    return canon_document("arccade.period-anchor", 1, [
        ("venueId", canon_text(anchor["venueId"])),
        ("periodId", canon_text(anchor["periodId"])),
        ("periodStartMicros", canon_int(anchor["periodStartMicros"])),
        ("periodEndMicros", canon_int(anchor["periodEndMicros"])),
        ("cycleCount", canon_int(anchor["cycleCount"])),
        ("committedUnits", canon_int(anchor["committedUnits"])),
        ("feeUnits", canon_int(anchor["feeUnits"])),
        ("returnedUnits", canon_int(anchor["returnedUnits"])),
        ("forfeitedUnits", canon_int(anchor["forfeitedUnits"])),
        ("payoutUnits", canon_int(anchor["payoutUnits"])),
        ("qualifyingTxCount", canon_int(anchor["qualifyingTxCount"])),
        ("nonQualifyingTxCount", canon_int(anchor["nonQualifyingTxCount"])),
        ("merkleRootHex", canon_text(anchor["merkleRootHex"])),
        ("reportDigest", canon_text(anchor["reportDigest"])),
        ("prevAnchorDigest", canon_text(anchor["prevAnchorDigest"])),
    ])


def anchor_digest(anchor: Mapping[str, Any]) -> str:
    return text_digest(anchor_document(anchor))


def anchor_totals(rows: Iterable[Mapping[str, Any]]) -> dict:
    """Period totals DERIVED FROM THE ROWS, never taken from the caller.

    Otherwise a venue could publish a correct root and lie in the summary
    fields: the root says nothing about whether the summary is right.

    A repeated ``cycleId`` inside one period is refused. A duplicate would be
    counted twice in the totals while the Merkle proof for each copy still
    verified, which is precisely the shape of a mistake this anchor exists to
    make visible.
    """
    totals = {
        "cycleCount": 0,
        "committedUnits": 0,
        "feeUnits": 0,
        "returnedUnits": 0,
        "forfeitedUnits": 0,
        "payoutUnits": 0,
    }
    seen = set()
    for r in rows:
        cycle_id = r["cycleId"]
        if cycle_id in seen:
            raise ValueError(f"duplicate cycleId in a period: {cycle_id!r}")
        seen.add(cycle_id)
        totals["cycleCount"] += 1
        for k in ("committedUnits", "feeUnits", "returnedUnits",
                  "forfeitedUnits", "payoutUnits"):
            value = r[k]
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"Cannot convert {value} to an integer")
            totals[k] += value
    return totals
