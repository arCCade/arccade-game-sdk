// Verify a published period report against its on-ledger anchor — in Java.
//
// The third implementation of the same check. verify-anchor.mjs, verify_anchor.py
// and this file read the same artifacts and must print the same hexadecimal;
// if they ever stop agreeing, the anchor stops being evidence and becomes a
// record arCCade keeps, so the agreement is the deliverable and not the code.
//
// Two things this language forces into the open:
//
//   * ArccadeDigest.canonInt takes a long. The report gives amounts as JSON
//     STRINGS of integer 1e-10 units, so they are parsed explicitly here.
//     A verifier tempted to read them as JSON numbers would be relying on a
//     double, and 300000000000 survives that while a larger period would not.
//   * Like the JavaScript client, this one exports no anchorDocument, so the
//     fifteen fields are written out by hand from canonDocument primitives.
//     That is the honest test of whether docs/INTEGRATION.md §5.4 is enough to
//     reimplement from. It was.
//
// Build the SDK jar once, then run this file directly — no project needed:
//
//   cd java && ./mvnw -q -DskipTests package && cd ..
//   java -cp java/target/game-sdk-1.5.1.jar examples/VerifyAnchor.java
//   java -cp java/target/game-sdk-1.5.1.jar examples/VerifyAnchor.java --source https://audit.arccade.io/testnet
//
// Default source is examples/fixtures — it runs with no network. Exit codes
// match the other two: 0 verified, 1 a check failed, 2 verified except that
// the served bytes are not the anchored bytes (T4).

import io.arccade.gamesdk.ArccadeDigest;
import io.arccade.gamesdk.ArccadeMerkle;
import io.arccade.gamesdk.ArccadeMerkle.MerkleStep;
import io.arccade.gamesdk.Json;
import io.arccade.gamesdk.PeriodAuditDocuments;
import io.arccade.gamesdk.PeriodAuditDocuments.CycleAuditRow;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

public final class VerifyAnchor {

    private static final List<String> failures = new ArrayList<>();
    private static final List<String> byteFindings = new ArrayList<>();

    // Resolved so the file runs from the repo root or from examples/ — the
    // source launcher gives no reliable handle on its own location, and an
    // example whose default path depends on the caller's cwd is a foot-gun.
    private static String source = defaultDir();
    private static String anchorsPath = defaultDir() + "/anchors.json";
    private static String only = null;

    private static String defaultDir() {
        return Files.isDirectory(Path.of("examples/fixtures")) ? "examples/fixtures" : "fixtures";
    }

