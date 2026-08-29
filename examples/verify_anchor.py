#!/usr/bin/env python3
"""Verify a published period report against its on-ledger anchor — in Python.

The JavaScript verify-anchor.mjs and this file check the same artifacts and
must print the same hexadecimal. That is the point of having both: the scheme
is only independently verifiable if a second implementation, reading nothing
but the published description, lands on the same bytes. Where they differ, the
difference is what is worth reading.

  * Python's client DOES export ``anchor_document``; JavaScript's and Java's do
    not, so the .mjs assembles the fifteen fields by hand. Here the SDK does it.
  * ``canon_int`` refuses ``bool`` and refuses a decimal string. JavaScript's
    ``BigInt`` would happily turn ``true`` into ``1``, so the same caller
    mistake would produce two different documents that both looked successful.
  * Report order (T14) breaks ties differently in the two languages. It does
    not bite here — no two rows share a ``committedAtMicros`` — but a verifier
    that RE-SORTS the rows rather than reading them in file order is choosing a
    collation, and the two languages do not choose the same one. So this reads
    them in file order and checks the root, which is the thing that must match.

  python3 examples/verify_anchor.py             # the live TestNet report
  python3 examples/verify_anchor.py --offline   # the copy in fixtures/, no network

Options and exit codes are the same as verify-anchor.mjs:
  0  everything reproduced
  1  a verification failed
  2  reproduced, except that the served bytes are not the anchored bytes (T4)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
LIVE = "https://audit.arccade.io/testnet"

# Run from a clone with no install: the sibling source tree is the same code
# the published package ships. `pip install arccade-game-sdk` also works and
# takes precedence, because this only appends.
sys.path.append(str(HERE.parent / "python"))

from arccade_game_sdk import (  # noqa: E402
    anchor_digest,
    merkle_empty,
    merkle_proof,
    merkle_root,
    period_leaf,
    period_row_verify,
)

failures: list[str] = []
byte_findings: list[str] = []


def fail(what: str) -> None:
    failures.append(what)


def mark(ok: bool) -> str:
    return "ok  " if ok else "FAIL"


def step(n: int, what: str) -> int:
    print(f"\n{n}. {what}")
    return n


def read_bytes(base: str, name: str, offline: bool) -> bytes:
    """The EXACT bytes, never a re-serialisation.

    ``reportDigest`` commits to the file as served. Parsing first and hashing
    second would check a different object than the anchor committed to (T4).
    """
    if base.startswith(("http://", "https://")):
        if offline:
            raise SystemExit(f"--offline, but the source is a URL: {base}")
        with urllib.request.urlopen(f"{base}/{name}", timeout=30) as r:
            return r.read()
    return (Path(base) / name).read_bytes()


def totals_of(rows: list[dict]) -> dict[str, int]:
    """Totals DERIVED FROM THE ROWS.

    A correct root says nothing about the summary fields: it commits to the
    rows, not to the arithmetic over them.
    """
    def s(field: str) -> int:
        return sum(int(r[field]) for r in rows)

    return {
        "cycleCount": len(rows),
        "committedUnits": s("committedUnits"),
        "feeUnits": s("feeUnits"),
        "returnedUnits": s("returnedUnits"),
        "forfeitedUnits": s("forfeitedUnits"),
        "payoutUnits": s("payoutUnits"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--source", default=None, help="url or directory holding index.json")
    ap.add_argument("--anchors", default=str(FIXTURES / "anchors.json"))
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--period", default=None)
    args = ap.parse_args()

    source = args.source or (str(FIXTURES) if args.offline else LIVE)
    print(f"source  {source}{'   (offline)' if args.offline else ''}")

    step(1, "The index, and where the anchors are coming from")
    index = json.loads(read_bytes(source, "index.json", args.offline))
    print(f"   {index['count']} period(s) published")

    anchors: list[dict] = []
    anchor_path = Path(args.anchors)
    if anchor_path.exists():
        anchors = [a["createArgument"] for a in json.loads(anchor_path.read_text())["anchors"]]
    print(f"   anchors from {anchor_path if anchors else 'nowhere'}: {len(anchors)}")

    reports = [r for r in index["reports"] if not args.period or r["periodId"] == args.period]
    if not reports:
        raise SystemExit(f"no published period matches --period {args.period}")

    previous_anchor_digest: str | None = None

    for meta in reports:
        anchor = next((a for a in anchors if a["periodId"] == meta["periodId"]), None)
        print("\n" + "─" * 72)
        print(f"{meta['venueId']}  period {meta['periodId']}  ({meta['cycleCount']} cycles)")
        n = 0

        n = step(n + 1, "The report, hashed as bytes")
        raw = read_bytes(source, meta["name"], args.offline)
        served = hashlib.sha256(raw).hexdigest()
        report = json.loads(raw)
        print(f"   {meta['name']}")
        print(f"   sha256 {served}")
        print(f"   {mark(served == meta['servedDigest'])}  matches index.servedDigest")
        if served != meta["servedDigest"]:
            fail(f"{meta['periodId']}: served bytes differ from index.servedDigest")

        n = step(n + 1, "Every leaf, recomputed from its row")
        leaves = [period_leaf(row) for row in report["rows"]]
        for i, leaf in enumerate(leaves):
            same = leaf == report["leaves"][i]
            print(f"   {mark(same)}  [{i}] {report['rows'][i]['cycleId']}  {leaf[:16]}…")
            if not same:
                fail(f"{meta['periodId']}: leaf {i} does not reproduce")
        if not leaves:
            print("   (no rows — an empty period is still anchored)")
        if len(leaves) != len(report["leaves"]):
            fail(f"{meta['periodId']}: leaf count differs from the published one")

        n = step(n + 1, "The root, rebuilt from the leaves")
        # A lone trailing node is PROMOTED, not duplicated: the Bitcoin
        # convention (CVE-2012-2459) lets [a,b,c] and [a,b,c,c] share a root.
        root = merkle_root(leaves)
        print(f"   {root}{'   (= merkle_empty)' if not leaves else ''}")
        if not leaves and root != merkle_empty():
            fail(f"{meta['periodId']}: empty root is wrong")
        print(f"   {mark(root == report['merkleRoot'])}  matches the report's merkleRoot")
        print(f"   {mark(root == meta['anchoredRoot'])}  matches the ANCHORED root")
        if root != report["merkleRoot"]:
            fail(f"{meta['periodId']}: rebuilt root differs from the report")
        if root != meta["anchoredRoot"]:
            fail(f"{meta['periodId']}: rebuilt root differs from the anchor")

        n = step(n + 1, "An inclusion proof for every row")
        if not leaves:
            # merkle_proof returns [] for any index into an empty period, and
            # folding [] returns the leaf unchanged. An empty proof must never
            # be read as proof of anything.
            print("   nothing to prove: no rows. An empty proof proves nothing.")
        else:
            for i, row in enumerate(report["rows"]):
                proof = merkle_proof(i, leaves)
                # period_row_verify, not merkle_verify: folding a bare hash
                # returns True for an internal node too. Deriving the leaf from
                # the row binds the claim "this is a cycle" to the row schema.
                ok = period_row_verify(row, proof, root)
                print(f"   {mark(ok)}  [{i}] {row['cycleId']}  {len(proof)} step(s)")
                if not ok:
                    fail(f"{meta['periodId']}: inclusion proof failed for {row['cycleId']}")

            tampered = dict(report["rows"][0])
            tampered["returnedUnits"] = str(int(tampered["returnedUnits"]) - 1)
            refused = period_row_verify(tampered, merkle_proof(0, leaves), root) is False
            print(f"   {mark(refused)}  the same proof REFUSES the row with returnedUnits-1")
            print(f"         {report['rows'][0]['returnedUnits']} -> {tampered['returnedUnits']}")
            if not refused:
                fail(f"{meta['periodId']}: a tampered row verified against the root")

        n = step(n + 1, "Totals, re-derived from the rows")
        totals = totals_of(report["rows"])
        if anchor:
            for field, got in totals.items():
                same = got == int(anchor[field])
                print(f"   {mark(same)}  {field:<16} {got}")
                if not same:
                    fail(f"{meta['periodId']}: {field} disagrees with the anchor")
        else:
            print(f"   cycleCount {totals['cycleCount']} vs index {meta['cycleCount']}")
            print("   the rest need the anchor contract; see fixtures/anchors.json")

        n = step(n + 1, "The anchor document, reassembled field by field")
        if not anchor:
            print("   SKIPPED — no anchor contract available for this period")
        else:
            # The SDK's own builder, unlike the JavaScript side. Same fifteen
            # fields, same order, same bytes — that equality is the claim.
            digest = anchor_digest(anchor)
            print(f"   {digest}")
            print(f"   {mark(digest == anchor['anchorDigest'])}  matches anchorDigest on the contract")
            print(f"   {mark(anchor['merkleRootHex'] == root)}  the anchor commits to the root we rebuilt")
            if digest != anchor["anchorDigest"]:
                fail(f"{meta['periodId']}: anchor document does not reproduce")
            if anchor["merkleRootHex"] != root:
                fail(f"{meta['periodId']}: anchor root differs from the rebuilt root")
            # reportUri is a field of the CONTRACT, not of the document: where
            # a report is served from is not part of the commitment.
            print(f"   reportUri (not covered by the digest): {anchor['reportUri']}")

            n = step(n + 1, "The chain")
            if previous_anchor_digest is None:
                shown = '""  (start of the chain)' if anchor["prevAnchorDigest"] == "" else anchor["prevAnchorDigest"]
                print(f"   prevAnchorDigest {shown}")
                if anchor["prevAnchorDigest"] != "":
                    print("   this is not the first period — run without --period to walk it")
            else:
                linked = anchor["prevAnchorDigest"] == previous_anchor_digest
                print(f"   {mark(linked)}  prevAnchorDigest is the previous period's anchorDigest")
                print(f"         {anchor['prevAnchorDigest']}")
                if not linked:
                    fail(f"{meta['periodId']}: chain link broken — a period is missing or reordered")
            previous_anchor_digest = anchor["anchorDigest"]

        n = step(n + 1, "The bytes the anchor actually commits to")
        anchored = anchor["reportDigest"] if anchor else meta["anchoredDigest"]
        print(f"   served   {served}")
        print(f"   anchored {anchored}")
        print(f"   {mark(served == anchored)}  the file served is the file anchored")
        if served != anchored:
            byte_findings.append(meta["periodId"])
            print(
                "\n   T4. The rows are intact — every leaf and the root reproduced above —\n"
                "   but these bytes are not the bytes the ledger was made to commit to.\n"
                "   Publish a report's bytes once and serve them byte-stable forever."
            )

    print("\n" + "─" * 72)
    if failures:
        print(f"\n{len(failures)} verification(s) failed:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    if byte_findings:
        print(
            f"\nRows, roots, proofs, anchors and the chain all reproduce.\n\n"
            f"The served bytes do not match the anchored bytes for: {', '.join(byte_findings)}.\n"
            f"Exit 2 — see T4 in docs/INTEGRATION.md.\n"
        )
        return 2
    print(
        "\nEverything reproduced, from the bytes up, and the hexadecimal above is\n"
        "identical to what verify-anchor.mjs prints. Two implementations, one\n"
        "canonical form — which is what makes the anchor evidence rather than a\n"
        "record arCCade keeps.\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
