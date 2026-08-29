package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import io.arccade.gamesdk.CycleCommands.AbortOptions;
import io.arccade.gamesdk.CycleCommands.CommitOptions;
import io.arccade.gamesdk.CycleCommands.DryRunCommitOptions;
import io.arccade.gamesdk.CycleCommands.ExpireOptions;
import io.arccade.gamesdk.CycleCommands.SettleOptions;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The two-write cycle's payloads.
 *
 * <p>The assertions worth reading are the ones about SHAPE: two commands in one
 * submission, settle before unlock, and the custody tag reaching
 * {@code optContext}. Each is a rule that a payload can break while still being
 * accepted by the JSON API, and each one breaks a cycle at a different moment.
 */
class CycleCommandsTest {

    private static final String SDK = "sdkpkg";
    private static final String AMULET = "amuletpkg";
    private static final String DIGEST =
            "5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852";
    private static final InstrumentId COIN = new InstrumentId("dso-party", "Amulet");

    private static CommitOptions commit(String cycleId, String feeAmount) {
        return new CommitOptions(SDK, AMULET, "venue-party", "operator-party", "player-party",
                "ent-0001", "trade-wars-v4", cycleId, DIGEST, "100.0", feeAmount, COIN,
                "2026-08-23T00:29:07Z", "rules-0001", "round-0001", List.of("amulet-0001"),
                "dso-party", "commit-1", Map.of());
    }

    @Test
    @DisplayName("the custody tag is prefix, cycle id and entry digest, in that order")
    void custodyTagShape() {
        assertEquals("arccade-game-sdk:1:tw-testnet-1787437747:" + DIGEST,
                CycleCommands.custodyTagFor("tw-testnet-1787437747", DIGEST));
    }

    @Test
    @DisplayName("a cycleId is measured in CODE POINTS, so 64 emoji is a valid id")
    void cycleIdLengthIsInCodePoints() {
        // Daml's T.length counts code points, so the ledger accepts this id. A
        // client measuring UTF-16 units refuses it on the audit path, against a
        // cycle that is already committed.
        String astral = "🎮".repeat(64);
        assertEquals(astral, CycleCommands.assertValidCycleId(astral));
        assertThrows(IllegalArgumentException.class,
                () -> CycleCommands.assertValidCycleId("🎮".repeat(65)));
        assertThrows(IllegalArgumentException.class, () -> CycleCommands.assertValidCycleId(""));
        assertThrows(IllegalArgumentException.class, () -> CycleCommands.assertValidCycleId("tw:1"));
        assertThrows(IllegalArgumentException.class, () -> CycleCommands.assertValidCycleId("tw|1"));
    }

    @Test
    @DisplayName("an uppercase digest is refused rather than folded to lowercase")
    void hex64IsLowercaseOnly() {
        assertEquals(DIGEST, CycleCommands.assertHex64(DIGEST));
        for (String bad : List.of(DIGEST.toUpperCase(), DIGEST.substring(1), DIGEST + "a", "")) {
            assertThrows(IllegalArgumentException.class, () -> CycleCommands.assertHex64(bad));
        }
    }

    @Test
    @DisplayName("WRITE 1 is two commands in ONE submission, transfer first")
    void commitIsTwoCommandsInOneSubmission() {
        // Sent separately, the link between the lock and the GameStake breaks
        // and a GameStake can exist unfunded.
        Json built = CycleCommands.buildCommitCommands(commit("tw-1", "0.5"));
        Json commands = built.path("submission").path("commands").path("commands");
        assertEquals(2, commands.size());
        assertEquals("AmuletRules_Transfer",
                commands.path(0).path("ExerciseCommand").path("choice").asText());
        assertEquals("Entitlement_Commit",
                commands.path(1).path("ExerciseCommand").path("choice").asText());
    }

