"""Trade Wars and Pixel Race document adapters.

DESIGN.md calls these documents normative, so they belong in the shipped
package. In the JavaScript client they live in ``js/examples/`` and are NOT in
the published tarball, which means a consumer cannot call them at all — the
conformance suite therefore states the game cases as compositions of the core
primitives instead. Here they ship.

Both games reduce everything the game knows to a canonical text; only its sha256
enters the chain. The ENTRY half is what the player committed to; the OUTCOME
half is what settlement commits to. A client with only the entry half can check
what was promised but not what was paid.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

from .digest import (canon_decimal, canon_document, canon_fields, canon_int,
                     canon_list, canon_text, canon_time_micros, text_digest)

__all__ = [
    "TRADE_WARS_GAME_CODE", "PIXEL_RACE_GAME_CODE",
    "tw_price_point", "tw_allocation", "tw_entry_document", "tw_entry_digest",
    "tw_outcome_document", "tw_outcome_digest",
    "pr_game_play", "pr_entry_document", "pr_entry_digest",
    "pr_outcome_document", "pr_outcome_digest", "seed_matches_commit",
]

TRADE_WARS_GAME_CODE = "trade-wars-v4"
PIXEL_RACE_GAME_CODE = "pixel-race-v1"


# ------------------------------------------------------------- trade wars

def tw_price_point(symbol: str, price: Any, source: str, as_of_micros: int) -> str:
    """One observed price. ``as-of`` is integer microseconds, never an ISO string."""
    return canon_fields([
        ("as-of", canon_time_micros(as_of_micros)),
        ("price", canon_decimal(price)),
        ("source", canon_text(source)),
        ("symbol", canon_text(symbol)),
    ])


def tw_allocation(symbol: str, pct: Any) -> str:
    return canon_fields([
        ("allocation-percent", canon_decimal(pct)),
        ("symbol", canon_text(symbol)),
    ])


def tw_entry_document(cycle_id: str, tier: str, virtual_balance: Any,
                      allocations: Iterable[Sequence[Any]],
                      entry_prices: Iterable[Sequence[Any]]) -> str:
    """The entry the player commits to. ALLOCATION ORDER IS PART OF THE DOCUMENT:
    swapping two allocations changes the digest."""
    return canon_document("arccade-trade-wars-entry", 1, [
        ("allocations", canon_list(tw_allocation(*a) for a in allocations)),
        ("cycle-id", canon_text(cycle_id)),
        ("entry-prices", canon_list(tw_price_point(*p) for p in entry_prices)),
        ("game-code", canon_text(TRADE_WARS_GAME_CODE)),
        ("tier", canon_text(tier)),
        ("virtual-balance", canon_decimal(virtual_balance)),
    ])


def tw_entry_digest(*args: Any, **kwargs: Any) -> str:
    return text_digest(tw_entry_document(*args, **kwargs))


def tw_outcome_document(cycle_id: str, exit_prices: Iterable[Sequence[Any]],
                        final_balance: Any, pnl_percent: Any,
                        returned_amount: Any, forfeited_amount: Any) -> str:
    """The outcome settlement commits to — the half a report cannot be checked
    without."""
    return canon_document("arccade-trade-wars-outcome", 1, [
        ("cycle-id", canon_text(cycle_id)),
        ("exit-prices", canon_list(tw_price_point(*p) for p in exit_prices)),
        ("final-balance", canon_decimal(final_balance)),
        ("forfeited-amount", canon_decimal(forfeited_amount)),
        ("game-code", canon_text(TRADE_WARS_GAME_CODE)),
        ("pnl-percent", canon_decimal(pnl_percent)),
        ("returned-amount", canon_decimal(returned_amount)),
    ])


def tw_outcome_digest(*args: Any, **kwargs: Any) -> str:
    return text_digest(tw_outcome_document(*args, **kwargs))


# ------------------------------------------------------------- pixel race

def pr_game_play(game_number: int, score: int, max_level: int,
                 coins_collected: int, survival_seconds: int) -> str:
    return canon_fields([
        ("coins-collected", canon_int(coins_collected)),
        ("game-number", canon_int(game_number)),
        ("max-level", canon_int(max_level)),
        ("score", canon_int(score)),
        ("survival-seconds", canon_int(survival_seconds)),
    ])


def pr_entry_document(cycle_id: str, tier: str, max_games: int, seed_commit: str) -> str:
    return canon_document("arccade-pixel-race-entry", 1, [
        ("cycle-id", canon_text(cycle_id)),
        ("game-code", canon_text(PIXEL_RACE_GAME_CODE)),
        ("max-games-per-session", canon_int(max_games)),
        ("rng-seed-commit", canon_text(seed_commit)),
        ("tier", canon_text(tier)),
    ])


def pr_entry_digest(*args: Any, **kwargs: Any) -> str:
    return text_digest(pr_entry_document(*args, **kwargs))


def pr_outcome_document(cycle_id: str, plays: Iterable[Sequence[Any]],
                        total_score: int, xp_awarded: int, rng_seed: str,
                        returned_amount: Any, forfeited_amount: Any) -> str:
    return canon_document("arccade-pixel-race-outcome", 1, [
        ("cycle-id", canon_text(cycle_id)),
        ("forfeited-amount", canon_decimal(forfeited_amount)),
        ("game-code", canon_text(PIXEL_RACE_GAME_CODE)),
        ("plays", canon_list(pr_game_play(*p) for p in plays)),
        ("returned-amount", canon_decimal(returned_amount)),
        ("rng-seed", canon_text(rng_seed)),
        ("total-score", canon_int(total_score)),
        ("xp-awarded", canon_int(xp_awarded)),
    ])


def pr_outcome_digest(*args: Any, **kwargs: Any) -> str:
    return text_digest(pr_outcome_document(*args, **kwargs))


def seed_matches_commit(seed: str, commitment: str) -> bool:
    """The provable-fairness endpoint: the revealed seed must hash to the
    commitment the entry document pinned before play started."""
    return text_digest(seed) == commitment
