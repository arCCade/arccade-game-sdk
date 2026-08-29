# Examples

Five things the SDK claims, each with a file you can run against a participant
you control — or, in the one case where running it would require real Canton
Coin and a Scan resolver, a walkthrough that says so rather than a script that
pretends.

| | Demonstrates | Needs |
|---|---|---|
| [`first-cycle.mjs`](first-cycle.mjs) | **commitment**, **settlement**, and both digests recomputed off-ledger | a participant, a party |
| [`recovery.mjs`](recovery.mjs) | **recovery** — abort, and expiry closed by the player alone | a participant, **two** parties |
| [`live-custody.md`](live-custody.md) | **custody** with real value — the two-command write, the tag, the unlock | nothing; it does not run |
| [`verify-anchor.mjs`](verify-anchor.mjs) | **verification** — leaves, root, inclusion proof, anchor, chain | nothing (offline) |
| [`verify_anchor.py`](verify_anchor.py) | the same verification, in Python | Python 3.10+ |
| [`VerifyAnchor.java`](VerifyAnchor.java) | the same verification, in Java | JDK 17+, the SDK jar |

The three verifiers print **the same hexadecimal** against the same input. That
agreement is the deliverable: an anchor is evidence only if a second and third
implementation, reading nothing but the published description, land on the same
bytes.

## Before you run the JavaScript ones

```bash
cd examples
npm install @arccade/game-sdk
```

Or, from a clone you are working in, point the package name at the source tree
so an example runs against the code you are editing:

```bash
mkdir -p node_modules/@arccade && ln -s ../../../js node_modules/@arccade/game-sdk
```

Everything below assumes a participant reachable on `LEDGER_URL` with the
`arccade-game-sdk` DAR uploaded. See [`docs/GETTING-STARTED.md`](../docs/GETTING-STARTED.md).

---

## `first-cycle.mjs` — commitment and settlement

A venue, a slot roster, a slot, a commitment, a settlement, and the two digests
reproduced off-ledger. Two ledger writes, and the SDK will not let you spend
more.

```bash
PARTY='your-party::1220…' LEDGER_URL=http://localhost:7575 node first-cycle.mjs
```

Dry-run, which is enforced rather than assumed: a `ModeDryRun` venue's id must
start with `dryrun-` and its fee floor and payout ceiling must both be zero, so
a dry-run cycle cannot be reported as real activity.

**Leaves a venue, a roster and an entitlement behind.** Archive them; see T15.

---

## `recovery.mjs` — the two exits that are not a settlement

`GameStake` is created by one choice and consumed by exactly one of three.
`first-cycle.mjs` covers `GameStake_Settle`. This covers the other two, and the
submissions that must be refused:

| Step | What it shows |
|---|---|
| 4 | the operator **cannot** abort alone — `GameStake_Abort` is `operator, player` |
| 5 | abort recycles the slot without counting the cycle |
| 6 | the returned slot is gated by `abortCooldownSeconds`, enforced from ledger time |
| 8 | the player cannot expire early either — the clock is the ledger's |
| 10 | with the lock expired, the **venue is refused** the same commands |
| 11 | the player closes the cycle with `actAs: [player]` and nothing else |
| 12 | the expired slot is reusable immediately — expiry writes no cooldown |
| 13 | a settlement with `forfeitedAmount > 0` on `TimeLockedHolding` is refused |

```bash
PARTY='venue-party::1220…' \
PLAYER_PARTY='player-party::1220…' \
LEDGER_URL=http://localhost:7575 node recovery.mjs
```

**Use two parties.** With one party acting as venue, operator and player, every
submission carries every authority and the refusals in steps 4 and 10 — the
ones carrying the argument — cannot fail. The script detects that case and
prints `SKIPPED` rather than reporting a check it did not run.

Takes about a minute — 52s measured — because it waits out a real lock.
`LOCK_SECONDS` (default 25) shortens or lengthens that; `KEEP=1` skips the
cleanup.

It archives everything it created and then **asks the ledger** whether anything
with its `venueId` is still active, rather than believing its own loop.

---

## `live-custody.md` — the part that needs real money

Not executable, on purpose. A live commitment locks real Canton Coin and needs
`AmuletRules` and an `OpenMiningRound` fetched from Scan and attached as
disclosed contracts. A script that stubbed those would run green and teach the
wrong thing, because the whole difficulty of live mode is that the encumbrance
either exists on the ledger or it does not.

The file gives the exact fields, the two-command shape, the custody tag, the
three things to assert before you let a player play, and what the recovery
paths look like with a `LockedAmulet` attached.

