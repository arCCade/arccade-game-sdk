# Gaming SDK for Canton

Contracts and client libraries for putting game economies on Canton, built
around one idea: **write few things on-chain, and make each one mean
something.** Gameplay stays in the game's own database; what reaches the ledger
is custody of value and the settlement that resolves it.

Assets follow [CIP-0056](https://lists.sync.global/g/cip-discuss), the Canton
Network Token Standard — `HoldingV1`, `AllocationV1`, `TransferInstructionV1`.

    package     arccade-game-sdk 1.3.0
    hash        bc607f6c6dbb3b29b38ff2428fe63f99068f9b67a8ce709a123378c1471c7e5a
    Daml SDK    3.4.10 (LF 2.1)
    network     vetted on Canton TestNet, settling real Canton Coin

Built and maintained by arCCade, and open to the ecosystem.

The Daml package keeps the name `arccade-game-sdk`, permanently. It names its
contributor rather than the network, which is the right way round: a package
called after Canton would read as though the Canton Foundation published it.
Keeping the name also keeps the upgrade lineage — Daml upgrades require an
unchanged package name, so renaming would start a new lineage and force every
live contract to be re-created under it.

## Layout

    daml/ArCCade/GameSdk/     the Daml package
      Time.daml               the only source of time; no choice takes a caller timestamp
      Digest.daml             canonical encoding and commitment digests
      Types.daml              policy, terms, custody and disposition types
      Policy.daml             policy validity and the terms-meet-policy check
      Custody.daml            proof that a stake is really locked
      Cycle.daml              venue, entitlement, stake — the two-write cycle
      Trade.daml              atomic multi-leg trades
      Registry.daml           CIP-0056 asset registry, accounts, minting
      Games/                  worked examples, not part of the core surface

    js/                       @arccade/game-sdk — command builders, digests, tenancy
    test-package/             the Daml test suite (a separate package by necessity)
    tools/digest_reference.py an independent Python implementation of the digest
    vendor/splice-0.7.1/      the CIP-0056 interface DARs this package builds against
    docs/                     the integration guide published at sdk.arccade.io

## The two-write cycle

A cycle costs exactly two ledger writes.

**Write 1 — commitment.** `AmuletRules_Transfer` locks the stake as a real
`LockedAmulet` and `Entitlement_Commit` creates the `GameStake`, both in one
transaction. They must be atomic: apart, a `GameStake` can exist unfunded.

**Write 2 — settlement.** `GameStake_Settle` records the disposition, the
amounts and the outcome digest, and `LockedAmulet_UnlockV2` releases the funds.
Order matters here — settle reads the lock.

Everything between those two writes — moves, scores, matchmaking — belongs in
the game's own store. The ledger carries the commitment and the result, and the
digests let anyone check that the result matches what was committed to.

## Digest parity

The commitment digest is implemented four times: Daml (`Digest.daml`),
JavaScript (`js/src/digest.js`), Python (`tools/digest_reference.py`) and Java
(`ArccadeDigest.java`, currently living in the wallet backend). They must agree
byte for byte; `test-package` asserts the golden vectors, and the Python
implementation exists so the parity check has an independent third opinion
rather than two ports of one author's reasoning.

The scheme id `arccade-sdk-digest-v1/sha256` is a wire constant and does not
follow the product name. A commitment already written to the ledger is bound to
that string; changing it would invalidate every existing commitment and every
golden vector for the sake of a label. If the pattern is standardised through
the CIP process, that arrives as a v2 scheme alongside v1, not as a rename.

One trap worth naming: Daml's `DA.Crypto.Text.sha256` takes a **hex string**,
not arbitrary text. Passing plain text compiles cleanly and fails at runtime.
`textDigest` handles this — do not call `sha256` directly.

## Building

A clone is enough. Every dependency resolves relative to the repo, and the
CIP-0056 interface DARs are vendored under `vendor/splice-0.7.1/` (Apache-2.0,
copied verbatim from the Splice 0.7.1 release), so no Splice installation and no
particular host layout is required.

    daml build                    # from the repo root, produces the DAR
    cd test-package && daml test  # 39 tests
    cd js && npm test             # 56 tests

The build is reproducible against what was vetted: a clone at any path produces
a DAR whose main package id is exactly

    bc607f6c6dbb3b29b38ff2428fe63f99068f9b67a8ce709a123378c1471c7e5a

## Status

Implemented and tested: the cycle, custody proof, policy enforcement, the
registry with quota-bounded minting, atomic trades, multi-tenancy, and the
digest in four languages.

Exercised live on TestNet, against real Canton Coin, through a real game client:
commit and lock in one transaction, settle and unlock in one transaction, funds
returned in full. The player-alone recovery path has been used in anger too —
three stranded cycles were closed with `actAs: [player]` and nothing else.

Not built, despite `docs/DESIGN.md` describing it: the audit/Merkle anchoring
module. `docs/DESIGN.md` carries an implementation-status table at the top —
read it before treating that document as a description of what exists.

One gap is worth naming here rather than leaving to be discovered. The venue's
`concurrencyLimit` is **not enforced by the contract**.
`GameVenue_IssueEntitlements` range-checks the slot index against the limit but
caps neither the number of entitlements a player holds nor their uniqueness, so
the number of concurrent open cycles is bounded only by the service layer today.
It is enforced there, and that is a real mitigation — but it is not an on-chain
guarantee and should not be described as one until 1.4.0 closes it.
