# Conformance suite

One manifest, many clients. `manifest.json` enumerates 470 cases that every
implementation of the arCCade digest, Merkle, audit, identity and builder
surfaces must agree on, byte for byte.

**Daml is the source of truth, not the JavaScript client.** 221 of the 470 cases
take their expected value from a literal in
`test-package/daml/Test/GameSdk/VectorsTest.daml`, parsed out of that file by
`generate.mjs`. For the rest, `generate.mjs` records what the JavaScript client
returns when driven through its published package entry point. Which of the two
a case rests on is written in its `source` field, and §"Where an expectation
comes from" says why the remainder has no Daml anchor.

## What "conforms" means

A client conforms at profile P if, driven exactly as a third-party consumer
would drive it, it passes every case in P with no `unsupported` result and no
`error`.

Two consequences are load-bearing and are stated here rather than left implicit:

**The suite is expected to ship RED.** 13 normative decisions are recorded in
`manifest.json` under `decisions`, and 15 cases currently disagree with the
JavaScript client. That is the point. A conformance suite that goes green on
day one has been written to match the code instead of to match the ledger. The
disagreements are listed in `divergences`, each naming the decision, what was
pinned, what the client actually did, and its raw error text.

**A capability with zero cases is a hole, not a pass.** `generate.mjs` refuses
to write the manifest if any catalogued capability has no case.

**0 capabilities are implemented by no client.** That line used to read "8", and
the 8 were wrong: `python/arccade_game_sdk` exports `anchor_document`,
`anchor_totals`, `valid_policy`, `policy_document`, `assert_settlement_valid`
and the four `time.*` operators from the package's top level, and the Java
client implements all of them too. The catalog said otherwise for as long as
nothing measured it. The `impl` column is now taken from what each runner
actually dispatches, and it is no longer prose:

> Each runner compares `capabilities[].impl.<its own language>` against its own
> dispatch table at startup, and **exits 2** — manifest error, nothing run — if
> the catalog claims an implementation it does not have, or denies one it does.

That is the whole of the fix. A `null` that has gone stale is now refuted by the
client it slanders, on the next run, without anyone remembering to look.

**0 capabilities the JavaScript client does not implement.** That line used to
read "9" — `audit.anchorDocument`, `audit.anchorTotals`, `policy.policyDocument`,
`policy.validPolicy`, `settlement.assertSettlementValid` and the four `time.*`
operators — and it had stopped being true before it was last written down. The
JavaScript package shipped every one of those functions from `js/src/index.js`
while the catalog still recorded `impl.js: null`, so **0 cases sit on
capabilities the JavaScript client does not implement**, where 40 did. All three
clients implement all 72.

That stale `null` was self-consistent, which is why it survived. `run.mjs` had no
dispatch entry for the nine, so its startup check compared a null claim against a
missing dispatch and agreed with itself; the generator never called the client
either, because those capabilities were driven by a generator-local `reference`.
Two checks now cross that gap, and both refuse to write or run:

> **`generate.mjs`**: `Boolean(impl.js) !== Boolean(run)` is fatal for any
> capability. A claim about a client and the ability to call that client have to
> move together.
>
> **`generate.mjs`**: where a capability has BOTH a `reference` and a client
> `run`, the reference stays the expectation and the client is measured against
> it on every case — `CLIENT vs REFERENCE`, a `problem`, nothing written. The 40
> cases keep expectations that no client authored; they simply now also fail if
> the client disagrees with them.

The reference is deliberately not retired. 16 of those 40 cases take their
expected value from it and from nothing else (the other 24 are anchored to Daml
literals), so deleting it in favour of the now-working client would convert 16
independent expectations into 16 restatements of what the client does.

The sharpest of the forty: the live TestNet anchor
`f3e0805b9c3b9b9147f8b7b866ddd34d157d5d1e1e60b5942e14335909a6bd2a` is on the
ledger and in the anchor report `generate.mjs` cross-checks against — an
absolute path on arCCade's operator host, named there as `LIVE_ANCHOR_FILE`.
This file used to say **no shipped client can reproduce it**, then that two did.
All three do: case `anchor-testnet-2026-08-27` passes in every runner. It also
pins the exact document text that hashes to the anchor, derived from
`canonDocument`, `canonText` and `canonInt` alone, so a client with no
`anchorDocument` at all can still check the digest through the `core-digest`
primitives.

## What is here

| File | |
|---|---|
| `manifest.json` | the cases. Generated; do not hand-edit. |
| `generate.mjs` | regenerates the manifest: expectations come from `VectorsTest.daml` where Daml has a literal, from the JS client where it does not. Refuses to write if anything below fails. |
| `runners/run.mjs` | the JavaScript runner. Drives `@arccade/game-sdk` through `js/package.json` `exports["."]`. |
| `runners/run.py` | the Python runner. Imports `arccade_game_sdk` as a top-level module from `python/`. |
| `runners/java/run` | the Java runner: builds `java/target/game-sdk-1.5.1.jar`, compiles `runners/java/Runner.java` against it, runs. `runners/java/README.md` is its own write-up. |
| `runners/results/` | the last run of each. Artifacts, not source. |
| `README.md` | this file. |

All three runners exist. `node generate.mjs --check` is a different check and
not a substitute for them: it re-derives the manifest and exits non-zero if any
expectation, golden, provenance claim or divergence has moved, which asks
whether the *manifest* is still honest, not whether a client conforms.

## The manifest in one screen

