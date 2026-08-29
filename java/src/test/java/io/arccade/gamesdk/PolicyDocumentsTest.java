package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.arccade.gamesdk.PolicyDocuments.VenuePolicy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The policy document a stake commits to, and the consistency rule the ledger
 * applies before a venue can exist at all.
 */
class PolicyDocumentsTest {

    private static VenuePolicy representative() {
        return new VenuePolicy("1.0", "1000.0", "0.5", "5000.0",
                7200, 86400, 60, 3600, 30, 300, 3, true);
    }

    /** The text case {@code policy-document-representative} pins in the manifest. */
    private static final String REPRESENTATIVE_DOCUMENT =
            "arccade-sdk-digest-v1|t:20:arccade-venue-policyi:1:1r:417:"
                    + "k:22:abort-cooldown-seconds=i:3:300;"
                    + "k:17:concurrency-limit=i:1:3;"
                    + "k:16:cooldown-seconds=i:2:30;"
                    + "k:17:max-cycle-seconds=i:4:3600;"
                    + "k:16:max-lock-seconds=i:5:86400;"
                    + "k:17:max-payout-amount=d:14:50000000000000;"
                    + "k:16:max-stake-amount=d:14:10000000000000;"
                    + "k:17:min-cycle-seconds=i:2:60;"
                    + "k:16:min-lock-seconds=i:4:7200;"
                    + "k:16:min-platform-fee=d:10:5000000000;"
                    + "k:16:min-stake-amount=d:11:10000000000;"
                    + "k:21:require-custody-proof=b:4:true;";

    @Test
    @DisplayName("golden vector: the representative policy's canonical text and digest")
    void representativePolicyGoldenVector() {
        assertEquals(REPRESENTATIVE_DOCUMENT, PolicyDocuments.policyDocument(representative()));
        assertEquals("4ec4e8bc990d8b0f75e992202bcbdf6524ffe190f5367e874cd64ad5c4b8ed2e",
                PolicyDocuments.policyDigest(representative()));
    }

    @Test
    @DisplayName("a policy is authored in DECIMALS while an audit row carries units")
    void amountsAreDecimalsNotUnits() {
        // canonDecimal converts to units; canonInt would hash "1.0" as text and
        // produce a digest no stake on the ledger could match.
        assertTrue(PolicyDocuments.policyDocument(representative())
                .contains("min-stake-amount=d:11:10000000000"));
    }

    @Test
    @DisplayName("a lock that can expire mid-cycle is refused")
    void lockMustOutlastACycle() {
        // The critical rule: a player could otherwise leave through
        // OwnerExpireLockV2 before the minimum duration was up, which hollows
        // out the minimum-ledger-lock commitment while everything else reads
        // as sound.
        assertTrue(PolicyDocuments.validPolicy(representative()));
        assertFalse(PolicyDocuments.validPolicy(new VenuePolicy("1.0", "1000.0", "0.5", "5000.0",
                30, 86400, 60, 3600, 30, 300, 3, true)));
    }

    @Test
    @DisplayName("a zero stake floor, an inverted band and a zero concurrency limit are refused")
    void otherInconsistenciesAreRefused() {
        assertFalse(PolicyDocuments.validPolicy(new VenuePolicy("0.0", "1000.0", "0.5", "5000.0",
                7200, 86400, 60, 3600, 30, 300, 3, true)));
        assertFalse(PolicyDocuments.validPolicy(new VenuePolicy("1.0", "0.5", "0.5", "5000.0",
                7200, 86400, 60, 3600, 30, 300, 3, true)));
        assertFalse(PolicyDocuments.validPolicy(new VenuePolicy("1.0", "1000.0", "0.5", "5000.0",
                7200, 86400, 60, 3600, 30, 300, 0, true)));
    }

    @Test
    @DisplayName("the digest is the sha256 of the document text and nothing else")
    void digestIsTheTextDigest() {
        assertEquals(ArccadeDigest.textDigest(PolicyDocuments.policyDocument(representative())),
                PolicyDocuments.policyDigest(representative()));
    }
}
