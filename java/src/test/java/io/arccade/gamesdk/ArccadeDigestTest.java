package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Cross-language parity for {@code arccade-sdk-digest-v1}.
 *
 * <p>The golden vector below is the same one {@code VectorsTest.daml} asserts.
 * If this test fails, Java disagrees with the ledger, and every stake it
 * commits becomes unsettleable — {@code GameStake_Settle} recomputes the digest
 * and rejects a mismatch. That failure would otherwise appear as an opaque
 * rejection during a live cycle rather than here.
 */
class ArccadeDigestTest {

    @Test
    @DisplayName("golden vector: Pixel Race entry matches the Daml suite")
    void pixelRaceEntryGoldenVector() {
        // Identical to samplePrEntry in VectorsTest.daml.
        var entry = new PixelRaceDocuments.Entry(
                "pr-sample-1",
                "bronze",
                3,
                "0000000000000000000000000000000000000000000000000000000000000000");

        assertEquals(
                "0b2349e05633cf279ca0ee1d3f5efd8b2308f3e2ee947a32f5c3397e456d0204",
                PixelRaceDocuments.entryDigest(entry));
    }

    @Test
    @DisplayName("golden vector: Trade Wars entry matches the Daml suite")
    void tradeWarsEntryGoldenVector() {
        // Identical to sampleTwEntry in VectorsTest.daml. The instant is
        // 1970-01-01T00:00:01Z, written there as `time (date 1970 Jan 1) 0 0 1`.
        var asOf = Instant.parse("1970-01-01T00:00:01Z");
        var entry = new TradeWarsDocuments.Entry(
                "tw-sample-1",
                "silver",
                new BigDecimal("10000.0"),
                List.of(
                        new TradeWarsDocuments.AssetAllocation("BTC", new BigDecimal("60.0")),
                        new TradeWarsDocuments.AssetAllocation("ETH", new BigDecimal("40.0"))),
                List.of(
                        new TradeWarsDocuments.PricePoint(
                                "BTC", new BigDecimal("60000.0"), "binance", asOf),
                        new TradeWarsDocuments.PricePoint(
                                "ETH", new BigDecimal("3000.0"), "binance", asOf)));

        assertEquals(
                "5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852",
                TradeWarsDocuments.entryDigest(entry));
    }

    @Test
    @DisplayName("Trade Wars list ordering is part of the commitment, not a detail")
    void tradeWarsAllocationOrderChangesTheDigest() {
        // Lists are encoded in the order given: the SDK does not sort them, because
        // the order a player allocated in is part of what they committed to. Swapping
        // two allocations must therefore produce a different digest -- if it did not,
        // an outcome could be re-attributed to a different entry after the fact.
        var asOf = Instant.parse("1970-01-01T00:00:01Z");
        var prices = List.of(
                new TradeWarsDocuments.PricePoint("BTC", new BigDecimal("60000.0"), "binance", asOf));
        var btcFirst = new TradeWarsDocuments.Entry("tw-order", "silver", new BigDecimal("10000.0"),
                List.of(new TradeWarsDocuments.AssetAllocation("BTC", new BigDecimal("60.0")),
                        new TradeWarsDocuments.AssetAllocation("ETH", new BigDecimal("40.0"))),
                prices);
        var ethFirst = new TradeWarsDocuments.Entry("tw-order", "silver", new BigDecimal("10000.0"),
                List.of(new TradeWarsDocuments.AssetAllocation("ETH", new BigDecimal("40.0")),
                        new TradeWarsDocuments.AssetAllocation("BTC", new BigDecimal("60.0"))),
                prices);

        org.junit.jupiter.api.Assertions.assertNotEquals(
                TradeWarsDocuments.entryDigest(btcFirst),
                TradeWarsDocuments.entryDigest(ethFirst));
    }

    @Test
    @DisplayName("textDigest is plain sha256 of the UTF-8 bytes")
    void textDigestIsPlainSha256() {
        // The point of the scheme: a third party runs sha256sum over the bytes
        // we publish and gets the same value, with no library involved.
        //   printf 'arccade' | sha256sum
        assertEquals(
                "140f371fce01eea5068da54d3de6bb719d68dc325f494be284ce56a52da44079",
                ArccadeDigest.textDigest("arccade"));
    }

    @Test
    @DisplayName("length is counted in code points, not UTF-16 units")
    void lengthUsesCodePoints() {
        // U+1F3AE VIDEO GAME is one code point but two UTF-16 units. Using
        // String.length() here would produce a document Daml and Python reject.
        String emoji = "🎮";
        assertEquals(1, ArccadeDigest.codePointLength(emoji));
        assertEquals(2, emoji.length());
        assertEquals("t:1:" + emoji, ArccadeDigest.canonText(emoji));
    }

    @Test
    @DisplayName("fields are sorted by name, so field order is not part of the document")
    void fieldsSortByName() {
        String a = ArccadeDigest.canonFields(List.of(
                ArccadeDigest.f("zebra", ArccadeDigest.canonInt(1)),
                ArccadeDigest.f("alpha", ArccadeDigest.canonInt(2))));
        String b = ArccadeDigest.canonFields(List.of(
                ArccadeDigest.f("alpha", ArccadeDigest.canonInt(2)),
                ArccadeDigest.f("zebra", ArccadeDigest.canonInt(1))));
        assertEquals(a, b);
    }

