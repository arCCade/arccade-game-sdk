# arCCade Game SDK

Contracts and client libraries for putting game economies on Canton, built
around one idea: **write few things on-chain, and make each one mean
something.** Gameplay stays in the game's own database; what reaches the ledger
is custody of value and the settlement that resolves it.

Assets follow [CIP-0056](https://lists.sync.global/g/cip-discuss), the Canton
Network Token Standard — `HoldingV1`, `AllocationV1`, `TransferInstructionV1`.

    package     arccade-game-sdk 1.3.0
    hash        bc607f6c6dbb3b29b38ff2428fe63f99068f9b67a8ce709a123378c1471c7e5a
    Daml SDK    3.4.10 (LF 2.1)
    network     vetted on Canton TestNet

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

The commitment digest is implemented three times: Daml (`Digest.daml`),
JavaScript (`js/src/digest.js`) and Python (`tools/digest_reference.py`). They
must agree byte for byte; `test-package` asserts the golden vectors, and the
Python implementation exists so the parity check has an independent third
opinion rather than two ports of one author's reasoning.

One trap worth naming: Daml's `DA.Crypto.Text.sha256` takes a **hex string**,
not arbitrary text. Passing plain text compiles cleanly and fails at runtime.
`textDigest` handles this — do not call `sha256` directly.

## Building

Both packages resolve their Splice dependencies by absolute path, so a build
currently expects this layout on the host:

    /opt/arccade/arccade-game-sdk/          this repo
    /opt/arccade/canton/splice-node-0.7.1/  the Splice release, for its DARs

Making the paths relocatable is open work; until then a clone alone is not
enough to build.

    daml build                    # from the repo root, produces the DAR
    cd test-package && daml test  # 39 tests
    cd js && npm test             # 56 tests

## Status

Implemented and tested: the cycle, custody proof, policy enforcement, the
registry with quota-bounded minting, atomic trades, multi-tenancy, and the
digest in three languages.

Not built, despite `docs/DESIGN.md` describing them: the audit/Merkle anchoring
module, the Java digest port, and live custody exercised on-chain (that last one
waits on TestNet CC). `docs/DESIGN.md` carries an implementation-status table at
the top — read it before treating that document as a description of what exists.
