"""Plain value transfer — the third and last kind of value event written on-chain.

Used for reward distribution, player-to-player sends, tournament payouts and
refunds. Unlike a trade there is no consideration; unlike a cycle there is no
lock and no settlement.

THIS IS THE MOST ABUSABLE ENDPOINT and it is deliberately the narrowest:

  * One-way, without consideration. Anything two-way is a ``trade``.
  * The sender ALWAYS signs. A tenant cannot move a player's balance without it.
  * Self-transfer is refused: it is the cheapest way to manufacture volume.
  * In a batch the same recipient cannot repeat; paying one party twice in one
    transaction is a single payment split to inflate a transaction count.

A player can still manufacture volume by sending small amounts repeatedly — but
each one burns real CC and a real network fee. Beyond that deterrence, the
protection is the tenant quota in ``tenant.py``.

Like the trade document, this format is pipe-joined and carries NO length
prefixes, so a ``|`` in any component is refused (decision D8).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence

from .digest import text_digest

__all__ = [
    "TRANSFER_TAG_PREFIX", "REASON_REWARD", "REASON_PAYOUT", "REASON_REFUND",
    "REASON_P2P", "REASONS", "transfer_document", "transfer_digest",
    "build_transfer_commands",
]

TRANSFER_TAG_PREFIX = "arccade-game-sdk:transfer:1:"

# Why the value moved — a reporting classification that enters the chain as part
# of the digest.
REASON_REWARD = "reward"
REASON_PAYOUT = "payout"
REASON_REFUND = "refund"
REASON_P2P = "p2p"

REASONS = (REASON_REWARD, REASON_PAYOUT, REASON_REFUND, REASON_P2P)


def _no_pipe(where: str, value: str) -> str:
    if "|" in value:
        raise ValueError(
            f"transfer belgesi bileseni '|' iceremez (belge ayristirilamaz olur): "
            f"{where}={value!r}"
        )
    return value


def _meta_items(meta: Any) -> list:
    if not meta:
        return []
    return list(meta.items()) if isinstance(meta, Mapping) else [(k, v) for k, v in meta]


def transfer_document(transfer: Mapping[str, Any]) -> str:
    """The transfer's canonical document. Recipient ORDER IS PRESERVED, because
    the batch order is what the ledger transaction will carry."""
    parts = [
        f"transferId={_no_pipe('transferId', str(transfer['transferId']))}",
        f"sender={_no_pipe('sender', str(transfer['sender']))}",
        f"reason={_no_pipe('reason', str(transfer['reason']))}",
    ]
    for r in transfer["recipients"]:
        instrument = r["instrumentId"]
        component = (f"{r['receiver']}:{r['amount']}:"
                     f"{instrument['admin']}/{instrument['id']}")
        parts.append(f"to={_no_pipe('to', component)}")
    for k, v in sorted(_meta_items(transfer.get("meta")), key=lambda kv: kv[0]):
        parts.append(f"meta.{_no_pipe('meta-key', k)}={_no_pipe('meta', str(v))}")
    return TRANSFER_TAG_PREFIX + "|".join(parts)


def transfer_digest(transfer: Mapping[str, Any]) -> str:
    return text_digest(transfer_document(transfer))


def build_transfer_commands(opts: Mapping[str, Any]) -> dict:
    """CC transfer to one or more recipients (``AmuletRules_Transfer``).

    A batch is ONE transaction: rewarding N players costs 1 transaction, not N.
    That is both cheaper and honest about qualifying activity — the SDK does not
    make it easy to inflate a transaction count by splitting one payment.
    """
    o = dict(opts)
    recipients = o.get("recipients")
    if not isinstance(recipients, (list, tuple)) or len(recipients) == 0:
        raise ValueError("en az bir alici gerekli")
    reason = o.get("reason", REASON_P2P)
    if reason not in REASONS:
        raise ValueError(f"bilinmeyen sebep: {reason} (gecerli: {', '.join(REASONS)})")
    input_amulet_cids = o.get("inputAmuletCids")
    if not isinstance(input_amulet_cids, (list, tuple)) or len(input_amulet_cids) == 0:
        raise ValueError("inputAmuletCids bos olamaz")

    sender = o["sender"]
    provider = o["provider"]
    seen = set()
    for r in recipients:
        if not r.get("receiver"):
            raise TypeError("alici partisi gerekli")
        if r["receiver"] == sender:
            # The cheapest way to manufacture volume; closed at source.
            raise ValueError("kendine transfer reddedilir")
        if r["receiver"] in seen:
            raise ValueError(f"ayni alici tekrar edemez: {r['receiver']}")
        seen.add(r["receiver"])
        if not Decimal(str(r["amount"])) > 0:
            raise ValueError(f"transfer tutari pozitif olmali: {r['amount']}")

    outputs = [{"receiver": r["receiver"], "amount": str(r["amount"]),
                "receiverFeeRatio": "0.0"} for r in recipients]

    cmd = {
        "ExerciseCommand": {
            "templateId": f"{o['amuletPackageId']}:Splice.AmuletRules:AmuletRules",
            "contractId": o["amuletRulesCid"],
            "choice": "AmuletRules_Transfer",
            "choiceArgument": {
                "transfer": {
                    "sender": sender,
                    "provider": provider,
                    "inputs": [{"tag": "InputAmulet", "value": cid} for cid in input_amulet_cids],
                    "outputs": outputs,
                    "beneficiaries": None,
                },
                "context": {
                    "openMiningRound": o["openMiningRoundCid"],
                    "issuingMiningRounds": [],
                    "validatorRights": [],
                },
                "expectedDso": o["dsoParty"],
            },
        }
    }

    doc_input = {"transferId": o["transferId"], "sender": sender,
                 "recipients": recipients, "reason": reason,
                 "meta": dict(_meta_items(o.get("meta")))}
    # The sender ALWAYS signs: a tenant cannot move a player's balance without it.
    act_as = list(dict.fromkeys([sender, provider]))
    return {
        "transferId": o["transferId"],
        # The document is published by the application; only the reason and the
        # amounts reach the chain.
        "document": transfer_document(doc_input),
        "digest": transfer_digest(doc_input),
        "commands": [cmd],
        "actAs": act_as,
        "submission": {
            "commands": {
                "commands": [cmd],
                "commandId": o.get("commandId") or f"transfer-{o['transferId']}",
                "actAs": act_as,
                "readAs": act_as,
            }
        },
    }
