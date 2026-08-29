"""arccade-sdk-digest-v1/sha256 — canonical encoding, amounts, Merkle, audit leaves.

This module MUST produce byte-identical output to `daml/ArCCade/GameSdk/Digest.daml`
and `js/src/digest.js`. The claim the whole package rests on is that a third party
can run plain `sha256sum` over a published document and find the digest that is on
the ledger; if the three implementations drift, that claim is gone.

Three rules a port gets wrong if nobody writes them down:

  1. LENGTHS ARE COUNTED IN UNICODE CODE POINTS. Python's ``len`` on ``str`` is
     already correct; JavaScript's ``.length`` and Java's ``String.length()`` are
     not (they count UTF-16 units and diverge on astral characters).
  2. AMOUNTS NEVER PASS THROUGH A BINARY FLOAT. A decimal literal is parsed as
     text into integer 1e-10 units. A native ``float`` is REFUSED rather than
     silently rounded: ``canon_decimal(123456789.0123456789)`` produced
     ``d:19:1234567890123456700`` here and ``...456789`` in JavaScript, both
     reporting success (conformance decision D4).
  3. TIMES ARE INTEGER MICROSECONDS SINCE THE EPOCH. An ISO string is never
     hashed, and any ISO conversion on a document path is microsecond-exact
     (decision D3).
"""

from __future__ import annotations

import calendar
import hashlib
import re
from decimal import Decimal
from typing import Any, Callable, Iterable, Mapping, NamedTuple, Sequence

__all__ = [
    "SCHEME_PREFIX", "DIGEST_ALG_ID",
    "code_point_length", "canon", "canon_text", "canon_int", "canon_bool",
    "canon_time_micros", "canon_party", "canon_optional", "canon_list",
    "canon_fields", "assert_field_name", "canon_document",
    "text_digest", "document_digest",
    "amount_units", "canon_decimal", "to_micros", "canon_time", "iso_to_micros",
    "MerkleStep", "merkle_empty", "merkle_node", "merkle_pair_up", "merkle_root",
    "merkle_proof", "merkle_fold", "merkle_verify",
    "DISPOSITIONS", "assert_disposition",
    "period_leaf_document", "period_leaf", "period_row_verify",
]

SCHEME_PREFIX = "arccade-sdk-digest-v1"
DIGEST_ALG_ID = "arccade-sdk-digest-v1/sha256"


# --------------------------------------------------------------- encoding

def code_point_length(s: str) -> int:
    """Length in UNICODE CODE POINTS, not UTF-16 units and not bytes."""
    if not isinstance(s, str):
        raise TypeError(f"{SCHEME_PREFIX}: metin bekleniyordu: {type(s).__name__}")
    return len(s)


def canon(tag: str, value: str) -> str:
    """The general encoding: ``<tag>:<length>:<value>``.

    The length prefix is what makes the encoding injective; without it
    ``a`` + ``bc`` and ``ab`` + ``c`` would encode identically.
    """
    return f"{tag}:{code_point_length(value)}:{value}"


def canon_text(s: str) -> str:
    return canon("t", s)


_INT_RE = re.compile(r"^-?[0-9]+$")


def canon_int(i: Any) -> str:
    """Integer encoding.

    A native boolean is REFUSED (decision D9): Python's ``str(True)`` yields
    ``i:4:True`` and JavaScript's ``BigInt(true)`` yields ``i:1:1``, so the same
    caller mistake produces two different documents that both look successful.
    A decimal string such as ``"100.0"`` is refused too — that is an amount, and
    amounts go through :func:`canon_decimal`.
    """
    if isinstance(i, bool):
        raise TypeError(f"{SCHEME_PREFIX}: desteklenmeyen tamsayi turu: bool")
    if isinstance(i, int):
        return canon("i", str(i))
    if isinstance(i, str):
        if not _INT_RE.match(i):
            raise ValueError(f"{SCHEME_PREFIX}: Cannot convert {i} to an integer")
        return canon("i", str(int(i)))
    raise TypeError(f"{SCHEME_PREFIX}: desteklenmeyen tamsayi turu: {type(i).__name__}")


def canon_bool(b: bool) -> str:
    return canon("b", "true" if b else "false")


def canon_time_micros(micros: Any) -> str:
    """Time is ALWAYS integer microseconds since the epoch; ISO text is never hashed."""
    # Validated by canon_int, then re-tagged: the two encodings differ only in
    # the tag letter, and routing through canon_int keeps one rule for what an
    # integer is (a boolean is not one).
    return "m" + canon_int(micros)[1:]