```
manifest.json
  manifestVersion, spec, premise
  generator      how expectations were produced, and the live-anchor cross-check result
  sdk            package name, version, and the entry the generator resolved
  profiles       core-digest, merkle, audit, identity, value-documents, time, quota, builder
  rejectClasses  the seven classes a refusal may carry
  rejectClassification  what is normative across clients and what cannot be
  rejectMaps     one map per language, harvested from that runner's own source
  rejectMap      rejectMaps.javascript with a use count per rule, under its old name
  capabilities   72 entries: profile, arg types, return kind, per-language impl name or null,
                 each cross-checked by that language's runner at startup
  damlVectors    the Daml file the expectations are harvested from, how many, and which capabilities have none
  goldens        19 published constants, each with where it came from and whether it still agrees
  decisions      the normative pins, which languages they turn red, and the cases
                 a settled one still governs
  divergences    where the JavaScript client disagrees with a pin, right now
  divergenceCoverage  which languages that array actually observed, and what closes the rest
  fixtures       sha256 of the two test-vectors files the cases were lifted from
  exclusions     what is deliberately not covered, each with a reason and a mitigation
  summary        counts by group, profile, source and kind
  groups[]       23 groups, each with its cases
```

Every case:

```json
{
  "id": "canon-fields-duplicate-name-kept-in-order",
  "group": "canon-composite",
  "capability": "digest.canonFields",
  "title": "Duplicate field names are kept in insertion order, not rejected",
  "why": "A caller building fields from a map merge can emit the same name twice; ...",
  "input": { "args": [ { "t": "pairs", "v": [ ... ] } ] },
  "expect": { "text": { "v": "r:16:k:1:a=1;k:1:a=2;", "vHex": "723a31363a..." } },
  "tags": ["encoding", "boundary"],
  "pins": {
    "daml": "canonFields [(\"a\", \"1\"), (\"a\", \"2\")] === \"r:16:k:1:a=1;k:1:a=2;\"",
    "damlVector": {
      "key": "canon-fields-duplicate-name-kept-in-order",
      "file": "test-package/daml/Test/GameSdk/VectorsTest.daml",
      "line": "349"
    },
    "sourceOfTruth": "daml-vector"
  },
  "source": "daml-vector"
}
```

`pins.damlVector` names the exact line the expected value was read from. Where
it is `null` the case has no Daml anchor and `source` says what it rests on
instead.

### Tagged values

**No JSON number appears anywhere under `input` or `expect`.** `1787437747372202`
survives `JSON.parse` in JavaScript today but `9223372036854775807` does not,
Python would hand a `float` to a Decimal path, and Jackson picks `Integer`,
`Long` or `Double` by value. One rule removes the whole class of problem.

| `t` | `v` | decodes to (JS / Python / Java) |
|---|---|---|
| `text` | string | `string` / `str` / `String` |
| `int` | decimal string | `BigInt` / `int` / `long`, or `BigInteger` when `"wide": true` |
| `dec` | exact decimal literal string | string / `Decimal` / `BigDecimal` — never a binary float |
| `bool` | `true`/`false` | native boolean |
| `micros` | int64 decimal string | as `int`; a separate type so a runner cannot pass an ISO string |
| `party` | string | string |
| `hex64` | 64 lowercase hex chars | string |
| `raw` | string | passed verbatim: an already-canonical fragment |
| `null` | `null` | `null` / `None` / `null` |
| `list` | array of tagged values | list |
| `pairs` | array of `[tagged, tagged]` | ordered field list |
| `record` | `{schema, fields}` | typed carrier |
| `steps` | `[{siblingOnLeft, sibling}]` | the neutral Merkle-proof shape |
| `float64` | `{bits, approx}` | native double; gated on trait `hasNativeFloat` |
| `json` | any JSON | passed verbatim |

`vHex` is the UTF-8 of `v` in lowercase hex. **Where both are present a runner
must decode `vHex` and assert it equals `v`**; a mismatch is a manifest error
(exit 2), not a case failure. That is what makes byte-exactness auditable in a
file a human can still read.

`t: "json"` is one extension over the design's tag list, and the one place a
JSON number may appear. It carries a ledger transaction tree — the Ledger API's
shape, not ours — straight into `rowsFromTransactions`. Nothing decodes it into
a typed value, so none of the width hazards above apply. The no-numbers walk in
`generate.mjs` and in any runner stops at a `json` node and nowhere else.

### Expectation forms

Exactly one key per `expect`:

`value` (structural, over a tagged value) · `text` (`{v, vHex}`, byte-for-byte)
· `digest` (lowercase hex64) · `document` (`{text, digest}` — **both** pinned, so
a failing runner can say which one moved) · `bool` · `order` (a cycleId
sequence) · `reject` (`{class}`).

An *assert* capability — `cycle.assertValidCycleId` and friends — returns its
argument unchanged when it accepts, so acceptance is `{"value": {"t":"text", ...}}`
and refusal is `{"reject": {...}}`.

### Refusals are first-class

108 of the 470 cases expect a refusal. Most of this SDK's safety is refusal, and
a suite with only happy paths lets a client that validates nothing pass.

Normative: **that** the call refuses, and the **class**. Not normative: the
exception type or the message text — three languages, two of them with Turkish
messages, and forcing agreement there is translation work with no auditor value.

The seven classes: `bad-type`, `bad-format`, `out-of-range`, `precision-loss`,
`unknown-tag`, `invariant-violated`, `not-injective`.

