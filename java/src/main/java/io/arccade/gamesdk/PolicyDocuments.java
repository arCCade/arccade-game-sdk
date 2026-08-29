package io.arccade.gamesdk;

import java.util.List;
import java.util.Map;

import static io.arccade.gamesdk.ArccadeDigest.canonBool;
import static io.arccade.gamesdk.ArccadeDigest.canonDecimal;
import static io.arccade.gamesdk.ArccadeDigest.canonDocument;
import static io.arccade.gamesdk.ArccadeDigest.canonInt;
import static io.arccade.gamesdk.ArccadeDigest.f;
import static io.arccade.gamesdk.ArccadeDigest.textDigest;

/**
 * The venue policy document, and the consistency check the ledger applies to it.
 *
 * <p>The FULL TEXT of the policy in force is committed as a digest at every
 * stake ({@code GameStake.policyHash}). "Under which rules was this cycle
 * opened" is then answered by the cycle's own record rather than by whatever
 * arCCade says later — which only holds if the document is reproducible outside
 * Daml, by someone who does not trust arCCade. That is what this class is for.
 *
 * <p>Note the deliberate difference from an audit row: a policy is authored in
 * DECIMALS ({@code canonDecimal}) while a row carries units already converted
 * ({@code canonInt}). Applying one convention to the other produces a policy
 * digest that no stake on the ledger can match, and nothing would catch it
 * until a venue's policy failed to verify.
 */
public final class PolicyDocuments {

    public static final String POLICY_SCHEMA = "arccade-venue-policy";
    public static final int SCHEMA_VERSION = 1;

    private PolicyDocuments() {
    }

    /**
     * A venue policy.
     *
     * <p>The four amounts are decimal TEXT, not {@code BigDecimal}: they come
     * from a config file or a ledger payload as text, and
     * {@link ArccadeDigest#amountUnits(String)} is stricter about what text is
     * an amount than {@code BigDecimal} is. Converting early would spend that
     * check before the policy ever reached this class.
     */
    public record VenuePolicy(
            String minStakeAmount,
            String maxStakeAmount,
            String minPlatformFee,
            String maxPayoutAmount,
            long minLockSeconds,
            long maxLockSeconds,
            long minCycleSeconds,
            long maxCycleSeconds,
            long cooldownSeconds,
            long abortCooldownSeconds,
            long concurrencyLimit,
            boolean requireCustodyProof) {
    }

    /**
     * The policy's canonical document.
     *
     * <p>Field order here does not matter — {@code canonFields} sorts by name —
     * so a field added later does not change the v1 digest unless the schema
     * version moves with it.
     */
    public static String policyDocument(VenuePolicy p) {
        List<Map.Entry<String, String>> fields = List.of(
                f("min-stake-amount", canonDecimal(p.minStakeAmount())),
                f("max-stake-amount", canonDecimal(p.maxStakeAmount())),
                f("min-platform-fee", canonDecimal(p.minPlatformFee())),
                f("max-payout-amount", canonDecimal(p.maxPayoutAmount())),
                f("min-lock-seconds", canonInt(p.minLockSeconds())),
                f("max-lock-seconds", canonInt(p.maxLockSeconds())),
                f("min-cycle-seconds", canonInt(p.minCycleSeconds())),
                f("max-cycle-seconds", canonInt(p.maxCycleSeconds())),
                f("cooldown-seconds", canonInt(p.cooldownSeconds())),
                f("abort-cooldown-seconds", canonInt(p.abortCooldownSeconds())),
                f("concurrency-limit", canonInt(p.concurrencyLimit())),
                f("require-custody-proof", canonBool(p.requireCustodyProof())));
        return canonDocument(POLICY_SCHEMA, SCHEMA_VERSION, fields);
    }

    public static String policyDigest(VenuePolicy p) {
        return textDigest(policyDocument(p));
    }

    /**
     * Whether the policy is internally consistent.
     *
     * <p>Daml runs these conditions in a template {@code ensure}, so an
     * inconsistent policy cannot create a venue at all. Restating them here
     * lets a caller find that out before submitting rather than from a
     * rejection.
     *
     * <p>THE CRITICAL RULE is {@code minLockSeconds >= minCycleSeconds}. A lock
     * that can expire mid-cycle is not a lock: the player could leave through
     * {@code LockedAmulet_OwnerExpireLockV2} before the minimum duration was up,
     * which hollows out the minimum-ledger-lock commitment while every other
     * field still reads as sound.
     */
    public static boolean validPolicy(VenuePolicy p) {
        long minStake = ArccadeDigest.amountUnits(p.minStakeAmount());
        long maxStake = ArccadeDigest.amountUnits(p.maxStakeAmount());
        long minFee = ArccadeDigest.amountUnits(p.minPlatformFee());
        long maxPayout = ArccadeDigest.amountUnits(p.maxPayoutAmount());
        return minStake > 0
                && maxStake >= minStake
                && minFee >= 0
                && maxPayout >= 0
                && p.minLockSeconds() > 0
                && p.maxLockSeconds() >= p.minLockSeconds()
                && p.minCycleSeconds() > 0
                && p.maxCycleSeconds() >= p.minCycleSeconds()
                && p.minLockSeconds() >= p.minCycleSeconds()
                && p.cooldownSeconds() >= 0
                && p.abortCooldownSeconds() >= 0
                && p.concurrencyLimit() > 0;
    }
}