    @Test
    @DisplayName("field names outside ASCII [a-zA-Z0-9-] are rejected")
    void rejectsNonAsciiFieldNames() {
        assertThrows(IllegalArgumentException.class, () -> ArccadeDigest.canonFields(
                List.of(ArccadeDigest.f("bad_name", ArccadeDigest.canonInt(1)))));
    }

    @Test
    @DisplayName("amounts become integer 1e-10 units, truncating toward zero")
    void amountUnitsTruncateTowardZero() {
        assertEquals(300_000_000_000L, ArccadeDigest.amountUnits(new BigDecimal("30.0")));
        assertEquals(100_000_000L, ArccadeDigest.amountUnits(new BigDecimal("0.01")));
        assertEquals(0L, ArccadeDigest.amountUnits(BigDecimal.ZERO));
        assertEquals(-300_000_000_000L, ArccadeDigest.amountUnits(new BigDecimal("-30.0")));
    }

    @Test
    @DisplayName("an amount finer than 1e-10 is refused rather than silently rounded")
    void amountBeyondPrecisionThrows() {
        assertThrows(IllegalArgumentException.class,
                () -> ArccadeDigest.amountUnits(new BigDecimal("0.00000000001")));
    }

    @Test
    @DisplayName("the amount grammar is narrower than BigDecimal's, deliberately")
    void amountGrammarIsNarrowerThanBigDecimal() {
        // Every one of these is accepted by new BigDecimal(String) and refused
        // by Daml. A consumer who converted a ledger field first would have
        // committed to a value the ledger reads differently, or refuses.
        for (String bad : List.of("+1", ".5", "1e3", "1E+2", " 1.5", "1,5", "1.2.3", "abc", "")) {
            assertThrows(NumberFormatException.class, () -> ArccadeDigest.amountUnits(bad));
        }
        // A TRAILING dot is a whole number with an empty fraction and every
        // implementation reads it that way; a leading one would be a second
        // spelling of a value that already has one.
        assertEquals(10_000_000_000L, ArccadeDigest.amountUnits("1."));
        assertEquals(0L, ArccadeDigest.amountUnits("-0.0"));
        assertEquals(9223372036854775807L, ArccadeDigest.amountUnits("922337203.6854775807"));
        assertThrows(ArithmeticException.class,
                () -> ArccadeDigest.amountUnits("922337203.6854775808"));
    }

    @Test
    @DisplayName("a native double is refused rather than converted")
    void nativeDoubleIsRefused() {
        // 1.5 is exact in binary and 0.1 is not, so a double argument would
        // succeed or lose precision depending on the literal. The overload
        // exists so the refusal happens here, with a reason.
        assertThrows(IllegalArgumentException.class, () -> ArccadeDigest.amountUnits(1.5));
        assertThrows(IllegalArgumentException.class, () -> ArccadeDigest.canonDecimal(1.5));
    }

    @Test
    @DisplayName("an integer wider than int64 has a canonical form; the band is amountUnits' job")
    void wideIntegersHaveACanonicalForm() {
        assertEquals("i:20:18446744073709551616",
                ArccadeDigest.canonInt(new BigInteger("18446744073709551616")));
        assertEquals(ArccadeDigest.canonInt(42L),
                ArccadeDigest.canonInt(BigInteger.valueOf(42)));
    }

    @Test
    @DisplayName("the empty string is refused, because Daml's toHex of it is a runtime error")
    void emptyTextDigestIsRefused() {
        // Returning e3b0c442... would hand a caller a commitment no
        // GameStake_Settle could ever match, and the mistake would surface at
        // settlement rather than here.
        assertThrows(IllegalArgumentException.class, () -> ArccadeDigest.textDigest(""));
    }

    @Test
    @DisplayName("code-point order and UTF-16 order disagree, and the tree follows code points")
    void codePointOrderDiffersFromCompareTo() {
        // U+1F3AE's lead surrogate D83C sorts BELOW U+FFFD as a code unit and
        // ABOVE it as a code point. Two honest implementations sorting the same
        // cycles differently publish different Merkle roots.
        String gamepad = "🎮";
        String replacement = "\uFFFD";
        assertTrue(gamepad.compareTo(replacement) < 0);
        assertTrue(ArccadeDigest.compareByCodePoint(gamepad, replacement) > 0);
        assertEquals(0, ArccadeDigest.compareByCodePoint("abc", "abc"));
        assertTrue(ArccadeDigest.compareByCodePoint("ab", "abc") < 0);
        assertTrue(ArccadeDigest.compareByCodePoint("B", "a") < 0);
    }

    @Test
    @DisplayName("the length prefix keeps content from impersonating a separator")
    void lengthPrefixIsInjective() {
        // Without the length, "a" + "b:c" and "a:b" + "c" could collide.
        assertEquals("t:3:a:b", ArccadeDigest.canonText("a:b"));
        assertEquals("t:1:a", ArccadeDigest.canonText("a"));
    }
}
