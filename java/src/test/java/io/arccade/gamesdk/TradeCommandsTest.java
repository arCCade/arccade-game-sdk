package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import io.arccade.gamesdk.TradeCommands.TradeLeg;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The trade document, and the proposal payload that embeds its digest. */
class TradeCommandsTest {

    private static final InstrumentId SWORD =
            new InstrumentId("registry-party", "mygame/sword-of-dawn#4a91c8f2");
    private static final InstrumentId COIN = new InstrumentId("dso-party", "Amulet");

    private static Map<String, TradeLeg> legs() {
        Map<String, TradeLeg> legs = new LinkedHashMap<>();
        legs.put("offer", TradeCommands.leg("maker-party", "taker-party", SWORD, "1"));
        legs.put("ask", TradeCommands.leg("taker-party", "maker-party", COIN, "25.0"));
        return legs;
    }

    @Test
    @DisplayName("golden vector: a two-leg trade document and its digest")
    void tradeDocumentGoldenVector() {
        TradeCommands.Trade t = new TradeCommands.Trade("t-1", "maker-party", "taker-party",
                legs(), "2026-08-30T00:00:00Z", Map.of("listing", "lst-9"));
        assertEquals("arccade-game-sdk:trade:1:tradeId=t-1|maker=maker-party|taker=taker-party"
                        + "|expiresAt=2026-08-30T00:00:00Z"
                        + "|leg.ask=taker-party>maker-party:25.0:dso-party/Amulet"
                        + "|leg.offer=maker-party>taker-party:1:"
                        + "registry-party/mygame/sword-of-dawn#4a91c8f2"
                        + "|meta.listing=lst-9",
                TradeCommands.tradeDocument(t));
        assertEquals("e0e246c230f3660dd984ebb18dfdfa5a9cfd40c222513a2fde8334a4c8f8aef8",
                TradeCommands.tradeDigest(t));
    }

    @Test
    @DisplayName("legs and meta are sorted by key, so the caller's insertion order cannot move the digest")
    void legAndMetaOrderIsByKey() {
        Map<String, TradeLeg> reversed = new LinkedHashMap<>();
        reversed.put("ask", TradeCommands.leg("taker-party", "maker-party", COIN, "25.0"));
        reversed.put("offer", TradeCommands.leg("maker-party", "taker-party", SWORD, "1"));
        assertEquals(
                TradeCommands.tradeDocument(new TradeCommands.Trade("t-1", "maker-party",
                        "taker-party", legs(), "2026-08-30T00:00:00Z",
                        Map.of("listing", "lst-9"))),
                TradeCommands.tradeDocument(new TradeCommands.Trade("t-1", "maker-party",
                        "taker-party", reversed, "2026-08-30T00:00:00Z",
                        Map.of("listing", "lst-9"))));
    }

    @Test
    @DisplayName("an open offer writes an EMPTY taker rather than dropping the field")
    void openOfferKeepsTheField() {
        String doc = TradeCommands.tradeDocument(new TradeCommands.Trade("t-3", "maker-party",
                null, legs(), "2026-08-30T00:00:00Z", Map.of()));
        assertTrue(doc.contains("|taker=|"));
    }

    @Test
    @DisplayName("a pipe in any component is refused, because v1 has no length prefixes")
    void pipeIsRefusedEverywhere() {
        // Unlike canon(), this format cannot survive a separator inside a value:
        // two different trades would produce the same text.
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.tradeDocument(new TradeCommands.Trade("t-4", "maker|party",
                        "taker-party", legs(), "2026-08-30T00:00:00Z", Map.of())));
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.tradeDocument(new TradeCommands.Trade("t-4", "maker-party",
                        "taker-party", legs(), "2026-08-30T00:00:00Z", Map.of("note", "a|b"))));
    }

    @Test
    @DisplayName("a leg cannot be self-dealing, zero-valued or half-formed")
    void legValidation() {
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.leg("p", "p", COIN, "1.0"));
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.leg("a", "b", COIN, "0"));
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.leg("a", "", COIN, "1.0"));
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.leg("a", "b", new InstrumentId("", "Amulet"), "1.0"));
    }

    @Test
    @DisplayName("a tradeId cannot carry a separator or exceed 64 code points")
    void tradeIdShape() {
        assertEquals("t-1", TradeCommands.assertValidTradeId("t-1"));
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.assertValidTradeId("t|1"));
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.assertValidTradeId("t".repeat(65)));
        assertTrue(TradeCommands.newTradeId().startsWith("t-"));
    }

    @Test
    @DisplayName("the proposal embeds the trade digest and asks only the maker to sign")
    void proposalEmbedsTheDigest() {
        Json built = TradeCommands.buildTradeProposalCommands(
                new TradeCommands.ProposalOptions("sdkpkg", "venue-party", "maker-party",
                        "taker-party", "t-0001", legs(), "2026-08-30T00:00:00Z",
                        "2026-08-31T00:00:00Z", "trade-propose-t-0001",
                        Map.of("listing", "lst-9")));

        Json args = built.path("commands").path(0).path("CreateCommand").path("createArguments");
        assertEquals("sdkpkg:ArCCade.GameSdk.Trade:TradeProposal",
                built.path("commands").path(0).path("CreateCommand").path("templateId").asText());
        assertEquals(TradeCommands.tradeDigest(new TradeCommands.Trade("t-0001", "maker-party",
                        "taker-party", legs(), "2026-08-30T00:00:00Z",
                        Map.of("listing", "lst-9"))),
                args.path("tradeDigest").asText());
        assertEquals(List.of("maker-party"), partyList(built.path("actAs")));
        // The venue observes but does not sign a proposal.
        assertEquals(List.of("maker-party", "venue-party"),
                partyList(built.path("submission").path("commands").path("readAs")));
    }

    @Test
    @DisplayName("a one-legged trade and an unallocated settle are refused")
    void incompleteTradesAreRefused() {
        Map<String, TradeLeg> oneLeg = new LinkedHashMap<>();
        oneLeg.put("offer", TradeCommands.leg("maker-party", "taker-party", SWORD, "1"));
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.buildTradeProposalCommands(
                        new TradeCommands.ProposalOptions("sdkpkg", "v", "m", "t", "t-1", oneLeg,
                                "2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z", null, Map.of())));
        assertThrows(IllegalArgumentException.class,
                () -> TradeCommands.buildTradeSettleCommands(
                        new TradeCommands.SettleOptions("sdkpkg", "v", "m", "t", "cid",
                                Map.of(), null)));
    }

    private static List<String> partyList(Json array) {
        List<String> out = new java.util.ArrayList<>();
        for (Json e : array) {
            out.add(e.asText());
        }
        return out;
    }
}
