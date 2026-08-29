package io.arccade.gamesdk;

/**
 * The settlement arithmetic {@code Cycle.daml} enforces, restated so a client
 * can check it.
 *
 * <p>No shipped client re-checked this, which meant a published report could
 * state amounts the ledger would have refused while every individual Merkle
 * proof still verified. Conservation is the one property a proof cannot
 * express: the tree says "this row is in the report", never "this row is
 * arithmetically possible".
 *
 * <p>Amounts are integer 1e-10 units, matching an audit row rather than a
 * policy. Messages name the condition from {@code Cycle.daml} that failed,
 * because "which rule" is the useful half of the answer when a report is being
 * argued about.
 */
public final class SettlementInvariants {

    private SettlementInvariants() {
    }

    /**
     * One settlement's amounts, in integer 1e-10 units.
     *
     * <p>{@code maxPayoutUnits} is the venue policy's cap, carried alongside
     * the settlement because the cap is what makes a payout checkable at all:
     * without it, any payout is as plausible as any other.
     */
    public record Settlement(
            String disposition,
            long stakeUnits,
            long returnedUnits,
            long forfeitedUnits,
            long payoutUnits,
            long maxPayoutUnits) {
    }

    /** Checks one settlement's amounts. Returns true, or throws saying why. */
    public static boolean assertSettlementValid(Settlement s) {
        String disposition = PeriodAuditDocuments.assertDisposition(s.disposition());

        // Sign first: a negative leg reverses the direction of the settlement
        // while the row still reads as a payment to the player.
        requireNonNegative("returnedUnits", s.returnedUnits());
        requireNonNegative("forfeitedUnits", s.forfeitedUnits());
        requireNonNegative("payoutUnits", s.payoutUnits());

        if (Math.addExact(s.returnedUnits(), s.forfeitedUnits()) != s.stakeUnits()) {
            throw new IllegalArgumentException("returned + forfeited must equal the stake: "
                    + s.returnedUnits() + " + " + s.forfeitedUnits() + " != " + s.stakeUnits());
        }

        switch (disposition) {
            case "returned-in-full" -> {
                if (s.forfeitedUnits() != 0) {
                    throw new IllegalArgumentException(
                            "returned-in-full cannot forfeit: forfeitedUnits=" + s.forfeitedUnits());
                }
            }
            case "forfeited-in-full" -> {
                if (s.returnedUnits() != 0) {
                    throw new IllegalArgumentException(
                            "forfeited-in-full cannot return: returnedUnits=" + s.returnedUnits());
                }
            }
            case "returned-with-forfeit" -> {
                if (!(s.returnedUnits() > 0 && s.forfeitedUnits() > 0)) {
                    throw new IllegalArgumentException(
                            "returned-with-forfeit needs both sides non-zero: returnedUnits="
                                    + s.returnedUnits() + ", forfeitedUnits=" + s.forfeitedUnits());
                }
            }
            // Unlocking a TimeLockedHolding always pays the owner in full and
            // neither mechanic can forfeit, so anything less than the whole
            // stake describes value that went nowhere.
            case "aborted", "expired-unsettled" -> {
                if (s.returnedUnits() != s.stakeUnits()) {
                    throw new IllegalArgumentException(disposition
                            + " must return the stake in full: returnedUnits=" + s.returnedUnits()
                            + ", stakeUnits=" + s.stakeUnits());
                }
            }
            default -> throw new IllegalArgumentException("unknown disposition: " + disposition);
        }

        if (s.payoutUnits() > s.maxPayoutUnits()) {
            throw new IllegalArgumentException("payout above the policy cap: payoutUnits="
                    + s.payoutUnits() + ", maxPayoutUnits=" + s.maxPayoutUnits());
        }
        return true;
    }

    /**
     * The predicate form.
     *
     * <p>Prefer {@link #assertSettlementValid} when reporting: which rule failed
     * is the half a reader needs, and this form throws it away.
     */
    public static boolean settlementIsValid(Settlement s) {
        try {
            return assertSettlementValid(s);
        } catch (IllegalArgumentException | ArithmeticException e) {
            return false;
        }
    }

    private static void requireNonNegative(String name, long value) {
        if (value < 0) {
            throw new IllegalArgumentException("negative settlement amount: " + name + "=" + value);
        }
    }
}
