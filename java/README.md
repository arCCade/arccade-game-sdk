# arCCade Game SDK — Java

`io.arccade:game-sdk:1.5.1` · Apache-2.0 · Java 17+ · **no runtime dependencies**

The Java implementation of the arCCade Game SDK: the canonical encoding, the
period-anchor Merkle tree, the audit-row documents and the reconstruction that
turns a ledger transaction stream into a verifiable period report — and, since
this module reached parity, the identity rules, the value documents, the ledger
time arithmetic, the tenancy layer and the ledger command builders.

This is one of four implementations. Daml (`daml/ArCCade/GameSdk/`), JavaScript
(`js/src/`), Python (`python/arccade_game_sdk/`) and this one must agree **byte
for byte**, and `conformance/manifest.json` is the shared contract that says so.
A divergence is not a formatting difference: `GameStake_Settle` recomputes the
digest on-ledger and rejects a mismatch, so a stake committed against a wrong
digest cannot be settled.

## Parity, and what it cost to claim it

This module used to implement 29 of the suite's 72 capabilities and report
`270 pass · 9 fail · 189 unsupported` — 42% of the suite unsupported. It was a
verification-only subset: enough to check an anchor, not enough to run a cycle.
A JVM consumer could confirm arCCade's arithmetic and then had to hand-build
every ledger payload.

It now implements all 72 and reports `470 of 470 cases: 470 pass`, with verdicts
**byte-identical** to the Python client's across the whole suite. The nine
failures were closed by adding refusals, never by relaxing a check:
`amountUnits(String)` carries the decimal grammar so `"1e3"` is refused rather
than accepted through `BigDecimal`; `amountUnits(double)` refuses a native float
outright; `canonInt(BigInteger)` gives a wide integer a canonical form;
`textDigest("")` is refused because Daml's `toHex ""` is a runtime error and no
ledger value can equal that digest; and the report order sorts by Unicode **code
point**, because `String::compareTo` is UTF-16 code-unit order and two honest
implementations that break a tie differently publish different Merkle roots over
the same cycles.

## Where it came from

These classes lived in `arccade-wallet-backend`, under
`com.arccade.wallet.gamesdk`, with a TODO on `ArccadeDigest` saying they belonged
here. They now do. `CycleAuditReader` in particular had **no production caller**
in that repository — it exists purely as the Java half of the cross-language
audit contract, which is an argument for keeping it beside the fixtures it is
pinned to rather than beside a Spring application it never served.

## Build

```
./mvnw test        # 115 tests
./mvnw package     # target/game-sdk-1.5.1.jar
```

`mvnw` downloads Maven 3.9.6 on first use; add `-o` to work from the local
repository only. Java 21 builds it, Java 17 runs it: `maven.compiler.release` is
17 because records are the only modern feature used and there is no reason to
shut 17 consumers out of an artifact that does not need anything newer.

## No dependencies, and what that cost

Two classes here touch JSON. `CycleAuditReader` **reads** a transaction tree
through six operations — `path`, `has`, `get`, `asText`, `size` and iterating an
array. The command builders **write** the JSON Ledger API payload a consumer
submits. `io.arccade.gamesdk.Json` provides both in about four hundred lines, so
nothing is on the runtime classpath but the JDK.

The writer lives in the same class as the reader rather than in a second one
because a builder's output can then be parsed back and compared with a reader's
— which is exactly what the conformance runner does, and what a second JSON type
would have made impossible.

The argument for paying that instead of depending on `jackson-databind` is in
`Json`'s class comment. Briefly: Jackson is the most commonly pre-pinned artifact
on the JVM, so an SDK that brings its own copy starts every integration with a
dependency-convergence argument; its audit surface is three orders of magnitude
larger than the code it would be supporting; and an auditor who wants to check
one anchor should be able to drop **one jar** on the classpath.

**The cost, stated plainly:** a caller who already holds a Jackson `JsonNode`
cannot hand it to `CycleAuditReader` directly. They pay one line —
`Json.parse(node.toString())` — at the boundary. That is one line for the callers
who have Jackson, rather than a transitive dependency for all of them.

`Json` is deliberately **stricter** than Jackson in three places, each pinned by
`JsonTest`:

| | Jackson | here | why |
|---|---|---|---|
| JSON `null` read as text | `"null"` | `""` | the four-character string `null` would hash into a canonical document as though the ledger had written it |
| a number's text | rendered from `int`/`long`/`double` | the **source lexeme** | `new BigDecimal(node.asText())` must see what the ledger wrote; a `double` round trip is the precision loss `amountUnits` exists to refuse |
| duplicate object keys | last one wins | refused | two values for one key means the document has no single reading, and two implementations picking differently build two different rows from the same bytes |

