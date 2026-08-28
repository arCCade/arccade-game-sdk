# @arccade/game-sdk

JavaScript client for the [Gaming SDK for Canton](https://github.com/arCCade/arccade-game-sdk)
— the off-ledger half of a two-write game cycle on the Canton Network.

```bash
npm install @arccade/game-sdk
```

Requires Node 20 or later. No runtime dependencies.

## What this package is for

The Daml package (`arccade-game-sdk`) holds the contracts. This one holds
everything a client needs to speak to them **correctly**, which in practice
means everything that has to produce the same bytes the ledger will produce:

- the **commitment scheme** `arccade-sdk-digest-v1/sha256` — canonical document
  encoding, digests, integer amount units;
- the **period audit** side — Merkle trees, cycle-audit-row leaves, inclusion
  proofs, and rebuilding report rows from the ledger's transaction tree;
- helpers for cycle ids, custody tags, tenant keys and asset instrument ids.

**MAJOR.MINOR tracks the Daml package; PATCH does not.** 1.5.x of this client
talks to 1.5.0 of the contracts. The two encode one agreement, and letting
them drift is how a client starts computing a digest the ledger will reject —
that already happened once, at 1.1.0 against a 1.5.0 ledger package, unnoticed
because the only consumer was a local `file:` dependency.

Patch is free to move on its own so that a client-only change — a packaging
fix, a helper, better types — does not require a new Daml package and another
round of on-chain vetting, which is governance-paced. The release workflow
enforces exactly this.

## Why a digest has to match exactly

`GameStake_Settle` recomputes the commitment on the ledger and rejects a
mismatch. A digest that differs by one byte does not produce a warning — it
produces a stake that cannot be settled. That is why this implementation is
pinned by golden vectors against the Daml, Python and Java ones:

```js
import { documentDigest, canonText, canonInt } from '@arccade/game-sdk'

const digest = documentDigest('my-game-entry', 1, [
  ['cycleId', canonText('pr-abc123')],
  ['seed', canonInt(42n)],
])
```

Two rules the encoding will not let you break quietly: lengths are counted in
**Unicode code points**, and amounts are hashed as **integer 1e-10 units**,
never as formatted decimals.

## Verifying a published period

Every cycle arCCade settles is committed to a daily Merkle root written on
Canton in a `VenuePeriodAnchor`. Given a published report you can check a row
belongs to it without trusting the publisher:

```js
import { periodLeaf, merkleProof, periodRowVerify, merkleRoot } from '@arccade/game-sdk'

const leaves = report.rows.map(periodLeaf)
const root = merkleRoot(leaves)                      // compare with the anchor
const ok = periodRowVerify(report.rows[2], merkleProof(2, leaves), root)
```

Use `periodRowVerify`, not `merkleVerify`, when the claim is "this cycle is in
the report". `merkleVerify` folds a hash and cannot know whether it started
from a leaf or an internal node; deriving the leaf from the row is what binds
the claim to the row schema.

## Rebuilding rows from the ledger

`rowsFromTransactions` turns a `TRANSACTION_SHAPE_LEDGER_EFFECTS` stream into
report rows, so an auditor can produce the report themselves rather than taking
one. The rules live in fixtures — `test-vectors/cycle-trees.json` and
`cycle-rows.json` in the repository — and the Python and Java implementations
assert against the same pair.

Two things it does that are easy to get wrong: it joins the commit and closing
halves by the **stake contract id** (a closing choice does not repeat the cycle
id), and it reports unmatched halves instead of dropping them.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
