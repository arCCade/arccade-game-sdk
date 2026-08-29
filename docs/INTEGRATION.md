# Integration

For a studio that has finished [`GETTING-STARTED.md`](GETTING-STARTED.md) and
now has to run a real game against real value, without arCCade operating
anything for them.

That guide gets a dry-run cycle onto a participant. This one covers what comes
after: live custody, every way a cycle can end and who controls each, how a
third party verifies a period with no arCCade API, where the SDK stops and your
code starts, and the traps that have already cost this project time. It does
not restate the design — [`DESIGN.md`](DESIGN.md) has the reasoning and an
implementation-status table, [`../README.md`](../README.md) has the shape of the
package, [`../js/README.md`](../js/README.md), [`../python/README.md`](../python/README.md)
and [`../java/README.md`](../java/README.md) have each client's own surface, and
[`../conformance/README.md`](../conformance/README.md) has the manifest that says
what "these clients agree" is allowed to mean.

Everything asserted here was run against the working tree or against the
published TestNet artifacts on 2026-08-28. Where a claim is checkable, the
check is printed next to it. Where something is broken today, it says so.

---

## 1. The boundary

The SDK is a **contract package plus an encoder**. It is not a service, not a
framework and not a ledger client.

| You get | You build |
|---|---|
| The Daml package: `GameVenue`, `PlayerRoster`, `PlayerEntitlement`, `GameStake`, `VenuePeriodAnchor`, and the choices that enforce the cycle | Submitting anything at all. There is no HTTP client in the SDK |
| Command **builders** that emit JSON Ledger API v2 payloads (`buildCommitCommands`, `buildSettleCommands`, `buildAbortCommands`, `buildExpireCommands`) | Resolving `amuletRulesCid`, `openMiningRoundCid`, `dsoParty`, `inputAmuletCids`, and fetching the two disclosed contracts from Scan |
| The commitment scheme — `canon*`, `canonDocument`, `documentDigest`, `amountUnits` — in Daml, JS, Python and Java, held to byte-identical output by `conformance/manifest.json`, which also records where the clients disagree today | Your game's entry and outcome **documents**: which fields, what they mean, when you publish them |
| Merkle construction, inclusion proofs, `periodLeaf`, `periodRowVerify` | The anchoring job, the report file, and wherever you publish it |
| `rowsFromTransactions` — report rows derived from a `TRANSACTION_SHAPE_LEDGER_EFFECTS` stream | Reading that stream. See trap **T1** |
| Identifier and tag validators (`assertValidCycleId`, `assertHex64`, `custodyTagFor`), tenancy and asset helpers | Matchmaking, scoring, sessions, leaderboards, retries, monitoring, key custody — the game |

Four things it explicitly does **not** do, because assuming otherwise is the
most common way this integration goes wrong:

1. **It does not submit.** Every builder returns `{ commands, actAs, readAs,
   submission }` and stops. Nothing in `@arccade/game-sdk` opens a socket.
2. **It does not fetch disclosed contracts.** `AmuletRules` and
   `OpenMiningRound` are invisible on your participant. Without them the live
   commit fails with `CONTRACT_NOT_FOUND`. §2.1.
3. **It does not run your game.** `gameCode` is a `Text` the package never
   interprets; the two documents behind the digests are yours.
4. **It does not ship the game adapters.** `npm pack` yields `src/`,
   `index.d.ts`, `README`, `LICENSE`, `NOTICE` — thirteen files, no `examples/`.
   The Trade Wars and Pixel Race document builders in `js/examples/` are worked
   examples in the repository, not published API. Build your documents from
   `canonDocument` and the `canon*` primitives, which are published.

```bash
cd js && npm pack --dry-run     # the exact list of what a consumer receives
```

---

## 2. Write 1 — commitment, with live custody

Dry-run commit is one command. Live commit is **two commands in one
submission**, and everything hard about this integration is in that sentence.

    AmuletRules_Transfer   → fee Amulet to the venue
                             LockedAmulet to the player (the encumbrance)
                             change Amulet back to the player
    Entitlement_Commit     → PlayerEntitlement archived
                             GameStake created

One transaction, one `updateId`. Apart, a `GameStake` can exist with nothing
funding it.

### 2.1 What you must resolve before you can build the commands

`buildCommitCommands` needs four things the SDK cannot know:

| Input | Where it comes from |
|---|---|
| `amuletRulesCid`, `dsoParty`, `amuletPackageId` | Scan: `POST /api/scan/v0/amulet-rules`. The package id is the prefix of the returned `template_id` — read it there rather than configuring it twice |
| `openMiningRoundCid` | Scan: `POST /api/scan/v0/open-and-issuing-mining-rounds` |
| `disclosedContracts` | Both of the above, reshaped as `{ templateId, contractId, createdEventBlob }` |
| `inputAmuletCids` | Your participant's ACS for the player, filtered to `:Amulet` and **excluding** `LockedAmulet` |

