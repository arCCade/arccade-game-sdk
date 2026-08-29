package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import io.arccade.gamesdk.PeriodAnchorDocuments.AnchorTotals;
import io.arccade.gamesdk.PeriodAnchorDocuments.PeriodAnchor;
import io.arccade.gamesdk.PeriodAuditDocuments.CycleAuditRow;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The anchor, checked against the one on TestNet.
 *
 * <p>{@code f3e0805b...} is a real anchor: it is on the ledger and in
 * {@code /opt/arccade/reports/game-sdk/}. Until this class existed no shipped
 * JVM client could re-derive it, which meant the chain could be read but not
 * checked from the JVM.
 */
class PeriodAnchorDocumentsTest {

    private static final String ROOT =
            "c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0";
    private static final String REPORT =
            "b4fda252f5064e39a0ed7a6e2914794545a3523b965e631eb94920f38be973fb";
    private static final String PREV =
            "caa2d6f54dc9d0be9d165e505757cc760a421c13c75a21a6ac69e194e0470fc6";

    @Test
    @DisplayName("golden vector: the live TestNet anchor of 2026-08-27 is reproduced")
    void testnetAnchorIsReproduced() {
        PeriodAnchor anchor = new PeriodAnchor("tradewars/testnet-arena-v2", "2026-08-27",
                1787788800000000L, 1787875200000000L, 0, 0, 0, 0, 0, 0, 0, 1, ROOT, REPORT, PREV);

        assertEquals("arccade-sdk-digest-v1|t:21:arccade.period-anchori:1:1r:632:"
                        + "k:14:committedUnits=i:1:0;k:10:cycleCount=i:1:0;k:8:feeUnits=i:1:0;"
                        + "k:14:forfeitedUnits=i:1:0;k:13:merkleRootHex=t:64:" + ROOT + ";"
                        + "k:20:nonQualifyingTxCount=i:1:1;k:11:payoutUnits=i:1:0;"
                        + "k:15:periodEndMicros=i:16:1787875200000000;"
                        + "k:8:periodId=t:10:2026-08-27;"
                        + "k:17:periodStartMicros=i:16:1787788800000000;"
                        + "k:16:prevAnchorDigest=t:64:" + PREV + ";"
                        + "k:17:qualifyingTxCount=i:1:0;"
                        + "k:12:reportDigest=t:64:" + REPORT + ";"
                        + "k:13:returnedUnits=i:1:0;"
                        + "k:7:venueId=t:26:tradewars/testnet-arena-v2;",
                PeriodAnchorDocuments.anchorDocument(anchor));
        assertEquals("f3e0805b9c3b9b9147f8b7b866ddd34d157d5d1e1e60b5942e14335909a6bd2a",
                PeriodAnchorDocuments.anchorDigest(anchor));
    }

    @Test
    @DisplayName("an empty prevAnchorDigest is a chain start, not an absent field")
    void chainStartCarriesAnEmptyPrevDigest() {
        // An anchor with no predecessor and one whose predecessor was forgotten
        // must not hash to the same document.
        PeriodAnchor start = new PeriodAnchor("tradewars/testnet-arena-v2", "2026-08-01",
                1787788800000000L, 1787875200000000L, 0, 0, 0, 0, 0, 0, 0, 1, ROOT, REPORT, "");
        assertEquals("f15bcb0678a266dbd359f9254f71732b3296f282cae0ef93fe787681681c382a",
                PeriodAnchorDocuments.anchorDigest(start));
    }

    @Test
    @DisplayName("totals are summed from the rows, never taken from the caller")
    void totalsComeFromTheRows() {
        AnchorTotals totals = PeriodAnchorDocuments.anchorTotals(
                List.of(row("a", 1_000_000_000_000L, 5_000_000_000L),
                        row("b", 300_000_000_000L, 100_000_000L),
                        row("c", 300_000_000_000L, 100_000_000L)));
        assertEquals(3, totals.cycleCount());
        assertEquals(1_600_000_000_000L, totals.committedUnits());
        assertEquals(5_200_000_000L, totals.feeUnits());
        assertEquals(1_600_000_000_000L, totals.returnedUnits());
    }

    @Test
    @DisplayName("an empty period still has totals: nothing happened is a reportable fact")
    void emptyPeriodHasTotals() {
        AnchorTotals totals = PeriodAnchorDocuments.anchorTotals(List.of());
        assertEquals(0, totals.cycleCount());
        assertEquals(0, totals.payoutUnits());
    }

    @Test
    @DisplayName("a repeated cycleId inside one period is refused")
    void duplicateCycleIdIsRefused() {
        // Counted twice in the totals while the Merkle proof for each copy
        // still verifies -- precisely the shape of mistake the anchor exists
        // to make visible.
        assertThrows(IllegalArgumentException.class, () -> PeriodAnchorDocuments.anchorTotals(
                List.of(row("a", 1, 0), row("a", 1, 0))));
    }

    private static CycleAuditRow row(String cycleId, long committed, long fee) {
        return new CycleAuditRow(cycleId, "player", "game", 0, "entry", "outcome",
                committed, fee, committed, 0, 0, "returned-in-full", 1, 2, "tag");
    }
}
