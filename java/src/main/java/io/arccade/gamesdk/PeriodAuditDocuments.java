package io.arccade.gamesdk;

import java.util.List;
import java.util.Map;

import static io.arccade.gamesdk.ArccadeDigest.canonDocument;
import static io.arccade.gamesdk.ArccadeDigest.canonInt;
import static io.arccade.gamesdk.ArccadeDigest.canonParty;
import static io.arccade.gamesdk.ArccadeDigest.canonText;
import static io.arccade.gamesdk.ArccadeDigest.f;
import static io.arccade.gamesdk.ArccadeDigest.textDigest;

/**
 * One row of a period report, and the leaf it hashes to.
 *
 * <p>Mirrors {@code ArCCade.GameSdk.Audit} in the SDK. The published report
 * must contain this canonical text VERBATIM: a third party reproduces the leaf
 * with plain {@code sha256sum} and checks it against the anchored root, without
 * this class, without Daml, without any library.
 *
 * <p>The field set was chosen around facts an auditor can cross-check WITHOUT
 * asking arCCade: {@code cycleId} and {@code entryDigest} ride in the lock's
 * {@code optContext}, {@code committedUnits} is the locked amount, and
 * {@code custodyTag} is what ties the two together. A report row that
 * contradicts those contradicts DSO-signed data.
 */
public final class PeriodAuditDocuments {

    public static final String ROW_SCHEMA = "arccade.cycle-audit-row";
    public static final int SCHEMA_VERSION = 1;

    /**
     * Disposition is the TAG, not the Daml constructor name.
     *
     * <p>Daml's {@code dispositionTag} renders {@code ReturnedInFull} as
     * {@code "returned-in-full"}. This caught a real divergence while the
     * JavaScript side was being written: passing the constructor name produced
     * a silently different leaf, and the mistake would first have surfaced when
     * an auditor's proof failed. It is validated rather than trusted.
     */
    public static final List<String> DISPOSITIONS = List.of(
            "returned-in-full",
            "returned-with-forfeit",
            "forfeited-in-full",
            "aborted",
            "expired-unsettled");

    private PeriodAuditDocuments() {
    }

    /**
     * Amounts are integer 1e-10 units, never {@code BigDecimal}.
     *
     * <p>The anchor's totals are summed from these on-ledger, so the report and
     * the leaf bytes cannot disagree about rounding.
     */
    public record CycleAuditRow(
            String cycleId,
            String player,
            String gameCode,
            long concurrencyIndex,
            String entryDigest,
            String outcomeDigest,
            long committedUnits,
            long feeUnits,
            long returnedUnits,
            long forfeitedUnits,
            long payoutUnits,
            String disposition,
            long committedAtMicros,
            long settledAtMicros,
            String custodyTag) {
    }

    public static String assertDisposition(String d) {
        if (!DISPOSITIONS.contains(d)) {
            throw new IllegalArgumentException(
                    ArccadeDigest.SCHEME_PREFIX + ": invalid disposition: " + d
                            + "; expected one of " + String.join(", ", DISPOSITIONS));
        }
        return d;
    }

    /** The canonical text of a row. Field names and order mirror Daml exactly. */
    public static String periodLeafDocument(CycleAuditRow r) {
        List<Map.Entry<String, String>> fields = List.of(
                f("cycleId", canonText(r.cycleId())),
                f("player", canonParty(r.player())),
                f("gameCode", canonText(r.gameCode())),
                f("concurrencyIndex", canonInt(r.concurrencyIndex())),
                f("entryDigest", canonText(r.entryDigest())),
                f("outcomeDigest", canonText(r.outcomeDigest())),
                f("committedUnits", canonInt(r.committedUnits())),
                f("feeUnits", canonInt(r.feeUnits())),
                f("returnedUnits", canonInt(r.returnedUnits())),
                f("forfeitedUnits", canonInt(r.forfeitedUnits())),
                f("payoutUnits", canonInt(r.payoutUnits())),
                f("disposition", canonText(assertDisposition(r.disposition()))),
                f("committedAtMicros", canonInt(r.committedAtMicros())),
                f("settledAtMicros", canonInt(r.settledAtMicros())),
                f("custodyTag", canonText(r.custodyTag())));
        return canonDocument(ROW_SCHEMA, SCHEMA_VERSION, fields);
    }

    public static String periodLeaf(CycleAuditRow row) {
        return textDigest(periodLeafDocument(row));
    }

    /** Root over a whole period, in report order. */
    public static String periodRoot(List<CycleAuditRow> rows) {
        return ArccadeMerkle.merkleRoot(rows.stream().map(PeriodAuditDocuments::periodLeaf).toList());
    }

    /**
     * THE ENTRY POINT AN AUDITOR SHOULD USE.
     *
     * <p>Derives the leaf from the ROW. Calling
     * {@link ArccadeMerkle#merkleVerify} on a bare hash returns true for an
     * internal node too — folding cannot know what it started from. Deriving
     * the leaf binds the claim "this is a cycle" to the row schema.
     */
    public static boolean periodRowVerify(CycleAuditRow row,
                                          List<ArccadeMerkle.MerkleStep> steps,
                                          String root) {
        return ArccadeMerkle.merkleVerify(periodLeaf(row), steps, root);
    }
}
