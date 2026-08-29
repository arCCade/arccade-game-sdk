package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The reader that replaced jackson-databind, pinned.
 *
 * <p>Dropping a dependency is only an improvement if what replaced it is
 * checked at least as hard. These tests exist because the alternative — a
 * hand-rolled parser with no tests, sitting under a class that decides what
 * gets anchored on a ledger — would be a worse position than the dependency
 * was.
 *
 * <p>The two tests that matter most are {@link #jsonNullIsNotTheStringNull} and
 * {@link #numbersKeepTheirSourceLexeme}: they pin the two places this reader is
 * deliberately stricter than Jackson, and both differences are the difference
 * between a canonical document that is right and one that hashes something the
 * ledger never said.
 */
class JsonTest {

    @Test
    @DisplayName("a JSON null reads as empty, never as the four-character string \"null\"")
    void jsonNullIsNotTheStringNull() {
        // Jackson's NullNode.asText() returns "null". Routed into canonText that
        // becomes t:4:null -- a value the ledger never wrote, hashed as though
        // it had. An absent outcome digest and the text "null" are not the same
        // fact and must not produce the same document.
        Json n = Json.parse("{\"outcomeDigest\":null}");
        assertTrue(n.path("outcomeDigest").isNull());
        assertEquals("", n.path("outcomeDigest").asText());
        assertEquals("", n.path("outcomeDigest").asText(""));
        assertEquals("t:0:", ArccadeDigest.canonText(n.path("outcomeDigest").asText()));

        // has() still distinguishes "present and null" from "absent", because
        // the reader must not lose that distinction on the way in.
        assertTrue(n.has("outcomeDigest"));
        assertFalse(n.has("nope"));
        assertTrue(n.path("nope").isMissing());
    }

    @Test
    @DisplayName("a number keeps the characters the document actually contained")
    void numbersKeepTheirSourceLexeme() {
        // The ledger writes amounts as strings, but a tree that ever carried one
        // as a number must not be re-rendered through a double on the way to
        // BigDecimal: 0.1 + trailing zeros is exactly the precision loss
        // amountUnits refuses.
        Json n = Json.parse("{\"a\":100.0000000000,\"b\":1e3,\"c\":-0.00000000005}");
        assertEquals("100.0000000000", n.path("a").asText());
        assertEquals("1e3", n.path("b").asText());
        assertEquals("-0.00000000005", n.path("c").asText());
        assertEquals(1_000_000_000_000L,
                ArccadeDigest.amountUnits(new BigDecimal(n.path("a").asText())));
    }

    @Test
    @DisplayName("navigation off the tree yields MISSING, not a NullPointerException")
    void navigationOffTheTreeIsTotal() {
        Json n = Json.parse("{\"events\":[{\"CreatedEvent\":{\"contractId\":\"abc\"}}]}");
        assertEquals("abc", n.path("events").path(0).path("CreatedEvent").path("contractId").asText());
        assertTrue(n.path("nope").path("deeper").path(7).isMissing());
        assertEquals("", n.path("nope").path("deeper").asText());
        assertEquals("fallback", n.path("nope").asText("fallback"));
        // Iterating a non-array iterates nothing rather than throwing.
        for (Json ignored : n.path("nope")) {
            throw new AssertionError("MISSING must not yield elements");
        }
    }

    @Test
    @DisplayName("objects keep field order and arrays keep element order")
    void orderIsPreserved() {
        Json n = Json.parse("{\"z\":1,\"a\":2,\"m\":3}");
        assertEquals(List.of("z", "a", "m"), n.names());
        Json a = Json.parse("[\"x\",\"y\",\"z\"]");
        assertEquals(3, a.size());
        assertEquals("y", a.path(1).asText());
    }

    @Test
    @DisplayName("an astral character survives as a surrogate pair, escaped or literal")
    void astralCharactersSurvive() {
        // U+1F3AE VIDEO GAME. If the reader dropped or mangled a surrogate pair,
        // codePointLength would disagree with Daml and the document would differ.
        Json escaped = Json.parse("{\"tier\":\"\\ud83c\\udfae\"}");
        Json literal = Json.parse("{\"tier\":\"🎮\"}");
        assertEquals(literal.path("tier").asText(), escaped.path("tier").asText());
        assertEquals(1, ArccadeDigest.codePointLength(escaped.path("tier").asText()));
        assertEquals(2, escaped.path("tier").asText().length());
    }

    @Test
    @DisplayName("duplicate object keys are refused, not silently last-one-wins")
    void duplicateKeysAreRefused() {
        // Two values for one key means the document has no single reading.
        // Jackson keeps the last; two implementations that pick differently
        // would build two different rows from the same bytes.
        Json.JsonException e = assertThrows(Json.JsonException.class,
                () -> Json.parse("{\"cycleId\":\"a\",\"cycleId\":\"b\"}"));
        assertTrue(e.getMessage().contains("duplicate object key"), e.getMessage());
    }

    @Test
    @DisplayName("malformed input is refused rather than half-read")
    void malformedInputIsRefused() {
        assertThrows(Json.JsonException.class, () -> Json.parse("{\"a\":1,}"));       // trailing comma
        assertThrows(Json.JsonException.class, () -> Json.parse("[1,2,]"));           // trailing comma
        assertThrows(Json.JsonException.class, () -> Json.parse("{'a':1}"));          // single quotes
        assertThrows(Json.JsonException.class, () -> Json.parse("{\"a\":01}"));       // leading zero
        assertThrows(Json.JsonException.class, () -> Json.parse("{\"a\":.5}"));       // bare fraction
        assertThrows(Json.JsonException.class, () -> Json.parse("{\"a\":1.}"));       // dangling point
        assertThrows(Json.JsonException.class, () -> Json.parse("{\"a\":NaN}"));      // not JSON
        assertThrows(Json.JsonException.class, () -> Json.parse("{\"a\":1} garbage"));// trailing content
        assertThrows(Json.JsonException.class, () -> Json.parse("{\"a\":\"x"));       // unterminated
        assertThrows(Json.JsonException.class, () -> Json.parse("{\"a\":\"\t\"}"));   // raw control char
        assertThrows(Json.JsonException.class, () -> Json.parse(""));                 // empty
        assertThrows(Json.JsonException.class, () -> Json.parse(null));               // no input
    }

    @Test
    @DisplayName("nesting past the limit is refused instead of overflowing the stack")
    void deepNestingIsRefused() {
        // A recursive-descent parser handed a hostile document must fail with a
        // message, not with a StackOverflowError somewhere up the call chain.
        String deep = "[".repeat(Json.MAX_DEPTH + 5) + "]".repeat(Json.MAX_DEPTH + 5);
        assertThrows(Json.JsonException.class, () -> Json.parse(deep));

        String fine = "[".repeat(50) + "]".repeat(50);
        assertEquals(1, Json.parse(fine).size());
    }

    @Test
    @DisplayName("a built object writes its fields in insertion order")
    void builtObjectsKeepInsertionOrder() {
        // Not sorted order: a payload diff should read like the code that
        // produced it, and the ledger parses JSON without caring about order.
        Json built = Json.object()
                .put("z", "1")
                .put("a", Json.array(List.of(Json.string("x"), Json.nul())))
                .put("ok", Json.bool(true))
                .build();
        assertEquals("{\"z\":\"1\",\"a\":[\"x\",null],\"ok\":true}", built.toJson());
    }

    @Test
    @DisplayName("a null value is written as JSON null, never as the text \"null\"")
    void nullsAreWrittenAsNull() {
        // The same distinction the reader makes: the four-character string
        // "null" must not be able to stand in for an absent value.
        assertEquals("{\"a\":null}", Json.object().put("a", (String) null).build().toJson());
    }

    @Test
    @DisplayName("a number is built from its lexeme, never from a double")
    void numbersAreBuiltFromTheirLexeme() {
        // Nothing in this SDK writes a JSON number, and the method exists so
        // that a caller who must cannot be pushed into a double: the lexeme
        // survives, trailing zeros and all.
        assertEquals("100.0000000000", Json.number("100.0000000000").asText());
        assertThrows(Json.JsonException.class, () -> Json.number("1.0e"));
        assertThrows(Json.JsonException.class, () -> Json.number("\"1\""));
    }

    @Test
    @DisplayName("a duplicate field is refused by the builder, as it is by the parser")
    void builderRefusesDuplicateFields() {
        assertThrows(Json.JsonException.class,
                () -> Json.object().put("a", "1").put("a", "2"));
    }

    @Test
    @DisplayName("a document survives a parse-write round trip, numbers as their source lexeme")
    void roundTripKeepsTheLexeme() {
        // A double round trip is exactly the precision loss amountUnits exists
        // to refuse, so a number must come back out as it went in.
        String source = "{\"a\":100.0000000000,\"b\":[1,2],\"c\":\"x\"}";
        assertEquals(source, Json.parse(source).toJson());
    }

    @Test
    @DisplayName("writing escapes what JSON requires, and control characters besides")
    void writingEscapes() {
        String written = Json.string("a\"b\\c\nd\u0001e🎮").toJson();
        assertEquals("\"a\\\"b\\\\c\\nd\\u0001e🎮\"", written);
        // And it parses back to what it started as.
        assertEquals("a\"b\\c\nd\u0001e🎮", Json.parse(written).asText());
    }

    @Test
    @DisplayName("escapes decode to the characters they name")
    void escapesDecode() {
        Json n = Json.parse("{\"s\":\"a\\\"b\\\\c\\/d\\be\\ff\\ng\\rh\\ti\\u0041\"}");
        assertEquals("a\"b\\c/d\be\ff\ng\rh\tiA", n.path("s").asText());
    }
}
