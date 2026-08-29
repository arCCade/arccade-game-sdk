package io.arccade.gamesdk;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static io.arccade.gamesdk.ArccadeDigest.canonDecimal;
import static io.arccade.gamesdk.ArccadeDigest.canonFields;
import static io.arccade.gamesdk.ArccadeDigest.canonList;
import static io.arccade.gamesdk.ArccadeDigest.canonText;
import static io.arccade.gamesdk.ArccadeDigest.canonTime;
import static io.arccade.gamesdk.ArccadeDigest.f;

/**
 * The two documents a Trade Wars cycle commits to.
 *
 * <p>The field sets mirror {@code ArCCade.GameSdk.Games.TradeWars} exactly. A
 * field added on one side only changes the digest and makes the stake
 * unsettleable, because {@code GameStake_Settle} recomputes both digests
 * on-ledger and rejects a mismatch.
 *
 * <p>The entry document carries the whole entry price vector, each point with
 * its source and timestamp. That is the point of committing before play: once
 * the market has moved, entry prices cannot be invented backwards.
 */
public final class TradeWarsDocuments {

    public static final String GAME_CODE = "trade-wars-v4";
    public static final String ENTRY_SCHEMA = "arccade-trade-wars-entry";
    public static final String OUTCOME_SCHEMA = "arccade-trade-wars-outcome";
    public static final int SCHEMA_VERSION = 1;

    private TradeWarsDocuments() {
    }

    /** One observed price, as of a stated moment, from a stated source. */
    public record PricePoint(String symbol, BigDecimal price, String source, Instant asOf) {
    }

    /** How much of the virtual balance the player put on one symbol. */
    public record AssetAllocation(String symbol, BigDecimal allocationPercent) {
    }

    /** What the player commits to before the round starts. */
    public record Entry(String cycleId, String tier, BigDecimal virtualBalance,
                        List<AssetAllocation> allocations, List<PricePoint> entryPrices) {
    }

    /** What the round produced, revealed at settlement. */
    public record Outcome(String cycleId, List<PricePoint> exitPrices,
                          BigDecimal virtualPnl, BigDecimal virtualPnlPercent,
                          BigDecimal xpAwarded,
                          BigDecimal returnedAmount, BigDecimal forfeitedAmount) {
    }

    // A price point appears inside a list, so it is encoded as a record document
    // in its own right rather than flattened into the parent's field set.
    private static String canonPricePoint(PricePoint p) {
        List<Map.Entry<String, String>> fields = List.of(
                f("as-of", canonTime(p.asOf())),
                f("price", canonDecimal(p.price())),
                f("source", canonText(p.source())),
                f("symbol", canonText(p.symbol())));
        return canonFields(fields);
    }

    private static String canonAllocation(AssetAllocation a) {
        List<Map.Entry<String, String>> fields = List.of(
                f("allocation-percent", canonDecimal(a.allocationPercent())),
                f("symbol", canonText(a.symbol())));
        return canonFields(fields);
    }

    private static List<String> pricePoints(List<PricePoint> points) {
        List<String> out = new ArrayList<>();
        for (PricePoint p : points) {
            out.add(canonPricePoint(p));
        }
        return out;
    }

    public static String entryDocument(Entry e) {
        List<String> allocations = new ArrayList<>();
        for (AssetAllocation a : e.allocations()) {
            allocations.add(canonAllocation(a));
        }
        return ArccadeDigest.canonDocument(ENTRY_SCHEMA, SCHEMA_VERSION, List.of(
                f("allocations", canonList(allocations)),
                f("cycle-id", canonText(e.cycleId())),
                f("entry-prices", canonList(pricePoints(e.entryPrices()))),
                f("game-code", canonText(GAME_CODE)),
                f("tier", canonText(e.tier())),
                f("virtual-balance", canonDecimal(e.virtualBalance()))));
    }

    public static String entryDigest(Entry e) {
        return ArccadeDigest.textDigest(entryDocument(e));
    }

    public static String outcomeDocument(Outcome o) {
        return ArccadeDigest.canonDocument(OUTCOME_SCHEMA, SCHEMA_VERSION, List.of(
                f("cycle-id", canonText(o.cycleId())),
                f("exit-prices", canonList(pricePoints(o.exitPrices()))),
                f("forfeited-amount", canonDecimal(o.forfeitedAmount())),
                f("game-code", canonText(GAME_CODE)),
                f("returned-amount", canonDecimal(o.returnedAmount())),
                f("virtual-pnl", canonDecimal(o.virtualPnl())),
                f("virtual-pnl-percent", canonDecimal(o.virtualPnlPercent())),
                f("xp-awarded", canonDecimal(o.xpAwarded()))));
    }

    public static String outcomeDigest(Outcome o) {
        return ArccadeDigest.textDigest(outcomeDocument(o));
    }
}
