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

**A consequence worth stating, because it will surprise you.** New exports can
appear in a patch release. 1.5.2 added nine capabilities — period-anchor and
policy documents, the settlement invariant, and the four ledger-time operators.
Plain semver would call that a minor bump. It is a patch here because the
*agreement did not move*: those values were already defined by the 1.5.0
contracts and the client was simply behind. A client catching up to an agreement
that already exists has not changed the agreement.

The rule is therefore: **major.minor answers "which contract am I speaking to",
not "how much of it have I implemented".** If you need the second question
answered, the conformance suite answers it exactly — `conformance/manifest.json`
lists all 72 capabilities and which client implements each.

## 1.5.3 changes behaviour that used to be silently wrong

Nine defects are fixed here and every one of them **throws where it previously
returned**. That is a runtime break for a caller who was relying on the old
answer — and relying on it meant computing a value the ledger would not accept,
so the break is the point:

- `canonInt(true)` returned `i:1:1`; a boolean now throws. `BigInt(true)` is 1n,
  so `true` and `1` produced the same document.
- `textDigest('')` returned the sha256 of nothing; empty text now throws. Daml's
  `toHex ""` is a runtime error, so that digest was one the ledger could never
  compute.
- `tradeDocument` / `transferDocument` joined components with `|` without
  screening for it. A party name or meta value containing a pipe reshaped the
  document, so two different inputs signed as one. Now refused.
- `buildCommitCommands` wrote `String(undefined)` — the literal text
  `undefined` — as `feeAmount` when it was omitted. Now refused; a free venue
  passes `'0.0'`.
- `amountUnits(' 1.0')` trimmed and accepted. Untrimmed input is now refused,
  because `' 1.0'` and `'1.0'` resolving to the same units means two inputs
  reach one commitment.
- `assertValidCycleId` counted UTF-16 units, so it rejected a valid 64
  code-point id the ledger accepts.
- `canonTime` routed through `Date.parse` and truncated microseconds to
  milliseconds, producing a digest Daml would not reproduce.
- `rowsFromTransactions` broke ties with `localeCompare` — locale- and
  ICU-version-dependent — so two honest implementations could publish
  **different Merkle roots over the same cycles**. Now ordered by Unicode code
  point, and `REPORT_ORDER` says so.

The version is a PATCH under the policy above: the *agreement* did not move.
These were always the rules; the client was wrong about them. All 470
conformance cases now pass in JavaScript, Python and Java alike.

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