A runner maps native throws to classes with a **table keyed by capability group,
never by case** — a per-case map would let a client pass by naming the answer.
Each language's table is in `manifest.json` under `rejectMaps.<language>`,
harvested by `generate.mjs` from that runner's own source so no rule is written
down twice. `rejectMap` is `rejectMaps.javascript` under its old name, with a
use count per rule; `generate.mjs` refuses to write the manifest if any rule is
never exercised, because a rule nobody exercises is a rule nobody checked.

**The three maps are not the same table and are not meant to be.** Python and
JavaScript match a substring of their own error text; Java matches on exception
type first and message second; Python legitimately carries rules JavaScript has
no use for, because it refuses three things JavaScript does not (D7, D8, D9).
What IS normative across clients is the class each case expects, in
`expect.reject.class`, and every runner is measured against it case by case.
Each runner compares its own table against its own entry at startup and **exits
2** on any difference — see check 20.

## Running it

Three runners ship, one per client. Each drives its client the way a consumer
would — through the published entry point, never by reaching into a source file
the distribution does not carry — and each writes JSON Lines plus a `.verdicts`
sidecar.

```
node    runners/run.mjs  --profiles merkle
python3 runners/run.py   --profiles merkle
runners/java/run --manifest manifest.json --out runners/results/java.jsonl --profiles merkle
```

| | Runner | Client resolved through |
|---|---|---|
| JavaScript | `runners/run.mjs` | `js/package.json` `exports["."]`, asserted to be inside `files` |
| Python | `runners/run.py` | `arccade_game_sdk` as a top-level module from `python/`, asserted against `python/pyproject.toml` |
| Java | `runners/java/run` | `java/target/game-sdk-1.5.1.jar` — the packaged jar, not `java/src` |

`node generate.mjs --check` is **not** the JavaScript runner. It re-derives
`manifest.json` and compares it byte for byte with the file on disk, which
answers "is the manifest still honest", not "does this client conform".

### Where the shipped runners differ from the contract this file used to state

Written down rather than quietly reconciled, because a documented contract no
runner satisfies is worse than no contract.

| Contract as stated | What ships |
|---|---|
| `runners/<lang>/run` | only Java is at that path. JavaScript and Python are `runners/run.mjs` and `runners/run.py` |
| `--manifest` required | required by Java (no flags → exit 2). JavaScript and Python default to `conformance/manifest.json` |
| `--out` required | required by Java. JavaScript and Python default to `runners/results/<lang>.jsonl` |
| the flag list | all three also accept `-h`/`--help`; JavaScript and Python also accept `--quiet` |
| `--profiles` default: every profile the runner declares | holds for all three, and all three now accept `--profiles all` as a spelling of it. Combining it with a named profile is exit 2 in each rather than a silent widening |
| "Python imports the module the repo ships at `tools/`" | the Python client moved to `python/arccade_game_sdk`. `tools/` now holds golden-vector entry points, not the implementation |

### Output

JSON Lines with a fixed key order: one `runner` header (language,
implementation, runtime, manifest sha256, declared profiles, declared traits,
the reject map), one `case` record per case sorted by id, one `summary`. No
floats anywhere. Five statuses and nothing else:

| status | meaning | counts as |
|---|---|---|
| `pass` | observed matched expected (a correct refusal is a pass) | ok |
| `fail` | observed differed, or a value came back where a refusal was required | red |
| `error` | threw where a value was expected, and the throw could not be classified | red |
| `unsupported` | capability not implemented by this client | red if the profile was declared |
| `not-applicable` | an `appliesWhen` trait is absent in this runtime | neutral |

The raw error text goes into `observed.errorText` **on pass as well as fail**,
so message drift is visible in review even when the class still matches. An
unclassifiable exception is `error`, never `pass`.

Exit codes are deliberately distinct — "the suite could not be trusted to run"
and "this client does not implement what it claims" are different facts, and
collapsing them into "tests failed" is how a run gets waved through:

| 0 | everything in the selected profiles passed or was not-applicable |
| 1 | at least one `fail` or `error` |
| 2 | manifest, sha256 or I/O problem: no cases ran, or the run is untrustworthy |
| 3 | a declared profile contains an `unsupported` capability |
| 4 | uncaught exception in the runner itself |

Every runner also writes `<out>.verdicts`: one `<id> <status>` line per case,
sorted by id.

> Two runners invoked with the same manifest and the same `--profiles` MUST
> produce byte-identical `.verdicts` files.

That is the literal meaning of "identical pass/fail output", and `diff` checks
it without trusting any runner.

### What the three runners report today

Manifest `e21681d67acf53736adb4cf9dc69a0e92b4dfb6b7535b953cd2bea3d54d3220d`,
470 cases, every runner given `--profiles all`:

| Profile | Cases | JS pass/fail/unsup | Python | Java |
|---|---:|---|---|---|
| core-digest | 137 | 134 / 3 / 0 | 137 / 0 / 0 | 137 / 0 / 0 |
| merkle | 75 | 75 / 0 / 0 | 75 / 0 / 0 | 75 / 0 / 0 |
| audit | 87 | 82 / 5 / 0 | 87 / 0 / 0 | 87 / 0 / 0 |
| identity | 88 | 86 / 2 / 0 | 88 / 0 / 0 | 88 / 0 / 0 |
| games | 20 | 19 / 1 / 0 | 20 / 0 / 0 | 20 / 0 / 0 |
| value-documents | 15 | 12 / 3 / 0 | 15 / 0 / 0 | 15 / 0 / 0 |
| time | 12 | 12 / 0 / 0 | 12 / 0 / 0 | 12 / 0 / 0 |
| quota | 10 | 10 / 0 / 0 | 10 / 0 / 0 | 10 / 0 / 0 |
| builder | 26 | 25 / 1 / 0 | 26 / 0 / 0 | 26 / 0 / 0 |
| **all 470** | 470 | **455 / 15 / 0** · exit 1 | **470 / 0 / 0** · exit 0 | **470 / 0 / 0** · exit 0 |

