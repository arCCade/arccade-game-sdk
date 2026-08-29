package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The duration arithmetic every policy check runs through.
 *
 * <p>These are not arithmetic identities being restated. Each one is a place
 * where a plausible alternative implementation gives a different answer and the
 * disagreement decides whether the ledger accepts a cycle.
 */
class LedgerTimeTest {

    @Test
    @DisplayName("division truncates toward zero, as Daml does, not toward minus infinity")
    void divisionTruncatesTowardZero() {
        // Math.floorDiv(-7, 2) is -4. Daml's Int division is -3, and a client
        // that floors refuses a lock the ledger would have accepted.
        assertEquals(-3L, LedgerTime.intDivide(-7, 2));
        assertEquals(3L, LedgerTime.intDivide(7, 2));
        assertEquals(-3L, LedgerTime.intDivide(7, -2));
    }

    @Test
    @DisplayName("a pre-epoch fraction of a second truncates to zero, not to minus one")
    void preEpochTruncatesToZero() {
        assertEquals(0L, LedgerTime.epochSeconds(-500_000L));
        assertEquals(1787437747L, LedgerTime.epochSeconds(1787437747_000000L));
        assertEquals(1787437747L, LedgerTime.epochSeconds(1787437747_372202L));
    }

    @Test
    @DisplayName("secondsBetween truncates EACH endpoint before subtracting")
    void endpointsTruncateIndependently() {
        // 0.9s to 60.0s is sixty seconds here and fifty-nine under (b-a)/1e6.
        // The second answer refuses a cycle the ledger accepts, which is the
        // most dangerous disagreement in the package.
        assertEquals(60L, LedgerTime.secondsBetween(900_000L, 60_000_000L));
        assertEquals(0L, LedgerTime.secondsBetween(1_000_001L, 1_999_999L));
        assertEquals(1L, LedgerTime.secondsBetween(1_999_999L, 2_000_000L));
    }

    @Test
    @DisplayName("a negative interval keeps its sign rather than being made absolute")
    void negativeIntervalKeepsItsSign() {
        // Taking an absolute value would accept a lock that expires before it
        // starts, which is exactly the shape of a clock-skew bug.
        assertEquals(-60L, LedgerTime.secondsBetween(60_000_000L, 900_000L));
    }

    @Test
    @DisplayName("adding seconds overflows loudly instead of wrapping")
    void addSecondsOverflowsLoudly() {
        assertEquals(1787437805_189712L, LedgerTime.addSeconds(1787437775_189712L, 30));
        assertEquals(1787437745_189712L, LedgerTime.addSeconds(1787437775_189712L, -30));
        assertThrows(ArithmeticException.class,
                () -> LedgerTime.addSeconds(Long.MAX_VALUE, 1));
    }
}
