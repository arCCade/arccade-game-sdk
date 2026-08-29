# Java conformance runner

Drives `io.arccade:game-sdk` through every case in `conformance/manifest.json`
and reports what it observed, in the JSON Lines format the suite specifies.

```
runners/java/run --manifest manifest.json --out runners/java/results/java.jsonl
```

The script builds `java/target/game-sdk-1.5.1.jar` if it is missing, compiles
`Runner.java` against it, and runs. **The SDK is resolved through the packaged
jar** — not `java/src`, not the wallet backend's `target/classes` — because a
class that does not ship is a class a consumer does not have, and a runner that
reaches into a source tree cannot tell the difference.

## Flags

```
--manifest <path>       required
--out <path.jsonl>      required; also writes <path>.verdicts
--profiles <a,b,c>      default: EVERY case. Naming profiles NARROWS the run,
                        and the summary then says how many cases it omitted.
                        "all" is still accepted and means the same as omitting it
--case <id>             repeatable
--group <name>          repeatable
--list-capabilities     catalog coverage as JSON (needs --manifest), exit 0
--traits                declared traits as JSON, exit 0
```

### The default used to be a subset, and said nothing about it

The bare invocation ran the profiles this runner *declared* — three of eight —
and printed `316 cases:` over a manifest of 468. Nothing in that line said 152
cases had not been run, and `316` reads as a total unless you already knew
better. A conformance run that quietly narrows its own scope is worse than one
that fails, because the failure is at least visible.

Two changes, either of which would have been enough:

1. **The default is now every case in the manifest.** `--profiles` narrows.
2. **A narrowed run says so, in the same breath as the count**, and names the
   flag that narrowed it:

```
75 of 470 cases: 75 pass, 0 fail, 0 error, 0 unsupported, 0 not-applicable
OMITTED 395 of 470 cases -- this run is a SUBSET, not a conformance result. Narrowed by: --profiles merkle
```

The counts are in the summary record too — `total`, `totalInManifest`,
`omitted`, `narrowedBy` — so a report tool reading the JSONL cannot mistake a
subset for a run either. An unknown `--profiles` value is exit 2 rather than a
selection that silently matches nothing.

## What it reports today

The runner prints the manifest's sha256 on every run and `run-all.sh` prints it
once for all three, which is how you tell that the three ran the same file. It
is deliberately not copied here: a hash frozen into prose is a claim that goes
wrong on the next regeneration and cannot announce that it has. 470 cases,
default invocation:

```
470 of 470 cases: 470 pass, 0 fail, 0 error, 0 unsupported, 0 not-applicable   exit 0
```

Per profile, run one at a time. These counts match `manifest.summary.byProfile`
exactly, which is the check that the case-to-profile mapping is right:

| Profile | Cases | Pass | Fail | Unsupported | Exit |
|---|---:|---:|---:|---:|---:|
| `core-digest` | 137 | 137 | 0 | 0 | **0** |
| `merkle` | 75 | 75 | 0 | 0 | **0** |
| `audit` | 87 | 87 | 0 | 0 | **0** |
| `identity` | 88 | 88 | 0 | 0 | **0** |
| `games` | 20 | 20 | 0 | 0 | **0** |
| `value-documents` | 15 | 15 | 0 | 0 | **0** |
| `time` | 12 | 12 | 0 | 0 | **0** |
| `quota` | 10 | 10 | 0 | 0 | **0** |
| `builder` | 26 | 26 | 0 | 0 | **0** |

All nine profiles are now **declared**. Declaring three and answering
`unsupported` 189 times was a survey result, not a claim; a client at parity has
to be willing to be wrong about every profile it is measured on.

A case's profile comes from its **group**, not from its capability. The two
disagree for 26 cases — `merkle-root-over-fixture-leaves` sits in the
`period-leaf` group but exercises `merkle.merkleRoot`, and all twenty game cases
sit in a `games` group while every one of them exercises a `core-digest`
capability. Taking the capability's profile is what made `games` unnameable:
`--profiles games` selected nothing in every runner while its 20 cases ran under
`--profiles all`, and the numbers still added up. All three runners read the
group's profile now, so `--profiles all` selects an identical set in each; the
`.verdicts` diff below is what holds them to it.

The **reject group** now comes from the catalog too (`capabilities[].rejectGroup`),
where it used to be re-derived from the capability id. That was a second opinion
about a fact the manifest already states, and the two had drifted:
`digest.textDigest` is catalogued under `digest.text` and was being classed under
`digest.scalar`.