def canon_party(p: str) -> str:
    return canon("p", p)


def canon_optional(f: Callable[[Any], str], x: Any) -> str:
    return canon("o", "") if x is None else canon("o", f(x))


def canon_list(items: Iterable[str]) -> str:
    """List: element count, then ``|``-joined elements, which must already be canonical.

    Nothing escapes a ``|`` inside an element, so ``['a|b']`` and ``['a','b']``
    are disambiguated only by the count that precedes them.
    """
    xs = list(items)
    return canon("l", f"{len(xs)}:" + "|".join(xs))


_FIELD_NAME_RE = re.compile(r"^[a-zA-Z0-9-]+$")


def assert_field_name(name: str) -> str:
    """Field names are ASCII ``[a-zA-Z0-9-]`` (decision D6).

    This restriction is the reason Daml's ``sortOn``, Python's ``sorted`` and
    JavaScript's ``Array.sort`` agree on field order. Python was the one
    implementation that did not enforce it, which inverted the point of having
    an independent reference.
    """
    if not isinstance(name, str) or not _FIELD_NAME_RE.match(name):
        raise ValueError(
            f"{SCHEME_PREFIX}: alan adi ASCII [a-zA-Z0-9-] olmali, "
            f"siralama diller arasi belirsizlige duser: {name!r}"
        )
    return name


def canon_fields(kvs: Iterable[Sequence[Any]]) -> str:
    """Record: fields sorted BY NAME in code-point order.

    The sort is stable, so a duplicated name keeps its insertion order rather
    than being rejected — pinned, because a caller building fields from a map
    merge can emit one twice.
    """
    entries = [(k, v) for k, v in kvs]
    for k, _ in entries:
        assert_field_name(k)
    ordered = sorted(entries, key=lambda kv: kv[0])
    body = "".join(f"{canon('k', k)}={v};" for k, v in ordered)
    return canon("r", body)


def canon_document(schema: str, version: Any, kvs: Iterable[Sequence[Any]]) -> str:
    """The document envelope. The literal ``|`` appears only after the prefix."""
    return SCHEME_PREFIX + "|" + canon_text(schema) + canon_int(version) + canon_fields(kvs)


def text_digest(t: str) -> str:
    """sha256 over the RAW UTF-8 BYTES of the canonical text, lowercase hex.

    The empty string is REFUSED (decision D7): Daml's ``toHex ""`` is a runtime
    error, so a client that returns ``e3b0c442...`` computes a value the ledger
    can never produce. No document can reach it — every document starts with the
    scheme prefix — so the refusal costs nothing.
    """
    if not isinstance(t, str):
        raise TypeError(f"{SCHEME_PREFIX}: metin bekleniyordu: {type(t).__name__}")
    if t == "":
        raise ValueError(
            f"{SCHEME_PREFIX}: bos metin digest'lenemez; Daml toHex \"\" calisma "
            f"zamani hatasi verir, yani zincir bu degeri asla uretemez"
        )
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def document_digest(schema: str, version: Any, kvs: Iterable[Sequence[Any]]) -> str:
    return text_digest(canon_document(schema, version, kvs))


# ---------------------------------------------------------------- amounts

_UNITS_SCALE = 10 ** 10
# The Daml Int band, expressed in 1e-10 units.
_MAX_UNITS = 9223372036854775807
_MIN_UNITS = -9223372036854775808

_AMOUNT_RE = re.compile(r"^(-?)(\d+)(?:\.(\d*))?$")