JavaScript's 15 failures are exactly the 15 entries in `divergences`. There is
no `unsupported` column left to explain: the 40 that used to sit here belonged
to nine capabilities the catalog said JavaScript did not implement and it did,
and they now pass. It is still the only client with any red, and every one of
those 15 is recorded.

**Python and Java produce byte-identical `.verdicts` files over all 470 cases.**
`diff` of the two prints nothing. That is the suite's headline claim satisfied
by two independent implementations across every profile, not just `merkle`.

Both green columns used to be read as "nothing is being checked over there".
They are not: they are the evidence that closed three of this round's four
findings, because the catalog said Python did not implement 42 of the
capabilities it passes and Java did not implement 43 of the ones it passes, and
`decisions[].goesRed` claimed Python violated six pins and Java three that both
had already adopted. None of that could be contradicted by a manifest generated
from the JavaScript client alone. It is contradicted now, by the runners
themselves: each refuses to run against a catalog that is wrong about it, and
`run-all.sh` refuses to pass on a `goesRed` the three runs disagree with.

### The cross-runner diff, taken

Differing `.verdicts` lines, per profile, for each pair:

| Profile | JS ~ Python | JS ~ Java | Python ~ Java |
|---|---:|---:|---:|
| core-digest | 3 | 3 | **0** |
| merkle | **0** | **0** | **0** |
| audit | 5 | 5 | **0** |
| identity | 2 | 2 | **0** |
| games | 1 | 1 | **0** |
| value-documents | 3 | 3 | **0** |
| time | **0** | **0** | **0** |
| quota | **0** | **0** | **0** |
| builder | 1 | 1 | **0** |
| **all** | 15 | 15 | **0** |

`conformance/run-all.sh` automates this: it drives all three with one invocation
shape, asserts they ran the same case set, prints the pairwise diff, checks
`goesRed` against all three, and judges the per-case verdict triple against a
frozen baseline of 15 lines, every one a recorded divergence. It was 55: the
other 40 were `no-impl:js` waivers, and `--freeze` reported all 40 as STALE once
the JavaScript client was actually driven.

### One wart, verified

`node generate.mjs --check` exits 1 anywhere except arCCade's operator host.
`manifest.generator.liveAnchorCrossCheck` records the absolute path of the live
anchor report, and `generate.mjs` writes `report file not present in this
environment` instead when that file is absent — a different byte string, so the
byte-for-byte comparison reports drift. Reproduced by pointing `LIVE_ANCHOR_FILE`
at a path that does not exist: `on disk … 1564395 bytes` versus `fresh …
1564307 bytes`, exit 1. The three runners are unaffected; they read the manifest
and never regenerate it.

## The checks that can fail

`generate.mjs` writes nothing unless all of these hold. Each has been
mutation-tested by breaking it on purpose.

1. **Daml mismatch.** For every case with a vector in `VectorsTest.daml`, the
   harvested literal is the expectation. If the client disagrees the run stops
   and prints the case, the Daml assertion with its file and line, the expected
   value and the observed one. **The observation is never adopted.** This is the
   check the file now turns on: it is what makes a wrong client fail instead of
   rewriting its own baseline.
2. **Daml input pins.** The `leaf-<n>` digests the manifest feeds back to the
   client are checked against Daml before anything is built from them, so a
   broken `textDigest` cannot move the inputs and the expectations together.
3. **Dead vectors.** A `@vector` key that names no case is a failure. A literal
   nobody is measured against reads like coverage and is not.
4. **Unreviewed anchors.** A vector may only attach to a capability listed in
   `DAML_ANCHORS`, and its assertion must mention that capability's Daml
   function as a whole name — so `canon` does not match `canonText` and a vector
   cannot be hung on the wrong encoder.
5. **One source of truth per case.** A case may not carry both a normative pin
   and a Daml vector, and a case carrying both a published golden and a vector
   fails unless the two are the same value.
6. **Golden drift.** The 19 already-published constants are asserted, not
   regenerated. If `textDigest("arccade")`, `merkleEmpty`, `merkleNode`, the
   three-leaf root, the golden audit leaf, the two game entry digests, the three
   fixture leaves, the fixture root, the three fixture custody tags or the live
   anchor stops matching, the run stops and says what moved.
7. **Golden provenance, fail-closed.** Every golden must resolve to at least one
   provenance the generator actually verified, and a golden that resolves to
   none stops the run. Two count: the value appears verbatim in a file the
   repository ships (`VectorsTest.daml` or `test-vectors/cycle-rows.json`), or
   the case is anchored to a named Daml vector, which is stronger than a grep
   because the literal was parsed out of the source and the client was already
   measured against it. Grepping is crude on purpose: it cannot be satisfied by
   the implementation agreeing with itself.

   This check used to **fail open.** A golden whose label contained none of
   three known substrings fell through to the sentence *"verified by running the
   Daml test package against the 1.5.0 DAR"* — prose nothing checks, stamped
   into `goldens[].provenance` where it reads exactly like a result. Three
   shipped goldens took that branch: the three `time.*` operators. They now
   carry the `VectorsTest.daml` line and number of the vector that proves
   them.
8. **Live anchor cross-check.** When the published anchor report is reachable,
   its `venueId`, `periodId`, `merkleRootHex`, `reportDigest`, `prevAnchorDigest`
   and `anchorDigest` are compared against the pins.
