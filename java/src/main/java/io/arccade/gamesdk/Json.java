package io.arccade.gamesdk;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A strict JSON value — the reason this artifact has no dependencies.
 *
 * <h2>Why this exists instead of {@code jackson-databind}</h2>
 *
 * <p>Two classes here touch JSON. {@link CycleAuditReader} READS a ledger
 * transaction tree through six operations — {@code path}, {@code has},
 * {@code get}, {@code asText}, {@code size} and iterating an array. The command
 * builders in {@link CycleCommands}, {@link TradeCommands} and
 * {@link TransferCommands} WRITE the JSON Ledger API payload a consumer
 * submits. Both surfaces together are smaller than the surface of the
 * dependency that would provide them.
 *
 * <p>The writer lives here rather than in a second class because one JSON type
 * that reads and writes is easier to audit than two that each do half: a
 * builder's output can be parsed back and compared with a reader's, which is
 * exactly what the conformance runner does.
 *
 * <p>Against that, a Jackson dependency costs every consumer three things:
 *
 * <ol>
 *   <li><b>A version conflict they did not ask for.</b> Jackson is the single
 *       most commonly pre-pinned artifact on the JVM — Spring Boot, Quarkus and
 *       Micronaut all manage its version. An SDK that drags in its own copy
 *       forces every integrator into a dependency-convergence argument whose
 *       only purpose is reading six fields out of a transaction tree.</li>
 *   <li><b>An audit surface far larger than the SDK's.</b> This repository's
 *       posture is that its claims can be checked by reading it. Roughly three
 *       hundred lines of parser can be read in an afternoon; jackson-databind
 *       is over a hundred thousand and has a CVE history driven by features
 *       (polymorphic deserialization) that this SDK will never use.</li>
 *   <li><b>A reason to skip the SDK entirely.</b> A JVM auditor who wants to
 *       verify one anchor should be able to drop one jar on the classpath. The
 *       moment verification needs a dependency tree, "an auditor can verify
 *       this in whatever language they already have" starts to shade into
 *       "an auditor can verify this if their build tool cooperates".</li>
 * </ol>
 *
 * <p>The cost of the decision, stated plainly: a consumer who already holds a
 * Jackson {@code JsonNode} cannot hand it to {@link CycleAuditReader} directly.
 * They serialize it and call {@link #parse}. That is one line at the boundary,
 * paid by the callers who already have Jackson, rather than a transitive
 * dependency paid by all of them.
 *
 * <h2>Two deliberate differences from Jackson</h2>
 *
 * <p>Both are stricter, and both are pinned in {@code JsonTest}:
 *
 * <ol>
 *   <li><b>A JSON {@code null} reads as the empty string, not {@code "null"}.</b>
 *       Jackson's {@code NullNode.asText()} returns the four-character string
 *       {@code "null"}, which would flow into a canonical document as a value
 *       and hash as though the ledger had said it. An absent value and the
 *       literal text "null" must not be the same thing in a commitment scheme.</li>
 *   <li><b>A number keeps its source lexeme.</b> {@link #asText()} on a number
 *       returns the characters that were in the document, so
 *       {@code new BigDecimal(node.asText())} sees exactly what the ledger
 *       wrote. Jackson would have chosen {@code int}, {@code long} or
 *       {@code double} by value first, and a {@code double} round trip is
 *       precisely the precision loss {@link ArccadeDigest#amountUnits} exists
 *       to refuse.</li>
 * </ol>
 *
 * <p>Duplicate object keys are rejected rather than last-one-wins: two values
 * for one key means the document does not have a single reading, and silently
 * picking one is how two implementations disagree about what they were sent.
 */
public final class Json implements Iterable<Json> {

    /** What a node is. {@link #MISSING} is the result of navigating off the tree. */
    public enum Kind { OBJECT, ARRAY, STRING, NUMBER, BOOLEAN, NULL, MISSING }

    /** Nesting limit. Hostile input must not turn into a StackOverflowError. */
    public static final int MAX_DEPTH = 512;

    private static final Json MISSING_NODE = new Json(Kind.MISSING, "", null, null);
    private static final Json NULL_NODE = new Json(Kind.NULL, "", null, null);
    private static final Json TRUE_NODE = new Json(Kind.BOOLEAN, "true", null, null);
    private static final Json FALSE_NODE = new Json(Kind.BOOLEAN, "false", null, null);

    private final Kind kind;
    private final String text;
    private final Map<String, Json> members;
    private final List<Json> elements;

    private Json(Kind kind, String text, Map<String, Json> members, List<Json> elements) {
        this.kind = kind;
        this.text = text;
        this.members = members;
        this.elements = elements;
    }

    /** Thrown for any input that is not a single well-formed JSON document. */
    public static final class JsonException extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;

        public JsonException(String message) {
            super("arccade-game-sdk json: " + message);
        }
    }

    /** Parses one complete JSON document. Trailing content is an error. */
    public static Json parse(String source) {
        if (source == null) {
            throw new JsonException("no input");
        }
        Parser p = new Parser(source);
        p.skipWhitespace();
        Json value = p.parseValue(0);
        p.skipWhitespace();
        if (!p.atEnd()) {
            throw new JsonException("trailing content after the document at offset " + p.pos);
        }
        return value;
    }

    /** The node navigated off the end of the tree. Never null. */
    public static Json missing() {
        return MISSING_NODE;
    }

    public Kind kind() {
        return kind;
    }

    public boolean isMissing() {
        return kind == Kind.MISSING;
    }

    public boolean isNull() {
        return kind == Kind.NULL;
    }

    public boolean isObject() {
        return kind == Kind.OBJECT;
    }

    public boolean isArray() {
        return kind == Kind.ARRAY;
    }

    public boolean isString() {
        return kind == Kind.STRING;
    }

    public boolean isNumber() {
        return kind == Kind.NUMBER;
    }

    public boolean isBoolean() {
        return kind == Kind.BOOLEAN;
    }

    /**
     * Field of an object, or {@link #missing()} — never null, so navigation
     * chains do not need a null check at every step.
     */
    public Json path(String field) {
        if (kind != Kind.OBJECT) {
            return MISSING_NODE;
        }
        Json v = members.get(field);
        return v == null ? MISSING_NODE : v;
    }

    /** Element of an array, or {@link #missing()}. */
    public Json path(int index) {
        if (kind != Kind.ARRAY || index < 0 || index >= elements.size()) {
            return MISSING_NODE;
        }
        return elements.get(index);
    }

    /** Whether an object carries this field, including a field whose value is null. */
    public boolean has(String field) {
        return kind == Kind.OBJECT && members.containsKey(field);
    }

    /** Field of an object, or null when absent. Prefer {@link #path(String)}. */
    public Json get(String field) {
        return kind == Kind.OBJECT ? members.get(field) : null;
    }

    /** Element of an array, or null when out of range. Prefer {@link #path(int)}. */
    public Json get(int index) {
        if (kind != Kind.ARRAY || index < 0 || index >= elements.size()) {
            return null;
        }
        return elements.get(index);
    }

    /** Field names in document order. Empty for anything that is not an object. */
    public List<String> names() {
        return kind == Kind.OBJECT ? List.copyOf(members.keySet()) : List.of();
    }

    /** Elements in order. Empty for anything that is not an array. */
    public List<Json> elements() {
        return kind == Kind.ARRAY ? elements : List.of();
    }

    /** Element count of an array, field count of an object, otherwise 0. */
    public int size() {
        if (kind == Kind.ARRAY) {
            return elements.size();
        }
        if (kind == Kind.OBJECT) {
            return members.size();
        }
        return 0;
    }

    /** Iterates an array's elements; iterates nothing for any other kind. */
    @Override
    public Iterator<Json> iterator() {
        return kind == Kind.ARRAY ? elements.iterator() : Collections.emptyIterator();
    }

    /**
     * Scalar as text: a string's value, a number's SOURCE LEXEME, "true" or
     * "false". Objects, arrays, null and missing all read as "" — see the class
     * notes on why a JSON null must not read as {@code "null"}.
     */
    public String asText() {
        return switch (kind) {
            case STRING, NUMBER, BOOLEAN -> text;
            default -> "";
        };
    }

    /** {@link #asText()}, but with a fallback for a non-scalar node. */
    public String asText(String fallback) {
        return switch (kind) {
            case STRING, NUMBER, BOOLEAN -> text;
            default -> fallback;
        };
    }

    @Override
    public String toString() {
        return kind + (kind == Kind.OBJECT || kind == Kind.ARRAY ? "(" + size() + ")" : ":" + text);
    }

    // ------------------------------------------------------------ building

    /**
     * A JSON string. Construction is separate from parsing so a builder cannot
     * accidentally emit a value that was never escaped.
     */
    public static Json string(String value) {
        if (value == null) {
            throw new JsonException("a JSON string cannot be null; use nul()");
        }
        return new Json(Kind.STRING, value, null, null);
    }

    /** JSON {@code null}. Named {@code nul} because {@code null} is a keyword. */
    public static Json nul() {
        return NULL_NODE;
    }

    public static Json bool(boolean value) {
        return value ? TRUE_NODE : FALSE_NODE;
    }

    /**
     * A JSON number from its LEXEME, not from a Java numeric type.
     *
     * <p>The ledger's decimals travel as strings for the same reason
     * {@link #asText()} hands a number's source lexeme back: routing an amount
     * through {@code double} is the precision loss
     * {@link ArccadeDigest#amountUnits} exists to refuse. Nothing in this SDK
     * writes a JSON number today; the method exists so that a caller who must
     * cannot be pushed into a {@code double}.
     */
    public static Json number(String lexeme) {
        Json parsed = parse(lexeme);
        if (!parsed.isNumber()) {
            throw new JsonException("not a JSON number: " + lexeme);
        }
        return parsed;
    }

    public static Json array(List<Json> elements) {
        return new Json(Kind.ARRAY, "", null, List.copyOf(elements));
    }

    /** An empty object builder; fields keep the order they are put in. */
    public static ObjectBuilder object() {
        return new ObjectBuilder();
    }

    /**
     * Builds an object in insertion order.
     *
     * <p>Insertion order, not sorted order: the payload is compared against the
     * ledger's schema by a reader that does not care about order, and keeping
     * the order the builder wrote makes a payload diff read like the code that
     * produced it. A duplicate field is refused for the same reason the parser
     * refuses one.
     */
    public static final class ObjectBuilder {
        private final Map<String, Json> members = new LinkedHashMap<>();

        private ObjectBuilder() {
        }

        public ObjectBuilder put(String name, Json value) {
            if (name == null || value == null) {
                throw new JsonException("a field needs a name and a value: " + name);
            }
            if (members.putIfAbsent(name, value) != null) {
                throw new JsonException("duplicate field: " + name);
            }
            return this;
        }

        public ObjectBuilder put(String name, String value) {
            return put(name, value == null ? nul() : string(value));
        }

        public Json build() {
            return new Json(Kind.OBJECT, "", new LinkedHashMap<>(members), null);
        }
    }

    // ------------------------------------------------------- serialisation

    /**
     * The document as JSON text, with no insignificant whitespace.
     *
     * <p>A number is written back as the lexeme it arrived with, so a value
     * that made a round trip through this class is byte-identical to what the
     * ledger sent.
     */
    public String toJson() {
        StringBuilder sb = new StringBuilder();
        write(sb);
        return sb.toString();
    }

    private void write(StringBuilder sb) {
        switch (kind) {
            case STRING -> writeString(sb, text);
            case NUMBER, BOOLEAN -> sb.append(text);
            case NULL, MISSING -> sb.append("null");
            case ARRAY -> {
                sb.append('[');
                for (int i = 0; i < elements.size(); i++) {
                    if (i > 0) {
                        sb.append(',');
                    }
                    elements.get(i).write(sb);
                }
                sb.append(']');
            }
            case OBJECT -> {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<String, Json> e : members.entrySet()) {
                    if (!first) {
                        sb.append(',');
                    }
                    first = false;
                    writeString(sb, e.getKey());
                    sb.append(':');
                    e.getValue().write(sb);
                }
                sb.append('}');
            }
            default -> throw new JsonException("unwritable node: " + kind);
        }
    }

    /**
     * Escapes exactly what JSON requires, and every control character.
     *
     * <p>Astral characters are written as themselves rather than as an escaped
     * surrogate pair: the payload is UTF-8 on the wire, and an escape pair would
     * be a second spelling of the same string for anything that hashes the
     * bytes.
     */
    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }

    private static final class Parser {
        private final String s;
        private int pos;

        Parser(String s) {
            this.s = s;
        }

        boolean atEnd() {
            return pos >= s.length();
        }

        void skipWhitespace() {
            while (pos < s.length()) {
                char c = s.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    pos++;
                } else {
                    return;
                }
            }
        }

        private char peek() {
            if (pos >= s.length()) {
                throw new JsonException("unexpected end of input");
            }
            return s.charAt(pos);
        }

        private void expect(char c) {
            if (pos >= s.length() || s.charAt(pos) != c) {
                throw new JsonException("expected '" + c + "' at offset " + pos);
            }
            pos++;
        }

        Json parseValue(int depth) {
            if (depth > MAX_DEPTH) {
                throw new JsonException("nesting deeper than " + MAX_DEPTH);
            }
            char c = peek();
            return switch (c) {
                case '{' -> parseObject(depth);
                case '[' -> parseArray(depth);
                case '"' -> new Json(Kind.STRING, parseString(), null, null);
                case 't' -> literal("true", TRUE_NODE);
                case 'f' -> literal("false", FALSE_NODE);
                case 'n' -> literal("null", NULL_NODE);
                default -> parseNumber();
            };
        }

        private Json literal(String word, Json node) {
            if (!s.startsWith(word, pos)) {
                throw new JsonException("expected " + word + " at offset " + pos);
            }
            pos += word.length();
            return node;
        }

        private Json parseObject(int depth) {
            expect('{');
            Map<String, Json> members = new LinkedHashMap<>();
            skipWhitespace();
            if (peek() == '}') {
                pos++;
                return new Json(Kind.OBJECT, "", members, null);
            }
            while (true) {
                skipWhitespace();
                String name = parseString();
                skipWhitespace();
                expect(':');
                skipWhitespace();
                Json value = parseValue(depth + 1);
                if (members.putIfAbsent(name, value) != null) {
                    throw new JsonException("duplicate object key \"" + name + "\" at offset " + pos);
                }
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                } else if (c == '}') {
                    pos++;
                    return new Json(Kind.OBJECT, "", members, null);
                } else {
                    throw new JsonException("expected ',' or '}' at offset " + pos);
                }
            }
        }

        private Json parseArray(int depth) {
            expect('[');
            List<Json> items = new ArrayList<>();
            skipWhitespace();
            if (peek() == ']') {
                pos++;
                return new Json(Kind.ARRAY, "", null, items);
            }
            while (true) {
                skipWhitespace();
                items.add(parseValue(depth + 1));
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                } else if (c == ']') {
                    pos++;
                    return new Json(Kind.ARRAY, "", null, items);
                } else {
                    throw new JsonException("expected ',' or ']' at offset " + pos);
                }
            }
        }

        private String parseString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (pos >= s.length()) {
                    throw new JsonException("unterminated string");
                }
                char c = s.charAt(pos++);
                if (c == '"') {
                    return sb.toString();
                }
                if (c == '\\') {
                    if (pos >= s.length()) {
                        throw new JsonException("unterminated escape");
                    }
                    char e = s.charAt(pos++);
                    switch (e) {
                        case '"' -> sb.append('"');
                        case '\\' -> sb.append('\\');
                        case '/' -> sb.append('/');
                        case 'b' -> sb.append('\b');
                        case 'f' -> sb.append('\f');
                        case 'n' -> sb.append('\n');
                        case 'r' -> sb.append('\r');
                        case 't' -> sb.append('\t');
                        case 'u' -> sb.append(parseHex4());
                        default -> throw new JsonException("invalid escape \\" + e + " at offset " + (pos - 1));
                    }
                } else if (c < 0x20) {
                    throw new JsonException("unescaped control character U+"
                            + String.format("%04X", (int) c) + " at offset " + (pos - 1));
                } else {
                    sb.append(c);
                }
            }
        }

        // A four-hex-digit escape yields exactly one UTF-16 unit, so a surrogate
        // PAIR arrives as two escapes and reassembles naturally in the
        // StringBuilder. That is why an astral character survives this parser
        // intact -- and why codePointLength, not String.length, is what the
        // digest scheme counts once the value gets there.
        // (Written this way because javac decodes a backslash-u sequence even
        // inside a comment, which makes the obvious phrasing a compile error.)
        private char parseHex4() {
            if (pos + 4 > s.length()) {
                throw new JsonException("truncated \\u escape at offset " + pos);
            }
            int value = 0;
            for (int i = 0; i < 4; i++) {
                int d = Character.digit(s.charAt(pos + i), 16);
                if (d < 0) {
                    throw new JsonException("invalid \\u escape at offset " + pos);
                }
                value = value * 16 + d;
            }
            pos += 4;
            return (char) value;
        }

        // The lexeme is kept verbatim: see the class notes on why this class
        // never turns a number into a double.
        private Json parseNumber() {
            int start = pos;
            if (pos < s.length() && s.charAt(pos) == '-') {
                pos++;
            }
            int intStart = pos;
            while (pos < s.length() && isDigit(s.charAt(pos))) {
                pos++;
            }
            int intDigits = pos - intStart;
            if (intDigits == 0) {
                throw new JsonException("not a JSON value at offset " + start);
            }
            if (intDigits > 1 && s.charAt(intStart) == '0') {
                throw new JsonException("leading zero at offset " + intStart);
            }
            if (pos < s.length() && s.charAt(pos) == '.') {
                pos++;
                int fracStart = pos;
                while (pos < s.length() && isDigit(s.charAt(pos))) {
                    pos++;
                }
                if (pos == fracStart) {
                    throw new JsonException("no digits after the decimal point at offset " + pos);
                }
            }
            if (pos < s.length() && (s.charAt(pos) == 'e' || s.charAt(pos) == 'E')) {
                pos++;
                if (pos < s.length() && (s.charAt(pos) == '+' || s.charAt(pos) == '-')) {
                    pos++;
                }
                int expStart = pos;
                while (pos < s.length() && isDigit(s.charAt(pos))) {
                    pos++;
                }
                if (pos == expStart) {
                    throw new JsonException("no digits in the exponent at offset " + pos);
                }
            }
            return new Json(Kind.NUMBER, s.substring(start, pos), null, null);
        }

        private static boolean isDigit(char c) {
            return c >= '0' && c <= '9';
        }
    }
}