def amount_units(d: Any) -> int:
    """Decimal amount -> integer 1e-10 units, with round-trip safety.

    Accepts ``str``, ``int`` and ``decimal.Decimal``. A ``float`` is refused
    unless it is integral, and surrounding whitespace is refused rather than
    trimmed: Daml does not trim, so a padded field accepted here and refused
    on the ledger is a divergence waiting for a production payload.
    """
    if isinstance(d, bool):
        raise TypeError(f"{SCHEME_PREFIX}: desteklenmeyen tutar turu: bool")
    if isinstance(d, str):
        s = d
    elif isinstance(d, int):
        s = str(d)
    elif isinstance(d, Decimal):
        if not d.is_finite():
            raise ValueError(f"{SCHEME_PREFIX}: gecersiz ondalik tutar: {str(d)!r}")
        s = format(d, "f")
    elif isinstance(d, float):
        if not float(d).is_integer():
            raise TypeError(
                f"{SCHEME_PREFIX}: kesirli tutar Number olarak verilemez "
                f"(hassasiyet kaybi riski), metin kullanin: {d!r}"
            )
        s = str(int(d))
    else:
        raise TypeError(f"{SCHEME_PREFIX}: desteklenmeyen tutar turu: {type(d).__name__}")

    m = _AMOUNT_RE.match(s)
    if not m:
        raise ValueError(f"{SCHEME_PREFIX}: gecersiz ondalik tutar: {s!r}")

    sign, int_part, frac_raw = m.group(1), m.group(2), m.group(3) or ""
    if len(frac_raw) > 10 and frac_raw[10:].strip("0"):
        # Round-trip safety: anything finer than 1e-10 cannot be represented.
        raise ValueError(f"{SCHEME_PREFIX}: tutar 1e-10 birimine kayipsiz cevrilemedi: {s}")
    frac = frac_raw[:10].ljust(10, "0")
    units = int(int_part) * _UNITS_SCALE + int(frac)
    signed = -units if sign == "-" else units

    if signed > _MAX_UNITS or signed < _MIN_UNITS:
        raise ValueError(
            f"{SCHEME_PREFIX}: tutar temsil edilebilir bandin disinda "
            f"(+/-922337203.6854775807): {s}"
        )
    return signed


def canon_decimal(d: Any) -> str:
    """An amount is NEVER hashed as a rendered decimal, only as integer units."""
    return canon("d", str(amount_units(d)))


# ------------------------------------------------------------------ time

_ISO_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$")


def iso_to_micros(iso: str) -> int:
    """Strict ISO 8601 -> integer microseconds. UTC (``Z``) only, microsecond-exact.

    Ledger stamps carry microseconds. Anything that routes through a
    millisecond-precision parser stops matching Daml on the third decimal, and
    the golden vectors all use whole seconds, so nothing else would catch it.
    An offset other than ``Z`` is refused rather than converted, because a
    conversion whose answer depends on the host's timezone database is not
    evidence.
    """
    if not isinstance(iso, str):
        raise TypeError(f"arccade-game-sdk: unparsable ledger timestamp: {iso!r}")
    m = _ISO_RE.match(iso)
    if not m:
        raise ValueError(f"arccade-game-sdk: unparsable ledger timestamp: {iso}")
    y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
    seconds = calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0))
    frac = ((m.group(7) or "") + "000000")[:6]
    return seconds * 1_000_000 + int(frac)


def to_micros(t: Any) -> int:
    """ISO text / datetime / integer microseconds -> integer microseconds."""
    if isinstance(t, bool):
        raise TypeError(f"{SCHEME_PREFIX}: desteklenmeyen zaman turu: bool")
    if isinstance(t, int):
        return t
    if isinstance(t, str):
        return iso_to_micros(t)
    tstamp = getattr(t, "timestamp", None)
    if callable(tstamp):
        # datetime: keep microseconds, never round to milliseconds.
        return int(round(tstamp() * 1_000_000))
    raise TypeError(f"{SCHEME_PREFIX}: desteklenmeyen zaman turu: {type(t).__name__}")


def canon_time(t: Any) -> str:
    return canon_time_micros(to_micros(t))


# ---------------------------------------------------------------- Merkle

class MerkleStep(NamedTuple):
    """One inclusion-proof step. Unpacks as ``(sibling_on_left, sibling)``."""

    sibling_on_left: bool
    sibling: str


def merkle_empty() -> str:
    """The root of an empty period. A day with no cycles is still anchored."""
    return document_digest("arccade.merkle-empty", 1, [])


def merkle_node(left: str, right: str) -> str:
    """An internal node. A DIFFERENT SCHEMA from a leaf, which is what stops a
    leaf being passed off as a node."""
    return document_digest(
        "arccade.merkle-node", 1, [("l", canon_text(left)), ("r", canon_text(right))]
    )


def merkle_pair_up(level: Sequence[str]) -> list:
    """A trailing odd node is PROMOTED, never duplicated (CVE-2012-2459)."""
    out = []
    for i in range(0, len(level), 2):
        out.append(merkle_node(level[i], level[i + 1]) if i + 1 < len(level) else level[i])
    return out


def merkle_root(leaves: Sequence[str]) -> str:
    if not leaves:
        return merkle_empty()
    level = list(leaves)
    while len(level) > 1:
        level = merkle_pair_up(level)
    return level[0]