## What closed the gap

This client implemented 29 of the 72 catalogued capabilities and reported
`270 pass · 9 fail · 189 unsupported`. It was a verification-only subset — the
digest, the tree and the audit reader — not a peer client. The 43 missing
capabilities are now implemented in `java/src/main/java/io/arccade/gamesdk/`:

| Added | |
|---|---|
| `LedgerTime` | `intDivide`, `epochSeconds`, `secondsBetween`, `addSeconds` — truncation toward zero, and per-endpoint truncation |
| `PolicyDocuments` | the venue policy document, its digest, and `validPolicy` |
| `SettlementInvariants` | the conservation arithmetic a Merkle proof cannot express |
| `PeriodAnchorDocuments` | the anchor document, its digest, and totals derived from the rows |
| `CycleCommands` | cycle ids, `assertHex64`, `custodyTagFor`, and the five cycle builders |
| `TradeCommands` | trade ids, legs, the trade document, and the three trade builders |
| `TransferCommands` | the transfer document and `buildTransferCommands` |
| `Tenancy`, `TenantQuota` | namespacing, isolation, keys, and the fixed-window quota |
| `Assets` | both asset models, the attribute document, and `deriveInstanceId` |
| `InstrumentId`, `LedgerPayloads` | the shared value type and the payload shapes the builders have in common |

The nine failures were not spec disagreements; each was a Java-side gap, and
each is closed by an addition rather than by relaxing anything:

| Was failing | Why | What closed it |
|---|---|---|
| `report-order-astral-vs-replacement` (**D1**) | `String::compareTo` is UTF-16 code-UNIT order, so U+1F3AE's lead surrogate sorted below U+FFFD | `ArccadeDigest.CODE_POINT_ORDER`, used by the report sort |
| `report-order-constant-names-a-collation` (**D11**) | the constant named no collation | `CycleAuditReader.REPORT_ORDER` now names it |
| `amount-native-float-rejected`, `-half-rejected` (**D4**) | no overload took a double, so the runner converted and the SDK answered | `amountUnits(double)`, which refuses. Nothing is converted now |
| `amount-rejects-{leading-plus,leading-dot,exponent-lower,exponent-upper}` (**D4/D5**) | the SDK took only `BigDecimal`, whose grammar accepts all four | `amountUnits(String)` carries the decimal grammar |
| `canon-int-wide-beyond-int64` | `canonInt(long)` had no wide overload | `canonInt(BigInteger)` |
| `text-digest-empty-rejected` (**D7**) | returned `e3b0c442…`, which Daml's `toHex ""` can never produce | `textDigest` refuses the empty string |
| 8 `constant-*` | the SDK exposed three of eleven wire constants | the other eight now have a home and are exported |

**Nothing here is not-applicable.** Every capability in the catalog can exist in
Java, so no case is answered with a stated reason instead of a result. The
status is implemented in the vocabulary and stays available for a case that
carries `appliesWhen`.

### One discrepancy with the manifest catalog

`manifest.json` records `impl.java` as null for 43 of the capabilities this
client now implements, because the manifest is generated and was not regenerated
here. `--list-capabilities` prints `supported` beside `catalogSaysJava`, so the
drift shows up as data rather than as an argument:

```
$ runners/java/run --manifest manifest.json --list-capabilities | jq '[.capabilities[]
    | select(.supported and .catalogSaysJava == null)] | length'
43
```

## The cross-runner diff, taken

`runners/run.mjs` and `runners/run.py` land alongside this one. Both accept the
full case set now, so the diff is taken over all 470:

```
diff py.verdicts java.verdicts     # no output: 470 cases, BYTE-IDENTICAL
```

Two independent implementations, one manifest, the same 470 verdicts down to the
byte. That is the design's headline check satisfied for the whole suite rather
than for one profile.

JavaScript is the client that is still red, and its red is the suite's original
point:

```
455 pass · 15 fail · 0 unsupported   exit 1
```

The 15 are the recorded divergences in `manifest.divergences` — `localeCompare`
in the report order, `Date.parse` truncating microseconds, `BigInt(true)`
rendering as `i:1:1`, `String.trim()` before the amount grammar, `textDigest("")`,
and the pipe that v1 documents must refuse. There were also 40 `unsupported`,
on nine capabilities the catalog recorded as unimplemented in JavaScript while
the JavaScript package exported every one of them; `run.mjs` now dispatches all
nine and they pass. The 15 are not a defect in this runner and should not be
made to go away by changing the manifest.

