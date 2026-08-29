#!/usr/bin/env python3
"""arccade-sdk-digest-v1/sha256 — golden-vector self-check for the Python client.

The logic now lives in the installable package at ``python/arccade_game_sdk``;
this file is the CI entry point and the compatibility shim for anything that
still imports ``tools.digest_reference``. It re-exports the package's names and
runs the golden vectors.

The point of a third implementation is that a third party can verify without
trusting arCCade. The Daml side (ArCCade.GameSdk.Digest) and the JavaScript
client must produce the SAME values as this one; if one of them drifts, CI
breaks. The outermost layer of verification needs no library at all: running

    sha256sum <document>

over a published canonical document gives the digest that is on the chain.

Run:  python3 tools/digest_reference.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from arccade_game_sdk import (  # noqa: E402
    DISPOSITIONS, SCHEME_PREFIX, amount_units, canon, canon_bool, canon_decimal,
    canon_document, canon_fields, canon_int, canon_list, canon_optional,
    canon_party, canon_text, canon_time_micros, document_digest, merkle_empty,
    merkle_node, merkle_pair_up, merkle_proof, merkle_root, merkle_verify,
    period_leaf, period_leaf_document, period_row_verify, text_digest,
)
from arccade_game_sdk.games import (  # noqa: E402
    pr_entry_document, tw_allocation, tw_entry_document, tw_price_point,
)

__all__ = [
    "SCHEME_PREFIX", "DISPOSITIONS", "canon", "canon_text", "canon_int",
    "canon_bool", "canon_decimal", "canon_time_micros", "canon_party",
    "canon_optional", "canon_list", "canon_fields", "canon_document",
    "amount_units", "text_digest", "document_digest", "merkle_empty",
    "merkle_node", "merkle_pair_up", "merkle_root", "merkle_proof",
    "merkle_verify", "period_leaf", "period_leaf_document", "period_row_verify",
    "tw_price_point", "tw_allocation", "tw_entry_document", "pr_entry_document",
]

TW_SAMPLE = dict(
    cycle_id="tw-sample-1",
    tier="silver",
    virtual_balance="10000.0",
    allocations=[("BTC", "60.0"), ("ETH", "40.0")],
    entry_prices=[
        ("BTC", "60000.0", "binance", 1_000_000),
        ("ETH", "3000.0", "binance", 1_000_000),
    ],
)

PR_SAMPLE = dict(
    cycle_id="pr-sample-1",
    tier="bronze",
    max_games=3,
    seed_commit="0" * 64,
)

GOLDEN_ROW = {
    "cycleId": "cycle-golden",
    "player": "auditor-golden-party",
    "gameCode": "pixel-race-v1",
    "concurrencyIndex": 0,
    "entryDigest": "0" * 63 + "1",
    "outcomeDigest": "0" * 63 + "2",
    "committedUnits": 300000000000,
    "feeUnits": 100000000,
    "returnedUnits": 300000000000,
    "forfeitedUnits": 0,
    "payoutUnits": 0,
    "disposition": "returned-in-full",
    "committedAtMicros": 1700000000000000,
    "settledAtMicros": 1700000003600000,
    "custodyTag": "arccade-game-sdk:1:cycle-golden:x",
}

# Values produced by the Daml side (Test.GameSdk.VectorsTest:documentTexts).
EXPECTED_MERKLE_EMPTY = "c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0"
EXPECTED_MERKLE_ROOT3 = "f31cc766e62a52c3c3156e05d53fde76f54fed6067d283dc9a3d8ada9d0ceedf"
EXPECTED_MERKLE_NODE = "aa3de7939ca80f5110e8b29ec442d9d770f525dfb63e86ff59e7624ff110e720"
EXPECTED_ROW_LEAF = "01e89a905ec52a23012354b602cdf583a7bc6dd92d9c36a19aa0346a1cf26237"

EXPECTED_TW_DIGEST = "5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852"
EXPECTED_PR_DIGEST = "0b2349e05633cf279ca0ee1d3f5efd8b2308f3e2ee947a32f5c3397e456d0204"


def main() -> int:
    tw_doc = tw_entry_document(**TW_SAMPLE)
    pr_doc = pr_entry_document(**PR_SAMPLE)
    tw = text_digest(tw_doc)
    pr = text_digest(pr_doc)

    ok = True
    for label, got, want in (("trade-wars", tw, EXPECTED_TW_DIGEST),
                             ("pixel-race", pr, EXPECTED_PR_DIGEST)):
        status = "OK " if got == want else "SAPMA"
        if got != want:
            ok = False
        print(f"  {status} {label}: {got}")
        if got != want:
            print(f"        beklenen: {want}")

    leaves = [text_digest(f"leaf-{n}") for n in (1, 2, 3)]
    for label, got, want in (
        ("merkle bos kok", merkle_empty(), EXPECTED_MERKLE_EMPTY),
        ("merkle kok(3)", merkle_root(leaves), EXPECTED_MERKLE_ROOT3),
        ("merkle ic dugum", merkle_node(leaves[0], leaves[1]), EXPECTED_MERKLE_NODE),
        ("denetim satiri yapragi", period_leaf(GOLDEN_ROW), EXPECTED_ROW_LEAF),
    ):
        status = "OK " if got == want else "SAPMA"
        if got != want:
            ok = False
        print(f"  {status} {label}: {got}")
        if got != want:
            print(f"        beklenen: {want}")

    # The proof system: every index at every size must verify, and a forgery
    # must not.
    for n in range(1, 10):
        ls = [text_digest(f"x-{i}") for i in range(n)]
        root = merkle_root(ls)
        for ix in range(n):
            if not merkle_verify(ls[ix], merkle_proof(ix, ls), root):
                ok = False
                print(f"  SAPMA icerme kaniti: boyut {n} indeks {ix}")
    forged = dict(GOLDEN_ROW, committedUnits=999900000000)
    rows = [dict(GOLDEN_ROW, cycleId=f"c-{i}") for i in range(5)]
    ls = [period_leaf(r) for r in rows]
    if not period_row_verify(rows[2], merkle_proof(2, ls), merkle_root(ls)):
        ok = False
        print("  SAPMA gercek satir dogrulanmadi")
    if period_row_verify(forged, merkle_proof(2, ls), merkle_root(ls)):
        ok = False
        print("  SAPMA UYDURULMUS SATIR DOGRULANDI")

    print(f"  {'OK ' if ok else 'SAPMA'} parite")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
