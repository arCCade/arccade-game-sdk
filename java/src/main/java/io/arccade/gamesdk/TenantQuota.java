package io.arccade.gamesdk;

import java.util.HashMap;
import java.util.Map;

/**
 * A per-tenant write quota — the ADMINISTRATIVE defence against spam.
 *
 * <p>Economic deterrence comes first: every endpoint in this SDK moves real
 * value, so every call costs the caller real Canton Coin and a network fee.
 * That is not sufficient on its own. A well-capitalised tenant can produce a
 * volume that is economically legitimate and operationally harmful, and this is
 * the second layer.
 *
 * <h2>A fixed window, and why the clock is an argument</h2>
 *
 * <p>The counter resets on a fixed window rather than sliding, which is the
 * cheaper and more forgiving of the two: a tenant that exhausts its allowance
 * gets it all back at the boundary. {@code nowMs} is passed IN rather than read
 * from the system clock, so the behaviour at a window boundary is testable and
 * pinned by the conformance suite instead of being a race.
 *
 * <p>The store is an ordinary map and this class is NOT thread-safe or durable.
 * Both are deliberate: a quota that survives a restart or spans processes needs
 * the caller's own store, and pretending otherwise would let an operator
 * believe a limit was enforced across a fleet when it was enforced per JVM.
 */
public final class TenantQuota {

    private final long windowMillis;
    private final long maxWrites;
    private final Map<String, Bucket> store = new HashMap<>();

    /** What a call to {@link #consume} decided. */
    public record Decision(boolean allowed, long remaining, long resetAt) {
    }

    private static final class Bucket {
        long start;
        long used;

        Bucket(long start) {
            this.start = start;
        }
    }

    public TenantQuota(long windowSeconds, long maxWrites) {
        if (windowSeconds <= 0 || maxWrites <= 0) {
            throw new IllegalArgumentException(
                    "a quota needs a positive window and a positive cap: windowSeconds="
                            + windowSeconds + ", maxWrites=" + maxWrites);
        }
        this.windowMillis = Math.multiplyExact(windowSeconds, 1000L);
        this.maxWrites = maxWrites;
    }

    /**
     * Charges {@code cost} against the tenant's window.
     *
     * <p>A REFUSED call does not consume. Otherwise a tenant hammering the API
     * would hold its own window open forever and never recover, which turns a
     * rate limit into a ban.
     */
    public Decision consume(String tenantId, long nowMs, long cost) {
        Tenancy.assertValidTenantId(tenantId);
        Bucket bucket = store.computeIfAbsent(tenantId, k -> new Bucket(nowMs));
        if (nowMs - bucket.start >= windowMillis) {
            bucket.start = nowMs;
            bucket.used = 0;
        }
        long resetAt = bucket.start + windowMillis;
        if (bucket.used + cost > maxWrites) {
            return new Decision(false, Math.max(0, maxWrites - bucket.used), resetAt);
        }
        bucket.used += cost;
        return new Decision(true, maxWrites - bucket.used, resetAt);
    }

    /** One unit of work. */
    public Decision consume(String tenantId, long nowMs) {
        return consume(tenantId, nowMs, 1);
    }
}