9. **Stale divergence.** A case pinned against a normative decision that has
   quietly started to *agree* is a failure. A stale pin is as misleading as a
   stale waiver.
10. **`goesRed`, in both directions, and across all three clients.** A decision
    listing JavaScript must still produce a divergence, *and* a decision not
    listing JavaScript must not produce one — a stale pin and a silent one are
    both failures. `generate.mjs` measures the JavaScript half by running the
    client. It cannot import the Python or the Java client, so it does not
    guess: `manifest.divergenceCoverage` says in the file itself that
    `divergences` is a JavaScript observation and is silent about the other two,
    and `run-all.sh` closes the gap by reading all three `.verdicts` files and
    failing when a language's observed red on a decision's cases is not what
    `goesRed` claims.

    This is what caught the stale `goesRed` lists. Six decisions named Python
    and three named Java; all nine were adopted by those clients some time ago
    and nothing noticed, because the old check required a decision to name
    **JavaScript** before it looked at anything. Corrected: every decision that
    still has a divergence has it in JavaScript alone.

11. **No JSON numbers** under `input` or `expect`, outside a `json` value.
12. **Capability coverage.** Every catalogued capability has at least one case.
13. **Reject-map coverage.** Every rule is exercised by at least one case, and no
    rule may be a catch-all.
14. **Unclassifiable throw.** A capability that threw where the map has no rule
    is a problem, not a silently widened `catch`.
15. **Case hygiene.** Ids are unique and kebab-case; `why` is at least 40
    characters and is not boilerplate; a hand-written `expect` must carry either
    a `golden` or a `decision`, because an expectation with neither behind it is
    an unfalsifiable claim.
16. **Profile declaration.** Every group's profile is one the manifest declares.
17. **README drift.** The counts quoted in this file are checked against the
    manifest. A quoted count that has stopped being true is a documentation bug
    that reads exactly like a fact. It finds a group's row by the **first** line
    that starts with `|` and mentions the group name in backticks, so a
    backticked profile name in an earlier table shadows it — which is why the
    runner-result tables above spell profile names without backticks. That is a
    sharp edge in the check, not in the tables.
18. **`--check` drift.** `manifest.json` on disk is byte-identical to what the
    current client produces. Off arCCade's operator host this one always fires,
    for a reason that has nothing to do with any client — see §"One wart,
    verified".
19. **A decision with no case.** D4, D5 and D6 claimed Python went red on them
    while carrying **zero cases**, which no evidence could contradict. A
    decision must now name at least one case: the pinned case that carries it,
    or — once every client agrees and there is nothing left to pin — the cases
    it `governs`. **4 settled decisions** (D4, D5, D6, D12) are in that state, and
    their cases stay attached so a regression in any client turns them red again
    instead of passing unnoticed.

20. **Reject-map drift is a refusal, not a note.** Reject classification is
    normative per case — `expect.reject.class` is measured in every language.
    The *message-to-class map* cannot be: Python and JavaScript match a
    substring of their own error text, Java matches on exception type plus
    message, and the three clients do not speak the same sentences. The manifest
    published the JavaScript map under the name `rejectMap`, as if it were
    everyone's; each runner then compared its own table against it, found drift,
    printed it, and exited 0. The manifest now carries `rejectMaps`, one entry
    per language, **harvested from that runner's own source** so each rule is
    written down once, and each runner compares its table against its own entry
    and **exits 2** on any difference. `generate.mjs` additionally checks its own
    classifier against `runners/run.mjs`, since a drift there would mean every
    generated `reject.class` came from a rule set no runner has.

21. **The catalog's `impl` column, checked by the client it describes.** Not a
    `generate.mjs` check — this one runs in each runner, because the runner is
    the only thing that knows. At startup, `run.mjs`, `run.py` and `Runner.java`
    each compare `capabilities[].impl.<their own language>` against their own
    dispatch table, and **exit 2 — manifest error, nothing run** — if the catalog
    claims an implementation they do not have or denies one they do. Before this
    check the column was hand-maintained prose, and it was wrong about 42
    capabilities in Python and 43 in Java while both clients passed all 469
    cases, which the runners then repeated back in their own summaries as "37 are
    implemented by no client in any language".

## Keeping the Daml vectors and the manifest in step

The vectors live in `test-package/daml/Test/GameSdk/VectorsTest.daml`, each as an
assertion Daml itself runs:

```daml
  -- @vector canon-fields-uppercase-sorts-before-lowercase
  canonFields [("a", "1"), ("A", "2")] === "r:16:k:1:A=2;k:1:a=1;"
```

The key is the conformance case id. `<case-id>.text` carries the canonical text
of a case whose expectation is a whole document; `input.*` carries a value the
manifest feeds to the client rather than one it expects back.

To add one: write the assertion in `VectorsTest.daml`, run `daml test` in
`test-package/` (it fails if Daml does not produce the literal), make sure the
capability is in `DAML_ANCHORS` in `generate.mjs`, then run `node generate.mjs`.
If the JavaScript client disagrees, the generator refuses to write and names
what moved. **Do not resolve that by editing the literal to match the client** —
that is the defect this whole mechanism replaces.

The literals were obtained by running Daml and then cross-checked against a
plain `sha256` of the canonical document text: the same check a third party
performs with `sha256sum` and no Daml, no SDK and no library.

## Adding a case

Cases live in `generate.mjs`, grouped by the `group(...)` calls. Add a `C({...})`
next to its neighbours and re-run the generator.

