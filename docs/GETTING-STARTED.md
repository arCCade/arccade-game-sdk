# Getting started

A complete stake-and-settle cycle on Canton TestNet, from a clone, in about
fifteen minutes. Most of that is waiting for a build.

The cycle you will run takes **two ledger writes** and the SDK will not let you
spend more. That constraint is the product; everything below is how to meet it.

## What you need first

**A Canton TestNet participant and a party you can act as.** The SDK does not
provide these and this guide does not cover getting them — they are Canton, not
arCCade. The [Splice validator
documentation](https://docs.dev.sync.global/validator_operator/index.html) is
the shortest route; a validator gives you a participant, a party, and a JSON
Ledger API on port 7575.

You do **not** need Canton Coin to finish this guide. The walkthrough runs in
dry-run mode, which is a real cycle on real contracts with no value moving.

Also: [Daml SDK](https://docs.daml.com/getting-started/installation.html)
3.4.10 and Node 20+.

## 1. Clone and build

```bash
git clone https://github.com/arCCade/arccade-game-sdk.git
cd arccade-game-sdk
daml build
```

No Splice installation, no environment variables, no host-specific paths. The
CIP-0056 interface DARs are vendored, so the build resolves against the same
bytes that were vetted on the network rather than whatever a fetch returns
today.

Check that you built what we built:

```bash
python3 tools/check_package_id.py
# OK  1.5.0 -> a0553775ff7b431dfdb8c92a3ae127638e124c02569e3cce22cc7a08aee2fb3a
```

If that fails, stop. A DAR that differs from the published id cannot be
compared against what the network vetted, and every guarantee below rests on
that comparison.

## 2. Upload the package to your participant

```bash
curl -X POST --data-binary @.daml/dist/arccade-game-sdk-1.5.0.dar \
     -H 'Content-Type: application/octet-stream' \
     http://localhost:7575/v2/packages
```

Uploading vets it on your connected synchronizer.

**A 503 here does not mean it failed.** The JSON API's 503 is a request
timeout and says nothing about the transaction — a DAR upload often completes
after it. Check before retrying:

```bash
curl -s http://localhost:7575/v2/packages | grep -c a0553775
```

## 3. Run a cycle

```bash
cd examples
npm install @arccade/game-sdk
PARTY='your-party::1220...' LEDGER_URL=http://localhost:7575 \
  node first-cycle.mjs
```

That script is ninety lines and worth reading rather than just running. It
creates a venue, initialises its slot roster, issues the player a slot,
commits a stake against an entry commitment, settles it revealing both
documents, and then recomputes both digests off-ledger.

## What just happened

**Two writes, and only two.** `Entitlement_Commit` created the stake;
`GameStake_Settle` closed it. There is no game-result contract, no claim
receipt, no leaderboard write. The outcome lives in the settlement's exercise
node and in the documents you revealed — which is why a consumer reading the
flat stream sees a create and an archive, and why the audit anchor exists.

**The slot came back.** Settlement recreates the entitlement it consumed. A
player holds exactly `concurrencyLimit` slots, commit takes one, settlement
returns it — so open cycles can never outnumber the tokens in circulation.
That count is structural: issuance mints exactly the policy's range and
refuses a player already on the roster.

**The commitment was checked, not recorded.** `GameStake_Settle` recomputed
sha256 over the entry document you revealed and compared it with what the
stake had been carrying since commit. Change one byte of the reveal and the
settlement is rejected by the ledger.

You can verify that yourself, with no library:

```bash
printf '%s' 'arccade-sdk-digest-v1|t:18:first-cycle-entry…' | sha256sum
```

The canonical document is plain text on purpose. Every value renders as
`<tag>:<length>:<value>` with the length in Unicode code points, fields sorted
by name, and amounts as integer 1e-10 units — never as formatted decimals,
because decimal rendering is not a canonical form another language happens to
match.

## Where the dry-run stops

A dry-run venue is constrained by the contract, not by convention: its id must
start with `dryrun-`, and its fee floor and payout ceiling must both be zero.
So a dry-run cycle cannot be reported as real activity — which is exactly why
it is safe to hand you first.

Going live changes three things:

1. **Custody becomes real.** `buildCommitCommands` (rather than
   `buildDryRunCommitCommands`) emits **two commands in one submission**: an
   `AmuletRules_Transfer` that produces a `LockedAmulet`, and the
   `Entitlement_Commit`. They cannot see each other — there is no
   output-to-input chaining within a submission — so the binding between them
   is atomicity plus the custody tag, verified at settlement.

2. **You need disclosed contracts.** `AmuletRules` and `OpenMiningRound` are
   not visible on your participant; fetch them from Scan and pass them as
   `disclosedContracts`. Without them the submission fails with
   `CONTRACT_NOT_FOUND`.

3. **`requireCustodyProof` turns on.** Settlement then fetches the locked
   holding and checks owner, instrument, amount, holder set, expiry and tag
   before releasing anything.

The mechanics of steps 1 and 2 are Splice's, not the SDK's. That is the
honest division: the SDK gives you the cycle, the commitment scheme and the
audit trail; Splice gives you the money.

## Housekeeping

Each run leaves a venue, a roster and an entitlement on your participant. They
are harmless but they accumulate, and this participant has a history of ACS
growth turning into 413s on list queries. Archive what you no longer need:

```bash
# find them
curl -s -X POST http://localhost:7575/v2/state/active-contracts …
```

## Next

- [`README.md`](../README.md) — what the package is and what it refuses to do.
- [`DESIGN.md`](DESIGN.md) — the full design, with an implementation-status
  table at the top. Read that table before treating the rest as a description
  of what exists.
- `test-vectors/` — the golden values and fixtures every implementation is
  pinned to. If you write a client in another language, this is the contract
  you are conforming to.
