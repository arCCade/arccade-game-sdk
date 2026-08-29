"""Ledger time arithmetic — the same truncation Daml does, in Python.

Every duration check in Policy.daml and Cycle.daml runs through this, and Daml's
Int division TRUNCATES TOWARD ZERO while Python's ``//`` floors. The two agree on
positive operands and disagree on negative ones, which is exactly where a
pre-epoch or clock-skewed timestamp lands.

``seconds_between`` truncates EACH ENDPOINT independently before subtracting, so
0.9s to 60.0s is SIXTY seconds, not fifty-nine. That is the single most dangerous
behaviour in the package: it decides whether a lock or a cycle is long enough, so
a client computing ``(b - a) / 1e6`` refuses cycles the ledger accepts.

Times are integer microseconds since the epoch throughout.
"""

from __future__ import annotations

__all__ = ["int_divide", "epoch_seconds", "seconds_between", "add_seconds"]


def int_divide(a: int, b: int) -> int:
    """Integer division truncating TOWARD ZERO, as Daml's ``/`` on Int does.

    ``int_divide(-7, 2) == -3``; floor division would give -4.
    """
    q = abs(a) // abs(b)
    return -q if (a < 0) != (b < 0) else q


def epoch_seconds(micros: int) -> int:
    """Epoch microseconds -> epoch seconds, truncated toward zero."""
    return int_divide(micros, 1_000_000)


def seconds_between(a_micros: int, b_micros: int) -> int:
    """``epoch_seconds(b) - epoch_seconds(a)``.

    Negative when b precedes a. The caller checks the sign; taking an absolute
    value here would accept a lock that expires before it starts.
    """
    return epoch_seconds(b_micros) - epoch_seconds(a_micros)


def add_seconds(micros: int, seconds: int) -> int:
    """Adds whole seconds to an instant. Used for cooldowns and deadlines."""
    return micros + seconds * 1_000_000
