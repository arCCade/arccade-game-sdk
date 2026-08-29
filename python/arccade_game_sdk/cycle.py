"""The two-write cycle: identifiers, the custody tag, and the ledger command builders.

The SDK's actual value is here — the cycle discipline is turned into code so a
game developer cannot get it wrong:

  * WRITE 1 is exactly TWO commands and they MUST travel in ONE submission. Sent
    apart, the lock and the GameStake come uncoupled: the commit can succeed
    while the transfer fails, or the reverse.
  * WRITE 2 has a MANDATORY ORDER. ``GameStake_Settle`` pulls the lock through
    the Holding interface, so it must come BEFORE ``LockedAmulet_UnlockV2``,
    which archives it. Reversed, settlement is rejected with "no custody proof".
  * ``optContext`` carries the custody tag. Writing generic prose there makes the
    stake unsettleable: settlement cannot verify the tag and the cycle can only
    be aborted.

Commands are JSON Ledger API v2 payloads; submitting them is left to the caller.
"""

from __future__ import annotations

import uuid
from typing import Any, Mapping, Optional, Sequence

from .digest import DIGEST_ALG_ID, amount_units, code_point_length, text_digest

__all__ = [
    "CUSTODY_TAG_PREFIX", "DRY_RUN_VENUE_PREFIX", "DIGEST_ALG_ID",
    "assert_valid_cycle_id", "assert_hex64", "custody_tag_for", "new_cycle_id",
    "build_commit_commands", "build_dry_run_commit_commands",
    "build_settle_commands", "build_abort_commands", "build_expire_commands",
]

CUSTODY_TAG_PREFIX = "arccade-game-sdk:1:"
DRY_RUN_VENUE_PREFIX = "dryrun-"

_HEX64 = "0123456789abcdef"


def assert_valid_cycle_id(cycle_id: str) -> str:
    """Non-empty, at most 64 CODE POINTS, and free of ``:`` and ``|``.

    Sixty-four CODE POINTS, matching Daml's ``T.length`` (decision D2). A UTF-16
    unit count refuses an id the ledger already accepted, which breaks the
    auditor path on a cycle that exists.
    """
    if not isinstance(cycle_id, str) or len(cycle_id) == 0 or code_point_length(cycle_id) > 64:
        raise ValueError(
            f"gecersiz cycleId (bos olmamali, <=64 kod noktasi): {cycle_id!r}"
        )
    if ":" in cycle_id or "|" in cycle_id:
        raise ValueError(
            f"cycleId ':' veya '|' iceremez (etiket ayristirilamaz olur): {cycle_id}"
        )
    return cycle_id


def assert_hex64(h: str) -> str:
    if not isinstance(h, str) or len(h) != 64 or any(c not in _HEX64 for c in h):
        raise ValueError(f"64 karakterlik kucuk harf sha256 bekleniyordu: {h!r}")
    return h


def custody_tag_for(cycle_id: str, entry_digest: str) -> str:
    """``arccade-game-sdk:1:<cycleId>:<entryDigest>`` — what binds a real ledger
    lock to one cycle and its entry commitment."""
    assert_valid_cycle_id(cycle_id)
    assert_hex64(entry_digest)
    return CUSTODY_TAG_PREFIX + cycle_id + ":" + entry_digest


def new_cycle_id(prefix: str = "c") -> str:
    """A fresh, unique cycle id.

    UNIQUENESS MATTERS: there is no contract key, so the ledger cannot stop the
    same ``cycleId`` + ``entryDigest`` pair being reused, and one lock carrying a
    repeated tag could "prove" several cycles. That is a known, reported limit of
    the design; the SDK closes it at source. Always take the id from here.
    """
    return assert_valid_cycle_id(f"{prefix}-{uuid.uuid4()}")


def _tpl(package_id: str, module: str, entity: str) -> str:
    return f"{package_id}:{module}:{entity}"


def _iso(t: Any) -> str:
    if isinstance(t, str):
        return t
    isoformat = getattr(t, "isoformat", None)
    if callable(isoformat):
        return isoformat()
    raise TypeError(f"lockExpiresAt ISO metni ya da datetime olmali: {type(t).__name__}")


