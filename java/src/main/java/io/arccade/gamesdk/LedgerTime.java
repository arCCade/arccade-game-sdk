package io.arccade.gamesdk;

/**
 * Ledger time arithmetic — the same truncation Daml does, in Java.
 *
 * <p>Every duration check in {@code Policy.daml} and {@code Cycle.daml} runs
 * through this arithmetic, so a client that computes a duration differently
 * refuses cycles the ledger accepts, or offers ones it will refuse.
 *
 * <h2>The two traps</h2>
 *
 * <ol>
 *   <li><b>Division truncates TOWARD ZERO.</b> Daml's {@code /} on {@code Int}
 *       does, and Java's {@code /} agrees — but Python's {@code //} floors and
 *       a client ported from it would disagree on negatives, which is exactly
 *       where a pre-epoch or clock-skewed timestamp lands. The operation is
 *       named here so the agreement is written down rather than assumed.</li>
 *   <li><b>{@link #secondsBetween} truncates EACH ENDPOINT before subtracting.</b>
 *       0.9s to 60.0s is SIXTY seconds, not fifty-nine. This is the most
 *       dangerous behaviour in the package: it decides whether a lock or a
 *       cycle is long enough, and a client computing {@code (b - a) / 1e6}
 *       refuses cycles the ledger accepts.</li>
 * </ol>
 *
 * <p>Times are integer microseconds since the epoch throughout. There is no
 * {@code Instant} overload on purpose: an {@code Instant} carries nanoseconds
 * the ledger does not have, and the conversion belongs at the boundary where
 * the caller can see it — {@link CycleAuditReader#instantToMicros}.
 */
public final class LedgerTime {

    private static final long MICROS_PER_SECOND = 1_000_000L;

    private LedgerTime() {
    }

    /**
     * Integer division truncating TOWARD ZERO, as Daml's {@code /} on
     * {@code Int} does. {@code intDivide(-7, 2) == -3}; flooring gives -4.
     */
    public static long intDivide(long a, long b) {
        return a / b;
    }

    /** Epoch microseconds to epoch seconds, truncated toward zero. */
    public static long epochSeconds(long micros) {
        return intDivide(micros, MICROS_PER_SECOND);
    }

    /**
     * {@code epochSeconds(b) - epochSeconds(a)}.
     *
     * <p>Negative when b precedes a. The caller checks the sign; taking an
     * absolute value here would accept a lock that expires before it starts.
     */
    public static long secondsBetween(long aMicros, long bMicros) {
        return epochSeconds(bMicros) - epochSeconds(aMicros);
    }

    /** Adds whole seconds to an instant. Used for cooldowns and deadlines. */
    public static long addSeconds(long micros, long seconds) {
        return Math.addExact(micros, Math.multiplyExact(seconds, MICROS_PER_SECOND));
    }
}
