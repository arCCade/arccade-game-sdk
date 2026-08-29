# Live custody — a walkthrough, not a script

**NOTHING IN THIS FILE RUNS.** There is no `live-custody.mjs` in this directory
and that is a deliberate absence.

A live commitment locks real Canton Coin. It needs an Amulet balance on the
player's party, `AmuletRules` and an `OpenMiningRound` fetched from Scan and
attached to the submission as disclosed contracts, and a venue in `ModeLive`
whose `requireCustodyProof` is on. A script that faked any of those would run
green and teach you the wrong thing: the entire difficulty of live mode is that
the encumbrance either exists on the ledger or it does not, and a stub is a
`GameStake` with nothing behind it — which is precisely the failure the two
commands are arranged to prevent.

So this is the shape of the write, the exact fields, and the checks that catch
each way it goes wrong. Run [`first-cycle.mjs`](first-cycle.mjs) and
[`recovery.mjs`](recovery.mjs) first: everything except the money is identical,
and the parts you can execute are worth executing before you read this.

Source of record: [`docs/INTEGRATION.md`](../docs/INTEGRATION.md) §2, §3 and §4.

---

## What actually changes

Three things, and only three.

1. **`buildCommitCommands` instead of `buildDryRunCommitCommands`.** One
   command becomes two, in one submission.
2. **Disclosed contracts.** `AmuletRules` and `OpenMiningRound` are not visible
   on your participant. Without them the submission fails `CONTRACT_NOT_FOUND`.
3. **`requireCustodyProof` is on** — and in `ModeLive` the contract will not let
   you turn it off. Settlement then fetches the locked holding and checks owner,
   instrument, amount, holder set, expiry and tag before anything moves.

The cycle, the slot, the commitment scheme, the audit row and the three exits
are unchanged. The mechanics of 1 and 2 are Splice's, not the SDK's.

---

## Write 1 — the two commands

```
AmuletRules_Transfer   → fee Amulet to the venue
                         LockedAmulet to the player   ← the encumbrance
                         change Amulet back to the player
Entitlement_Commit     → PlayerEntitlement archived
                         GameStake created
```

One submission. One `updateId`. Sent apart, a `GameStake` can exist with
nothing funding it.

### Four inputs the SDK cannot know

| Input | Where it comes from |
|---|---|
| `amuletRulesCid`, `dsoParty`, `amuletPackageId` | Scan: `POST /api/scan/v0/amulet-rules`. The package id is the prefix of the returned `template_id` — read it there rather than configuring it in a second place where it can drift |
| `openMiningRoundCid` | Scan: `POST /api/scan/v0/open-and-issuing-mining-rounds` |
| `disclosedContracts` | Both of the above, reshaped as `{ templateId, contractId, createdEventBlob }` |
| `inputAmuletCids` | Your participant's ACS for the player, filtered to `:Amulet` and **excluding** `LockedAmulet` |

There is no Scan client in this SDK and this table is the specification rather
than a pointer to one. Three rules about the resolution, each learned by being
wrong about it in production:

- **Cache with a short TTL and invalidate on failure.** 60s for `AmuletRules`,
  30s for the open round.
- **Scan can hand you a round the synchronizer has already archived.** The
  submission returns `INACTIVE_CONTRACTS`, and retrying with the same round
  returns it again — you must exclude the failed contract id and ask Scan
  afresh. Prefer a round whose `opensAt` is already in the past.
- **Input selection must overshoot.** The Splice transfer fee comes out of the
  inputs, so selecting exactly `stake + fee` is short. Select until the sum
  **exceeds** the requirement; never test for equality.

### The call

```js
const commit = buildCommitCommands({
  sdkPackageId: '#arccade-game-sdk',   // package NAME reference, not a package id
  amuletPackageId,                     // from the AmuletRules template_id
  venue, operator, player,
  entitlementCid,
  gameCode: 'trade-wars-v4',
  cycleId: newCycleId('tw'),           // never hand-made — see T9
  entryDigest,                         // sha256 of YOUR canonical entry document
  stakeAmount: '30.0',
  feeAmount:   '0.01',                 // pass explicitly — see T8
  instrumentId,
  lockExpiresAt,                       // absolute, with margin — see T10
  amuletRulesCid, openMiningRoundCid, inputAmuletCids, dsoParty,
})
// commit.commands → [transfer, entitlementCommit]
// commit.actAs    → [player, venue, operator]
```

