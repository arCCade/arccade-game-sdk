"""arccade-game-sdk — game-economy primitives for the Canton Network, in Python.

ARCHITECTURAL RULE. This SDK has NO WRITE API THAT DOES NOT MOVE VALUE. Game
activity — score, level, inventory state, matchmaking, ranking, session records,
achievements — stays in the application's OWN DATABASE. Only ownership and value
events are written on-chain:

  1. ``cycle``     value commitment + settlement  (a stake is locked, then resolved)
  2. ``trade``     change of ownership            (marketplace, item swap)
  3. ``transfer``  plain value movement

The spam protection is not a rule list but an ABSENCE: there is no "write the
score on-chain" endpoint, so nobody can spam it. Every endpoint that exists moves
real value and therefore imposes a real cost on an attacker.

Everything the game knows is reduced to a canonical text document and only its
sha256 goes on-chain. The document is published by the application; a third party
verifies it with ``sha256sum``. No library required.

This package is the third implementation of the digest scheme, alongside
``daml/ArCCade/GameSdk/`` and ``js/src/``. Where the three disagreed, the
conformance suite under ``conformance/`` decides, and this client follows the
suite rather than the other clients — see its README for the decision list.
"""

from __future__ import annotations

from .digest import (DIGEST_ALG_ID, DISPOSITIONS, LEAF_FIELDS, SCHEME_PREFIX,
                     MerkleStep, amount_units, assert_disposition,
                     assert_field_name, canon, canon_bool, canon_decimal,
                     canon_document, canon_fields, canon_int, canon_list,
                     canon_optional, canon_party, canon_text, canon_time,
                     canon_time_micros, code_point_length, document_digest,
                     iso_to_micros, merkle_empty, merkle_fold, merkle_node,
                     merkle_pair_up, merkle_proof, merkle_root, merkle_verify,
                     period_leaf, period_leaf_document, period_row_verify,
                     text_digest, to_micros)

from .cycle_audit import (AuditReport, CLOSING_CHOICES, DISPOSITION_TAGS,
                          REPORT_ORDER, SDK_MODULE, closing_facts, commit_facts,
                          rows_from_transactions, to_leaf_row)

from .cycle import (CUSTODY_TAG_PREFIX, DRY_RUN_VENUE_PREFIX, assert_hex64,
                    assert_valid_cycle_id, build_abort_commands,
                    build_commit_commands, build_dry_run_commit_commands,
                    build_expire_commands, build_settle_commands,
                    custody_tag_for, new_cycle_id)

from .trade import (LEG_ASK, LEG_OFFER, TRADE_TAG_PREFIX, assert_valid_trade_id,
                    build_trade_cancel_commands, build_trade_proposal_commands,
                    build_trade_settle_commands, leg, new_trade_id, trade_digest,
                    trade_document)

from .transfer import (REASON_P2P, REASON_PAYOUT, REASON_REFUND, REASON_REWARD,
                       REASONS, TRANSFER_TAG_PREFIX, build_transfer_commands,
                       transfer_digest, transfer_document)

from .tenant import (KEY_PREFIX, TenantQuota, assert_tenant_legs,
                     assert_tenant_owns_instrument, assert_valid_tenant_id,
                     generate_tenant_key, hash_tenant_key,
                     namespaced_instrument_id, parse_instrument_id,
                     tenant_id_from_key, verify_tenant_key)

from .assets import (FUNGIBLE, INSTANCE_SEPARATOR, UNIQUE,
                     asset_attribute_digest, asset_attribute_document,
                     assert_amount_valid_for_asset, assert_valid_local_id,
                     derive_instance_id, fungible_instrument, is_unique,
                     parse_asset, unique_instrument)

from .audit import ANCHOR_FIELDS, anchor_digest, anchor_document, anchor_totals

from .policy import VenuePolicy, policy_digest, policy_document, valid_policy

from .settlement import assert_settlement_valid, settlement_is_valid

from .ledger_time import add_seconds, epoch_seconds, int_divide, seconds_between

from .games import (PIXEL_RACE_GAME_CODE, TRADE_WARS_GAME_CODE,
                    pr_entry_digest, pr_entry_document, pr_game_play,
                    pr_outcome_digest, pr_outcome_document, seed_matches_commit,
                    tw_allocation, tw_entry_digest, tw_entry_document,
                    tw_outcome_digest, tw_outcome_document, tw_price_point)

__version__ = "1.5.1"

__all__ = [name for name in dir() if not name.startswith("_")]