def merkle_proof(ix: int, leaves: Sequence[str]) -> list:
    """Inclusion proof for leaf ``ix``.

    Returns ``[]`` rather than raising for an out-of-range index, so an empty
    proof is indistinguishable from a one-leaf tree: a caller must not read
    ``[]`` as proof of anything.
    """
    if ix < 0 or ix >= len(leaves):
        return []
    steps: list = []
    level = list(leaves)
    i = ix
    while len(level) > 1:
        sib = i + 1 if i % 2 == 0 else i - 1
        if sib < len(level):      # a promoted node has no sibling at this level
            steps.append(MerkleStep(i % 2 == 1, level[sib]))
        level = merkle_pair_up(level)
        i //= 2
    return steps


def merkle_fold(leaf: str, steps: Iterable[Sequence[Any]]) -> str:
    """Folds a proof to the root it implies. Split from :func:`merkle_verify` so a
    caller can display or diff the root rather than only compare it."""
    acc = leaf
    for step in steps:
        on_left, sibling = step
        acc = merkle_node(sibling, acc) if on_left else merkle_node(acc, sibling)
    return acc


def merkle_verify(leaf: str, steps: Iterable[Sequence[Any]], root: str) -> bool:
    """Deliberately weak: folding cannot know whether it started from a leaf, so
    this returns True for an internal node too. Auditors use
    :func:`period_row_verify`."""
    return merkle_fold(leaf, steps) == root


# ----------------------------------------------------------- audit leaves

DISPOSITIONS = (
    "returned-in-full",
    "returned-with-forfeit",
    "forfeited-in-full",
    "aborted",
    "expired-unsettled",
)


def assert_disposition(d: str) -> str:
    """The disposition is a TAG, not a Daml constructor name.

    Passing ``"ReturnedInFull"`` would silently produce different bytes and the
    mistake would only surface when an auditor tried to verify a proof — the
    latest possible moment. So it is checked here.
    """
    if d not in DISPOSITIONS:
        raise ValueError(
            f"{SCHEME_PREFIX}: gecersiz disposition: {d!r}; "
            f"beklenen etiketler: {', '.join(DISPOSITIONS)}"
        )
    return d


LEAF_FIELDS = (
    "cycleId", "player", "gameCode", "concurrencyIndex", "entryDigest",
    "outcomeDigest", "committedUnits", "feeUnits", "returnedUnits",
    "forfeitedUnits", "payoutUnits", "disposition", "committedAtMicros",
    "settledAtMicros", "custodyTag",
)


def period_leaf_document(row: Mapping[str, Any]) -> str:
    """The canonical text of one audit row — exactly fifteen fields.

    Amounts are INTEGER 1e-10 units (``canon_int``), not decimals, and
    timestamps are integers, not times: the report totals and the leaf bytes
    then have no rounding question between them.
    """
    return canon_document("arccade.cycle-audit-row", 1, [
        ("cycleId", canon_text(row["cycleId"])),
        ("player", canon_party(row["player"])),
        ("gameCode", canon_text(row["gameCode"])),
        ("concurrencyIndex", canon_int(row["concurrencyIndex"])),
        ("entryDigest", canon_text(row["entryDigest"])),
        ("outcomeDigest", canon_text(row["outcomeDigest"])),
        ("committedUnits", canon_int(row["committedUnits"])),
        ("feeUnits", canon_int(row["feeUnits"])),
        ("returnedUnits", canon_int(row["returnedUnits"])),
        ("forfeitedUnits", canon_int(row["forfeitedUnits"])),
        ("payoutUnits", canon_int(row["payoutUnits"])),
        ("disposition", canon_text(assert_disposition(row["disposition"]))),
        ("committedAtMicros", canon_int(row["committedAtMicros"])),
        ("settledAtMicros", canon_int(row["settledAtMicros"])),
        ("custodyTag", canon_text(row["custodyTag"])),
    ])


def period_leaf(row: Mapping[str, Any]) -> str:
    return text_digest(period_leaf_document(row))


def period_row_verify(row: Mapping[str, Any], steps: Iterable[Sequence[Any]], root: str) -> bool:
    """THE ENDPOINT AN AUDITOR SHOULD USE: derives the leaf FROM THE ROW.

    Calling raw :func:`merkle_verify` on a hash returns True for an internal
    node as well. Deriving the leaf from the row binds the claim "this is a
    cycle row" to the ``arccade.cycle-audit-row`` schema.
    """
    return merkle_verify(period_leaf(row), steps, root)