None of that resolution is in the SDK: there is no Scan client here, and this
section is the specification, not a pointer to one. arCCade's own resolver is
not open, so the three rules below are stated in full rather than delegated to
code you would have to be inside arCCade to read. They were each learned by
being wrong about them in production:

- **Cache with a short TTL, and invalidate on failure.** 60s for `AmuletRules`,
  30s for the open round is what runs today.
- **Scan can hand you a round the synchronizer has already archived.** The
  submission comes back `INACTIVE_CONTRACTS`. Retrying with the same round
  returns the same error; you have to exclude the failed contract id and ask
  Scan again. Prefer a round whose `opensAt` is already in the past — Scan will
  happily announce one your participant has not seen yet.
- **Input selection must overshoot.** The Splice transfer fee comes out of the
  inputs, so selecting exactly `stake + fee` is not enough. Select until the sum
  **exceeds** the requirement; do not look for exact equality.

### 2.2 The binding is atomicity plus the tag, not a reference

The two commands **cannot see each other**. A single submission has no
output-to-input chaining, so `Entitlement_Commit` cannot be handed the
`LockedAmulet` contract id that the sibling transfer is creating in the same
transaction. There is no field in `GameStake` pointing at the lock and there
cannot be one.

What ties them together instead is a string, written into the lock by the
registry and into the stake by the SDK:

    arccade-game-sdk:1:<cycleId>:<entryDigest>

It goes into `TimeLock.optContext` on the transfer output and into
`terms.custodyTag` on the commit, and `GameStake.ensure` requires
`terms.custodyTag == custodyTagFor cycleId entryDigest` — so a stake carrying
the wrong tag is not creatable at all. At settlement `verifyLockedHolding`
fetches the locked holding through the standard `Holding` interface and asserts
owner, instrument, amount, holder set, expiry **and** `lock.context` against
that same tag.

Two consequences worth stating plainly:

- The tag is on a **DSO-signed** contract. An auditor who can see the lock can
  read which cycle it belongs to and which entry commitment it was made
  against, without any arCCade endpoint and without trusting the app.
- Writing a generic string there — the shared literal `"arCCade game stake"`
  that the legacy path used — produces a lock that settlement can never verify.
  The cycle becomes abort-only. The SDK computes the tag for you and
  `buildCommitCommands` will not let you override it; if you build the transfer
  command yourself, this is the field to get right.

Never call `assertValidCycleId` on a hand-made id and consider yourself done —
use `newCycleId()`. See **T9**.

### 2.3 The submission

```js
const commit = buildCommitCommands({
  sdkPackageId: '#arccade-game-sdk',   // package NAME reference; see §7
  amuletPackageId,                      // from the AmuletRules template_id
  venue, operator, player,
  entitlementCid,
  gameCode: 'trade-wars-v4',
  cycleId: newCycleId('tw'),
  entryDigest,                          // sha256 of YOUR canonical entry document
  stakeAmount: '30.0',
  feeAmount:   '0.01',                  // pass this explicitly — see T8
  instrumentId,
  lockExpiresAt,                        // absolute; see T10
  amuletRulesCid, openMiningRoundCid, inputAmuletCids, dsoParty,
})
// commit.commands  → [transfer, entitlementCommit]
// commit.actAs     → [player, venue, operator]
// commit.readAs    → [player, venue]
```

Submit `commit.commands` as one submission with `disclosedContracts` attached.
All three parties are needed, and for different reasons: the transfer needs the
player as sender and the venue as provider and lock holder;
`Entitlement_Commit`'s controller set is `operator, player`.

### 2.4 What to check before you let the player play

The commitment is worth exactly as much as the lock behind it, and the lock is
in a different command. So do not admit the player into the game on an HTTP 200.
Read the transaction back and assert three things:

1. A `LockedAmulet` **create event exists in the same `updateId`**.
2. Its `lock.context` equals `commit.custodyTag`, byte for byte.
3. Its `lock.holders` **contains the venue party**. If it is empty, see **T7** —
   the cycle is already unsettleable and the only clean exit is abort.

A commit whose sibling transfer never materialised is not a disaster — it cannot
settle (custody proof fails) and `GameStake_Abort` recycles the slot without
counting the cycle — but it is a farming vector if you let the player play
anyway, and it costs the player their slot for `abortCooldownSeconds`.

---

## 3. Write 2 — settlement

```js
const settle = buildSettleCommands({
  sdkPackageId: '#arccade-game-sdk', amuletPackageId,
  venue, operator, player,
  stakeCid, lockedAmuletCid,
  disposition: 'ReturnedInFull',
  returnedAmount: '30.0',
  outcomeDocument,                 // digest computed from it if you omit outcomeDigest
  revealedEntry: entryDocument,    // the ledger recomputes entryDigest from this
})
```