## What is here

| Class | |
|---|---|
| `ArccadeDigest` | the encoding: `canon*`, `canonDocument`, `textDigest`, `amountUnits`. Length is in **code points**; amounts are integer 1e-10 units, truncated toward zero; `CODE_POINT_ORDER` is the collation every cross-language sort uses |
| `ArccadeMerkle` | the tree. A lone node is **promoted, not duplicated** (CVE-2012-2459); leaves and internal nodes hash under different schemas |
| `PeriodAuditDocuments` | `arccade.cycle-audit-row` v1, and `periodRowVerify` — the entry point an auditor should use, because `merkleVerify` on a bare hash cannot tell a leaf from an internal node |
| `PeriodAnchorDocuments` | the anchor document, its digest, and totals **derived from the rows** rather than taken from the caller |
| `CycleAuditReader` | rebuilds report rows from a transaction tree. Joins by **stake contract id**, not cycleId; `isoToMicros` is microsecond-exact; `REPORT_ORDER` names its collation |
| `PolicyDocuments` | the venue policy document, and `validPolicy` — including the rule that a lock must outlast a cycle |
| `SettlementInvariants` | conservation. The one property a Merkle proof cannot express: the tree says a row is in the report, never that it is arithmetically possible |
| `LedgerTime` | Daml's duration arithmetic. Division truncates toward zero, and `secondsBetween` truncates **each endpoint** before subtracting |
| `CycleCommands` | cycle ids, the custody tag, and the five cycle builders. WRITE 1 is two commands in one submission; WRITE 2 puts settle **before** unlock |
| `TradeCommands`, `TransferCommands` | the v1 trade and transfer documents — which refuse a `\|` in any component, because the format has no length prefixes — and their builders |
| `Tenancy`, `TenantQuota` | namespacing, the isolation check, constant-time key verification, and a fixed-window quota driven by an **injected** clock |
| `Assets` | fungible and unique instruments, the attribute document whose digest binds an item's stats, and `deriveInstanceId` |
| `InstrumentId`, `LedgerPayloads` | the shared value type, and the payload shapes the three builders have in common |
| `TradeWarsDocuments`, `PixelRaceDocuments` | the two games' entry and outcome documents |
| `Json` | the reader and writer described above |

## Tests

`ArccadeDigestTest` and `ArccadeMerkleTest` pin the golden vectors that
`VectorsTest.daml` and `js/test/` assert independently. `CycleAuditReaderTest`
reads `../test-vectors/` — the real TestNet transactions and the rows, leaves and
root they must produce — and reproduces
`910a515e5aba2c177291fd253d1cb4dbba7a04878e65b0f8e6d0a2bb54705128`.
`PeriodAnchorDocumentsTest` reproduces the live TestNet anchor
`f3e0805b9c3b9b9147f8b7b866ddd34d157d5d1e1e60b5942e14335909a6bd2a`, which no
shipped JVM client could re-derive before this module.

The rest are written against the behaviours where a plausible alternative
implementation gives a different answer: window boundaries in `TenantQuotaTest`,
per-endpoint truncation in `LedgerTimeTest`, settle-before-unlock and the custody
tag reaching `optContext` in `CycleCommandsTest`, and the four refusals in
`TransferCommandsTest`. An assertion that only restates an arithmetic identity
has not been written down.

In the backend those fixture tests were **skipped** when the files were not
found, because they lived in a sibling repository that might not be checked out.
That reasoning did not survive the move: the fixtures are now two directories up,
in this repository, so a missing file is a defect in this build and the skip is
gone. Removing a conditional parity check was most of the point of relocating.

## Conformance

The tests above are this implementation's own. The shared contract is
`conformance/manifest.json`, driven by `conformance/runners/java/run`, which
resolves this artifact through the **packaged jar** — never through `src/`, so a
class that does not ship cannot look supported.

```
cd ../conformance && ./runners/java/run --manifest manifest.json \
    --out runners/java/results/java.jsonl

470 of 470 cases: 470 pass, 0 fail, 0 error, 0 unsupported, 0 not-applicable
```

The default is now **every case in the manifest**; naming `--profiles` narrows
the run and the summary then says how many cases it omitted and which flag did
it. See that directory's README for the per-profile table, the cross-runner
verdict diff, and the mutations each guard was checked against.
