# Gaming SDK for Canton

Contracts and client libraries for putting game economies on Canton, built
around one idea: **write few things on-chain, and make each one mean
something.** Gameplay stays in the game's own database; what reaches the ledger
is custody of value and the settlement that resolves it.

Assets follow [CIP-0056](https://lists.sync.global/g/cip-discuss), the Canton
Network Token Standard — `HoldingV1`, `AllocationV1`, `TransferInstructionV1`.

    package     arccade-game-sdk 1.5.0
    hash        a0553775ff7b431dfdb8c92a3ae127638e124c02569e3cce22cc7a08aee2fb3a
    Daml SDK    3.4.10 (LF 2.1)
    network     1.4.0 vetted on Canton TestNet, settling real Canton Coin;
                1.5.0 is built and tested but NOT yet vetted. Earlier
                versions stay vetted, so nothing created under them stops.

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
    cd test-package && daml test  # 62 tests
    cd js && npm test             # 64 tests

The build is reproducible: a clone at any path produces a DAR whose main
package id is exactly

    1.5.0  a0553775ff7b431dfdb8c92a3ae127638e124c02569e3cce22cc7a08aee2fb3a
    1.4.0  ad08e9ae3090cfbd251324ab9d6f4bec58c672c2716ad7ecc78f2846fe18a02b
    1.3.0  bc607f6c6dbb3b29b38ff2428fe63f99068f9b67a8ce709a123378c1471c7e5a

Each vetted id rebuilds byte-identically from its own commit — which is what
makes the upgrade check meaningful rather than a comparison against a DAR
nobody can reproduce. `damlc upgrade-check` reports **no errors and no
warnings** from 1.4.0 to 1.5.0.

## Status

Implemented and tested: the cycle, custody proof, policy enforcement, the
registry with quota-bounded minting, atomic trades, multi-tenancy, and the
digest in four languages.

Exercised live on TestNet, against real Canton Coin, through a real game client:
commit and lock in one transaction, settle and unlock in one transaction, funds
returned in full. The player-alone recovery path has been used in anger too —
three stranded cycles were closed with `actAs: [player]` and nothing else.

`docs/DESIGN.md` carries an implementation-status table at the top — read it
before treating that document as a description of what exists.

### Proving an omission (1.5.0)

The two-write cycle carries its outcome in the settlement's exercise node, so
a consumer on the flat stream sees a create and an archive. That is the
deliberate price of writing little — but it leaves one question unanswerable:
an auditor who sees a lock on Scan and cannot find that cycle in arCCade's
report has no way to prove it was **omitted** rather than merely unseen.

`GameVenue_AnchorPeriod` closes that. One write per venue per period (a UTC
day by default) carrying a Merkle root over **every** cycle in the period,
chained to the previous period's digest. At 1,000 cycles/day it costs 0.1% of
one write per cycle. There is deliberately no per-cycle audit record — that
would put a non-value write back inside the qualifying transaction, which is
what this design exists to avoid.

Two properties are worth stating because they are what make the anchor
evidence rather than a claim:

**The root and the money totals are recomputed in Daml.** The caller passes
rows, not a root. A correct root says nothing about whether the summary
fields are correct, so the totals are summed from the same rows on-ledger.

**Leaves and internal nodes hash in different domains, and a lone node is
promoted rather than duplicated.** Duplicating it — the Bitcoin convention —
lets two different cycle sets produce the same root (CVE-2012-2459).

The auditor's entry point is `periodRowVerify`, not raw `merkleVerify`: it
derives the leaf from the row itself, which is what binds "this is a cycle"
to the row schema. Verification is implemented in Daml, JavaScript and
Python, locked together by golden vectors — an auditor checks a proof in the
language they already have, not in Daml.

The gap this README used to name here is closed. Through 1.3.0 the venue's
`concurrencyLimit` was **not enforced by the contract**:
`GameVenue_IssueEntitlements` range-checked the slot index against the limit but
capped neither the number of entitlements a player held nor their uniqueness, so
the number of concurrent open cycles was bounded only by the service layer.

In 1.4.0 it is a ledger rule. Issuance requires a `PlayerRoster`, refuses a
player already on it, and creates **exactly** `concurrencyLimit` entitlements at
indices `0..limit-1`. Neither the count nor the uniqueness is asserted from
caller-supplied input — the caller chooses neither — so the limit holds without
contract keys, which LF 2.1 does not have.

### Upgrading a venue from 1.3.0

A venue created under 1.3.0 carries no roster and **cannot issue** until the
operator calls `GameVenue_InitRoster`. That is deliberate: issuance fails closed
rather than silently falling back to the unenforced behaviour. `InitRoster` is
one-shot per venue.

This bites the moment 1.4.0 is vetted, not when you choose to adopt it. Canton
resolves a package-name reference to the highest vetted version, so an existing
venue is read as 1.4.0 with `roster = None` and refuses to issue. Commit and
settlement are unaffected — they never touch the roster — so open cycles and
entitlements already in players' hands keep working. Plan `InitRoster` as part
of the vetting, not after it.

The roster is a chain of `PlayerRoster` shards, and the venue holds only a
pointer to its head. Growth therefore never touches the venue's schema — which
matters, because Daml upgrades cannot remove a field: a list living in the venue
would have been permanent, and sharding it later would have meant migrating live
venues.

`damlc upgrade-check` reports two warnings on this upgrade, both of the form
`Name ...$$sc_$censure1_1 and name ...$$sc_$censure_1 differ ... reason: Nothing`.
They are name-comparison artifacts: adding `PlayerRoster`'s `ensure` renumbers
the compiler's generated constants, and the checker compares those names without
looking through them. No existing `ensure`, `signatory`, `observer`, or
`controller` was modified — the diff on the module contains no removals from any
1.3.0 template, only additions belonging to the new one.
