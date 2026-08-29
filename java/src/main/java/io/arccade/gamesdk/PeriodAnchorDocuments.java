package io.arccade.gamesdk;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import io.arccade.gamesdk.PeriodAuditDocuments.CycleAuditRow;

import static io.arccade.gamesdk.ArccadeDigest.canonDocument;
import static io.arccade.gamesdk.ArccadeDigest.canonInt;
import static io.arccade.gamesdk.ArccadeDigest.canonText;
import static io.arccade.gamesdk.ArccadeDigest.f;
import static io.arccade.gamesdk.ArccadeDigest.textDigest;

/**
 * The period anchor — the package's only mechanism that proves OMISSION.
 *
 * <p>The price of two writes per cycle is that the outcome travels inside the
 * settlement's exercise node and is invisible in the flat stream. If an auditor
 * sees a lock on Scan and cannot find that cycle in arCCade's report, the only
 * thing that can settle the argument is a commitment over the WHOLE report:
 * one write per period, a Merkle root over 100% of that period's cycles, and a
 * digest chained to the previous period.
 *
 * <h2>What is proven and what is declared</h2>
 *
 * <p>The distinction matters and is not hidden:
 *
 * <ul>
 *   <li><b>PROVEN</b> — Daml recomputes it, so the venue cannot lie:
 *       {@code merkleRootHex}, {@code anchorDigest}, {@code cycleCount},
 *       {@code committedUnits}, {@code feeUnits}, {@code returnedUnits},
 *       {@code forfeitedUnits}, {@code payoutUnits}.</li>
 *   <li><b>DECLARED</b> — it arrives as an argument and the contract cannot
 *       check it: {@code reportUri}, {@code reportDigest},
 *       {@code prevAnchorDigest}, {@code qualifyingTxCount},
 *       {@code nonQualifyingTxCount}.</li>
 * </ul>
 *
 * <p>Until this class existed, no shipped JVM client could reproduce the anchor
 * document: Daml decided it and the live TestNet anchor sat on disk with
 * nothing able to re-derive it outside the ledger.
 */
public final class PeriodAnchorDocuments {

    public static final String ANCHOR_SCHEMA = "arccade.period-anchor";
    public static final int SCHEMA_VERSION = 1;

    private PeriodAnchorDocuments() {
    }

    /**
     * One period's anchor.
     *
     * <p>{@code prevAnchorDigest} is empty text at the start of a chain rather
     * than absent: an anchor with no predecessor and an anchor whose
     * predecessor was forgotten must not hash to the same document.
     */
    public record PeriodAnchor(
            String venueId,
            String periodId,
            long periodStartMicros,
            long periodEndMicros,
            long cycleCount,
            long committedUnits,
            long feeUnits,
            long returnedUnits,
            long forfeitedUnits,
            long payoutUnits,
            long qualifyingTxCount,
            long nonQualifyingTxCount,
            String merkleRootHex,
            String reportDigest,
            String prevAnchorDigest) {
    }

    /** The six totals an anchor states, summed from the rows themselves. */
    public record AnchorTotals(
            long cycleCount,
            long committedUnits,
            long feeUnits,
            long returnedUnits,
            long forfeitedUnits,
            long payoutUnits) {
    }

    /**
     * The anchor's canonical text. {@code anchorDigest} is its sha256, and the
     * next link in the chain carries that value as {@code prevAnchorDigest}.
     */
    public static String anchorDocument(PeriodAnchor a) {
        List<Map.Entry<String, String>> fields = List.of(
                f("venueId", canonText(a.venueId())),
                f("periodId", canonText(a.periodId())),
                f("periodStartMicros", canonInt(a.periodStartMicros())),
                f("periodEndMicros", canonInt(a.periodEndMicros())),
                f("cycleCount", canonInt(a.cycleCount())),
                f("committedUnits", canonInt(a.committedUnits())),
                f("feeUnits", canonInt(a.feeUnits())),
                f("returnedUnits", canonInt(a.returnedUnits())),
                f("forfeitedUnits", canonInt(a.forfeitedUnits())),
                f("payoutUnits", canonInt(a.payoutUnits())),
                f("qualifyingTxCount", canonInt(a.qualifyingTxCount())),
                f("nonQualifyingTxCount", canonInt(a.nonQualifyingTxCount())),
                f("merkleRootHex", canonText(a.merkleRootHex())),
                f("reportDigest", canonText(a.reportDigest())),
                f("prevAnchorDigest", canonText(a.prevAnchorDigest())));
        return canonDocument(ANCHOR_SCHEMA, SCHEMA_VERSION, fields);
    }

    public static String anchorDigest(PeriodAnchor a) {
        return textDigest(anchorDocument(a));
    }

    /**
     * Period totals DERIVED FROM THE ROWS, never taken from the caller.
     *
     * <p>Otherwise a venue could publish a correct root and lie in the summary:
     * the root says nothing about whether the summary agrees with the leaves it
     * was built from.
     *
     * <p>A repeated {@code cycleId} inside one period is refused. A duplicate
     * would be counted twice in the totals while the Merkle proof for each copy
     * still verified, which is precisely the shape of mistake this anchor
     * exists to make visible.
     */
    public static AnchorTotals anchorTotals(List<CycleAuditRow> rows) {
        Set<String> seen = new LinkedHashSet<>();
        long count = 0;
        long committed = 0;
        long fee = 0;
        long returned = 0;
        long forfeited = 0;
        long payout = 0;
        for (CycleAuditRow r : rows) {
            if (!seen.add(r.cycleId())) {
                throw new IllegalArgumentException("duplicate cycleId in a period: " + r.cycleId());
            }
            count++;
            // addExact rather than +: a period whose totals overflow an int64
            // is a period the ledger could not have anchored, and a wrapped
            // total would be a smaller, plausible-looking lie.
            committed = Math.addExact(committed, r.committedUnits());
            fee = Math.addExact(fee, r.feeUnits());
            returned = Math.addExact(returned, r.returnedUnits());
            forfeited = Math.addExact(forfeited, r.forfeitedUnits());
            payout = Math.addExact(payout, r.payoutUnits());
        }
        return new AnchorTotals(count, committed, fee, returned, forfeited, payout);
    }
}
