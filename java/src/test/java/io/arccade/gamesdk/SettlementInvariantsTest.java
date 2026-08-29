package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.arccade.gamesdk.SettlementInvariants.Settlement;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Conservation, which no Merkle proof can express.
 *
 * <p>A proof says "this row is in the report". It never says "this row is
 * arithmetically possible", so a published report could state amounts the
 * ledger would have refused while every inclusion proof still verified.
 */
class SettlementInvariantsTest {

    private static final long STAKE = 1_000_000_000_000L;
    private static final long CAP = 50_000_000_000_000L;

    private static Settlement of(String disposition, long returned, long forfeited, long payout) {
        return new Settlement(disposition, STAKE, returned, forfeited, payout, CAP);
    }

    @Test
    @DisplayName("returned + forfeited must equal the stake")
    void conservationHolds() {
        assertTrue(SettlementInvariants.assertSettlementValid(
                of("returned-in-full", STAKE, 0, 0)));
        assertThrows(IllegalArgumentException.class, () -> SettlementInvariants
                .assertSettlementValid(of("returned-in-full", 900_000_000_000L, 0, 0)));
    }

    @Test
    @DisplayName("a disposition cannot contradict its own amounts")
    void dispositionsAgreeWithAmounts() {
        assertThrows(IllegalArgumentException.class, () -> SettlementInvariants
                .assertSettlementValid(of("returned-in-full", 900_000_000_000L,
                        100_000_000_000L, 0)));
        assertThrows(IllegalArgumentException.class, () -> SettlementInvariants
                .assertSettlementValid(of("forfeited-in-full", 900_000_000_000L,
                        100_000_000_000L, 0)));
        assertThrows(IllegalArgumentException.class, () -> SettlementInvariants
                .assertSettlementValid(of("returned-with-forfeit", STAKE, 0, 0)));
        assertTrue(SettlementInvariants.assertSettlementValid(
                of("returned-with-forfeit", 700_000_000_000L, 300_000_000_000L, 0)));
    }

    @Test
    @DisplayName("abort and expiry return the stake in full: neither mechanic can forfeit")
    void abortAndExpiryReturnEverything() {
        assertTrue(SettlementInvariants.assertSettlementValid(of("aborted", STAKE, 0, 0)));
        assertTrue(SettlementInvariants.assertSettlementValid(
                of("expired-unsettled", STAKE, 0, 0)));
        // Unlocking a TimeLockedHolding always pays the owner in full, so
        // anything less describes value that went nowhere.
        assertThrows(IllegalArgumentException.class, () -> SettlementInvariants
                .assertSettlementValid(of("aborted", 900_000_000_000L, 100_000_000_000L, 0)));
    }

    @Test
    @DisplayName("a negative leg is refused before conservation is even checked")
    void negativeLegsAreRefused() {
        // -1000 + 2000 = 1000 conserves perfectly while reversing the direction
        // of the settlement, so the sign check has to come first.
        assertThrows(IllegalArgumentException.class, () -> SettlementInvariants
                .assertSettlementValid(of("returned-in-full", -STAKE, 2 * STAKE, 0)));
    }

    @Test
    @DisplayName("the payout cap is inclusive")
    void payoutCapIsInclusive() {
        assertTrue(SettlementInvariants.assertSettlementValid(
                of("returned-in-full", STAKE, 0, CAP)));
        assertThrows(IllegalArgumentException.class, () -> SettlementInvariants
                .assertSettlementValid(of("returned-in-full", STAKE, 0, CAP + 1)));
    }

    @Test
    @DisplayName("an unknown disposition tag is refused, not treated as a default")
    void unknownDispositionIsRefused() {
        assertThrows(IllegalArgumentException.class, () -> SettlementInvariants
                .assertSettlementValid(of("ReturnedInFull", STAKE, 0, 0)));
        assertFalse(SettlementInvariants.settlementIsValid(of("ReturnedInFull", STAKE, 0, 0)));
    }
}