```js
C({
  id: 'canon-list-element-containing-pipe',        // kebab-case, unique, PERMANENT
  capability: 'digest.canonList',                  // must be in the catalog
  title: 'canonList of one element that itself contains a pipe',
  why: 'Without the leading count this would encode identically to a two-element list, '
     + 'which is the exact ambiguity the count exists to prevent.',
  args: [A.list([A.raw('a|b')])],
  tags: ['encoding', 'boundary'],
})
```

Then:

```
node conformance/generate.mjs && node conformance/generate.mjs --check
```

Rules worth knowing before you write one:

- **Ids are permanent.** Waivers and frozen verdicts reference them, so a reused
  id would silently re-point a waiver. A deleted case's id goes into
  `retiredIds`, never back into circulation.
- **`why` names a concrete failure**, not what the case does. The generator
  rejects anything under 40 characters or starting "tests that" / "checks the" /
  "verifies that". A case nobody can justify is a case nobody will maintain.
- **Do not type an expected value.** Omit `expect` and the generator writes down
  what the client produced. There are exactly two reasons to type one:
  - `golden: '<where it was published>'` — an already-published constant. A
    mismatch stops the run.
  - `decision: 'D<n>'` — a normative pin no client satisfies yet. A mismatch is
    recorded as a divergence; an unexpected *match* stops the run. Add
    `expectDivergence: false` when a decision has several cases and only some of
    them diverge; the decision-level check still requires at least one.
- **New capability?** Add it to the catalog with `cap(...)`, giving its profile,
  its per-language `impl` names (or `null` where nobody implements it) and
  either a `run` that drives the shipped client or a `reference` built only from
  shipped primitives. It needs at least one case or the generator refuses.
- **New rejection message?** Add a rule to `REJECT_MAP` under the right
  capability group, and a case that reaches it.

## Coverage

470 cases, 23 groups, 72 capabilities.

| Group | Profile | Cases | Covers |
|---|---|---|---|
| `canon-scalars` | core-digest | 55 | tag/length shape; `canonText` and `codePointLength` over a 16-entry Unicode corpus (astral, combining, ZWJ, NUL, CJK, replacement); `canonInt` at both int64 edges and wide; `canonBool`; `canonTimeMicros` incl. pre-1970; `canonParty` with the full `::1220` fingerprint |
| `canon-composite` | core-digest | 27 | `canonOptional` incl. the documented non-injectivity; `canonList` count disambiguation and order sensitivity; the `canonFields` sort, duplicate names, `A` before `a`, values containing `;` and `=`; six field-name refusals |
| `amount-units` | core-digest | 36 | the Daml-pinned vectors; truncation toward zero on negatives; `1.`, `-0.0`, padded zeros; both band edges and both overshoots; eight format refusals; precision-loss refusals; native-float refusal |
| `canon-document` | core-digest | 9 | the envelope, the single literal pipe, schema and version inside the document, `textDigest("arccade")` against plain `sha256sum`, `textDigest("")` refused |
| `merkle-structure` | merkle | 20 | `merkleEmpty`, `merkleNode`, domain separation, `merkleRoot []` and `[x]`, roots for n = 1..9, `merklePairUp` promotion, `[a,b,c]` vs `[a,b,c,c]` (CVE-2012-2459) |
| `merkle-proof` | merkle | 55 | every index at every size n = 1..9; promoted leaves emit no step; out-of-range index yields `[]`; the trap that an empty proof verifies anything against a one-leaf tree; folding split from verifying |
| `period-leaf` | audit | 27 | the 15 fields of `arccade.cycle-audit-row`; the golden leaf and the three TestNet leaves; the leaf of a row rebuilt by the ledger reader rather than typed out here; amounts as `canonInt` not `canonDecimal`; timestamps as `canonInt` not `canonTimeMicros`; all five tags and all five constructor refusals; empty `outcomeDigest`; four forged-row cases |
| `period-anchor` | audit | 7 | `arccade.period-anchor` v1; the live TestNet anchor; empty-period anchoring; chain start; totals derived from rows; duplicate cycleId refused |
| `policy-document` | audit | 8 | `arccade-venue-policy` v1; decimals here vs units in the audit row; `validPolicy` incl. `minLockSeconds >= minCycleSeconds` |
| `audit-tree` | audit | 20 | the three published rows rebuilt from the six real TestNet transactions; join by stake contract id; derived amounts for abort and expiry; open stakes and orphan closings surfaced; the unlock cross-check; `isoToMicros` |
| `report-order` | audit | 10 | seven tie-break pairs where locale, UTF-16 and code-point order disagree; distinct timestamps dominating; one microsecond separating two commits; the `REPORT_ORDER` string itself |
| `identifiers` | identity | 47 | cycleId length in code points, `:` and `|`; hex64 case, length, charset; tradeId; localId grammar and bounds; tenantId; instanceId; namespaced round-trip |
| `custody-tag` | identity | 10 | `arccade-game-sdk:1:<cycleId>:<entryDigest>`; the three fixture tags; the prefix constant; every refusal path |
| `games-trade-wars` | (grouping) | 10 | `arccade-trade-wars-entry` golden; nested price points and allocations; allocation order sensitivity; sub-millisecond `as-of` |
| `games-pixel-race` | (grouping) | 10 | `arccade-pixel-race-entry` golden; `canonGamePlay`; seed commitment; empty plays |
| `assets` | identity | 19 | fungible and unique instrument ids; `parseAsset`; `isUnique`; unique amount must be 1; attribute documents; `deriveInstanceId` determinism and salt sensitivity |
| `tenant` | identity | 12 | `hashTenantKey`; `tenantIdFromKey` and every refusal path; `verifyTenantKey` value behaviour; isolation incl. namespace-less assets; multi-leg isolation |
| `value-documents` | value-documents | 15 | `tradeDocument` and `transferDocument`; leg and meta ordering; empty taker; the pipe ambiguity |
| `time-arithmetic` | time | 12 | truncation toward zero; `secondsBetween` truncating each endpoint independently; `addSeconds` |
| `settlement-invariants` | audit | 15 | conservation, non-negativity, each disposition's arithmetic, the payout cap, abort and expiry returning in full |
| `constants` | core-digest | 10 | every wire constant, `DISPOSITIONS` order and membership |
| `quota` | quota | 10 | window roll at the exact boundary, cost above one, `remaining` and `resetAt`, per-tenant buckets, refusals not consuming quota |
| `builder` | builder | 26 | two-command atomicity, the custody tag reaching `optContext`, dry-run shape, settle-before-unlock order, and every builder refusal |

