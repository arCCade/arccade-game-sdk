package io.arccade.gamesdk;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import io.arccade.gamesdk.ArccadeMerkle.MerkleStep;
import io.arccade.gamesdk.PeriodAuditDocuments.CycleAuditRow;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Cross-language parity for the period anchor.
 *
 * <p>The four constants below were produced INDEPENDENTLY by Daml
 * ({@code Test.GameSdk.VectorsTest:merkleVectors} and {@code :auditRowVector}),
 * JavaScript ({@code js/test/merkle.test.js}) and Python
 * ({@code tools/digest_reference.py}). An auditor verifies a proof in whichever
 * of those they already have — never in Daml — so a divergence here silently
 * turns the whole anchoring mechanism into decoration.
 */
class ArccadeMerkleTest {

    private static final String GOLDEN_EMPTY =
            "c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0";
    private static final String GOLDEN_ROOT_3 =
            "f31cc766e62a52c3c3156e05d53fde76f54fed6067d283dc9a3d8ada9d0ceedf";
    private static final String GOLDEN_NODE =
            "aa3de7939ca80f5110e8b29ec442d9d770f525dfb63e86ff59e7624ff110e720";
    private static final String GOLDEN_ROW_LEAF =
            "01e89a905ec52a23012354b602cdf583a7bc6dd92d9c36a19aa0346a1cf26237";

    private static final CycleAuditRow GOLDEN_ROW = new CycleAuditRow(
            "cycle-golden",
            "auditor-golden-party",
            "pixel-race-v1",
            0,
            "0000000000000000000000000000000000000000000000000000000000000001",
            "0000000000000000000000000000000000000000000000000000000000000002",
            300_000_000_000L,
            100_000_000L,
            300_000_000_000L,
            0L,
            0L,
            "returned-in-full",
            1_700_000_000_000_000L,
            1_700_000_003_600_000L,
            "arccade-game-sdk:1:cycle-golden:x");

    private static List<String> threeLeaves() {
        return List.of(
                ArccadeDigest.textDigest("leaf-1"),
                ArccadeDigest.textDigest("leaf-2"),
                ArccadeDigest.textDigest("leaf-3"));
    }

    @Test
    void emptyRootMatchesTheOtherThreeImplementations() {
        assertEquals(GOLDEN_EMPTY, ArccadeMerkle.merkleEmpty());
    }

    @Test
    void threeLeafRootMatchesTheOtherThreeImplementations() {
        assertEquals(GOLDEN_ROOT_3, ArccadeMerkle.merkleRoot(threeLeaves()));
    }

    @Test
    void internalNodeMatchesTheOtherThreeImplementations() {
        List<String> leaves = threeLeaves();
        assertEquals(GOLDEN_NODE, ArccadeMerkle.merkleNode(leaves.get(0), leaves.get(1)));
    }

    @Test
    void auditRowLeafMatchesTheOtherThreeImplementations() {
        assertEquals(GOLDEN_ROW_LEAF, PeriodAuditDocuments.periodLeaf(GOLDEN_ROW));
    }

    @Test
    void dispositionMustBeTheTagNotTheConstructorName() {
        // Silently hashing "ReturnedInFull" would defer the error to the moment
        // an auditor's proof fails, which is the worst place to find it.
        CycleAuditRow wrong = new CycleAuditRow(
                GOLDEN_ROW.cycleId(), GOLDEN_ROW.player(), GOLDEN_ROW.gameCode(),
                GOLDEN_ROW.concurrencyIndex(), GOLDEN_ROW.entryDigest(), GOLDEN_ROW.outcomeDigest(),
                GOLDEN_ROW.committedUnits(), GOLDEN_ROW.feeUnits(), GOLDEN_ROW.returnedUnits(),
                GOLDEN_ROW.forfeitedUnits(), GOLDEN_ROW.payoutUnits(), "ReturnedInFull",
                GOLDEN_ROW.committedAtMicros(), GOLDEN_ROW.settledAtMicros(),
                GOLDEN_ROW.custodyTag());
        assertThrows(IllegalArgumentException.class, () -> PeriodAuditDocuments.periodLeaf(wrong));
    }

