package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Isolation, namespacing and keys — the three obligations the ledger will not discharge. */
class TenancyTest {

    private static final String REGISTRY = "registry-party";

    @Test
    @DisplayName("a tenant id is 3-32 lowercase characters with no leading, trailing or doubled hyphen")
    void tenantIdShape() {
        assertEquals("abc", Tenancy.assertValidTenantId("abc"));
        assertEquals("my-game", Tenancy.assertValidTenantId("my-game"));
        assertEquals("a".repeat(32), Tenancy.assertValidTenantId("a".repeat(32)));
        for (String bad : List.of("ab", "a".repeat(33), "-mygame", "mygame-", "MyGame",
                "my/game", "my--game")) {
            assertThrows(IllegalArgumentException.class, () -> Tenancy.assertValidTenantId(bad));
        }
    }

    @Test
    @DisplayName("an item id cannot carry a digest separator")
    void namespacedIdRefusesSeparators() {
        // ':' is the encoding's tag separator and '|' its list separator; '/'
        // is the namespace separator itself. Any of the three inside an item id
        // makes the resulting instrument id ambiguous.
        assertEquals("mygame/sword-of-dawn",
                Tenancy.namespacedInstrumentId(REGISTRY, "mygame", "sword-of-dawn").id());
        for (String bad : List.of("sub/sword", "sw:ord", "sw|ord", "a".repeat(97))) {
            assertThrows(IllegalArgumentException.class,
                    () -> Tenancy.namespacedInstrumentId(REGISTRY, "mygame", bad));
        }
    }

    @Test
    @DisplayName("a tenant cannot touch another tenant's namespace, but may touch a shared asset")
    void isolationIsEnforced() {
        assertEquals("mygame", Tenancy.assertTenantOwnsInstrument("mygame",
                new InstrumentId(REGISTRY, "mygame/gold")));
        // A namespaceless asset is shared on purpose: refusing it would stop a
        // tenant paying anyone in Canton Coin.
        assertEquals("mygame", Tenancy.assertTenantOwnsInstrument("mygame",
                new InstrumentId("dso-party", "Amulet")));
        assertThrows(IllegalArgumentException.class,
                () -> Tenancy.assertTenantOwnsInstrument("mygame",
                        new InstrumentId(REGISTRY, "othergame/gold")));
    }

    @Test
    @DisplayName("every leg of a trade is checked, not just the first")
    void everyLegIsChecked() {
        TradeCommands.TradeLeg own = TradeCommands.leg("M", "T",
                new InstrumentId(REGISTRY, "mygame/sword#4a91c8f2"), "1");
        TradeCommands.TradeLeg other = TradeCommands.leg("T", "M",
                new InstrumentId("othergame/registry", "othergame/gold"), "10.0");
        assertThrows(IllegalArgumentException.class,
                () -> Tenancy.assertTenantLegs("mygame", List.of(own, other)));
        assertEquals("mygame", Tenancy.assertTenantLegs("mygame", List.of(own)));
    }

    @Test
    @DisplayName("a key hashes to a stable value and verifies against it")
    void keyHashAndVerify() {
        String secret = "ags_mygame_Zm9vYmFyYmF6cXV4";
        String hash = "f5f94ef14fad18122de883e055b58ca0a912a9ec0fee967579f8b6461324e2c5";
        assertEquals(hash, Tenancy.hashTenantKey(secret));
        assertTrue(Tenancy.verifyTenantKey(secret, hash));
        assertFalse(Tenancy.verifyTenantKey("ags_mygame_Zm9vYmFyYmF6cXV5", hash));
        // A short hash must not throw its way out of a verification path.
        assertFalse(Tenancy.verifyTenantKey(secret, "deadbeef"));
        assertFalse(Tenancy.verifyTenantKey(null, hash));
    }

    @Test
    @DisplayName("the tenant id read out of a key is a claim, and a malformed key claims nothing")
    void tenantIdFromKeyIsOnlyAClaim() {
        assertEquals("mygame", Tenancy.tenantIdFromKey("ags_mygame_Zm9vYmFyYmF6cXV4"));
        assertNull(Tenancy.tenantIdFromKey("sk_live_mygame_abc"));
        assertNull(Tenancy.tenantIdFromKey("ags_mygame"));
        assertNull(Tenancy.tenantIdFromKey("ags_My--Game_abc"));
    }

    @Test
    @DisplayName("a generated key is unique and its hash matches the secret it was made from")
    void generatedKeysAreUniqueAndSelfConsistent() {
        Tenancy.TenantKey a = Tenancy.generateTenantKey("mygame");
        Tenancy.TenantKey b = Tenancy.generateTenantKey("mygame");
        assertNotEquals(a.secret(), b.secret());
        assertEquals("mygame", Tenancy.tenantIdFromKey(a.secret()));
        assertTrue(Tenancy.verifyTenantKey(a.secret(), a.hash()));
        assertFalse(Tenancy.verifyTenantKey(a.secret(), b.hash()));
    }
}