def _amount_text(name: str, value: Any) -> str:
    """Serialises an amount for the wire.

    An omitted amount is REFUSED (decision D10). The JavaScript builders call
    bare ``String()``, so a missing ``feeAmount`` reaches the ledger as the
    literal text ``"undefined"`` — verified. Refusing costs one line.
    """
    if value is None:
        raise TypeError(f"{name} verilmeli: eksik tutar zincire metin olarak gider")
    if isinstance(value, bool):
        raise TypeError(f"{name} tutar olmali, bool degil")
    if isinstance(value, float):
        raise TypeError(f"{name} kesirli tutar Number olarak verilemez, metin kullanin: {value!r}")
    return str(value)


def amount_is_positive(text: str) -> bool:
    """True when a wire amount is strictly positive, parsed as an exact decimal.

    Not ``float(text) > 0``: the whole point of the amount layer is that a
    decimal never passes through a binary float.
    """
    return amount_units(text) > 0


def build_commit_commands(opts: Mapping[str, Any]) -> dict:
    """WRITE 1 — the commitment. Two commands, one submission, one updateId."""
    o = dict(opts)
    cycle_id = o["cycleId"]
    entry_digest = o["entryDigest"]
    assert_valid_cycle_id(cycle_id)
    assert_hex64(entry_digest)
    input_amulet_cids = o.get("inputAmuletCids")
    if not isinstance(input_amulet_cids, (list, tuple)) or len(input_amulet_cids) == 0:
        raise ValueError("inputAmuletCids bos olamaz: kilitlenecek Amulet girdisi yok")

    venue, player, operator = o["venue"], o["player"], o["operator"]
    expires_at = _iso(o["lockExpiresAt"])
    custody_tag = custody_tag_for(cycle_id, entry_digest)
    stake_amount = _amount_text("stakeAmount", o.get("stakeAmount"))
    fee_amount = _amount_text("feeAmount", o.get("feeAmount"))

    outputs = []
    if amount_is_positive(fee_amount):
        outputs.append({"receiver": venue, "amount": fee_amount, "receiverFeeRatio": "0.0"})
    outputs.append({
        "receiver": player,
        "amount": stake_amount,
        "receiverFeeRatio": "0.0",
        # The field that binds the lock to the cycle. Do NOT write generic prose.
        "lock": {"holders": [venue], "expiresAt": expires_at, "optContext": custody_tag},
    })

    transfer_cmd = {
        "ExerciseCommand": {
            "templateId": _tpl(o["amuletPackageId"], "Splice.AmuletRules", "AmuletRules"),
            "contractId": o["amuletRulesCid"],
            "choice": "AmuletRules_Transfer",
            "choiceArgument": {
                "transfer": {
                    "sender": player,
                    "provider": venue,
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

    commit_cmd = {
        "ExerciseCommand": {
            "templateId": _tpl(o["sdkPackageId"], "ArCCade.GameSdk.Cycle", "PlayerEntitlement"),
            "contractId": o["entitlementCid"],
            "choice": "Entitlement_Commit",
            "choiceArgument": {
                "gameCode": o["gameCode"],
                "cycleId": cycle_id,
                "terms": {
                    "stakeAmount": stake_amount,
                    "feeAmount": fee_amount,
                    "feeReceiver": venue,
                    "instrumentId": o["instrumentId"],
                    "custody": "TimeLockedHolding",
                    "lockHolders": [venue],
                    "lockExpiresAt": expires_at,
                    "custodyTag": custody_tag,
                },
                "entryDigest": entry_digest,
                "stakeMeta": {"values": dict(o.get("stakeMeta") or {})},
            },
        }
    }

    commands = [transfer_cmd, commit_cmd]
    return {
        "custodyTag": custody_tag,
        "cycleId": cycle_id,
        "commands": commands,
        "actAs": [player, venue, operator],
        "readAs": [player, venue],
        "submission": {
            "commands": {
                "commands": commands,
                "commandId": o.get("commandId") or f"commit-{cycle_id}",
                "actAs": [player, venue, operator],
                "readAs": [player, venue],
            }
        },
    }


def build_dry_run_commit_commands(opts: Mapping[str, Any]) -> dict:
    """Commit for a DRY RUN — ONE command, no lock.

    ``ModeDryRun`` is already constrained by the venue contract: the venueId must
    start with ``dryrun-`` and both the fee floor and the maximum payout must be
    zero, so a dry-run cycle cannot be reported as a real one. The custody tag is
    still computed and written into the terms, because skipping it would create a
    difference that first appeared on the way to production.
    """
    o = dict(opts)
    cycle_id = o["cycleId"]
    entry_digest = o["entryDigest"]
    assert_valid_cycle_id(cycle_id)
    assert_hex64(entry_digest)
    venue, player, operator = o["venue"], o["player"], o["operator"]
    expires_at = _iso(o["lockExpiresAt"])
    custody_tag = custody_tag_for(cycle_id, entry_digest)

    commit_cmd = {
        "ExerciseCommand": {
            "templateId": _tpl(o["sdkPackageId"], "ArCCade.GameSdk.Cycle", "PlayerEntitlement"),
            "contractId": o["entitlementCid"],
            "choice": "Entitlement_Commit",
            "choiceArgument": {
                "gameCode": o["gameCode"],
                "cycleId": cycle_id,
                "terms": {
                    "stakeAmount": _amount_text("stakeAmount", o.get("stakeAmount")),
                    # Mode discipline forces a zero fee on the contract; writing
                    # it explicitly stops a caller expecting to charge one.
                    "feeAmount": "0.0",
                    "feeReceiver": venue,
                    "instrumentId": o["instrumentId"],
                    "custody": "TimeLockedHolding",
                    "lockHolders": [venue],
                    "lockExpiresAt": expires_at,
                    "custodyTag": custody_tag,
                },
                "entryDigest": entry_digest,
                "stakeMeta": {"values": dict(o.get("stakeMeta") or {})},
            },
        }
    }
    commands = [commit_cmd]
    return {
        "custodyTag": custody_tag,
        "cycleId": cycle_id,
        "commands": commands,
        "actAs": [player, venue, operator],
        "readAs": [player, venue],
        "submission": {
            "commands": {
                "commands": commands,
                "commandId": o.get("commandId") or f"dryrun-commit-{cycle_id}",
                "actAs": [player, venue, operator],
                "readAs": [player, venue],
            }
        },
    }


def build_settle_commands(opts: Mapping[str, Any]) -> dict:
    """WRITE 2 — settlement. Settle BEFORE unlock; the reverse is rejected."""
    o = dict(opts)
    disposition = o.get("disposition", "ReturnedInFull")
    returned = _amount_text("returnedAmount", o.get("returnedAmount"))
    forfeited = _amount_text("forfeitedAmount", o.get("forfeitedAmount", "0.0"))
    payout = _amount_text("payoutAmount", o.get("payoutAmount", "0.0"))
    outcome_document = o.get("outcomeDocument")
    digest = o.get("outcomeDigest") or (text_digest(outcome_document) if outcome_document else None)
    if not digest:
        raise ValueError("outcomeDocument ya da outcomeDigest verilmeli")
    assert_hex64(digest)

    if disposition == "ReturnedInFull" and amount_units(forfeited) != 0:
        raise ValueError("ReturnedInFull stake in tamamini iade etmeli (forfeitedAmount 0 olmali)")
    if disposition == "ForfeitedInFull" and amount_units(returned) != 0:
        raise ValueError("ForfeitedInFull hicbir sey iade etmemeli (returnedAmount 0 olmali)")

    stake_cid = o["stakeCid"]
    locked_amulet_cid = o.get("lockedAmuletCid")
    reveal_outcome = o.get("revealOutcome", True)

    settle_cmd = {
        "ExerciseCommand": {
            "templateId": _tpl(o["sdkPackageId"], "ArCCade.GameSdk.Cycle", "GameStake"),
            "contractId": stake_cid,
            "choice": "GameStake_Settle",
            "choiceArgument": {
                "disposition": disposition,
                "returnedAmount": returned,
                "forfeitedAmount": forfeited,
                "payoutAmount": payout,
                "outcomeDigest": digest,
                "revealedOutcome": outcome_document if (reveal_outcome and outcome_document) else None,
                "revealedEntry": o.get("revealedEntry"),
                "custodyRef": ({"tag": "HoldingRef", "value": locked_amulet_cid}
                               if locked_amulet_cid else None),
                "settlementMeta": {"values": dict(o.get("settlementMeta") or {})},
            },
        }
    }

    commands = [settle_cmd]
    if locked_amulet_cid:
        commands.append({
            "ExerciseCommand": {
                "templateId": _tpl(o["amuletPackageId"], "Splice.Amulet", "LockedAmulet"),
                "contractId": locked_amulet_cid,
                "choice": "LockedAmulet_UnlockV2",
                "choiceArgument": {},
            }
        })

    parties = [o["operator"], o["venue"], o["player"]]
    return {
        "commands": commands,
        "actAs": parties,
        "readAs": parties,
        "outcomeDigest": digest,
        "submission": {
            "commands": {
                "commands": commands,
                "commandId": o.get("commandId") or f"settle-{stake_cid[:16]}",
                "actAs": parties,
                "readAs": parties,
            }
        },
    }


def build_abort_commands(opts: Mapping[str, Any]) -> dict:
    """Aborting a cycle. The custody proof is DELIBERATELY optional: the reason
    abort exists is that the lock may never have been created. The cycle does not
    count, and the longer ``abortCooldownSeconds`` holds the slot out of use."""
    o = dict(opts)
    stake_cid = o["stakeCid"]
    locked_amulet_cid = o.get("lockedAmuletCid")
    cmd = {
        "ExerciseCommand": {
            "templateId": _tpl(o["sdkPackageId"], "ArCCade.GameSdk.Cycle", "GameStake"),
            "contractId": stake_cid,
            "choice": "GameStake_Abort",
            "choiceArgument": {
                "reason": o.get("reason"),
                "custodyRef": ({"tag": "HoldingRef", "value": locked_amulet_cid}
                               if locked_amulet_cid else None),
            },
        }
    }
    act_as = [o["operator"], o["player"]]
    return {
        "commands": [cmd],
        "actAs": act_as,
        "submission": {
            "commands": {
                "commands": [cmd],
                "commandId": o.get("commandId") or f"abort-{stake_cid[:16]}",
                "actAs": act_as,
                "readAs": [o["operator"], o["venue"], o["player"]],
            }
        },
    }


def build_expire_commands(opts: Mapping[str, Any]) -> dict:
    """The player's unconditional exit: after the lock expires they recover both
    their funds and their slot without arCCade and without the DSO."""
    o = dict(opts)
    stake_cid = o["stakeCid"]
    player = o["player"]
    locked_amulet_cid = o.get("lockedAmuletCid")
    commands = [{
        "ExerciseCommand": {
            "templateId": _tpl(o["sdkPackageId"], "ArCCade.GameSdk.Cycle", "GameStake"),
            "contractId": stake_cid,
            "choice": "GameStake_ExpireUnsettled",
            "choiceArgument": {},
        }
    }]
    if locked_amulet_cid:
        commands.append({
            "ExerciseCommand": {
                "templateId": _tpl(o["amuletPackageId"], "Splice.Amulet", "LockedAmulet"),
                "contractId": locked_amulet_cid,
                "choice": "LockedAmulet_OwnerExpireLockV2",
                "choiceArgument": {},
            }
        })
    return {
        "commands": commands,
        "actAs": [player],
        "submission": {
            "commands": {
                "commands": commands,
                "commandId": o.get("commandId") or f"expire-{stake_cid[:16]}",
                "actAs": [player],
                "readAs": [player],
            }
        },
    }