**Order is mandatory.** `GameStake_Settle` fetches the `LockedAmulet` to prove
the encumbrance, so it must precede the `LockedAmulet_UnlockV2` that archives
it. Reversed, settlement is rejected for want of a custody proof.

**Three parties, each for a distinct reason.** `actAs: [operator, venue,
player]` — the player and the venue because `LockedAmulet_UnlockV2`'s controller
set is `amulet.owner :: lock.holders`; the venue additionally for **visibility**,
because a submission cannot fetch a contract none of its reading parties sees;
the operator because it controls `GameStake_Settle`.

What the ledger checks for you, in the same transaction as the money:

- `sha256` of `revealedEntry` equals the `entryDigest` recorded at commit — one
  byte of drift and the settlement is rejected, not warned about;
- the same for `revealedOutcome` against `outcomeDigest`;
- `policy.minCycleSeconds <= elapsed <= policy.maxCycleSeconds`, from ledger
  time (see **T11** for the arithmetic);
- `returnedAmount + forfeitedAmount == terms.stakeAmount`, both non-negative;
- `payoutAmount <= policy.maxPayoutAmount`;
- `forfeitedAmount == 0` on `TimeLockedHolding` — see §4.4;
- the full custody proof against the lock.

A prize works in this same transaction as an optional third command: an
`AmuletRules_Transfer` funded from **pre-existing venue-owned** Amulets, whose
contract ids you already know when you build the submission.

**Reading the outcome back requires the right transaction shape.** The result
lives in the settlement's exercise node. A consumer on the default ACS-delta
stream sees a create and an archive and nothing else. Use
`TRANSACTION_SHAPE_LEDGER_EFFECTS`.

---

## 4. Recovery — every way a cycle can end

There are exactly three, and `GameStake` is created by exactly one choice and
consumed by exactly one of these three. There is no fourth state and no
administrative override.

| | `GameStake_Settle` | `GameStake_Abort` | `GameStake_ExpireUnsettled` |
|---|---|---|---|
| **Controller** | `operator` | `operator, player` | **`player` alone** |
| **Precondition** | duration band, digests match, custody proof | none; custody proof optional | `now >= terms.lockExpiresAt` |
| **Amounts** | declared in the choice | none — derived | none — derived |
| **Counts as a cycle** | yes | no | no |
| **Cooldown written** | `cooldownSeconds` | `abortCooldownSeconds` (longer) | `now` — immediate |
| **Pairs with** | `LockedAmulet_UnlockV2` | `LockedAmulet_UnlockV2`, if a lock exists | `LockedAmulet_OwnerExpireLockV2` |
| **Slot returns** | yes | yes | yes |

### 4.1 Abort

The escape hatch for a commitment whose lock never materialised, or a cycle the
venue is cancelling. The custody proof is **optional here on purpose** — the
whole premise of an abort is that the encumbrance may not exist. The cycle is
not counted and the longer `abortCooldownSeconds` keeps the slot out of use, so
an unfunded commit buys a farmer no throughput.

It needs the player's authority as well as the operator's. An operator cannot
abort a player's cycle alone.

### 4.2 Expiry — the SDK's strongest custody claim

```
choice GameStake_ExpireUnsettled : ContractId PlayerEntitlement
  controller player
  do
    now <- getTime
    assertMsg "kilit suresi henuz dolmadi" (now >= terms.lockExpiresAt)
    recycleEntitlement this False now
```

**The controller is the player and nobody else.** After `terms.lockExpiresAt`
the player recovers their money with `LockedAmulet_OwnerExpireLockV2` — whose
controller is `amulet.owner` alone, in Splice's own package, nothing to do with
arCCade — and clears the SDK's record of the cycle with this choice. Neither the
venue, nor the operator, nor the DSO is in either controller set.

There is no state in which the venue can strand a player's funds or their slot.
That is the claim, and it is a claim about two controller sets you can read in
the sources rather than about anyone's intentions. It has been exercised: the
README records three stranded cycles closed with `actAs: [player]` and nothing
else.

`buildExpireCommands` emits both commands with `actAs: [player]`. **Ship this
path in your client.** A studio that only ever calls settlement from a backend
worker has an availability dependency where the SDK deliberately put none.

### 4.3 The power the venue does have, stated with its bound

Before expiry, `LockedAmulet_UnlockV2` requires `owner :: lock.holders` — so the
venue can **refuse to co-sign** and leave the player's funds encumbered until
`lockExpiresAt`. It is not seizure: unlock only ever pays the owner, and after
expiry the owner acts alone. But it is a real power, it is bounded only by
`policy.maxLockSeconds`, and a hostile reviewer will frame it as custodial.
State it with the bound rather than letting someone find it.