    @Test
    @DisplayName("the custody tag reaches optContext, and the terms carry the same value")
    void custodyTagReachesOptContext() {
        // Generic text here makes the stake unusable: settlement cannot verify
        // the tag and the cycle can only be aborted.
        Json built = CycleCommands.buildCommitCommands(commit("tw-tag-check", "0.5"));
        String tag = built.path("custodyTag").asText();
        assertEquals("arccade-game-sdk:1:tw-tag-check:" + DIGEST, tag);

        Json outputs = built.path("commands").path(0).path("ExerciseCommand")
                .path("choiceArgument").path("transfer").path("outputs");
        assertEquals(tag, outputs.path(1).path("lock").path("optContext").asText());
        assertEquals(tag, built.path("commands").path(1).path("ExerciseCommand")
                .path("choiceArgument").path("terms").path("custodyTag").asText());
    }

    @Test
    @DisplayName("a zero fee writes no fee output at all")
    void zeroFeeWritesNoFeeOutput() {
        Json built = CycleCommands.buildCommitCommands(commit("tw-no-fee", "0.0"));
        Json outputs = built.path("commands").path(0).path("ExerciseCommand")
                .path("choiceArgument").path("transfer").path("outputs");
        assertEquals(1, outputs.size());
        assertEquals("player-party", outputs.path(0).path("receiver").asText());
    }

    @Test
    @DisplayName("a missing fee amount is refused, never serialised")
    void missingFeeIsRefused() {
        // A builder that serialises an absent amount sends the literal text of
        // whatever its language calls "absent" into a ledger field.
        assertThrows(IllegalArgumentException.class,
                () -> CycleCommands.buildCommitCommands(commit("tw-no-fee", null)));
        assertThrows(IllegalArgumentException.class,
                () -> CycleCommands.buildCommitCommands(
                        new CommitOptions(SDK, AMULET, "v", "o", "p", "ent", "g", "tw-1", DIGEST,
                                "100.0", "0.5", COIN, "2026-08-23T00:29:07Z", "rules", "round",
                                List.of(), "dso", "c", Map.of())));
    }

    @Test
    @DisplayName("the dry run is one command with a zero fee and the same custody tag")
    void dryRunIsOneCommandWithAZeroFee() {
        // Skipping the tag in a dry run would create a difference that first
        // appeared on the day a game went live.
        Json built = CycleCommands.buildDryRunCommitCommands(new DryRunCommitOptions(
                SDK, "dryrun-venue", "operator-party", "player-party", "ent-0001",
                "pixel-race-v1", "pr-dry-1", DIGEST, "30.0", COIN, "2026-08-23T00:29:07Z",
                null, Map.of()));
        assertEquals(1, built.path("commands").size());
        Json terms = built.path("commands").path(0).path("ExerciseCommand")
                .path("choiceArgument").path("terms");
        assertEquals("0.0", terms.path("feeAmount").asText());
        assertEquals("arccade-game-sdk:1:pr-dry-1:" + DIGEST, terms.path("custodyTag").asText());
        assertEquals("dryrun-commit-pr-dry-1",
                built.path("submission").path("commands").path("commandId").asText());
    }

    @Test
    @DisplayName("WRITE 2 puts settle BEFORE unlock, because settle reads the lock")
    void settleComesBeforeUnlock() {
        // Reversed, settlement is rejected for want of custody proof.
        Json built = CycleCommands.buildSettleCommands(settle("locked-0001", "ReturnedInFull",
                "100.0", "0.0"));
        Json commands = built.path("commands");
        assertEquals(2, commands.size());
        assertEquals("GameStake_Settle",
                commands.path(0).path("ExerciseCommand").path("choice").asText());
        assertEquals("LockedAmulet_UnlockV2",
                commands.path(1).path("ExerciseCommand").path("choice").asText());
    }