    public static void main(String[] args) throws Exception {
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--source" -> source = args[++i];
                case "--anchors" -> anchorsPath = args[++i];
                case "--period" -> only = args[++i];
                default -> throw new IllegalArgumentException("unknown option: " + args[i]);
            }
        }

        System.out.println("source  " + source);

        step(1, "The index, and where the anchors are coming from");
        Json index = Json.parse(new String(readBytes("index.json"), StandardCharsets.UTF_8));
        System.out.println("   " + index.get("count").asText() + " period(s) published");

        List<Json> anchors = new ArrayList<>();
        Path ap = Path.of(anchorsPath);
        if (Files.exists(ap)) {
            for (Json a : Json.parse(Files.readString(ap)).get("anchors")) {
                anchors.add(a.get("createArgument"));
            }
        }
        System.out.println("   anchors from " + (anchors.isEmpty() ? "nowhere" : anchorsPath)
                + ": " + anchors.size());

        String previousAnchorDigest = null;

        for (Json meta : index.get("reports")) {
            if (only != null && !only.equals(meta.get("periodId").asText())) {
                continue;
            }
            String periodId = meta.get("periodId").asText();
            Json anchor = null;
            for (Json a : anchors) {
                if (periodId.equals(a.get("periodId").asText())) {
                    anchor = a;
                }
            }

            System.out.println("\n" + "─".repeat(72));
            System.out.println(meta.get("venueId").asText() + "  period " + periodId
                    + "  (" + meta.get("cycleCount").asText() + " cycles)");
            int n = 0;

            step(++n, "The report, hashed as bytes");
            // The EXACT bytes. reportDigest commits to the file as served, so a
            // verifier that parses first and re-serialises is hashing a
            // different object than the anchor committed to (T4).
            byte[] raw = readBytes(meta.get("name").asText());
            String served = sha256(raw);
            Json report = Json.parse(new String(raw, StandardCharsets.UTF_8));
            System.out.println("   " + meta.get("name").asText());
            System.out.println("   sha256 " + served);
            check(served.equals(meta.get("servedDigest").asText()),
                    "matches index.servedDigest",
                    periodId + ": served bytes differ from index.servedDigest");

            step(++n, "Every leaf, recomputed from its row");
            List<CycleAuditRow> rows = new ArrayList<>();
            for (Json r : report.get("rows")) {
                rows.add(row(r));
            }
            List<String> leaves = new ArrayList<>();
            for (int i = 0; i < rows.size(); i++) {
                String leaf = PeriodAuditDocuments.periodLeaf(rows.get(i));
                leaves.add(leaf);
                boolean same = leaf.equals(report.get("leaves").get(i).asText());
                System.out.println("   " + mark(same) + "  [" + i + "] " + rows.get(i).cycleId()
                        + "  " + leaf.substring(0, 16) + "…");
                if (!same) {
                    failures.add(periodId + ": leaf " + i + " does not reproduce");
                }
            }
            if (leaves.isEmpty()) {
                System.out.println("   (no rows — an empty period is still anchored)");
            }

            step(++n, "The root, rebuilt from the leaves");
            // A lone trailing node is PROMOTED, not duplicated — the Bitcoin
            // convention (CVE-2012-2459) lets [a,b,c] and [a,b,c,c] share a root.
            String root = ArccadeMerkle.merkleRoot(leaves);
            System.out.println("   " + root + (leaves.isEmpty() ? "   (= merkleEmpty)" : ""));
            if (leaves.isEmpty() && !root.equals(ArccadeMerkle.merkleEmpty())) {
                failures.add(periodId + ": empty root is wrong");
            }
            check(root.equals(report.get("merkleRoot").asText()),
                    "matches the report's merkleRoot",
                    periodId + ": rebuilt root differs from the report");
            check(root.equals(meta.get("anchoredRoot").asText()),
                    "matches the ANCHORED root",
                    periodId + ": rebuilt root differs from the anchor");

            step(++n, "An inclusion proof for every row");
            if (leaves.isEmpty()) {
                // merkleProof returns [] for any index into an empty period and
                // folding [] returns the leaf unchanged. An empty proof must
                // never be read as proof of anything.
                System.out.println("   nothing to prove: no rows. An empty proof proves nothing.");
            } else {
                for (int i = 0; i < rows.size(); i++) {
                    List<MerkleStep> proof = ArccadeMerkle.merkleProof(i, leaves);
                    // periodRowVerify, not merkleVerify: folding a bare hash
                    // returns true for an internal node too, because the fold
                    // cannot know what it started from.
                    boolean ok = PeriodAuditDocuments.periodRowVerify(rows.get(i), proof, root);
                    System.out.println("   " + mark(ok) + "  [" + i + "] " + rows.get(i).cycleId()
                            + "  " + proof.size() + " step(s)");
                    if (!ok) {
                        failures.add(periodId + ": inclusion proof failed for " + rows.get(i).cycleId());
                    }
                }
                CycleAuditRow first = rows.get(0);
                CycleAuditRow tampered = new CycleAuditRow(
                        first.cycleId(), first.player(), first.gameCode(), first.concurrencyIndex(),
                        first.entryDigest(), first.outcomeDigest(), first.committedUnits(),
                        first.feeUnits(), first.returnedUnits() - 1, first.forfeitedUnits(),
                        first.payoutUnits(), first.disposition(), first.committedAtMicros(),
                        first.settledAtMicros(), first.custodyTag());
                boolean refused = !PeriodAuditDocuments.periodRowVerify(
                        tampered, ArccadeMerkle.merkleProof(0, leaves), root);
                System.out.println("   " + mark(refused)
                        + "  the same proof REFUSES the row with returnedUnits-1");
                System.out.println("         " + first.returnedUnits() + " -> " + tampered.returnedUnits());
                if (!refused) {
                    failures.add(periodId + ": a tampered row verified against the root");
                }
            }

            step(++n, "Totals, re-derived from the rows");
            // A correct root says nothing about the summary fields: it commits
            // to the rows, not to the arithmetic over them.
            long committed = 0, fee = 0, returned = 0, forfeited = 0, payout = 0;
            for (CycleAuditRow r : rows) {
                committed += r.committedUnits();
                fee += r.feeUnits();
                returned += r.returnedUnits();
                forfeited += r.forfeitedUnits();
                payout += r.payoutUnits();
            }
            if (anchor != null) {
                total(periodId, "cycleCount", rows.size(), anchor);
                total(periodId, "committedUnits", committed, anchor);
                total(periodId, "feeUnits", fee, anchor);
                total(periodId, "returnedUnits", returned, anchor);
                total(periodId, "forfeitedUnits", forfeited, anchor);
                total(periodId, "payoutUnits", payout, anchor);
            } else {
                System.out.println("   cycleCount " + rows.size()
                        + " vs index " + meta.get("cycleCount").asText());
                System.out.println("   the rest need the anchor contract; see fixtures/anchors.json");
            }

            step(++n, "The anchor document, reassembled field by field");
            if (anchor == null) {
                System.out.println("   SKIPPED — no anchor contract available for this period");
            } else {
                String digest = anchorDigest(anchor);
                System.out.println("   " + digest);
                check(digest.equals(anchor.get("anchorDigest").asText()),
                        "matches anchorDigest on the contract",
                        periodId + ": anchor document does not reproduce");
                check(anchor.get("merkleRootHex").asText().equals(root),
                        "the anchor commits to the root we rebuilt",
                        periodId + ": anchor root differs from the rebuilt root");
                // reportUri is a field of the CONTRACT and not of the document:
                // where a report is served from is not part of the commitment.
                System.out.println("   reportUri (not covered by the digest): "
                        + anchor.get("reportUri").asText());

                step(++n, "The chain");
                String prev = anchor.get("prevAnchorDigest").asText();
                if (previousAnchorDigest == null) {
                    System.out.println("   prevAnchorDigest "
                            + (prev.isEmpty() ? "\"\"  (start of the chain)" : prev));
                    if (!prev.isEmpty()) {
                        System.out.println("   this is not the first period — run without --period to walk it");
                    }
                } else {
                    boolean linked = prev.equals(previousAnchorDigest);
                    check(linked, "prevAnchorDigest is the previous period's anchorDigest",
                            periodId + ": chain link broken — a period is missing or reordered");
                    System.out.println("         " + prev);
                }
                previousAnchorDigest = anchor.get("anchorDigest").asText();
            }

            step(++n, "The bytes the anchor actually commits to");
            String anchored = anchor != null
                    ? anchor.get("reportDigest").asText()
                    : meta.get("anchoredDigest").asText();
            System.out.println("   served   " + served);
            System.out.println("   anchored " + anchored);
            boolean bytesMatch = served.equals(anchored);
            System.out.println("   " + mark(bytesMatch) + "  the file served is the file anchored");
            if (!bytesMatch) {
                byteFindings.add(periodId);
                // Written as concatenation rather than a text block: a text
                // block strips the common indentation, and these lines are
                // meant to sit under the check they explain.
                System.out.println(
                        "\n   T4. The rows are intact — every leaf and the root reproduced above —\n"
                        + "   but these bytes are not the bytes the ledger was made to commit to.\n"
                        + "   Publish a report's bytes once and serve them byte-stable forever.");
            }
        }

        System.out.println("\n" + "─".repeat(72));
        if (!failures.isEmpty()) {
            System.err.println("\n" + failures.size() + " verification(s) failed:");
            failures.forEach(f -> System.err.println("  - " + f));
            System.exit(1);
        }
        if (!byteFindings.isEmpty()) {
            System.out.println(
                    "\nRows, roots, proofs, anchors and the chain all reproduce.\n\n"
                    + "The served bytes do not match the anchored bytes for: "
                    + String.join(", ", byteFindings)
                    + ".\nExit 2 — see T4 in docs/INTEGRATION.md.\n");
            System.exit(2);
        }
        System.out.println(
                "\nEverything reproduced, from the bytes up, and the hexadecimal above is\n"
                + "identical to what verify-anchor.mjs and verify_anchor.py print. Three\n"
                + "implementations, one canonical form.\n");
    }

    /**
     * The anchor document. Fifteen fields, this order, schema
     * arccade.period-anchor version 1 — see docs/INTEGRATION.md §5.4.
     */
    private static String anchorDigest(Json a) {
        List<Map.Entry<String, String>> fields = List.of(
                ArccadeDigest.f("venueId", ArccadeDigest.canonText(a.get("venueId").asText())),
                ArccadeDigest.f("periodId", ArccadeDigest.canonText(a.get("periodId").asText())),
                ArccadeDigest.f("periodStartMicros", canonLong(a, "periodStartMicros")),
                ArccadeDigest.f("periodEndMicros", canonLong(a, "periodEndMicros")),
                ArccadeDigest.f("cycleCount", canonLong(a, "cycleCount")),
                ArccadeDigest.f("committedUnits", canonLong(a, "committedUnits")),
                ArccadeDigest.f("feeUnits", canonLong(a, "feeUnits")),
                ArccadeDigest.f("returnedUnits", canonLong(a, "returnedUnits")),
                ArccadeDigest.f("forfeitedUnits", canonLong(a, "forfeitedUnits")),
                ArccadeDigest.f("payoutUnits", canonLong(a, "payoutUnits")),
                ArccadeDigest.f("qualifyingTxCount", canonLong(a, "qualifyingTxCount")),
                ArccadeDigest.f("nonQualifyingTxCount", canonLong(a, "nonQualifyingTxCount")),
                ArccadeDigest.f("merkleRootHex", ArccadeDigest.canonText(a.get("merkleRootHex").asText())),
                ArccadeDigest.f("reportDigest", ArccadeDigest.canonText(a.get("reportDigest").asText())),
                // Empty on the first period of a chain, and that emptiness is signed.
                ArccadeDigest.f("prevAnchorDigest", ArccadeDigest.canonText(a.get("prevAnchorDigest").asText())));
        return ArccadeDigest.documentDigest("arccade.period-anchor", 1, fields);
    }

    private static String canonLong(Json o, String field) {
        return ArccadeDigest.canonInt(Long.parseLong(o.get(field).asText()));
    }

    private static CycleAuditRow row(Json r) {
        return new CycleAuditRow(
                r.get("cycleId").asText(),
                r.get("player").asText(),
                r.get("gameCode").asText(),
                Long.parseLong(r.get("concurrencyIndex").asText()),
                r.get("entryDigest").asText(),
                r.get("outcomeDigest").asText(),
                Long.parseLong(r.get("committedUnits").asText()),
                Long.parseLong(r.get("feeUnits").asText()),
                Long.parseLong(r.get("returnedUnits").asText()),
                Long.parseLong(r.get("forfeitedUnits").asText()),
                Long.parseLong(r.get("payoutUnits").asText()),
                r.get("disposition").asText(),
                Long.parseLong(r.get("committedAtMicros").asText()),
                Long.parseLong(r.get("settledAtMicros").asText()),
                r.get("custodyTag").asText());
    }

    private static void total(String periodId, String field, long got, Json anchor) {
        long want = Long.parseLong(anchor.get(field).asText());
        System.out.printf("   %s  %-16s %d%n", mark(got == want), field, got);
        if (got != want) {
            failures.add(periodId + ": " + field + " disagrees with the anchor");
        }
    }

    private static byte[] readBytes(String name) throws IOException {
        if (source.startsWith("http://") || source.startsWith("https://")) {
            URL url = URI.create(source + "/" + name).toURL();
            try (InputStream in = url.openStream()) {
                return in.readAllBytes();
            }
        }
        return Files.readAllBytes(Path.of(source, name));
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static void check(boolean ok, String what, String failure) {
        System.out.println("   " + mark(ok) + "  " + what);
        if (!ok) {
            failures.add(failure);
        }
    }

    private static String mark(boolean ok) {
        return ok ? "ok  " : "FAIL";
    }

    private static void step(int n, String what) {
        System.out.println("\n" + n + ". " + what);
    }
}
