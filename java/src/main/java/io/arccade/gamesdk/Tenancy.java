package io.arccade.gamesdk;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Collection;
import java.util.regex.Pattern;

/**
 * The multi-tenant layer — the surface arCCade opens to third parties through
 * its own validator.
 *
 * <p>Applications built on this SDK do not run their own validator; they run
 * through arCCade's participant and are handed a key. That makes arCCade an
 * infrastructure provider rather than a game studio, and it creates three
 * obligations that the ledger will NOT discharge on its own:
 *
 * <ol>
 *   <li><b>Isolation.</b> Tenant A must not move tenant B's venue, players or
 *       assets. They stand on one participant, so this is this layer's job and
 *       not the ledger's.</li>
 *   <li><b>Namespacing.</b> Tenant A must not mint tenant B's item. Because
 *       third parties cannot run their own registry, every tenant's items sit
 *       under ONE admin party — arCCade's registry. Without a prefix, tenant A
 *       could mint {@code "sword-of-dawn"} and be minting tenant B's item. The
 *       prefix makes that structurally impossible rather than forbidden.</li>
 *   <li><b>Quota.</b> Economic deterrence is not the only defence against spam;
 *       a per-tenant write quota is the administrative one. See
 *       {@link TenantQuota}.</li>
 * </ol>
 */
public final class Tenancy {

    /** Tenant id: lowercase, digits and hyphens; 3 to 32 characters. */
    private static final Pattern TENANT_ID = Pattern.compile("[a-z0-9][a-z0-9-]{1,30}[a-z0-9]");

    /** Key prefix. Part of the wire format: {@link #tenantIdFromKey} parses it. */
    private static final String KEY_PREFIX = "ags_";

    private Tenancy() {
    }

    public static String assertValidTenantId(String tenantId) {
        if (tenantId == null || !TENANT_ID.matcher(tenantId).matches()) {
            throw new IllegalArgumentException("invalid tenant id (3-32 characters, [a-z0-9-], "
                    + "cannot start or end with a hyphen): " + tenantId);
        }
        if (tenantId.contains("--")) {
            // Not cosmetic: a double hyphen is how a tenant id could be made to
            // look like two, and ids end up in human-facing places where that
            // reads as a namespace it is not.
            throw new IllegalArgumentException(
                    "a tenant id must not have consecutive hyphens: " + tenantId);
        }
        return tenantId;
    }

    /**
     * Puts a tenant's item id into its namespace: {@code <tenantId>/<localId>}.
     *
     * <p>{@code /} is the separator because {@code :} is the digest encoding's
     * tag separator and {@code |} is its list separator — both are meaningful
     * inside a canonical document, and {@code /} is not. An item id carrying
     * either would produce a document that reads as a different shape, so they
     * are refused here rather than escaped later.
     */
    public static InstrumentId namespacedInstrumentId(String registryParty, String tenantId,
                                                      String localId) {
        assertValidTenantId(tenantId);
        if (localId == null || localId.isEmpty()
                || ArccadeDigest.codePointLength(localId) > 96) {
            throw new IllegalArgumentException(
                    "an item id must be 1-96 characters: " + localId);
        }
        if (localId.indexOf('/') >= 0) {
            throw new IllegalArgumentException(
                    "an item id cannot contain '/' (the namespace separator): " + localId);
        }
        if (localId.indexOf(':') >= 0 || localId.indexOf('|') >= 0) {
            throw new IllegalArgumentException(
                    "an item id cannot contain ':' or '|': " + localId);
        }
        return new InstrumentId(registryParty, tenantId + "/" + localId);
    }

    /**
     * The owning tenant and the local id of an instrument.
     *
     * <p>{@code tenantId} is null for an asset with no namespace — Canton Coin
     * and anything else the whole ecosystem shares.
     */
    public record ParsedInstrumentId(String tenantId, String localId) {
    }

