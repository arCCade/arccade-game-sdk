package io.arccade.gamesdk;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import static io.arccade.gamesdk.ArccadeDigest.canonDocument;
import static io.arccade.gamesdk.ArccadeDigest.canonInt;
import static io.arccade.gamesdk.ArccadeDigest.canonText;
import static io.arccade.gamesdk.ArccadeDigest.f;
import static io.arccade.gamesdk.ArccadeDigest.textDigest;

/**
 * The asset layer — two models, and where an item's attributes live.
 *
 * <h2>Two models, both needed</h2>
 *
 * <ul>
 *   <li><b>Fungible</b>, by type: "500 gold", "3 potions". Copies are
 *       interchangeable, cheap, and stack in a wallet.</li>
 *   <li><b>Unique</b>, by instance: "this sword, with its +9 roll". Every
 *       instance is its OWN instrument and the amount is always 1, which is
 *       what makes rarity and "this one is mine" possible.</li>
 * </ul>
 *
 * <h2>Where attributes live: NOT on the ledger</h2>
 *
 * <p>A sword's attack, artwork, description and in-game effect stay in the
 * application's own database. Writing them on-chain would break the SDK's
 * architectural rule — data that carries no value is not written to the ledger.
 *
 * <p>What IS bound on-chain is the DIGEST of the attribute document. The
 * consequences are the whole point: a buyer can verify the sword is +9 before
 * paying; the application cannot quietly drop it to +3 afterwards, because the
 * digest would not match; and a third-party marketplace can check both without
 * trusting the application's database. It is the same mechanism as every other
 * commitment here — nothing new is required.
 */
public final class Assets {

    public static final String FUNGIBLE = "fungible";
    public static final String UNIQUE = "unique";

    /** The mark separating a unique instance from its type. A wire constant. */
    public static final String INSTANCE_SEPARATOR = "#";

    public static final String ATTRIBUTE_SCHEMA = "arccade-asset-attributes";

    /** One whole unit, in the 1e-10 units every amount converts to. */
    private static final long ONE_IN_UNITS = 10_000_000_000L;

    private static final Pattern LOCAL_ID = Pattern.compile("[a-z0-9][a-z0-9._-]{0,94}[a-z0-9]");
    private static final Pattern INSTANCE_ID = Pattern.compile("[a-z0-9-]{4,64}");

    private Assets() {
    }

    /**
     * An asset id: 2 to 96 characters of {@code [a-z0-9._-]}, not starting or
     * ending with a separator.
     *
     * <p>Lowercase only, and no uppercase alias: {@code Gold} and {@code gold}
     * as two instruments in one registry is a phishing surface, and case-folding
     * them together would make the id's collation locale-dependent, which is the
     * mistake {@code canonFields} exists to avoid.
     */
    public static String assertValidLocalId(String localId) {
        if (localId == null || !LOCAL_ID.matcher(localId).matches()) {
            throw new IllegalArgumentException("invalid asset id (2-96 characters, [a-z0-9._-], "
                    + "cannot start or end with a hyphen or dot): " + localId);
        }
        return localId;
    }

    /** {@code <tenantId>/<localId>} — for example {@code mygame/health-potion}. */
    public static InstrumentId fungibleInstrument(String registryParty, String tenantId,
                                                  String localId) {
        Tenancy.assertValidTenantId(tenantId);
        assertValidLocalId(localId);
        return new InstrumentId(registryParty, tenantId + "/" + localId);
    }

    /**
     * {@code <tenantId>/<localId>#<instanceId>} — for example
     * {@code mygame/sword-of-dawn#4a91c8f2}.
     *
     * <p>{@code instanceId} must be STABLE for the same instance: the same item
     * has to keep its identifier across re-issues, or a wallet cannot tell a
     * re-mint of one sword from the minting of a second one.
     * {@link #deriveInstanceId} is one way to get that property for free.
     */
    public static InstrumentId uniqueInstrument(String registryParty, String tenantId,
                                                String localId, String instanceId) {
        Tenancy.assertValidTenantId(tenantId);
        assertValidLocalId(localId);
        if (instanceId == null || !INSTANCE_ID.matcher(instanceId).matches()) {
            throw new IllegalArgumentException(
                    "invalid instance id (4-64 characters, [a-z0-9-]): " + instanceId);
        }
        return new InstrumentId(registryParty,
                tenantId + "/" + localId + INSTANCE_SEPARATOR + instanceId);
    }

    /** An instrument id taken apart. Nulls where a component is absent. */
    public record ParsedAsset(String tenantId, String localId, String instanceId,
                              String assetClass) {
    }

    public static ParsedAsset parseAsset(InstrumentId instrumentId) {
        String raw = instrumentId.id();
        int slash = raw.indexOf('/');
        if (slash < 0) {
            // No namespace: an ecosystem-wide asset such as Canton Coin.
            return new ParsedAsset(null, raw, null, FUNGIBLE);
        }
        String tenantId = raw.substring(0, slash);
        String rest = raw.substring(slash + 1);
        int hash = rest.indexOf(INSTANCE_SEPARATOR);
        if (hash < 0) {
            return new ParsedAsset(tenantId, rest, null, FUNGIBLE);
        }
        return new ParsedAsset(tenantId, rest.substring(0, hash), rest.substring(hash + 1), UNIQUE);
    }

