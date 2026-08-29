# arccade-game-sdk (Python)

The third implementation of `arccade-sdk-digest-v1/sha256`, alongside
`daml/ArCCade/GameSdk/` and `js/src/`. Standard library only.

```bash
pip install ./python          # or: PYTHONPATH=./python python3 -c 'import arccade_game_sdk'
```

```python
from arccade_game_sdk import period_leaf, merkle_root, merkle_proof, period_row_verify

leaves = [period_leaf(r) for r in rows]          # rows in REPORT_ORDER
root   = merkle_root(leaves)
assert period_row_verify(rows[2], merkle_proof(2, leaves), root)
```

## What this client is for

Verification that does not depend on arCCade. The outermost layer needs no
library at all — `sha256sum` over a published canonical document yields the
digest that is on the ledger. This package is the layer above that: it rebuilds
report rows from the ledger's transaction-tree stream, recomputes leaves, roots
and inclusion proofs, reproduces the period anchor, and builds the ledger
commands for the two-write cycle, trades and transfers.

## Where it deliberately differs from the JavaScript client

The conformance suite in `../conformance/` is the authority when the
implementations disagree; this client follows the suite. That means it is
*stricter* than `js/src/` in seven places, each of which is a decision recorded
in the manifest:

| | |
|---|---|
| D1 | report order breaks ties by Unicode code point |
| D2 | the cycleId limit is 64 **code points** |
| D3 | any ISO→micros conversion on a document path is microsecond-exact |
| D7 | `text_digest("")` is refused — Daml can never produce that value |
| D8 | trade/transfer documents refuse a `\|` in any component |
| D9 | `canon_int(True)` is refused |
| D11 | `REPORT_ORDER` names its collation |

It also enforces what earlier Python did not: the Daml Int band, the ASCII
field-name rule, refusal of a native `float` as an amount, and refusal of
untrimmed whitespace around a decimal.

## Layout

| module | contents |
|---|---|
| `digest` | canonical encoding, amounts, Merkle, audit leaves |
| `cycle_audit` | transaction tree → report rows, `REPORT_ORDER` |
| `cycle` | cycle ids, custody tags, the two-write command builders |
| `trade`, `transfer` | value documents and their command builders |
| `tenant`, `assets` | isolation, namespacing, keys, quota, instruments |
| `audit`, `policy`, `settlement` | period anchor, venue policy, settlement invariants |
| `ledger_time` | Daml's truncate-toward-zero time arithmetic |
| `games` | Trade Wars / Pixel Race entry and outcome documents |

## Tests

```bash
python3 -m unittest discover -s python/tests            # unit tests
python3 conformance/runners/run.py                      # the shared conformance suite
python3 tools/digest_reference.py                       # golden vectors
python3 tools/cycle_audit_reference.py                  # the TestNet tree fixture
```