Set `maxLockSeconds` to the smallest number your game can live with.

### 4.4 What you cannot express, and what to do instead

On `TimeLockedHolding`, `GameStake_Settle` refuses `forfeitedAmount > 0`. This
is not policy, it is mechanics: `LockedAmulet_UnlockV2`'s body always pays the
full amount to the owner, and a locked amulet is not a valid `TransferInput`, so
routing part of the stake to the venue would need a third transaction. The
contract enforces the refusal rather than letting that third write appear
quietly.

**Take the at-risk amount as `terms.feeAmount` at commit.** A fee spent before
the outcome exists cannot be dodged by refusing to settle, which makes it
strictly stronger evidence of exposure than a settlement-time capture.

### 4.5 What an operator must monitor

Not a nice-to-have list. Each of these is a state the ledger permits and the SDK
will not rescue you from.

| Signal | Why it matters |
|---|---|
| **Open `GameStake` approaching `terms.lockExpiresAt`** | Past it, the player self-recovers and your settlement — with its outcome digest and its amounts — never happens. The cycle leaves no outcome on the ledger and your report row is derived, not declared. Alert well before, not at, the deadline |
| **Settlement latency versus `lockExpiresAt`** | The distribution, not the mean. The tail is what expires |
| **Abort rate, by reason** | A rising rate is either a broken transfer path or a farming attempt. Both are audit signals |
| **Players with zero entitlements and no open stake** | They are locked out and **cannot be reissued** — see **T6**. This is a launch requirement, not a metric |
| **`GameStake` created with no `LockedAmulet` in the same `updateId`** | An unfunded commit. Abort it; do not let the player play |
| **`lock.holders == []` on a created lock** | **T7**. The cycle is unsettleable from birth |
| **`AmuletConfig` changes to transfer output fees** | Today CIP-78 leaves only `holdingFee`, so an exactly-locked stake returns exactly. That is DSO-governed configuration, not code. A change would silently break settlement of every open cycle |
| **Holdings per player** | A staking game that repeatedly splits and returns change manufactures dust. Keep it under ~10 holdings per user |
| **ACS size** | See **T5** |

---

## 5. Verifying a period without arCCade

The point of the anchor is that a third party can prove a cycle was **omitted**
from a published report. This section is the procedure, run against the real
TestNet artifacts so the numbers are checkable rather than illustrative.

What a verifier needs: the published report file, the `VenuePeriodAnchor`
contract from the ledger (or Scan), and sha256. No arCCade API, no Daml.

### 5.1 Step 1 — the leaf, with nothing but `sha256sum`

The canonical leaf document is plain text. Take row 0 of the 2026-08-26 report,
render it, hash the raw UTF-8 bytes:

```
arccade-sdk-digest-v1|t:23:arccade.cycle-audit-rowi:1:1r:768:k:17:committedAtMicros=…
```

```bash
printf '%s' "$LEAF_DOCUMENT" | sha256sum
# 64ee0b9c7c6cd87e020b85f20d1df22efe677937bbf27a0368fc1fc4ad44e69d
```

which is the first entry in that report's `leaves` array. There is no library in
that check. That is the property the whole scheme exists to have.

The fifteen fields are fixed and **sorted by name**, so a field appended in a
later schema version cannot silently move a v1 digest. Amounts are integer
1e-10 units (`i:` tag), not decimals; both timestamps are integer microseconds
carried as `canonInt`, not `canonTime`.

### 5.2 Step 2 — the root

```js
import { periodLeaf, merkleRoot, merkleProof, periodRowVerify } from '@arccade/game-sdk'

const leaves = report.rows.map(periodLeaf)
merkleRoot(leaves) === anchor.merkleRootHex
```

Against the published 2026-08-26 report this yields
`de7fbed367ddba63a5b4df70f6eb3c41075db1f78f6f9f29593a3bbfc73e8106`, which is
the `merkleRootHex` on the anchor. An empty period is still anchored: the root
of a period with no cycles is `merkleEmpty()` =
`c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0`, which is
exactly the 2026-08-27 anchor. "Nothing happened" and "we did not report" have
to be distinguishable.

### 5.3 Step 3 — inclusion, with the right entry point

```js
const proof = merkleProof(0, leaves)
periodRowVerify(report.rows[0], proof, root)   // true
```

Use `periodRowVerify`, never bare `merkleVerify`. Folding a hash cannot know
whether it started from a leaf or from an internal node, so `merkleVerify`
returns `true` when handed an internal node with the proof that fits it.
`periodRowVerify` derives the leaf **from the row**, which is what binds the
claim "this is a cycle" to the `arccade.cycle-audit-row` schema. Two further
structural properties matter here: leaves and internal nodes hash under
different schemas, and a lone trailing node is **promoted unchanged** rather
than duplicated — the Bitcoin convention (CVE-2012-2459) would let `[a,b,c]` and
`[a,b,c,c]` produce one root.

