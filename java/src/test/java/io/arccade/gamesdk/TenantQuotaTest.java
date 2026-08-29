package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The quota, driven by an injected clock.
 *
 * <p>Every assertion here is about a window boundary, which is the only part of
 * a rate limiter that is ever really wrong. Reading the system clock instead
 * would make these tests a race.
 */
class TenantQuotaTest {

    @Test
    @DisplayName("the window rolls at exactly start + window, not one millisecond later")
    void windowRollsAtTheBoundary() {
        TenantQuota q = new TenantQuota(60, 1);
        assertTrue(q.consume("mygame", 0, 1).allowed());
        assertFalse(q.consume("mygame", 59_999, 1).allowed());
        TenantQuota.Decision rolled = q.consume("mygame", 60_000, 1);
        assertTrue(rolled.allowed());
        assertEquals(120_000, rolled.resetAt());
    }

    @Test
    @DisplayName("resetAt is the window's start plus the window, not now plus the window")
    void resetAtIsAnchoredToTheWindowStart() {
        TenantQuota q = new TenantQuota(30, 2);
        assertEquals(35_000, q.consume("mygame", 5_000, 1).resetAt());
        assertEquals(35_000, q.consume("mygame", 20_000, 1).resetAt());
    }

    @Test
    @DisplayName("a refused call does not consume, so a hammered window still recovers")
    void refusalDoesNotConsume() {
        // Otherwise a tenant hammering the API holds its own window open
        // forever, which turns a rate limit into a ban.
        TenantQuota q = new TenantQuota(60, 2);
        assertTrue(q.consume("mygame", 0, 1).allowed());
        assertTrue(q.consume("mygame", 0, 1).allowed());
        assertFalse(q.consume("mygame", 0, 1).allowed());
        assertFalse(q.consume("mygame", 0, 1).allowed());
        assertTrue(q.consume("mygame", 60_000, 1).allowed());
        assertTrue(q.consume("mygame", 60_000, 1).allowed());
    }

    @Test
    @DisplayName("a cost larger than the cap is never allowed, in any window")
    void oversizedCostNeverFits() {
        TenantQuota q = new TenantQuota(60, 3);
        TenantQuota.Decision first = q.consume("mygame", 0, 5);
        assertFalse(first.allowed());
        assertEquals(3, first.remaining());
        assertFalse(q.consume("mygame", 60_000, 5).allowed());
    }

    @Test
    @DisplayName("tenants have separate buckets")
    void bucketsArePerTenant() {
        TenantQuota q = new TenantQuota(60, 1);
        assertTrue(q.consume("mygame", 0, 1).allowed());
        assertTrue(q.consume("othergame", 0, 1).allowed());
        assertFalse(q.consume("mygame", 0, 1).allowed());
    }

    @Test
    @DisplayName("the one-argument form charges exactly one unit")
    void defaultCostIsOne() {
        TenantQuota q = new TenantQuota(60, 2);
        assertEquals(1, q.consume("mygame", 0).remaining());
        assertEquals(0, q.consume("mygame", 0).remaining());
        assertFalse(q.consume("mygame", 0).allowed());
    }

    @Test
    @DisplayName("an invalid tenant id is refused before anything is counted")
    void invalidTenantIdIsRefused() {
        TenantQuota q = new TenantQuota(60, 3);
        assertThrows(IllegalArgumentException.class, () -> q.consume("My--Game", 0, 1));
        assertThrows(IllegalArgumentException.class, () -> new TenantQuota(0, 3));
    }
}