---

## `verify-anchor.mjs`, `verify_anchor.py`, `VerifyAnchor.java` — verification

Take a published period report and its on-ledger anchor and reproduce
everything: sha256 over the served bytes, every leaf from its row, the root
from the leaves, an inclusion proof for every row, the period totals, the
fifteen-field anchor document, and the `prevAnchorDigest` chain. The report's
own `leaves` and `merkleRoot` are checked, never trusted.

Then the check an example usually omits: one row is tampered with by a single
unit and the same proof is shown refusing it.

```bash
node verify-anchor.mjs                # live: https://audit.arccade.io/testnet
node verify-anchor.mjs --offline      # fixtures/, no network at all
node verify-anchor.mjs --ledger       # anchors from your own participant's ACS
node verify-anchor.mjs --period 2026-08-27

python3 verify_anchor.py --offline

# from the repo root, with the SDK jar on the classpath
java -cp java/target/game-sdk-1.5.1.jar examples/VerifyAnchor.java
# or from here
java -cp ../java/target/game-sdk-1.5.1.jar VerifyAnchor.java
```

`verify_anchor.py` appends `../python` to `sys.path`, so it runs from a clone
with nothing installed; an installed `arccade_game_sdk` takes precedence.

`VerifyAnchor.java` needs `java/target/game-sdk-1.5.1.jar`, normally built with
`./java/mvnw -q -DskipTests -f java/pom.xml package`. **That build currently
fails**, on something unrelated to these examples:
`java/src/main/java/io/arccade/gamesdk/Json.java:388` contains `\uXXXX` inside a
Javadoc comment, and javac decodes unicode escapes before comments are stripped,
so it is read as an illegal escape rather than as prose. Writing it `\\uXXXX`
fixes it. Until then, use the jar already in `java/target/`.

`--ledger` reads `VenuePeriodAnchor` from `LEDGER_URL` as `PARTY` — the
strongest source, because it is the anchor as the ledger holds it rather than a
summary of it. Without it the anchor document check is **skipped and labelled
skipped**; `index.json` carries only `anchoredRoot` and `anchoredDigest`, and a
summary cannot be reassembled into the document it summarises.

### Exit codes

| | |
|---|---|
| `0` | everything reproduced |
| `1` | a verification failed — a leaf, a root, a proof, an anchor or the chain |
| `2` | everything reproduced **except** the served bytes, which are not the bytes the anchor commits to |

**Against the published TestNet report today, these exit 2.** That is a real
finding and not a bug in the example: the `2026-08-26` report's rows are intact
— every leaf and the root reproduce, and the anchor document reproduces to
`caa2d6f5…` — but the file served hashes to `9f2a1c9d…` while the anchor
commits to `e83f509f…`. The bytes were re-serialised after anchoring. That is
**T4** in [`docs/INTEGRATION.md`](../docs/INTEGRATION.md): publish a report's
bytes once and serve them byte-stable forever. `index.json` records both
digests, so it was noticed rather than hidden.

The `2026-08-27` period exits 0 on its own (`--period 2026-08-27`), including
the empty-period case: no cycles, root equal to `merkleEmpty()`, still anchored
— because otherwise "nothing happened" and "we did not report" would look the
same.

### `fixtures/`

Captured verbatim so the verifiers work with no network:

| File | What it is | sha256 |
|---|---|---|
| `index.json` | the published index | `bbf609ea…` |
| `tradewars_testnet-arena-v2_2026-08-26.json` | period report, 2 cycles | `9f2a1c9d…` |
| `tradewars_testnet-arena-v2_2026-08-27.json` | period report, empty | `b4fda252…` |
| `anchors.json` | the two `VenuePeriodAnchor` contracts, read from a participant's ACS | — |

The two report files are byte-identical to what `https://audit.arccade.io/testnet`
serves, which is what makes `--offline` and the live run produce the same
digests. `anchors.json` holds each contract's `createArgument` verbatim,
including a `reportUri` on the 2026-08-26 anchor that points at a local file —
`reportUri` is a field of the **contract** and not of the anchor **document**,
so it is not covered by `anchorDigest`, and that anchor pointing somewhere
unpublished is part of the story of how its bytes drifted.

---

## Housekeeping

`recovery.mjs` cleans up after itself and verifies it. `first-cycle.mjs` does
not. Dev-loop leftovers are how an ACS grows into 413s on list queries — this
participant has a history of it — so archive what you no longer need and alert
on ACS size per party rather than discovering it as an HTTP error.