Tamper with one field of the row and the same call returns `false`. That is the
check worth writing in your own verifier, not the happy path.

### 5.4 Step 4 — the anchor digest

**No shipped client implements `anchorDocument`.** Daml computes it inside
`GameVenue_AnchorPeriod`; the JavaScript, Python and Java clients do not export
it. Until they do, a verifier assembles it from `canonDocument`, `canonText` and
`canonInt`, which every client does export. The fifteen fields, exactly, in the
schema `arccade.period-anchor` version 1:

```js
documentDigest('arccade.period-anchor', 1, [
  ['venueId',              canonText(a.venueId)],
  ['periodId',             canonText(a.periodId)],
  ['periodStartMicros',    canonInt(a.periodStartMicros)],
  ['periodEndMicros',      canonInt(a.periodEndMicros)],
  ['cycleCount',           canonInt(a.cycleCount)],
  ['committedUnits',       canonInt(a.committedUnits)],
  ['feeUnits',             canonInt(a.feeUnits)],
  ['returnedUnits',        canonInt(a.returnedUnits)],
  ['forfeitedUnits',       canonInt(a.forfeitedUnits)],
  ['payoutUnits',          canonInt(a.payoutUnits)],
  ['qualifyingTxCount',    canonInt(a.qualifyingTxCount)],
  ['nonQualifyingTxCount', canonInt(a.nonQualifyingTxCount)],
  ['merkleRootHex',        canonText(a.merkleRootHex)],
  ['reportDigest',         canonText(a.reportDigest)],
  ['prevAnchorDigest',     canonText(a.prevAnchorDigest)],
])
```

Note `reportUri` is a field of the *contract* and not of the *document* — the
location a report is served from is not part of the commitment, its bytes are.

Run against the live TestNet anchor for `tradewars/testnet-arena-v2`,
`periodId` `2026-08-27` — bounds `1787788800000000..1787875200000000`,
`cycleCount` 0, all totals 0, `qualifyingTxCount` 0, `nonQualifyingTxCount` 1,
root `c950347c…`, `prevAnchorDigest` `caa2d6f5…` — this reproduces

    f3e0805b9c3b9b9147f8b7b866ddd34d157d5d1e1e60b5942e14335909a6bd2a

which is the `anchorDigest` on the ledger. The 2026-08-26 anchor reproduces the
same way, at `caa2d6f5…`, with `qualifyingTxCount` 4 — two cycles, two writes
each — and `prevAnchorDigest` empty, being the start of the chain.

### 5.5 Step 5 — the chain, and the report bytes

`prevAnchorDigest` on each anchor is the previous period's `anchorDigest`. Walk
it backwards to the first period, whose `prevAnchorDigest` is `""`. A missing
period is a broken link and shows up as an unresolvable hash, not as an absence
you have to notice.

Then the last check, and the one to run first in practice:

```bash
sha256sum tradewars_testnet-arena-v2_2026-08-27.json
# b4fda252f5064e39a0ed7a6e2914794545a3523b965e631eb94920f38be973fb
```

which equals the anchored `reportDigest`. **On the 2026-08-26 report it does
not.** The served file hashes to `9f2a1c9d7abe396edc73959214518836b495363bcc39ed558138eaf35ebbc6b7`;
the anchor commits to `e83f509f02b3951286aa4e37c33998ec073ce1f231ac86beaffc2ebb1e07aa46`.
The rows are intact — every leaf and the root still reproduce — but the bytes
served are not the bytes anchored. `index.json` in that directory records both
under `servedDigest` and `anchoredDigest`, so it was noticed rather than hidden;
it is still a live example of **T4**. Publish the report bytes once, serve them
byte-stable forever, and re-serialising for pretty-printing is a breaking
change.

### 5.6 Don't take the report — rebuild it

The strongest form of the check does not start from arCCade's file at all.
`rowsFromTransactions` turns a `TRANSACTION_SHAPE_LEDGER_EFFECTS` stream into
the same rows, so a verifier reconstructs the period from the ledger and
compares. Three things about that derivation matter if you implement it
yourself:

- **The join key is the stake contract id, not the cycleId.** A closing choice
  does not repeat `cycleId` — it lives on the contract being exercised. The
  commit's `exerciseResult` is that contract id and it is the only thing linking
  the two halves in the stream.
- **Abort and expiry declare nothing.** Their amounts are derived from the
  mechanic: unlocking a `TimeLockedHolding` always pays the owner in full and
  this mechanic cannot forfeit, so the stake returns and nothing else moves.
  `outcomeDigest` is `""` because no outcome ever existed.