    public static ParsedInstrumentId parseInstrumentId(InstrumentId instrumentId) {
        int slash = instrumentId.id().indexOf('/');
        if (slash < 0) {
            return new ParsedInstrumentId(null, instrumentId.id());
        }
        return new ParsedInstrumentId(instrumentId.id().substring(0, slash),
                instrumentId.id().substring(slash + 1));
    }

    /**
     * THE ISOLATION CHECK — run it on every tenant-driven call.
     *
     * <p>Requires that every instrument a tenant touches is either inside its
     * own namespace or has none at all. A namespaceless asset is shared on
     * purpose: refusing those would stop a tenant paying anyone in Canton Coin.
     */
    public static String assertTenantOwnsInstrument(String tenantId, InstrumentId instrumentId) {
        assertValidTenantId(tenantId);
        String owner = parseInstrumentId(instrumentId).tenantId();
        if (owner != null && !owner.equals(tenantId)) {
            throw new IllegalArgumentException("tenant isolation violated: \"" + tenantId
                    + "\" cannot touch \"" + owner + "\"'s asset (" + instrumentId.id() + ")");
        }
        return tenantId;
    }

    /** Checks every leg of a trade or transfer for isolation. */
    public static String assertTenantLegs(String tenantId,
                                          Collection<TradeCommands.TradeLeg> legs) {
        for (TradeCommands.TradeLeg leg : legs) {
            assertTenantOwnsInstrument(tenantId, leg.instrumentId());
        }
        return tenantId;
    }

    // ------------------------------------------------------------------ keys

    /** A freshly generated key. The secret is shown once and never stored. */
    public record TenantKey(String tenantId, String secret, String hash) {
    }

    /**
     * Generates a new SDK key.
     *
     * <p>The returned {@code secret} is shown to the tenant ONCE and not kept;
     * the server side stores only {@code hash}. A lost key is replaced, never
     * recovered — which is the same property as storing a password hash, and
     * for the same reason.
     */
    public static TenantKey generateTenantKey(String tenantId) {
        assertValidTenantId(tenantId);
        byte[] entropy = new byte[24];
        new SecureRandom().nextBytes(entropy);
        String secret = KEY_PREFIX + tenantId + "_"
                + Base64.getUrlEncoder().withoutPadding().encodeToString(entropy);
        return new TenantKey(tenantId, secret, hashTenantKey(secret));
    }

    public static String hashTenantKey(String secret) {
        return ArccadeDigest.textDigest(secret);
    }

    /**
     * Verifies a key in CONSTANT TIME.
     *
     * <p>A plain {@code equals} returns as soon as two bytes differ, and the
     * response time leaks how much of a guess was right. {@link MessageDigest#isEqual}
     * is the JDK's constant-time comparison; using {@code String.equals} here
     * would be a timing oracle that no test in this repository could observe.
     */
    public static boolean verifyTenantKey(String secret, String expectedHash) {
        if (secret == null || expectedHash == null) {
            return false;
        }
        byte[] a = hashTenantKey(secret).getBytes(StandardCharsets.UTF_8);
        byte[] b = expectedHash.getBytes(StandardCharsets.UTF_8);
        // Lengths differ observably whatever this does, so comparing them up
        // front costs nothing: MessageDigest.isEqual returns early on length too.
        return a.length == b.length && MessageDigest.isEqual(a, b);
    }

    /**
     * Reads the tenant id out of a key. NOT a substitute for verification.
     *
     * <p>Anyone can write a string that starts {@code ags_mygame_}; this says
     * which tenant a key CLAIMS to be, so a caller can look up the stored hash
     * before {@link #verifyTenantKey} decides whether the claim is true. Null
     * when the key is not shaped like one of ours.
     */
    public static String tenantIdFromKey(String secret) {
        if (secret == null || !secret.startsWith(KEY_PREFIX)) {
            return null;
        }
        String rest = secret.substring(KEY_PREFIX.length());
        int sep = rest.indexOf('_');
        if (sep < 0) {
            return null;
        }
        String id = rest.substring(0, sep);
        try {
            return assertValidTenantId(id);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