By capability profile: core-digest 159, identity 87, audit 81, merkle 77,
builder 28, value-documents 15, time 12, quota 10.

## Where an expectation comes from

| `source` | Cases | What it means |
|---|---:|---|
| `daml-vector` | 202 | the expected value was read out of a literal in `VectorsTest.daml`, which `daml test` asserts Daml still computes |
| `daml-vector-golden` | 12 | the same, and the value is also one of the already-published goldens |
| `generated` | 214 | Daml has no literal for this case; the value is what the JavaScript client returned |
| `normative-pin` | 18 | hand-written against a `decisions` entry, because no client agrees with it yet |
| `reference` | 16 | produced by a reference in `generate.mjs`, for a capability no client implements and Daml has no pure function for |
| `asserted-golden` | 7 | a published constant whose provenance is `test-vectors/cycle-rows.json` or the live TestNet anchor |

**Why this matters.** Before the Daml harvest, 395 of 468 cases were `generated`,
which means the expectation *was* whatever the client returned at generation
time. Breaking the client — `codePointLength` counting UTF-16 units, `canonFields`
sorting with `localeCompare`, `merkleFold` flipping which side a sibling is on —
made `generate.mjs` rewrite the expectations to match the break and exit 0. The
broken client then scored its exact baseline. A suite that cannot fail a wrong
reference client is decoration. Daml is the right anchor because the ledger
recomputes these values inside `GameStake_Settle` and rejects a mismatch: a
client that disagrees with Daml has a bug that the ledger will surface as a
rejected transaction.

Ten of the 239 literals are `input.*` pins rather than expectations: they pin the
`leaf-<n>` digests the manifest *feeds* to the client. Without them a broken
`textDigest` would move the Merkle inputs and the Merkle expectations together.

### What has no Daml anchor, and why

The honest residue: 41 of the 72 capabilities have no Daml-anchored case.

| Capabilities | Why not |
|---|---|
| the nine `builder.*` command builders (26 cases) | they emit Ledger API command payloads. A command payload is the client's side of the gRPC contract, not a Daml value; Daml has no notion of one. |
| `audit.rowsFromTransactions`, `audit.unmatchedHalves`, `audit.unlockWarnings`, `audit.reportOrder`, `audit.isoToMicros` | off-ledger reconstruction of a period from Ledger API transaction *trees* plus an ISO-8601 parser. Daml never sees a transaction tree and has no ISO parser. |
| `digest.canonTime` | the same missing ISO parser: Daml `canonTime` takes a ledger `Time`, and this capability's input is an ISO string. Its one case is normative pin D3. |
| `tenant.hashTenantKey`, `tenant.tenantIdFromKey`, `tenant.verifyTenantKey` | tenant API-key hashing is off-ledger by design; no Daml function exists to anchor to. |
| the seven `assets.*` helpers, `tenant.namespacedInstrumentId`, `tenant.parseInstrumentId` | these operate on Splice `Holding.InstrumentId` strings. `Registry.daml` has only `inTenantNamespace` and `assertNamespaced`, which answer a different question (a `Bool` and an `Update ()`), not the value these return. |
| `trade.tradeDocument`, `trade.leg`, `transfer.transferDocument` | the v1 trade and transfer document format has no length prefixes and is not the canonical scheme; `Trade.daml` carries `TradeLeg` and `validLeg`, but no document function to anchor to. Decision D8 exists precisely because that format is weaker. |
| `cycle.assertValidCycleId`, `cycle.assertHex64`, `trade.assertValidTradeId`, `assets.assertValidLocalId`, `tenant.assertValidTenantId` | shape mismatch. Daml has `isValidCycleId` and `isHex64` returning `Bool`; these capabilities return **the argument unchanged** on accept and a classified refusal otherwise. Daml can say *whether* it accepts, not what these return. The other three predicates do not exist in Daml at all. |
| `settlement.assertSettlementValid`, `quota.consume` | the rules exist in Daml but only inside choice bodies (`GameStake_Settle`, `TenantMintRight`), as `ensure` and `assertMsg` in `Update`. A `Script` assertion cannot pin a value they never return. |
| `audit.anchorTotals` | `Audit.daml` has `sumRows`/`PeriodTotals`, but the manifest's expectation is an ordered `pairs` list that also carries `cycleCount`, which `PeriodTotals` does not hold. The duplicate-`cycleId` refusal is likewise a client-side rule: the Daml choice derives totals from rows it already holds. |
| `audit.periodRowVerify` | anchorable in principle — `Audit.daml` has `periodRowVerify` — but its five cases are built from the three TestNet rows in `test-vectors/cycle-rows.json` and forgeries of them. Reconstructing each as a 15-field Daml literal would move their provenance from the ledger fixture into this test module. Not done in this pass; their leaves are already `asserted-golden` against that file. |