    public static boolean isUnique(InstrumentId instrumentId) {
        return UNIQUE.equals(parseAsset(instrumentId).assetClass());
    }

    /**
     * A unique asset's amount is ALWAYS 1.
     *
     * <p>Run on the trade and transfer paths. "3 of this sword" is meaningless,
     * and letting it through silently produces balances that look like double
     * spends to anyone reading the registry.
     */
    public static String assertAmountValidForAsset(InstrumentId instrumentId, String amount) {
        // Compared in units rather than as text: "1", "1.0" and "1.0000000000"
        // are one amount, and a caller reading any of the three off a ledger
        // payload must not get three different answers.
        long units = ArccadeDigest.amountUnits(amount);
        if (isUnique(instrumentId) && units != ONE_IN_UNITS) {
            throw new IllegalArgumentException("a unique asset's amount must be 1 ("
                    + amount + " given for " + instrumentId.id() + ")");
        }
        if (units <= 0) {
            throw new IllegalArgumentException("an asset amount must be positive: " + amount);
        }
        return amount;
    }

    /**
     * An attribute value: an integer or text, never a binary float.
     *
     * <p>A decimal attribute is passed as TEXT. Routing it through a float would
     * make the document depend on how each language renders a double, and the
     * whole value of the digest is that four implementations produce the same
     * bytes. This type exists so the refusal happens where the attribute is
     * built, with the attribute's name in the message.
     */
    public static final class Attribute {
        private final String name;
        private final String canonicalValue;

        private Attribute(String name, String canonicalValue) {
            this.name = name;
            this.canonicalValue = canonicalValue;
        }

        public static Attribute ofInt(String name, long value) {
            return new Attribute(name, canonInt(value));
        }

        public static Attribute ofText(String name, String value) {
            return new Attribute(name, canonText(value));
        }

        /**
         * From a value whose type is only known at runtime — a JSON attribute
         * map, most often. {@code Long}, {@code Integer} and {@code String} are
         * accepted; everything else, a {@code Double} above all, is refused.
         */
        public static Attribute of(String name, Object value) {
            if (value instanceof Long || value instanceof Integer || value instanceof Short
                    || value instanceof Byte) {
                return ofInt(name, ((Number) value).longValue());
            }
            if (value instanceof String s) {
                return ofText(name, s);
            }
            throw new IllegalArgumentException("an attribute value must be an integer or text ("
                    + name + ": " + (value == null ? "null" : value.getClass().getSimpleName())
                    + ") — pass a decimal as text");
        }

        public String name() {
            return name;
        }

        public String canonicalValue() {
            return canonicalValue;
        }
    }

    /**
     * The asset's CANONICAL ATTRIBUTE DOCUMENT.
     *
     * <p>The application chooses which attributes it wants to be bound by;
     * presentation data — artwork, localised description — may be included but
     * does not have to be. What goes in is what the application is declaring
     * immutable.
     */
    public static String assetAttributeDocument(InstrumentId instrumentId,
                                                List<Attribute> attributes, int schemaVersion) {
        return attributeDocument(instrumentId.id(), attributes, schemaVersion);
    }

    private static String attributeDocument(String instrumentText, List<Attribute> attributes,
                                            int schemaVersion) {
        List<Map.Entry<String, String>> fields = new ArrayList<>();
        fields.add(f("instrument", canonText(instrumentText)));
        for (Attribute a : attributes) {
            fields.add(f(a.name(), a.canonicalValue()));
        }
        return canonDocument(ATTRIBUTE_SCHEMA, schemaVersion, fields);
    }

    /** Schema version 1, the only one written so far. */
    public static String assetAttributeDocument(InstrumentId instrumentId,
                                                List<Attribute> attributes) {
        return assetAttributeDocument(instrumentId, attributes, 1);
    }

    public static String assetAttributeDigest(InstrumentId instrumentId,
                                              List<Attribute> attributes) {
        return textDigest(assetAttributeDocument(instrumentId, attributes));
    }

    /**
     * DERIVES an instance id from the attributes it was minted with.
     *
     * <p>Two mintings with identical attributes then collide on one id, which is
     * the point: an application that accidentally mints the same item twice
     * finds out, instead of shipping two swords that claim to be one. The salt
     * is the escape hatch for a deliberate reprint. Using this is optional — an
     * application with its own identifier scheme should keep it.
     */
    public static String deriveInstanceId(String tenantId, String localId,
                                          List<Attribute> attributes, String salt) {
        // The document is built over the bare "<tenant>/<local>" text and no
        // admin party: an instance id must not change when the same item is
        // issued from a different registry, or a migration would rename every
        // sword in circulation.
        String document = attributeDocument(tenantId + "/" + localId, attributes, 1);
        return textDigest(document + "|" + salt).substring(0, 32);
    }
}