- **Unmatched halves are surfaced, not dropped.** A commit whose closing fell
  outside the window comes back in `openStakes`; a settlement whose commit is
  missing comes back in `orphanClosings`. Silently discarding either is exactly
  the omission the anchor exists to make provable. Likewise `warnings` carries
  rows where a same-transaction unlock disagrees with the declared
  `returnedAmount` — an independent second reading of the money.

The rules live in `test-vectors/cycle-trees.json` (real TestNet transactions)
and `test-vectors/cycle-rows.json` (the rows they must produce). If you write
a client in another language, that pair is the contract you are conforming to,
and `conformance/manifest.json` enumerates the case-level expectations.

---

## 6. Traps

Consolidated from what has already been measured or hit in this project. Each
one names the check that catches it.

### T1 — The JSON API cannot carry a day's report

Measured on TestNet: `http-list-max-elements-limit` is **200**, and the `limit`
query parameter does **not** raise it. A single query spanning 40,000 offsets
returns **413**. The fixture in `test-vectors/` had to be extracted in 300-offset
windows.

Windowed reads work around it but the limit applies **per window**: a busy day
can exceed 200 in one window and lose that whole window. The OpenAPI text itself
recommends websockets for larger sets. Use the websocket `/v2/updates` stream —
and make an unclean close an **error**, not a short read. Anchoring an
incomplete period produces something that looks exactly like a complete anchor,
which is the failure the anchor exists to prevent.

**Check:** compare `cycleCount` against an independent count of settlement
transactions in the window before anchoring; refuse to anchor if the scan did
not reach the period start.

### T2 — HTTP 503 says nothing about the transaction

The JSON Ledger API's 503 is pekko-http's **request timeout** (~20s). Measured:
both a 2,000-row and a 4,000-row anchor were written to the ledger **after**
returning 503. The same trap bit a DAR upload — 503 returned, package uploaded.

**Check:** never treat 503 as failure. Query the ledger for the effect before
deciding anything. `submit-and-wait-for-transaction` will always 503 on large
anchors; the correct pattern is asynchronous submission followed by ACS or
completion tracking.

### T3 — Duplicate anchor on retry

The contract prevents a duplicate `cycleId` **within** a period. It does not
prevent a duplicate `periodId`. A job that retries on 503 (see T2) creates a
second anchor for the same period, and the chain then carries two different
`anchorDigest` values for one link with nothing to say which is authoritative.

**Two defences, both required:**

1. A **deterministic `commandId`** per period, e.g. `<venueId>:<periodId>`, so
   Canton's command deduplication cooperates. The default deduplication window
   is 30 seconds, so this alone is not enough.
2. **Query the ACS for that `venueId` + `periodId` before submitting.** The
   ledger decides, not the HTTP status.

### T4 — The report's bytes are the commitment

`reportDigest` is sha256 over the exact bytes you publish. Regenerating the file
— reordering keys, changing indentation, re-serialising through a different
JSON writer — breaks it while leaving the Merkle root intact, which makes it
look like a verification bug rather than a publication bug. Live example in
§5.5.

**Check:** `sha256sum` the file you serve against the anchored `reportDigest` in
CI, on every deploy of the report host.

### T5 — Period size is bounded by interpretation *time*, not payload

`rows` on `GameVenue_AnchorPeriod` is a choice argument: it never enters the
ACS, but it is carried in the transaction and interpretation is O(N) sha256.
Measured on `dryrun-pixelforge-arena-v2` at package id 1.5.0:

| rows | payload | result |
|---|---|---|
| 0 | — | passed, root = `merkleEmpty` |
| 1,000 | 634 KB | passed, ~20 s |
| 2,000 | 1.27 MB | passed |
| 4,000 | 2.53 MB | passed, ~62 s — at the edge |
| 8,000 | 5.06 MB | **`INTERPRETATION_TIME_EXCEEDED`**, rejected |

The ceiling is time, not size: Canton must finish interpretation within Ledger
Effective Time plus a one-minute tolerance. The 8,000-row attempt was rejected
**cleanly** — no partial write.

**Safe ceiling: ~2,000 rows per anchor.** A larger venue splits the period —
`periodId` can be subdivided within a day and the chain is unaffected, since
each link only references the previous `anchorDigest`.

### T6 — A lost entitlement locks a player out

There is no contract key and no lookup. At `concurrencyLimit` 1 there is no
spare. Since 1.4.0 the player is on the `PlayerRoster`, so a second issuance is
**rejected by the ledger** — the old "just mint another slot" escape is closed,
deliberately, as the price of the limit being real. There is no roster-removal
or slot-reissue choice in 1.5.0.

The only remaining recovery is the player's own `GameStake_ExpireUnsettled`, and
that only helps if there is an open stake to close.

**Check:** monitor players with zero entitlements and no open stake, and treat a
hit as an incident. This is a launch requirement.