The first six rows cannot be anchored at all. The last four could be, at a cost
stated in each row; they are listed so the number is not mistaken for a limit of
the design.

#### Two of them are DEMONSTRATED escapes, not theoretical ones

An adversarial pass mutated capabilities off this list identically in all three
clients and asked whether the suite noticed. Two got through, and they are named
here because an unanchored capability that has been *shown* to escape is a
different thing from one that merely lacks an anchor:

| Capability | The mutation | What happened |
|---|---|---|
| `builder.buildSettleCommands` | emit a different settlement payload shape | `generate.mjs` exited 0 and rewrote the expectation to match. All three runners then agreed with the mutation. |
| `tenant.assertTenantOwnsInstrument` | weaken the namespace-prefix test so a tenant passes isolation for an instrument it does not own | escaped, and more quietly than the first: nothing in the suite re-derives tenant isolation, so there was no second opinion to disagree with. |

The second is the one that matters. It is the check that keeps one studio from
issuing against another studio's instrument, and the suite currently cannot tell
a correct implementation from a permissive one — in any language, because all
three would be wrong together and the expectation is whatever they say.

Neither is anchorable in Daml as the code stands: a command payload is not a
Daml value, and `Registry.daml` answers a different question than
`assertTenantOwnsInstrument` returns. Closing them means either giving Daml a
function that returns the value these capabilities return, or writing the
expectations as hand-pinned normative decisions with the rule stated in prose —
which is weaker, and should be recorded as weaker.

Until then: **the builder and tenant-isolation capabilities are covered for
shape, not for correctness.** That sentence is the accurate description of what
a green run means for those two.

## What the design asked for that is NOT a case here

Stated explicitly rather than dropped quietly.

1. **The `games.*` adapter capabilities.** `tradeWarsEntryDocument`,
   `pixelRaceEntryDocument`, `seedMatchesCommit` and their outcome siblings live
   in `js/examples/arccade-games.js`, which `npm pack` does not ship. A consumer
   cannot call them, so they cannot be capabilities in a suite whose whole point
   is driving a client as a consumer would. The 20 cases in the two game groups
   express the same documents as compositions of `canonDocument`, `canonList`,
   `canonFields`, `canonText`, `canonDecimal` and `canonInt`, and they still pin
   the two published golden digests. Consequence: **there is no `games`
   capability profile**, and the two groups' `profile` field says so. `DESIGN.md`
   calls those documents normative; either they ship or that claim changes, and
   the manifest refuses to let both stand.
17. **Property cases.** The design reserved `property: {iterations}` for the
   entropy surfaces — `newCycleId`, `newTradeId`, `generateTenantKey` — where
   the input cannot be pinned and only an invariant can be asserted. The
   manifest's case shape allows the field and **no case uses it**: the generator
   has no property-case support. What is covered instead is the *shape* those
   functions produce (`cycleid-uuid-shaped`, the four `tenant-id-from-key`
   cases), which is weaker: it does not check that `newCycleId()` output
   actually satisfies `assertValidCycleId`, nor that `generateTenantKey` round
   trips. This is the largest known gap in the manifest.
18. **`verifyTenantKey`'s constant-time behaviour.** A timing property. A
   value-equality harness cannot observe it and a synthetic timing assertion
   would be flaky and defeatable. Recorded in `exclusions` with **mitigation:
   none**. Its value behaviour is covered by three cases; only the timing
   guarantee is unchecked.
19. **The cross-runner `.verdicts` diff.** The single most valuable check in the
   design — two runners, one manifest, byte-identical verdicts — is a property
   *of runners*, not of a case, so it cannot live in `manifest.json`. The three
   runners each write `.verdicts`, and §"The cross-runner diff, taken" carries
   the result; nothing automates it. Taking it is `diff`, run by hand.
20. **Waivers, `expected/verdicts.frozen`, and the report tool.** The design's
   dated-waiver machinery belongs to a tool that merges runner outputs, and no
   such tool exists here. This directory records the same facts under
   `decisions` and `divergences`, but without expiry dates or tracking ids, so
   nothing here expires.
21. **`toMicros` over `Date` and epoch-millis numbers.** Host-timezone dependent
   and millisecond-precision by construction, and Python and Java have no
   equivalent type set. Excluded, but not silently: `audit.isoToMicros` is
   strict and mandatory, and `iso-micros-preserved-in-document` pins a
   microsecond timestamp through to document bytes, so a client whose document
   path routes through a millisecond conversion fails.
22. **Ledger submission, package/DAR reproducibility, performance, `reportUri`
   fetching.** All in `exclusions`, each with a reason and a mitigation.

`manifest.json`'s `exclusions` array carries the same list in machine-readable
form; an exclusion whose mitigation is "none" is written as such.

## Fixtures

`test-vectors/cycle-rows.json` and `test-vectors/cycle-trees.json` are **not
moved or copied**. Their sha256s are recorded in `manifest.fixtures`, and the
values the cases need — the three rows, their leaves, the fixture root, the
three custody tags, the six real transactions — are lifted into the manifest
verbatim by the generator, which reads them from those files on every run.

That costs about 130 KB of manifest for the three full-tree cases, and it buys
the property the task actually needs: **every case is checkable by a client that
has only `manifest.json` and the SDK's public API.** Nothing here resolves a
path, and no case depends on a repository internal.
