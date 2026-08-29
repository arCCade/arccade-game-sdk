package io.arccade.gamesdk;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * Marketplace and item trading — the SECOND kind of value event written to the
 * ledger.
 *
 * <p>THE ARCHITECTURAL RULE. This SDK has no write API that does not carry
 * value, and will not gain one. Game activity — score, level, inventory state,
 * matchmaking, leaderboards, session records — stays in the application's own
 * database. Only three things reach the ledger: a value commitment and its
 * settlement ({@link CycleCommands}), a change of ownership (here), and a plain
 * transfer of value ({@link TransferCommands}).
 *
 * <p>Every leg carries its OWN {@code instrumentId}, so one primitive covers
 * item-for-coin (a marketplace sale), item-for-item (a swap) and
 * asset-for-asset (a third party's own assets).
 *
 * <h2>Why allocations, when a stake gets a lock</h2>
 *
 * <p>{@code Allocation_Withdraw} can be called by the sender alone. For a stake
 * that would be unacceptable — a reservation is not a lock. For a TRADE it is
 * the correct behaviour: being able to walk away before the counterparty
 * settles is the difference between an offer and an escrow. Custody stays with
 * each party until {@code Trade_Settle} runs, and then all legs move in one
 * transaction or none do.
 */
public final class TradeCommands {

    /** First component of every trade document. A wire constant. */
    public static final String TRADE_TAG_PREFIX = "arccade-game-sdk:trade:1:";

    /** The canonical leg keys. They are sorted INTO the document; see below. */
    public static final String LEG_OFFER = "offer";
    public static final String LEG_ASK = "ask";

    private TradeCommands() {
    }

    /**
     * One leg: "X sends N units of INSTR to Y".
     *
     * <p>{@code instrumentId.admin} is that asset's registry — the DSO for
     * Canton Coin, the minting application's registry party for a game item.
     * The SDK does not interpret the asset; it carries the legs and settles
     * them atomically.
     *
     * <p>Validation lives in the constructor rather than in a factory so that
     * no path can build an unchecked leg — a builder handed one would write a
     * payload the ledger refuses, at the point where it costs a submission.
     */
    public record TradeLeg(String sender, String receiver, InstrumentId instrumentId,
                           String amount) {
        public TradeLeg {
            if (sender == null || sender.isEmpty() || receiver == null || receiver.isEmpty()) {
                throw new IllegalArgumentException(
                        "a trade leg needs a sender and a receiver: sender=" + sender
                                + ", receiver=" + receiver);
            }
            if (sender.equals(receiver)) {
                // The cheapest way to manufacture fake volume, closed at source.
                throw new IllegalArgumentException(
                        "a trade leg's sender and receiver must differ: " + sender);
            }
            if (instrumentId == null) {
                throw new IllegalArgumentException("instrumentId needs an admin and an id: null");
            }
            if (ArccadeDigest.amountUnits(amount) <= 0) {
                throw new IllegalArgumentException("a trade leg amount must be positive: " + amount);
            }
        }
    }

    /** The documented way to build a leg. See {@link TradeLeg}. */
    public static TradeLeg leg(String sender, String receiver, InstrumentId instrumentId,
                               String amount) {
        return new TradeLeg(sender, receiver, instrumentId, amount);
    }

    /**
     * A trade, as the parties agreed it.
     *
     * <p>{@code taker} is null for an open offer. {@code expiresAt} is ISO 8601
     * text, passed through to the document verbatim: reformatting a timestamp
     * would change the digest of a trade that has already been proposed.
     */
    public record Trade(String tradeId, String maker, String taker,
                        Map<String, TradeLeg> legs, String expiresAt, Map<String, String> meta) {
    }

    public static String newTradeId() {
        return newTradeId("t");
    }

    public static String newTradeId(String prefix) {
        return assertValidTradeId(prefix + "-" + UUID.randomUUID());
    }

    public static String assertValidTradeId(String tradeId) {
        if (tradeId == null || tradeId.isEmpty()
                || ArccadeDigest.codePointLength(tradeId) > 64) {
            throw new IllegalArgumentException(
                    "invalid tradeId (non-empty, at most 64 code points): " + tradeId);
        }
        if (tradeId.indexOf(':') >= 0 || tradeId.indexOf('|') >= 0) {
            throw new IllegalArgumentException(
                    "a tradeId cannot contain ':' or '|': " + tradeId);
        }
        return tradeId;
    }

    /**
     * The trade's canonical document, and the only thing hashed onto the ledger.
     *
     * <p>An item's name, artwork, rarity and in-game effect are not written
     * anywhere. What the ledger records is the CHANGE OF OWNERSHIP.
     *
     * <h2>Why a pipe is refused rather than escaped</h2>
     *
     * <p>The v1 format joins components with {@code |} and has no length
     * prefixes — unlike {@link ArccadeDigest#canon}, whose length prefix is what
     * makes it injective. A pipe inside a party name or a meta value therefore
     * reshapes the document silently: two different trades can produce the same
     * text. Escaping would fix that only if all four implementations escaped
     * identically, which is a larger promise than refusing the character.
     */
    public static String tradeDocument(Trade t) {
        assertValidTradeId(t.tradeId());
        List<String> parts = new ArrayList<>();
        parts.add("tradeId=" + noPipe("tradeId", t.tradeId()));
        parts.add("maker=" + noPipe("maker", t.maker()));
        parts.add("taker=" + noPipe("taker", t.taker() == null ? "" : t.taker()));
        parts.add("expiresAt=" + noPipe("expiresAt", t.expiresAt()));
        for (Map.Entry<String, TradeLeg> e : sorted(t.legs()).entrySet()) {
            TradeLeg l = e.getValue();
            parts.add("leg." + noPipe("leg key", e.getKey()) + "="
                    + noPipe("leg sender", l.sender()) + ">" + noPipe("leg receiver", l.receiver())
                    + ":" + noPipe("leg amount", l.amount())
                    + ":" + noPipe("registry", l.instrumentId().admin())
                    + "/" + noPipe("instrument", l.instrumentId().id()));
        }
        for (Map.Entry<String, String> e : sorted(t.meta()).entrySet()) {
            parts.add("meta." + noPipe("meta key", e.getKey()) + "="
                    + noPipe("meta value", e.getValue()));
        }
        return TRADE_TAG_PREFIX + String.join("|", parts);
    }

    public static String tradeDigest(Trade t) {
        return ArccadeDigest.textDigest(tradeDocument(t));
    }

    // ------------------------------------------------------------- builders

    /**
     * STEP 1 — the proposal. The maker signs, the venue observes. A null taker
     * is an open offer.
     *
     * <p>This is an INVITATION rather than a settlement, and it still carries
     * value: accepting it changes ownership. Events that carry none — "listing
     * viewed", "added to favourites" — stay in the application's database.
     */
    public record ProposalOptions(String sdkPackageId, String venue, String maker, String taker,
                                  String tradeId, Map<String, TradeLeg> legs, String expiresAt,
                                  String settleBefore, String commandId,
                                  Map<String, String> meta) {
    }

    public static Json buildTradeProposalCommands(ProposalOptions o) {
        assertValidTradeId(o.tradeId());
        Map<String, TradeLeg> legs = o.legs() == null ? Map.of() : o.legs();
        if (!legs.containsKey(LEG_OFFER) || !legs.containsKey(LEG_ASK)) {
            throw new IllegalArgumentException("a trade needs two legs: \"" + LEG_OFFER
                    + "\" and \"" + LEG_ASK + "\"");
        }
        Map<String, String> meta = o.meta() == null ? Map.of() : o.meta();

        Json.ObjectBuilder legValues = Json.object();
        for (Map.Entry<String, TradeLeg> e : legs.entrySet()) {
            legValues.put(e.getKey(), legJson(e.getValue()));
        }
        String digest = tradeDigest(new Trade(o.tradeId(), o.maker(), o.taker(), legs,
                o.expiresAt(), meta));

        Json create = Json.object()
                .put("CreateCommand", Json.object()
                        .put("templateId", LedgerPayloads.templateId(
                                o.sdkPackageId(), "ArCCade.GameSdk.Trade", "TradeProposal"))
                        .put("createArguments", Json.object()
                                .put("venue", o.venue())
                                .put("tradeId", o.tradeId())
                                .put("maker", o.maker())
                                .put("taker", o.taker())
                                .put("legs", Json.object().put("values", legValues.build()).build())
                                .put("expiresAt", o.expiresAt())
                                .put("settleBefore", o.settleBefore())
                                .put("tradeDigest", digest)
                                .put("meta", LedgerPayloads.values(meta))
                                .build())
                        .build())
                .build();

        List<Json> commands = List.of(create);
        List<String> actAs = List.of(o.maker());
        return Json.object()
                .put("tradeId", o.tradeId())
                .put("commands", Json.array(commands))
                .put("actAs", LedgerPayloads.parties(actAs))
                .put("submission", LedgerPayloads.submission(commands,
                        LedgerPayloads.orElse(o.commandId(), "trade-propose-" + o.tradeId()),
                        actAs, LedgerPayloads.distinct(List.of(o.maker(), o.venue()))))
                .build();
    }

    /**
     * STEP 2 — atomic settlement. The venue exercises every leg in ONE
     * transaction, so the Canton engine's all-or-nothing guarantee covers the
     * whole trade: there is no state in which the item moved and the coin did
     * not.
     */
    public record SettleOptions(String sdkPackageId, String venue, String maker, String taker,
                                String tradeCid, Map<String, String> allocations,
                                String commandId) {
    }

    public static Json buildTradeSettleCommands(SettleOptions o) {
        if (o.allocations() == null || o.allocations().isEmpty()) {
            throw new IllegalArgumentException(
                    "settle needs an allocation contract id for every leg");
        }
        Json.ObjectBuilder allocations = Json.object();
        for (Map.Entry<String, String> e : o.allocations().entrySet()) {
            allocations.put(e.getKey(), e.getValue());
        }
        Json cmd = LedgerPayloads.exercise(
                LedgerPayloads.templateId(o.sdkPackageId(), "ArCCade.GameSdk.Trade", "Trade"),
                o.tradeCid(), "Trade_Settle",
                Json.object().put("allocations",
                        Json.object().put("values", allocations.build()).build()).build());
        List<Json> commands = List.of(cmd);
        List<String> actAs = List.of(o.venue());
        return Json.object()
                .put("commands", Json.array(commands))
                .put("actAs", LedgerPayloads.parties(actAs))
                .put("submission", LedgerPayloads.submission(commands,
                        LedgerPayloads.orElse(o.commandId(),
                                "trade-settle-" + LedgerPayloads.shortId(o.tradeCid())),
                        actAs, LedgerPayloads.distinct(
                                List.of(o.venue(), o.maker(), o.taker()))))
                .build();
    }

    public record CancelOptions(String sdkPackageId, String venue, String tradeCid, String reason,
                                String commandId) {
    }

    public static Json buildTradeCancelCommands(CancelOptions o) {
        Json cmd = LedgerPayloads.exercise(
                LedgerPayloads.templateId(o.sdkPackageId(), "ArCCade.GameSdk.Trade", "Trade"),
                o.tradeCid(), "Trade_Cancel",
                Json.object().put("reason", o.reason() == null ? "" : o.reason()).build());
        List<Json> commands = List.of(cmd);
        List<String> actAs = List.of(o.venue());
        return Json.object()
                .put("commands", Json.array(commands))
                .put("actAs", LedgerPayloads.parties(actAs))
                // No readAs: a cancellation is the venue acting on its own
                // contract, and widening the read set would disclose the trade
                // to parties the cancellation does not concern.
                .put("submission", LedgerPayloads.submission(commands,
                        LedgerPayloads.orElse(o.commandId(),
                                "trade-cancel-" + LedgerPayloads.shortId(o.tradeCid())),
                        actAs, null))
                .build();
    }

    static Json legJson(TradeLeg l) {
        return Json.object()
                .put("sender", l.sender())
                .put("receiver", l.receiver())
                .put("instrumentId", LedgerPayloads.instrument(l.instrumentId()))
                .put("amount", l.amount())
                .build();
    }

    /**
     * Sorted by Unicode code point, matching Daml's {@code sortOn} and the
     * other clients. The keys are ASCII today, so this is a promise about
     * tomorrow's keys rather than a fix for today's.
     */
    private static <V> Map<String, V> sorted(Map<String, V> m) {
        Map<String, V> out = new TreeMap<>(ArccadeDigest.CODE_POINT_ORDER);
        out.putAll(m == null ? new LinkedHashMap<>() : m);
        return out;
    }

    static String noPipe(String what, String value) {
        if (value.indexOf('|') >= 0) {
            throw new IllegalArgumentException("a v1 document component cannot contain '|' ("
                    + what + "): " + value);
        }
        return value;
    }
}