    @Test
    @DisplayName("with no lock there is nothing to unlock, so the submission is one command")
    void settleWithoutALockIsOneCommand() {
        Json built = CycleCommands.buildSettleCommands(settle(null, "ReturnedInFull",
                "100.0", "0.0"));
        assertEquals(1, built.path("commands").size());
        assertTrue(built.path("commands").path(0).path("ExerciseCommand")
                .path("choiceArgument").path("custodyRef").isNull());
    }

    @Test
    @DisplayName("the outcome digest can be derived from the document, and the document revealed")
    void digestIsDerivedFromTheDocument() {
        Json built = CycleCommands.buildSettleCommands(new SettleOptions(SDK, AMULET,
                "venue-party", "operator-party", "player-party", "stake-1", "locked-0001",
                "ReturnedInFull", "100.0", "0.0", "0.0", "arccade-sdk-digest-v1|t:3:foo", null,
                true, null, "settle-fromdoc", Map.of()));
        Json arg = built.path("commands").path(0).path("ExerciseCommand").path("choiceArgument");
        assertEquals(ArccadeDigest.textDigest("arccade-sdk-digest-v1|t:3:foo"),
                arg.path("outcomeDigest").asText());
        assertEquals("arccade-sdk-digest-v1|t:3:foo", arg.path("revealedOutcome").asText());
    }

    @Test
    @DisplayName("a disposition that contradicts its amounts is refused, and so is no outcome at all")
    void settlementInvariantsAreEnforcedBeforeSubmission() {
        assertThrows(IllegalArgumentException.class,
                () -> CycleCommands.buildSettleCommands(settle("locked-0001", "ReturnedInFull",
                        "99.0", "1.0")));
        assertThrows(IllegalArgumentException.class,
                () -> CycleCommands.buildSettleCommands(settle("locked-0001", "ForfeitedInFull",
                        "1.0", "99.0")));
        assertThrows(IllegalArgumentException.class,
                () -> CycleCommands.buildSettleCommands(new SettleOptions(SDK, AMULET, "v", "o",
                        "p", "stake-1", "locked-0001", "ReturnedInFull", "100.0", "0.0", "0.0",
                        null, null, true, null, null, Map.of())));
    }

    @Test
    @DisplayName("abort may carry no custody proof, and expiry acts as the player alone")
    void abortAndExpire() {
        // Abort exists because the lock may never have been created.
        Json abort = CycleCommands.buildAbortCommands(new AbortOptions(SDK, "venue-party",
                "operator-party", "player-party", "stake-1", "player disconnected", null,
                "abort-1"));
        assertTrue(abort.path("commands").path(0).path("ExerciseCommand")
                .path("choiceArgument").path("custodyRef").isNull());
        assertEquals(2, abort.path("actAs").size());

        Json expire = CycleCommands.buildExpireCommands(new ExpireOptions(SDK, AMULET,
                "player-party", "stake-1", "locked-0001", "expire-1"));
        assertEquals(1, expire.path("actAs").size());
        assertEquals("player-party", expire.path("actAs").path(0).asText());
        assertEquals("LockedAmulet_OwnerExpireLockV2",
                expire.path("commands").path(1).path("ExerciseCommand").path("choice").asText());
    }

    @Test
    @DisplayName("a generated cycle id is unique and valid")
    void generatedCycleIds() {
        String a = CycleCommands.newCycleId();
        String b = CycleCommands.newCycleId();
        assertFalse(a.equals(b));
        assertTrue(a.startsWith("c-"));
        assertEquals(a, CycleCommands.assertValidCycleId(a));
    }

    private static SettleOptions settle(String lockedAmuletCid, String disposition,
                                        String returned, String forfeited) {
        return new SettleOptions(SDK, AMULET, "venue-party", "operator-party", "player-party",
                "stake-000000000000001", lockedAmuletCid, disposition, returned, forfeited, "0.0",
                null, "124de70ecc959cfe2d9f01362a414e9a493df2e10b521551ffd262c1f29d2f0a",
                true, null, "settle-1", Map.of());
    }
}