### T7 — Player and venue as the same party produces an unsettleable lock

Splice drops the owner from the `holders` list as meaningless. If the player
party and the venue party are the same, the lock is created with
`holders: []`, and `verifyLockedHolding`'s "venue is among the lock holders"
condition can never be satisfied again. The commit succeeds; the failure appears
**hours later**, at settlement.

**Check:** refuse the commit before writing anything if `player == venue` in
live mode. In production the player party is always distinct, which is exactly
why this shows up in test and staging.

### T8 — An omitted `feeAmount` reaches the ledger as `"undefined"`

Verified against the working tree:

```js
buildCommitCommands({ /* … no feeAmount … */ })
// terms.feeAmount === "undefined"       (the string)
// transfer outputs: [player]            — no fee output at all
```

`String(undefined)` is `"undefined"`, and the fee output is skipped because
`Number(undefined) > 0` is false. The stake terms and the transfer then disagree
about whether a fee exists.

**Check:** pass `feeAmount` explicitly on every call, including `'0.0'`. Assert
in your own wrapper that it is a string matching `^\d+(\.\d+)?$` before building.

### T9 — `cycleId` length is counted differently on each side

Daml counts **Unicode code points** (`T.length`, limit 64). The JavaScript
client counts **UTF-16 units** (`cycleId.length`). A 33-emoji id is 33 code
points and 66 UTF-16 units: the ledger would accept it, `assertValidCycleId`
refuses it. The client is strictly stricter — code points never exceed UTF-16
units — so the failure is always "the ledger took an id the tooling cannot
handle", which is the worse direction: the auditor path breaks on a cycle that
is already committed. A verifier written in Java has the same defect
(`String.length()` counts UTF-16 units; `codePointCount` is correct).

**Check:** use `newCycleId()` and keep ids to ASCII `[a-z0-9-]`. `:` and `|` are
forbidden on both sides — they would make the custody tag ambiguous to parse.

### T10 — Ledger time decides; your wall clock does not

`lockExpiresAt` is an absolute time you supply, but every duration check runs
against ledger time inside the choice. Deriving it as `Date.now() + lockSeconds`
and passing exactly `policy.minLockSeconds` is a coin flip on clock skew:
`Entitlement_Commit` asserts `minLockSeconds <= secondsBetween now
lockExpiresAt`, with `now` from `getTime`.

**Check:** add margin. Never request exactly the policy minimum.

### T11 — `secondsBetween` truncates each endpoint independently

`epochSeconds` truncates toward zero — not floor — and `secondsBetween a b` is
`epochSeconds b - epochSeconds a`, so each endpoint is truncated **before** the
subtraction. Verified against the ledger: `(-7) / 2 == -3`,
`epochSeconds (-500000µs) == 0`, and `secondsBetween 0.9s 60.0s == 60`, not 59.

A client computing elapsed time as `(b - a) / 1e6` will disagree with the ledger
by up to one second at exactly the boundary where acceptance flips —
`minCycleSeconds`, `maxCycleSeconds`, `minLockSeconds`, `maxLockSeconds`, the
cooldown gate.

**Check:** never schedule a settlement at the exact band boundary. If you
predict acceptance client-side, truncate both endpoints to whole seconds first.

### T12 — The report speaks tags; Daml speaks constructors

The canonical document — and therefore the leaf, the root and every verifier —
carries the **tag** `"returned-in-full"`. Daml's JSON encoding of the variant
expects the **constructor** `"ReturnedInFull"`. They are not the same string,
and the translation belongs at the ledger boundary, not in the report: making
the report match Daml's encoding would make the canonical document depend on
Daml's JSON.

`assertDisposition` refuses anything outside the five tags, which is what stops
a constructor name from producing a silently different digest whose failure
would only surface when an auditor tried to verify a proof.

**Check:** the five tags are `returned-in-full`, `returned-with-forfeit`,
`forfeited-in-full`, `aborted`, `expired-unsettled`. Convert once, at
submission, and fail loudly on anything unrecognised.

### T13 — Digest arithmetic will not warn you

Four ways to compute a digest that is wrong and looks right:

| | |
|---|---|
| **Lengths** | code points, not UTF-16 units. `[...s].length` in JS, `codePointCount` in Java |
| **Amounts** | integer 1e-10 units via `amountUnits`, never a rendered decimal and never through a binary float. `amountUnits` refuses a fractional `Number` and refuses anything outside ±922337203.6854775807 |
| **Time in your own documents** | `canonTime` routes through `Date.parse` and truncates to **milliseconds**: `2026-08-27T18:18:11.258920Z` yields `m:16:1787854691258000`, losing `920`. `isoToMicros` is exact and yields `…258920`. Use it for anything that has to match a ledger timestamp |
| **`toMicros` on a string without `Z`** | host-timezone dependent — measured as a two-hour shift on this host. Always pass explicit UTC |

