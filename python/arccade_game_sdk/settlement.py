"""The settlement arithmetic Cycle.daml enforces, restated so a client can check it.

No shipped client re-checked this, which meant a published report could state
amounts the ledger would have refused while every individual Merkle proof still
verified. Conservation is the one property a proof cannot express: the tree says
"this row is in the report", never "this row is arithmetically possible".

Messages here are English rather than Turkish because they name conditions from
Cycle.daml's assertions, and the conformance reject map keys off them.
"""

from __future__ import annotations

from typing import Any, Mapping

from .digest import assert_disposition

__all__ = ["assert_settlement_valid", "settlement_is_valid"]


def assert_settlement_valid(settlement: Mapping[str, Any]) -> bool:
    """Checks one settlement's amounts. Returns True or raises.

    Field names match the audit row: ``disposition``, ``stakeUnits``,
    ``returnedUnits``, ``forfeitedUnits``, ``payoutUnits``, ``maxPayoutUnits``,
    all in integer 1e-10 units.
    """
    disposition = assert_disposition(settlement["disposition"])
    stake = int(settlement["stakeUnits"])
    returned = int(settlement["returnedUnits"])
    forfeited = int(settlement["forfeitedUnits"])
    payout = int(settlement["payoutUnits"])
    max_payout = int(settlement["maxPayoutUnits"])

    # Sign first: a negative leg reverses the direction of the settlement while
    # the row still reads as a payment to the player.
    for name, value in (("returnedUnits", returned), ("forfeitedUnits", forfeited),
                        ("payoutUnits", payout)):
        if value < 0:
            raise ValueError(f"negative settlement amount: {name}={value}")

    if returned + forfeited != stake:
        raise ValueError(
            f"returned + forfeited must equal the stake: "
            f"{returned} + {forfeited} != {stake}"
        )

    if disposition == "returned-in-full" and forfeited != 0:
        raise ValueError(f"returned-in-full cannot forfeit: forfeitedUnits={forfeited}")
    if disposition == "forfeited-in-full" and returned != 0:
        raise ValueError(f"forfeited-in-full cannot return: returnedUnits={returned}")
    if disposition == "returned-with-forfeit" and not (returned > 0 and forfeited > 0):
        raise ValueError(
            f"returned-with-forfeit needs both sides non-zero: "
            f"returnedUnits={returned}, forfeitedUnits={forfeited}"
        )
    if disposition in ("aborted", "expired-unsettled") and returned != stake:
        # Unlocking a TimeLockedHolding always pays the owner in full and this
        # mechanic cannot forfeit, so anything less describes value that went
        # nowhere.
        raise ValueError(
            f"{disposition} must return the stake in full: "
            f"returnedUnits={returned}, stakeUnits={stake}"
        )

    if payout > max_payout:
        raise ValueError(
            f"payout above the policy cap: payoutUnits={payout}, "
            f"maxPayoutUnits={max_payout}"
        )
    return True


def settlement_is_valid(settlement: Mapping[str, Any]) -> bool:
    """The predicate form. Prefer :func:`assert_settlement_valid` when reporting:
    which rule failed is the useful half."""
    try:
        return assert_settlement_valid(settlement)
    except (ValueError, TypeError, KeyError):
        return False