Submit those two commands as one submission with `disclosedContracts`
attached. All three parties are needed for different reasons: the transfer
needs the player as sender and the venue as provider and lock holder;
`Entitlement_Commit`'s controller set is `operator, player`.

`feeAmount` is the one field where an omission is silent. Leaving it out puts
the **string** `"undefined"` on the ledger and produces a transfer with no fee
output at all (T8). It is also the only amount that is genuinely at risk in a
`TimeLockedHolding` cycle — see the last section.

### The binding is atomicity plus a tag, not a reference

The two commands **cannot see each other**. A submission has no
output-to-input chaining, so `Entitlement_Commit` cannot be handed the
`LockedAmulet` contract id its sibling is creating in the same transaction.
There is no field in `GameStake` pointing at the lock and there cannot be one.

What ties them together is a string:

```
arccade-game-sdk:1:<cycleId>:<entryDigest>
```

written into `TimeLock.optContext` on the transfer output and into
`terms.custodyTag` on the commit. `GameStake.ensure` requires
`terms.custodyTag == custodyTagFor cycleId entryDigest`, so a stake carrying
the wrong tag **cannot be created at all**.

Two consequences worth stating plainly:

- The tag sits on a **DSO-signed** contract. An auditor who can see the lock
  reads which cycle it belongs to and which entry commitment it was made
  against, with no arCCade endpoint and no trust in the app.
- A generic string there — the shared literal `"arCCade game stake"` the legacy
  path used — produces a lock settlement can never verify. The cycle becomes
  abort-only. `buildCommitCommands` computes the tag and will not let you
  override it; if you build the transfer yourself, this is the field to get
  right.

### Before you let the player play

**Do not admit the player on an HTTP 200.** The commitment is worth exactly
what the lock behind it is worth, and the lock is in the other command. Read
the transaction back and assert three things:

1. A `LockedAmulet` create event exists **in the same `updateId`**.
2. Its `lock.context` equals `commit.custodyTag`, byte for byte.
3. Its `lock.holders` **contains the venue party**. Empty means T7 — player and
   venue are the same party, Splice dropped the owner from `holders` as
   meaningless, and the cycle is unsettleable from birth. The only clean exit
   is abort, and the failure would otherwise surface hours later at settlement.

An unfunded commit is survivable — it cannot settle, and `GameStake_Abort`
recycles the slot without counting the cycle — but letting the player play on
one is a farming vector, and it costs them their slot for
`abortCooldownSeconds`.

---

## Write 2 — settlement, with the unlock

```js
const settle = buildSettleCommands({
  sdkPackageId: '#arccade-game-sdk', amuletPackageId,
  venue, operator, player,
  stakeCid, lockedAmuletCid,           // ← the difference from first-cycle.mjs
  disposition: 'ReturnedInFull',
  returnedAmount: '30.0',
  outcomeDocument,
  revealedEntry: entryDocument,
})
```

**Order is mandatory.** `GameStake_Settle` fetches the `LockedAmulet` to prove
the encumbrance, so it must precede the `LockedAmulet_UnlockV2` that archives
it. Reversed, settlement is rejected for want of a custody proof — and the
builder emits them in the right order so that you do not have to hold this in
your head.

**Three parties, each for a distinct reason.** `actAs: [operator, venue,
player]` — the player and the venue because `LockedAmulet_UnlockV2`'s
controller set is `amulet.owner :: lock.holders`; the venue additionally for
**visibility**, since a submission cannot fetch a contract none of its reading
parties can see; the operator because it controls `GameStake_Settle`.

A prize rides in the same transaction as an optional third command: an
`AmuletRules_Transfer` funded from **pre-existing venue-owned** Amulets whose
contract ids you already know when you build the submission.

