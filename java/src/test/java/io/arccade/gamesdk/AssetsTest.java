package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The two asset models, and the attribute document a buyer can check. */
class AssetsTest {

    private static final String REGISTRY = "registry-party";

    @Test
    @DisplayName("an asset id is lowercase and cannot start or end with a separator")
    void localIdShape() {
        assertEquals("health-potion", Assets.assertValidLocalId("health-potion"));
        assertEquals("sword.of.dawn", Assets.assertValidLocalId("sword.of.dawn"));
        assertEquals("gg", Assets.assertValidLocalId("gg"));
        for (String bad : List.of("g", ".gold", "gold-", "Gold", "my/gold", "my:gold", "my|gold")) {
            assertThrows(IllegalArgumentException.class, () -> Assets.assertValidLocalId(bad));
        }
    }

    @Test
    @DisplayName("a unique instance carries its own instrument id")
    void uniqueInstrumentIsItsOwnInstrument() {
        assertEquals("mygame/sword-of-dawn#4a91c8f2",
                Assets.uniqueInstrument(REGISTRY, "mygame", "sword-of-dawn", "4a91c8f2").id());
        assertEquals("mygame/gold", Assets.fungibleInstrument(REGISTRY, "mygame", "gold").id());
        assertThrows(IllegalArgumentException.class,
                () -> Assets.uniqueInstrument(REGISTRY, "mygame", "sword", "abc"));
        assertThrows(IllegalArgumentException.class,
                () -> Assets.uniqueInstrument(REGISTRY, "mygame", "sword", "4A91C8F2"));
    }

    @Test
    @DisplayName("a namespaceless instrument parses as a shared fungible asset")
    void namespacelessAssetsAreShared() {
        // Canton Coin has no tenant prefix and must not be read as one tenant's.
        Assets.ParsedAsset amulet = Assets.parseAsset(new InstrumentId("dso-party", "Amulet"));
        assertNull(amulet.tenantId());
        assertEquals("Amulet", amulet.localId());
        assertNull(amulet.instanceId());
        assertEquals(Assets.FUNGIBLE, amulet.assetClass());

        Assets.ParsedAsset sword = Assets.parseAsset(
                new InstrumentId(REGISTRY, "mygame/sword-of-dawn#4a91c8f2"));
        assertEquals("mygame", sword.tenantId());
        assertEquals("sword-of-dawn", sword.localId());
        assertEquals("4a91c8f2", sword.instanceId());
        assertTrue(Assets.isUnique(new InstrumentId(REGISTRY, "mygame/sword#4a91c8f2")));
        assertFalse(Assets.isUnique(new InstrumentId(REGISTRY, "mygame/gold")));
    }

    @Test
    @DisplayName("a unique asset's amount is always 1, whichever way 1 is spelled")
    void uniqueAmountIsOne() {
        InstrumentId sword = new InstrumentId(REGISTRY, "mygame/sword#4a91c8f2");
        assertEquals("1", Assets.assertAmountValidForAsset(sword, "1"));
        assertEquals("1.0000000000", Assets.assertAmountValidForAsset(sword, "1.0000000000"));
        assertThrows(IllegalArgumentException.class,
                () -> Assets.assertAmountValidForAsset(sword, "3"));

        InstrumentId gold = new InstrumentId(REGISTRY, "mygame/gold");
        assertThrows(IllegalArgumentException.class,
                () -> Assets.assertAmountValidForAsset(gold, "0"));
        assertThrows(IllegalArgumentException.class,
                () -> Assets.assertAmountValidForAsset(gold, "-5"));
    }

    @Test
    @DisplayName("golden vector: the attribute document and its digest")
    void attributeDocumentGoldenVector() {
        InstrumentId sword = new InstrumentId(REGISTRY, "mygame/sword-of-dawn#4a91c8f2");
        List<Assets.Attribute> attributes = List.of(
                Assets.Attribute.ofInt("attack", 9),
                Assets.Attribute.ofText("name", "Sword of Dawn"));

        assertEquals("arccade-sdk-digest-v1|t:24:arccade-asset-attributesi:1:1r:96:"
                        + "k:6:attack=i:1:9;"
                        + "k:10:instrument=t:29:mygame/sword-of-dawn#4a91c8f2;"
                        + "k:4:name=t:13:Sword of Dawn;",
                Assets.assetAttributeDocument(sword, attributes));
        assertEquals("ccda258801bc55ca253c9651cac60a5792f60884fce7d79f7a9daa25bf8ea544",
                Assets.assetAttributeDigest(sword, attributes));
    }

    @Test
    @DisplayName("a binary float attribute is refused; a decimal is passed as text")
    void floatAttributesAreRefused() {
        // 1.5 is exact in binary and 0.1 is not, so a double attribute would
        // succeed or lose precision depending on the literal, and two languages
        // rendering the same double disagree about the digits.
        assertThrows(IllegalArgumentException.class,
                () -> Assets.Attribute.of("weight", Double.valueOf(1.5)));
        assertEquals("t:3:1.5", Assets.Attribute.ofText("weight", "1.5").canonicalValue());
    }

    @Test
    @DisplayName("an instance id derived from attributes is stable, salted and attribute-sensitive")
    void derivedInstanceIds() {
        List<Assets.Attribute> nine = List.of(Assets.Attribute.ofInt("attack", 9));
        List<Assets.Attribute> three = List.of(Assets.Attribute.ofInt("attack", 3));
        assertEquals("cf8aea7df6b3bc8b25c94ba90974c882",
                Assets.deriveInstanceId("mygame", "sword-of-dawn", nine, ""));
        assertEquals("e4c06c8c1ef010ed1e61f3299d99b4a5",
                Assets.deriveInstanceId("mygame", "sword-of-dawn", nine, "reprint-2"));
        assertEquals("05029f442bf2c4e23d53abc55b5b14c0",
                Assets.deriveInstanceId("mygame", "sword-of-dawn", three, ""));
    }
}
