package io.arccade.gamesdk;

/**
 * A CIP-0056 instrument identifier: the registry that admits the asset, and the
 * asset's id within it.
 *
 * <p>It is one type rather than two strings because the pair travels together
 * through every value path in this SDK — a trade leg, a transfer recipient, a
 * stake's terms — and the two halves are not interchangeable. {@code admin} is
 * a party (the DSO for Canton Coin, a game's registry party for its items) and
 * {@code id} is namespaced text. Swapping them produces a payload the ledger
 * rejects at submission rather than a value that is quietly wrong, but only
 * because they happen to be shaped differently today.
 *
 * <p>Both halves must be present. An instrument with no admin has no registry
 * that could have issued it, and {@link TradeCommands#leg} refuses it for that
 * reason rather than carrying a half-formed reference into a document.
 */
public record InstrumentId(String admin, String id) {

    public InstrumentId {
        if (admin == null || admin.isEmpty() || id == null || id.isEmpty()) {
            throw new IllegalArgumentException(
                    "instrumentId needs an admin and an id: admin=" + admin + ", id=" + id);
        }
    }
}