**Check:** `cd js && npm test`, `python3 tools/digest_reference.py`, and the
conformance runners — `node conformance/runners/run.mjs --profiles merkle` and
`python3 conformance/runners/run.py --profiles merkle`, which is the profile all
three shipped clients pass today. If you write a fifth implementation, pin it to
`test-vectors/` and to `conformance/manifest.json` before you pin it to anything
of your own.

### T14 — Report order is under-specified, and two honest clients diverge

`REPORT_ORDER` reads `"committedAtMicros, then cycleId"` with no collation
named. On a tie the JavaScript client breaks it with `localeCompare` and the
Python reference with code-point order, and these disagree: `'a_1'` before
`'a-1'` under ICU, after it by code point. Different leaf order, different
Merkle root, over the same set of cycles.

Ties need identical `committedAtMicros` to the microsecond, so this is rare —
but it is exactly the kind of rare that surfaces in front of an auditor.

**Check:** compute the root with two implementations and diff before anchoring.
Keep cycle ids to `[a-z0-9-]`, which keeps the two orderings agreeing on
everything tested here.

### T15 — Terminal contracts and ACS growth

An earlier design wrote a contract per game result; 41 `GameResult` and 9
`SessionResult` contracts were enough to push the ACS past the JSON API's
200-contract limit, after which every query returned 413. The SDK's cycle
accumulates nothing terminal — the entitlement archive rides in write 1 and its
recreate rides in write 2 — but **your** venues, rosters and dev-loop leftovers
still accumulate.

**Check:** archive what you no longer need, and alert on ACS size per party
rather than discovering it as a 413.

---

## 7. Versions and references

**Reference templates by package name, not package id.**
`#arccade-game-sdk:ArCCade.GameSdk.Cycle:GameStake` lets the ledger resolve to
the highest vetted version and does not go stale on upgrade. Two consequences:

- A gotcha if you filter query results by exact `templateId` string equality —
  the ledger returns a **package-id-qualified** id. Compare the
  `module:entity` suffix, or resolve the package id once at startup.
- Canton resolves to the highest vetted version whether or not you adopted it.
  A venue created under 1.3.0 is read as 1.4.0+ with `roster = None` and
  **refuses to issue** until `GameVenue_InitRoster` is called. That fails closed
  rather than silently reverting to the unenforced behaviour, and it bites at
  vetting time, not at adoption time. Plan `InitRoster` as part of the vetting.

**The JavaScript client's MAJOR.MINOR tracks the Daml package; PATCH does not.**
1.5.x of `@arccade/game-sdk` talks to 1.5.0 of the contracts. Letting them drift
is how a client starts computing a digest the ledger will reject — which has
already happened once, at 1.1.0 against a 1.5.0 ledger package, unnoticed
because the only consumer was a local `file:` dependency.

**Check what you built is what was vetted:**

```bash
python3 tools/check_package_id.py
# OK  1.5.0 -> a0553775ff7b431dfdb8c92a3ae127638e124c02569e3cce22cc7a08aee2fb3a
```

---

## 8. Where the SDK stops helping

Named so you can plan around them rather than discover them.

- **`anchorDocument` exists only in Daml.** No shipped client reproduces the
  anchor digest; §5.4 is the workaround and it is fifteen lines you maintain.
- **The Python reference is the digest and the report derivation, not the whole
  client.** It has no identifier validators, no command builders and no tenancy.
- **The game adapters are not published** (§1). Your documents are yours to
  build from the `canon*` primitives.
- **Report transport is yours.** There is no anchoring job, no report host and
  no inclusion-proof endpoint in this repository — only the pieces they would be
  built from, and the fixtures that pin them.
- **Conditional forfeiture of a locked stake is not expressible in two writes**
  (§4.4). The seam for allocation custody is cut — `CustodyMechanic`,
  `CustodyRef.AllocationRef`, `verifyCustody` failing closed on that branch —
  but the branch is not implemented.
- **Venue-alone settlement is not available.** The `Holding` interface has no
  choices, so the unlock cannot be driven through it, and nesting
  `LockedAmulet_UnlockV2` inside `GameStake_Settle` would mean importing
  `splice-amulet` and pinning its package id into a DAR whose selling point is
  that it pins only frozen 1.0.0 packages. Today this costs nothing because
  submissions already carry `actAs: [player, venue]`. It becomes a blocker the
  day player keys move into the browser, and it has to be solved before that
  migration, not after.
- **Committing to prices and scores makes them tamper-evident, not true.**
  Nothing on-chain proves your price feed was honest. Say "commitment", never
  "proof of fair play". The durable fix is a signed oracle feed whose signatures
  live inside the entry document.