    @Test
    void inclusionProofsVerifyAtEverySizeAndIndex() {
        // Odd sizes exercise the promotion path, where the proof must emit NO
        // step at that level. Testing one size would skip it entirely.
        for (int n = 1; n <= 9; n++) {
            List<String> leaves = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                leaves.add(ArccadeDigest.textDigest("x-" + i));
            }
            String root = ArccadeMerkle.merkleRoot(leaves);
            for (int ix = 0; ix < n; ix++) {
                List<MerkleStep> proof = ArccadeMerkle.merkleProof(ix, leaves);
                assertTrue(ArccadeMerkle.merkleVerify(leaves.get(ix), proof, root),
                        "size " + n + " index " + ix);
            }
        }
    }

    @Test
    void forgedRowDoesNotVerify() {
        List<CycleAuditRow> rows = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            rows.add(new CycleAuditRow("c-" + i, GOLDEN_ROW.player(), GOLDEN_ROW.gameCode(),
                    GOLDEN_ROW.concurrencyIndex(), GOLDEN_ROW.entryDigest(),
                    GOLDEN_ROW.outcomeDigest(), GOLDEN_ROW.committedUnits(), GOLDEN_ROW.feeUnits(),
                    GOLDEN_ROW.returnedUnits(), GOLDEN_ROW.forfeitedUnits(),
                    GOLDEN_ROW.payoutUnits(), GOLDEN_ROW.disposition(),
                    GOLDEN_ROW.committedAtMicros(), GOLDEN_ROW.settledAtMicros(),
                    GOLDEN_ROW.custodyTag()));
        }
        List<String> leaves = rows.stream().map(PeriodAuditDocuments::periodLeaf).toList();
        String root = ArccadeMerkle.merkleRoot(leaves);
        List<MerkleStep> proof = ArccadeMerkle.merkleProof(2, leaves);

        assertTrue(PeriodAuditDocuments.periodRowVerify(rows.get(2), proof, root));

        CycleAuditRow forged = new CycleAuditRow(rows.get(2).cycleId(), rows.get(2).player(),
                rows.get(2).gameCode(), rows.get(2).concurrencyIndex(), rows.get(2).entryDigest(),
                rows.get(2).outcomeDigest(), 999_900_000_000L, rows.get(2).feeUnits(),
                rows.get(2).returnedUnits(), rows.get(2).forfeitedUnits(),
                rows.get(2).payoutUnits(), rows.get(2).disposition(),
                rows.get(2).committedAtMicros(), rows.get(2).settledAtMicros(),
                rows.get(2).custodyTag());
        assertFalse(PeriodAuditDocuments.periodRowVerify(forged, proof, root));
    }

    @Test
    void loneNodeIsPromotedNotDuplicated() {
        // Duplicating it would let [a,b,c] and [a,b,c,c] share a root
        // (CVE-2012-2459), so two different reports could fit one anchor.
        List<String> leaves = threeLeaves();
        List<String> withDuplicate = new ArrayList<>(leaves);
        withDuplicate.add(leaves.get(2));
        assertNotEquals(ArccadeMerkle.merkleRoot(leaves), ArccadeMerkle.merkleRoot(withDuplicate));
    }

    @Test
    void leafAndNodeHashInDifferentDomains() {
        String x = ArccadeDigest.textDigest("x");
        String y = ArccadeDigest.textDigest("y");
        assertNotEquals(ArccadeMerkle.merkleEmpty(), ArccadeMerkle.merkleNode(x, y));
        assertNotEquals(ArccadeDigest.textDigest(x + y), ArccadeMerkle.merkleNode(x, y));
    }
}
