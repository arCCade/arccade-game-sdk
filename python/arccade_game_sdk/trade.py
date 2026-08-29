"""Marketplace and item trading — the second kind of value event written on-chain.

ARCHITECTURAL RULE. This SDK has no write API that does not move value, and it
never will. Game activity — score, level, inventory state, matchmaking, ranking,
session records — stays in the application's OWN DATABASE. Only three things are
written: value commitment and settlement (``cycle``), change of ownership (this
module), and plain value transfer (``transfer``).

The trade document is NOT the canonical length-prefixed encoding: it is a
pipe-joined ``k=v`` line under ``arccade-game-sdk:trade:1:``. Because it has no
length prefixes, a ``|`` inside any component silently reshapes the document —
the exact ambiguity ``canon``'s length prefix exists to prevent — so v1 REFUSES
a pipe in any component (conformance decision D8). A canonical v2 replaces the
format rather than patching it.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any, Mapping, Optional

from .digest import text_digest

__all__ = [
    "TRADE_TAG_PREFIX", "LEG_OFFER", "LEG_ASK",
    "new_trade_id", "assert_valid_trade_id", "leg",
    "trade_document", "trade_digest",
    "build_trade_proposal_commands", "build_trade_settle_commands",
    "build_trade_cancel_commands",
]

TRADE_TAG_PREFIX = "arccade-game-sdk:trade:1:"

# The canonical keys of a trade's two legs.
LEG_OFFER = "offer"
LEG_ASK = "ask"


def new_trade_id(prefix: str = "t") -> str:
    return assert_valid_trade_id(f"{prefix}-{uuid.uuid4()}")


def assert_valid_trade_id(trade_id: str) -> str:
    if not isinstance(trade_id, str) or len(trade_id) == 0 or len(trade_id) > 64:
        raise ValueError(f"gecersiz tradeId (bos olmamali, <=64 kod noktasi): {trade_id!r}")
    if ":" in trade_id or "|" in trade_id:
        raise ValueError(f"tradeId ':' veya '|' iceremez: {trade_id}")
    return trade_id


def leg(spec: Mapping[str, Any]) -> dict:
    """One leg of a trade: "X sends N units of INSTR to Y".

    ``instrumentId.admin`` is that asset's registry: the DSO for CC, the minting
    application's registry party for a game item. The SDK does not interpret the
    asset — it carries the legs and settles them atomically.
    """
    sender = spec.get("sender")
    receiver = spec.get("receiver")
    instrument_id = spec.get("instrumentId")
    amount = spec.get("amount")
    if not sender or not receiver:
        raise TypeError("takas bacagi sender ve receiver ister")
    if sender == receiver:
        raise ValueError("takas bacaginda sender ve receiver ayni olamaz")
    if not isinstance(instrument_id, Mapping) or not instrument_id.get("admin") \
            or not instrument_id.get("id"):
        raise TypeError("instrumentId {admin, id} olmali (varligin registry partisi + kimligi)")
    if not Decimal(str(amount)) > 0:
        raise ValueError(f"takas bacagi tutari pozitif olmali: {amount}")
    return {"sender": sender, "receiver": receiver,
            "instrumentId": dict(instrument_id), "amount": str(amount)}


def _no_pipe(where: str, value: str) -> str:
    """v1 has no length prefixes, so a separator inside a component is fatal."""
    if "|" in value:
        raise ValueError(
            f"takas belgesi bileseni '|' iceremez (belge ayristirilamaz olur): "
            f"{where}={value!r}"
        )
    return value


def _legs_items(legs: Any) -> list:
    return list(legs.items()) if isinstance(legs, Mapping) else [(k, v) for k, v in legs]


def _meta_items(meta: Any) -> list:
    if not meta:
        return []
    return list(meta.items()) if isinstance(meta, Mapping) else [(k, v) for k, v in meta]


def trade_document(trade: Mapping[str, Any]) -> str:
    """The trade's canonical document.

    Only the digest goes on-chain; the document is published by the application.
    An item's name, art, rarity and in-game effect are never written. What is
    written is the CHANGE OF OWNERSHIP.
    """
    trade_id = trade["tradeId"]
    assert_valid_trade_id(trade_id)
    maker = trade["maker"]
    taker = trade.get("taker") or ""
    expires_at = trade["expiresAt"]
    expires_at = expires_at if isinstance(expires_at, str) else expires_at.isoformat()

    parts = [
        f"tradeId={_no_pipe('tradeId', trade_id)}",
        f"maker={_no_pipe('maker', maker)}",
        f"taker={_no_pipe('taker', taker)}",
        f"expiresAt={_no_pipe('expiresAt', expires_at)}",
    ]
    for k, l in sorted(_legs_items(trade["legs"]), key=lambda kv: kv[0]):
        instrument = l["instrumentId"]
        component = (f"{l['sender']}>{l['receiver']}:{l['amount']}:"
                     f"{instrument['admin']}/{instrument['id']}")
        parts.append(f"leg.{_no_pipe('leg-key', k)}={_no_pipe('leg', component)}")
    for k, v in sorted(_meta_items(trade.get("meta")), key=lambda kv: kv[0]):
        parts.append(f"meta.{_no_pipe('meta-key', k)}={_no_pipe('meta', str(v))}")
    return TRADE_TAG_PREFIX + "|".join(parts)


def trade_digest(trade: Mapping[str, Any]) -> str:
    return text_digest(trade_document(trade))


def _tpl(package_id: str, module: str, entity: str) -> str:
    return f"{package_id}:{module}:{entity}"


def build_trade_proposal_commands(opts: Mapping[str, Any]) -> dict:
    """STEP 1 — the proposal. The maker signs, the venue observes. A ``None``
    taker means an open offer.

    This is an INVITATION rather than a write, and it carries value: accepting it
    changes ownership. Value-less events such as "listing viewed" stay in the
    application's database.
    """
    o = dict(opts)
    trade_id = o["tradeId"]
    assert_valid_trade_id(trade_id)
    legs = o.get("legs") or {}
    legs_map = dict(_legs_items(legs))
    if LEG_OFFER not in legs_map or LEG_ASK not in legs_map:
        raise ValueError(f'takas iki bacak ister: "{LEG_OFFER}" ve "{LEG_ASK}"')
    exp = o["expiresAt"] if isinstance(o["expiresAt"], str) else o["expiresAt"].isoformat()
    settle = o["settleBefore"] if isinstance(o["settleBefore"], str) else o["settleBefore"].isoformat()
    meta = dict(_meta_items(o.get("meta")))
    maker, venue, taker = o["maker"], o["venue"], o.get("taker")

    cmd = {
        "CreateCommand": {
            "templateId": _tpl(o["sdkPackageId"], "ArCCade.GameSdk.Trade", "TradeProposal"),
            "createArguments": {
                "venue": venue,
                "tradeId": trade_id,
                "maker": maker,
                "taker": taker,
                "legs": {"values": legs_map},
                "expiresAt": exp,
                "settleBefore": settle,
                "tradeDigest": trade_digest({
                    "tradeId": trade_id, "maker": maker, "taker": taker,
                    "legs": legs_map, "expiresAt": exp, "meta": meta,
                }),
                "meta": {"values": meta},
            },
        }
    }
    return {
        "tradeId": trade_id,
        "commands": [cmd],
        "actAs": [maker],
        "submission": {
            "commands": {
                "commands": [cmd],
                "commandId": o.get("commandId") or f"trade-propose-{trade_id}",
                "actAs": [maker],
                "readAs": [maker, venue],
            }
        },
    }


def build_trade_settle_commands(opts: Mapping[str, Any]) -> dict:
    """STEP 2 — atomic settlement. The venue runs every leg in ONE transaction,
    so there is no intermediate state where the item left and the CC never came."""
    o = dict(opts)
    allocations = o.get("allocations") or {}
    if not allocations:
        raise ValueError("settle icin her bacagin allocation contract id si gerekli")
    trade_cid = o["tradeCid"]
    venue = o["venue"]
    cmd = {
        "ExerciseCommand": {
            "templateId": _tpl(o["sdkPackageId"], "ArCCade.GameSdk.Trade", "Trade"),
            "contractId": trade_cid,
            "choice": "Trade_Settle",
            "choiceArgument": {"allocations": {"values": dict(allocations)}},
        }
    }
    read_as = [p for p in [venue, o.get("maker"), o.get("taker")] if p]
    return {
        "commands": [cmd],
        "actAs": [venue],
        "submission": {
            "commands": {
                "commands": [cmd],
                "commandId": o.get("commandId") or f"trade-settle-{trade_cid[:16]}",
                "actAs": [venue],
                "readAs": read_as,
            }
        },
    }


def build_trade_cancel_commands(opts: Mapping[str, Any]) -> dict:
    o = dict(opts)
    trade_cid = o["tradeCid"]
    venue = o["venue"]
    cmd = {
        "ExerciseCommand": {
            "templateId": _tpl(o["sdkPackageId"], "ArCCade.GameSdk.Trade", "Trade"),
            "contractId": trade_cid,
            "choice": "Trade_Cancel",
            "choiceArgument": {"reason": o.get("reason", "")},
        }
    }
    return {
        "commands": [cmd],
        "actAs": [venue],
        "submission": {
            "commands": {
                "commands": [cmd],
                "commandId": o.get("commandId") or f"trade-cancel-{trade_cid[:16]}",
                "actAs": [venue],
            }
        },
    }
