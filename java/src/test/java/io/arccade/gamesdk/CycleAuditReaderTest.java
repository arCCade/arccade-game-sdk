package io.arccade.gamesdk;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import io.arccade.gamesdk.CycleAuditReader.ReportRow;
import io.arccade.gamesdk.PeriodAuditDocuments.CycleAuditRow;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * This implementation's half of a cross-language contract.
 *
 * <p>The fixtures are real transactions captured from TestNet, and the rows,
 * leaves and root they must produce. The JavaScript and Python implementations
 * assert against the very same two files. That is what makes "an auditor can
 * verify this in whatever language they already have" a fact rather than a
 * claim.
 *
 * <p>In arccade-wallet-backend these tests were SKIPPED when the fixtures were
 * not found, because there they lived in a sibling repository that might not be
 * checked out, and a red test for a missing neighbour trains people to ignore
 * red tests. That reasoning does not survive the move: the fixtures are now two
 * directories up, in this same repository, so a missing file is a defect in
 * this build and not a gap in someone's environment. The skip is therefore gone
 * — the whole point of relocating these classes was to stop the parity check
 * from being conditional on how somebody laid out their disk.
 */
class CycleAuditReaderTest {

    /** Surefire runs with the module directory as its working directory. */
    private static final Path VECTORS = Path.of("..", "test-vectors");

    private static Json trees;
    private static Json expected;

    @BeforeAll
    static void load() throws Exception {
        Path treesFile = VECTORS.resolve("cycle-trees.json");
        Path rowsFile = VECTORS.resolve("cycle-rows.json");
        assertTrue(Files.exists(treesFile), "missing fixture: " + treesFile.toAbsolutePath());
        assertTrue(Files.exists(rowsFile), "missing fixture: " + rowsFile.toAbsolutePath());
        trees = Json.parse(Files.readString(treesFile));
        expected = Json.parse(Files.readString(rowsFile));
    }

    private static List<Json> transactions() {
        List<Json> out = new ArrayList<>();
        for (Json c : trees.path("cases")) {
            out.add(c.path("commitTransaction"));
            out.add(c.path("closingTransaction"));
        }
        return out;
    }

    @Test
    void fixtureCoversEveryWayACycleCanClose() {
        // A path with no fixture is a path an implementation can get wrong and
        // still pass.
        List<String> choices = new ArrayList<>();
        trees.path("cases").forEach(c -> choices.add(c.path("closingChoice").asText()));
        choices.sort(String::compareTo);
        assertEquals(List.of("GameStake_Abort", "GameStake_ExpireUnsettled", "GameStake_Settle"),
                choices);
    }

    @Test
    void rowsMatchTheGoldenVector() {
        List<ReportRow> rows = CycleAuditReader.rowsFromTransactions(transactions()).rows();
        Json want = expected.path("rows");
        assertEquals(want.size(), rows.size(), "row count");
        for (int i = 0; i < rows.size(); i++) {
            CycleAuditRow got = rows.get(i).row();
            Json w = want.path(i);
            assertEquals(w.path("cycleId").asText(), got.cycleId());
            assertEquals(w.path("player").asText(), got.player());
            assertEquals(w.path("gameCode").asText(), got.gameCode());
            assertEquals(Long.parseLong(w.path("concurrencyIndex").asText()), got.concurrencyIndex());
            assertEquals(w.path("entryDigest").asText(), got.entryDigest());
            assertEquals(w.path("outcomeDigest").asText(), got.outcomeDigest());
            assertEquals(Long.parseLong(w.path("committedUnits").asText()), got.committedUnits());
            assertEquals(Long.parseLong(w.path("feeUnits").asText()), got.feeUnits());
            assertEquals(Long.parseLong(w.path("returnedUnits").asText()), got.returnedUnits());
            assertEquals(Long.parseLong(w.path("forfeitedUnits").asText()), got.forfeitedUnits());
            assertEquals(Long.parseLong(w.path("payoutUnits").asText()), got.payoutUnits());
            assertEquals(w.path("disposition").asText(), got.disposition());
            assertEquals(Long.parseLong(w.path("committedAtMicros").asText()), got.committedAtMicros());
            assertEquals(Long.parseLong(w.path("settledAtMicros").asText()), got.settledAtMicros());
            assertEquals(w.path("custodyTag").asText(), got.custodyTag());
        }
    }

    @Test
    void leavesAndRootMatchTheGoldenVector() {
        List<ReportRow> rows = CycleAuditReader.rowsFromTransactions(transactions()).rows();
        for (int i = 0; i < rows.size(); i++) {
            assertEquals(expected.path("leaves").path(i).asText(),
                    PeriodAuditDocuments.periodLeaf(rows.get(i).row()),
                    "leaf " + i);
        }
        assertEquals(expected.path("merkleRoot").asText(), CycleAuditReader.periodRoot(rows));
    }

    @Test
    void abortReturnsTheStakeInFullAndHasNoOutcome() {
        CycleAuditRow aborted = CycleAuditReader.rowsFromTransactions(transactions()).rows().stream()
                .map(ReportRow::row)
                .filter(r -> "aborted".equals(r.disposition()))
                .findFirst().orElseThrow();
        // Abort states no amounts; unlocking pays the owner in full and this
        // mechanic cannot forfeit.
        assertEquals(aborted.committedUnits(), aborted.returnedUnits());
        assertEquals(0L, aborted.forfeitedUnits());
        assertEquals(0L, aborted.payoutUnits());
        assertEquals("", aborted.outcomeDigest());
    }

    @Test
    void theUnlockInTheSameTransactionIsCrossCheckedNotTrusted() {
        assertTrue(CycleAuditReader.rowsFromTransactions(transactions()).warnings().isEmpty());
    }

    @Test
    void aCommitWithNoClosingIsReportedNotDropped() {
        // Silently discarding a commit whose settlement fell outside the window
        // is precisely the omission the anchor exists to make provable.
        List<Json> commitsOnly = new ArrayList<>();
        trees.path("cases").forEach(c -> commitsOnly.add(c.path("commitTransaction")));
        CycleAuditReader.Result r = CycleAuditReader.rowsFromTransactions(commitsOnly);
        assertEquals(0, r.rows().size());
        assertEquals(3, r.openStakeIds().size());
    }

    @Test
    void ledgerTimestampsKeepMicrosecondPrecision() {
        // Anything routed through milliseconds truncates them and the
        // canonical document stops matching Daml's.
        assertEquals(1787763491258920L, CycleAuditReader.isoToMicros("2026-08-26T16:58:11.258920Z"));
        assertEquals(1787851620000000L, CycleAuditReader.isoToMicros("2026-08-27T17:27:00Z"));
    }
}
