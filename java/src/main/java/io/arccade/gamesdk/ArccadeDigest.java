package io.arccade.gamesdk;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Commitment scheme {@code arccade-sdk-digest-v1/sha256}, Java side.
 *
 * <p>A payload becomes a canonical text document; the commitment is that text's
 * sha256. Nothing structural is hashed, so a third party verifies by running
 * plain {@code sha256sum} over the bytes we publish — no library, no traversal.
 *
 * <p>This is the fourth implementation. Daml ({@code Digest.daml}), JavaScript
 * ({@code js/src/digest.js}) and Python ({@code tools/digest_reference.py})
 * must all agree with it byte for byte, and {@code ArccadeDigestTest} pins that
 * against the same golden vectors the Daml suite asserts. A divergence here is
 * not a formatting difference: it makes a stake unsettleable, because
 * {@code GameStake_Settle} recomputes the digest on-ledger and rejects a
 * mismatch.
 *
 * <h2>Two traps this class exists to avoid</h2>
 *
 * <ol>
 *   <li><b>Length is in Unicode code points.</b> {@code String.length()} counts
 *       UTF-16 units, so any character outside the BMP — an emoji in a player's
 *       tier name is enough — would silently produce a different document than
 *       Daml and Python. {@link #codePointLength} is used everywhere.</li>
 *   <li><b>Amounts are never hashed as formatted decimals.</b> Decimal
 *       rendering is not a canonical form that another language happens to
 *       match. Amounts convert to integer 1e-10 units, rounding DOWN (toward
 *       zero) so negatives agree with Daml's {@code truncate} and JS
 *       {@code BigInt}.</li>
 * </ol>
 *
 * <p>Published from the arccade-game-sdk repository as
 * {@code io.arccade:game-sdk}, so a third party integrating from the JVM gets
 * the same implementation the backend runs. It was relocated here out of
 * arccade-wallet-backend, where it had no business deciding a wire format that
 * four implementations have to agree on.
 */
public final class ArccadeDigest {

    /** Scheme identity; the first component of every document. */
    public static final String SCHEME_PREFIX = "arccade-sdk-digest-v1";

    /** Algorithm identifier recorded alongside a stake on the ledger. */
    public static final String DIGEST_ALG_ID = "arccade-sdk-digest-v1/sha256";

    /** 1e-10 units per whole unit; the scale every amount converts through. */
    private static final BigDecimal UNITS_SCALE = BigDecimal.TEN.pow(10);

    /**
     * The decimal spelling an amount is allowed to arrive in.
     *
     * <p>A trailing dot is allowed because {@code "1."} is a whole number with
     * an empty fraction and every implementation reads it that way; a LEADING
     * dot is not, because {@code ".5"} and {@code "0.5"} would be two spellings
     * of one value and the encoding has to be injective.
     */
    private static final Pattern DECIMAL_GRAMMAR = Pattern.compile("-?\\d+(?:\\.\\d*)?");

    private ArccadeDigest() {
    }

    /**
     * Ascending Unicode CODE POINT order.
     *
     * <p>{@link String#compareTo} is UTF-16 code-UNIT order, and the two
     * disagree for exactly one class of input: an astral character, whose lead
     * surrogate (U+D800..U+DBFF) sorts below U+E000..U+FFFF as a code unit and
     * above it as a code point. A player id with an emoji is enough to hit it.
     *
     * <p>That matters wherever an ordering decides bytes rather than
     * presentation — the report order a Merkle root is built over, above all.
     * Two honest implementations sorting the same cycles differently publish
     * different roots, and neither can prove the other wrong.
     */
    public static final Comparator<String> CODE_POINT_ORDER = ArccadeDigest::compareByCodePoint;

    /** See {@link #CODE_POINT_ORDER}. */
    public static int compareByCodePoint(String a, String b) {
        int i = 0;
        int j = 0;
        while (i < a.length() && j < b.length()) {
            int ca = a.codePointAt(i);
            int cb = b.codePointAt(j);
            if (ca != cb) {
                return Integer.compare(ca, cb);
            }
            i += Character.charCount(ca);
            j += Character.charCount(cb);
        }
        return Integer.compare(a.length() - i, b.length() - j);
    }

    /** Length in Unicode code points — NOT {@code String.length()}. */
    public static int codePointLength(String s) {
        return s.codePointCount(0, s.length());
    }

    /**
     * The general encoding: {@code <tag>:<length>:<value>}.
     *
     * <p>The length prefix makes the encoding injective — content cannot
     * impersonate a separator.
     */
    public static String canon(String tag, String value) {
        return tag + ":" + codePointLength(value) + ":" + value;
    }

    public static String canonText(String s) {
        return canon("t", s);
    }

    public static String canonInt(long i) {
        return canon("i", Long.toString(i));
    }

    /**
     * The wide overload, for an integer that does not fit in an int64.
     *
     * <p>Daml's {@code Int} is 64-bit, so a document written from a wider value
     * is one the ledger cannot reproduce and no commitment should be built on
     * it. It exists anyway because the encoding is defined over the DECIMAL
     * RENDERING of an integer and JavaScript's {@code BigInt} reaches values
     * this method would otherwise have no answer for: without it a Java
     * consumer holding an oversized number gets no document at all and cannot
     * tell whether the two clients disagree. Checking the band is the caller's
     * job and {@link #amountUnits} is where it is enforced for amounts.
     */
    public static String canonInt(BigInteger i) {
        return canon("i", i.toString());
    }

    public static String canonBool(boolean b) {
        return canon("b", b ? "true" : "false");
    }

    /** Amount as integer 1e-10 units. See {@link #amountUnits}. */
    public static String canonDecimal(BigDecimal d) {
        return canon("d", Long.toString(amountUnits(d)));
    }

    /** Amount from the ledger's own spelling. See {@link #amountUnits(String)}. */
    public static String canonDecimal(String amount) {
        return canon("d", Long.toString(amountUnits(amount)));
    }

    /** Refuses, always. See {@link #amountUnits(double)}. */
    public static String canonDecimal(double amount) {
        return canon("d", Long.toString(amountUnits(amount)));
    }

    /** Time is always integer microseconds since the epoch, never ISO text. */
    public static String canonTimeMicros(long micros) {
        return canon("m", Long.toString(micros));
    }

    public static String canonTime(Instant t) {
        long micros = Math.multiplyExact(t.getEpochSecond(), 1_000_000L) + t.getNano() / 1_000L;
        return canonTimeMicros(micros);
    }

    /** Full party identifier, namespace fingerprint included. */
    public static String canonParty(String partyId) {
        return canon("p", partyId);
    }

    public static <T> String canonOptional(Function<T, String> f, T value) {
        return canon("o", value == null ? "" : f.apply(value));
    }

    /**
     * List: the element count is encoded too, elements joined with {@code |}.
     * Elements must already be canonical.
     */
    public static String canonList(List<String> items) {
        return canon("l", items.size() + ":" + String.join("|", items));
    }

    /**
     * Record: fields sorted BY NAME, each rendered {@code k:...:name=value;}.
     *
     * <p>Sorting is why field order is not part of the document: a field added
     * in a later version cannot silently change a v1 digest.
     */
    public static String canonFields(List<Map.Entry<String, String>> fields) {
        List<Map.Entry<String, String>> sorted = new ArrayList<>(fields);
        sorted.sort(Comparator.comparing(Map.Entry::getKey));
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : sorted) {
            assertFieldName(e.getKey());
            sb.append(canon("k", e.getKey())).append("=").append(e.getValue()).append(";");
        }
        return canon("r", sb.toString());
    }

    /**
     * Field names are ASCII {@code [a-zA-Z0-9-]} so that sorting cannot differ
     * between languages' collation rules.
     */
    public static void assertFieldName(String name) {
        if (name.isEmpty()) {
            throw new IllegalArgumentException(SCHEME_PREFIX + ": empty field name");
        }
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '-';
            if (!ok) {
                throw new IllegalArgumentException(
                        SCHEME_PREFIX + ": field name must be ASCII [a-zA-Z0-9-]: " + name);
            }
        }
    }

    /** Full document: scheme prefix, schema name, schema version, sorted fields. */
    public static String canonDocument(String schema, int version,
                                       List<Map.Entry<String, String>> fields) {
        return SCHEME_PREFIX + "|" + canonText(schema) + canonInt(version) + canonFields(fields);
    }

    /**
     * sha256 of the document's raw UTF-8 bytes, lowercase hex.
     *
     * <p>Deliberately the bytes as published: {@code sha256sum} over the file
     * gives the same value, with no dependency on this class or on Daml.
     *
     * <p>The empty string is REFUSED rather than digested. Daml reaches sha256
     * through {@code toHex}, whose result for an empty string is a runtime
     * error, so {@code e3b0c442...} is a value the ledger can never compute:
     * returning it would hand a caller a commitment no {@code GameStake_Settle}
     * could ever match, and the mistake would surface at settlement rather than
     * here.
     */
    public static String textDigest(String text) {
        if (text.isEmpty()) {
            throw new IllegalArgumentException(
                    SCHEME_PREFIX + ": refusing to digest the empty string; Daml's toHex \"\" is a "
                            + "runtime error, so no ledger value can equal this digest");
        }
        try {
            byte[] out = MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(out.length * 2);
            for (byte b : out) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    public static String documentDigest(String schema, int version,
                                        List<Map.Entry<String, String>> fields) {
        return textDigest(canonDocument(schema, version, fields));
    }

    /**
     * Amount to integer 1e-10 units, with a round-trip guard.
     *
     * <p>Throws rather than silently losing precision or overflowing. The
     * representable band is +/-922337203.6854775807 — a CC stake is far inside
     * it. Rounding is DOWN (toward zero), matching Daml's {@code truncate}.
     */
    public static long amountUnits(BigDecimal d) {
        if (d == null) {
            throw new IllegalArgumentException(SCHEME_PREFIX + ": an amount cannot be null");
        }
        // toPlainString never renders an exponent, so the grammar below sees the
        // same shape whichever overload a caller reached. A BigDecimal built
        // from "1e3" has already been through BigDecimal's laxer grammar by the
        // time it arrives; only the string overload can refuse that.
        return amountUnits(d.toPlainString());
    }

    /**
     * The overload a ledger payload should use: amounts arrive as TEXT.
     *
     * <p>The grammar is deliberately narrower than {@code new BigDecimal(String)}
     * and matches the other three implementations exactly:
     * {@code -?digits(.digits*)?} — no leading {@code +}, no bare {@code .5},
     * no exponent, no surrounding whitespace. Every one of those is something
     * {@code BigDecimal} accepts and Daml does not, so a Java consumer who
     * converted first would have committed to a value the ledger reads
     * differently, or refuses.
     */
    public static long amountUnits(String amount) {
        if (amount == null) {
            throw new IllegalArgumentException(SCHEME_PREFIX + ": an amount cannot be null");
        }
        if (!DECIMAL_GRAMMAR.matcher(amount).matches()) {
            // NumberFormatException rather than IllegalArgumentException: the
            // refusal is about the SPELLING, and the reject map has to be able
            // to tell that apart from a value that was spelled fine and did not
            // fit.
            throw new NumberFormatException(
                    SCHEME_PREFIX + ": not a decimal amount: \"" + amount + "\"");
        }
        BigDecimal d = new BigDecimal(amount);
        BigDecimal scaled = d.multiply(UNITS_SCALE);
        long units = scaled.setScale(0, RoundingMode.DOWN).longValueExact();
        BigDecimal back = BigDecimal.valueOf(units).divide(UNITS_SCALE);
        if (back.compareTo(d) != 0) {
            throw new IllegalArgumentException(
                    SCHEME_PREFIX + ": amount not representable in 1e-10 units without loss: " + d);
        }
        return units;
    }

    /**
     * Refuses, always: a binary float is not an amount.
     *
     * <p>{@code 1.5} is exact in binary and {@code 0.1} is not, so a double
     * argument would succeed or lose precision depending on the literal, and
     * two languages rendering the same double disagree about the digits. The
     * overload exists so the refusal happens HERE with a reason, instead of the
     * caller silently reaching {@code amountUnits(BigDecimal.valueOf(d))} and
     * getting an answer.
     */
    public static long amountUnits(double amount) {
        throw new IllegalArgumentException(
                SCHEME_PREFIX + ": a native double cannot be an amount (" + amount
                        + "); pass the decimal as text");
    }

    /** Convenience for building the field lists the canon* methods take. */
    public static Map.Entry<String, String> f(String name, String canonicalValue) {
        return Map.entry(name, canonicalValue);
    }
}