## Exit codes

| 0 | everything in the selection passed |
| 1 | at least one `fail` or `error` |
| 2 | manifest, flag or I/O problem — nothing ran, or the run cannot be trusted |
| 3 | a declared **or explicitly requested** profile contains an `unsupported` capability |
| 4 | the runner itself threw |

All nine profiles are declared, so any `unsupported` result now raises 3. When
both 1 and 3 apply, 1 is returned and the stderr summary states the other fact,
so exit-code precedence never hides one of them.

## The guards, and how they were checked

Each of these was broken on purpose and confirmed to fire.

| Guard | Mutation | Result |
|---|---|---|
| `vHex` must decode to `v` | flipped one byte of `canon-text-ascii`'s `vHex` | exit 2, `vHex does not decode to v: ff3a333a616263` |
| no JSON numbers under `input`/`expect` | `"3"` → `3` in `code-point-length-ascii` | exit 2, naming the path `code-point-length-ascii.expect.value.v` |
| no catch-all reject rule | added `RuntimeException` with no message predicate | exit 2, `catch-all reject rule: digest.amount/RuntimeException` |
| the cases have teeth | changed `canonText`'s tag from `t` to `T` in the SDK | 122 cases went red |
| golden drift | changed `merkleEmpty`'s schema version to 2 | 2 merkle cases went red |
| the NEW cases have teeth | `LedgerTime.intDivide` → `Math.floorDiv` | 2 red: `int-divide-negative-truncates-toward-zero`, `epoch-seconds-negative-truncates-to-zero` |
| | `CUSTODY_TAG_PREFIX` `:1:` → `:2:` | 12 red, across `custody-tag`, `constants` and `builder` |
| | report sort back to `String::compareTo` | 1 red: `report-order-astral-vs-replacement` |
| | the v1 pipe check made unconditional-false | 3 red, all three `*-rejects-pipe-*` cases |

The reject map is keyed by capability **group**, never by case — a per-case map
would let this client pass by naming the answer — and every rule names a concrete
exception type. Rules the selection never exercised are printed to stderr,
because a rule nothing exercises is a rule nothing checked. One is printed on a
full run today: `quota/IllegalArgumentException/must not have consecutive
hyphens`. The quota's only invalid-tenant case uses `My--Game`, which fails the
character rule before it reaches the hyphen rule, so that refusal is reachable in
the SDK and unproven by the suite. It is left in the map and left reported rather
than deleted to make the line go away.

`amountUnits` throwing three different exception types is **not** a divergence:
`NumberFormatException` for a spelling that is not a decimal,
`IllegalArgumentException` for precision loss, and `ArithmeticException` for band
overflow map to `bad-format`, `precision-loss` and `out-of-range`, which are three
genuinely different refusals. It is the clearest argument in the suite for
classing refusals rather than pinning exception types.

## Coercions, and the point of recording them

The header record's `coercions` map names every conversion this runner performs
where a manifest value has no direct Java counterpart. The entry that used to
matter most is gone:

> `text -> BigDecimal`: new BigDecimal(String). The SDK has no String overload,
> so a consumer must convert; BigDecimal's grammar is laxer than the manifest's
> and that difference is a finding, not an artefact of this runner.

That coercion is how the suite found the gap, and closing the gap deleted it.
**The right end state for a recorded coercion is that it stops existing.** What
remains is a real difference between the manifest's value domain and Java's. The
`float64` entry is the one worth reading twice: the double is *not* converted, it
is handed to an overload that refuses — converting it would have produced an
answer, and the answer was the defect.

The one addition is `builder output -> t:json`: a built payload is compared as
JSON with object keys sorted on both sides. Field order is not part of the Ledger
API's contract, so pinning it would fail this client for a difference no ledger
can observe. Array order **is** preserved, because the order of commands in a
submission is exactly what WRITE 2 depends on.

## Not implemented here

- **A report tool.** `<out>.verdicts` is written — one `<id> <status>` line per
  case, sorted by id — and the diffs above were taken by hand with `diff`. The
  matrix, waivers and `expected/verdicts.frozen` belong to the merge tool the
  design places at `conformance/bin/conformance_report.py`, which does not exist
  yet.
- **`appliesWhen` trait gating.** `--traits` declares four traits and no case in
  the manifest uses `appliesWhen`, so `not-applicable` is never produced. The
  gate is implemented in the status vocabulary and will start mattering as soon
  as a case carries the field.