---

## The recovery paths, with money attached

[`recovery.mjs`](recovery.mjs) runs both of these against a participant with
nothing locked. Live, each closing choice gains one command beside it, and the
builders emit both:

| | abort | expiry |
|---|---|---|
| SDK choice | `GameStake_Abort` | `GameStake_ExpireUnsettled` |
| Splice command beside it | `LockedAmulet_UnlockV2` *if a lock exists* | `LockedAmulet_OwnerExpireLockV2` |
| `actAs` | `[operator, player]` | **`[player]`** |
| Builder | `buildAbortCommands` | `buildExpireCommands` |

`GameStake_Abort` takes the `LockedAmulet` as an **optional** `custodyRef`, and
the optionality is the point: the premise of an abort is that the encumbrance
may never have been created.

The expiry column is the whole custody argument. `GameStake_ExpireUnsettled` is
controlled by the player alone; `LockedAmulet_OwnerExpireLockV2` is controlled
by `amulet.owner` alone, in Splice's package, with nothing of arCCade's in the
controller set. After `lockExpiresAt` the player recovers the money and the
slot with one submission carrying one signature. `recovery.mjs` step 10 submits
the same commands as the venue and shows the ledger refusing them.

**Ship this path in your client.** A studio that only ever calls settlement
from a backend worker has built an availability dependency exactly where the
SDK took care not to put one.

### The power the venue does have

Before `lockExpiresAt`, `LockedAmulet_UnlockV2` requires `owner ::
lock.holders`, so the venue can **refuse to co-sign** and leave the player's
funds encumbered until the lock expires. It is not seizure — unlock only ever
pays the owner, and after expiry the owner acts alone — but it is a real power,
bounded only by `policy.maxLockSeconds`. State it with the bound rather than
letting a reviewer find it. Set `maxLockSeconds` to the smallest number your
game can live with.

### What you cannot express

On `TimeLockedHolding`, `GameStake_Settle` refuses `forfeitedAmount > 0`, and
`recovery.mjs` step 13 shows the ledger refusing it. This is mechanics, not
policy: `LockedAmulet_UnlockV2` always pays the full amount to the owner and a
locked amulet is not a valid transfer input, so routing part of the stake to
the venue would need a third write. The contract refuses rather than letting
that write appear quietly.

**Take the at-risk amount as `terms.feeAmount` at commit.** A fee spent before
the outcome exists cannot be dodged by refusing to settle, which makes it
strictly stronger evidence of exposure than a settlement-time capture would be.

---

## What to monitor once real value is moving

Each of these is a state the ledger permits and the SDK will not rescue you
from.

| Signal | Why |
|---|---|
| Open `GameStake` approaching `terms.lockExpiresAt` | Past it the player self-recovers and your settlement — with its outcome digest and its amounts — never happens. Alert well before, not at, the deadline |
| Settlement latency **distribution** versus `lockExpiresAt` | The tail is what expires; the mean tells you nothing |
| Abort rate by reason | A rising rate is either a broken transfer path or a farming attempt |
| Players with zero entitlements and no open stake | Locked out and **not reissuable** — T6. A launch requirement, not a metric |
| `GameStake` created with no `LockedAmulet` in the same `updateId` | An unfunded commit. Abort it; do not let the player play |
| `lock.holders == []` on a created lock | T7. Unsettleable from birth |
| `AmuletConfig` changes to transfer output fees | DSO-governed configuration, not code. A change would silently break settlement of every open cycle |
| Holdings per player | Repeated split-and-return manufactures dust. Keep it under ~10 |
| ACS size per party | T5, T15 — and it arrives as a 413 on your list queries |

---

## When this becomes a script

The honest bar for adding `live-custody.mjs` to this directory is a TestNet
party with a funded Amulet balance that a reader can obtain themselves, and a
Scan resolver in the repo rather than in arCCade's closed one. Until both
exist, a runnable file here would be a demonstration of arCCade's
infrastructure rather than of the SDK, and it would pass whether or not the
lock was ever created.
