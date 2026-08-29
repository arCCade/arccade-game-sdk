#!/usr/bin/env python3
"""arCCade Game SDK — Python conformance runner.

Reads ../manifest.json and executes every case against the PUBLISHED public API
of ``arccade-game-sdk``. It resolves the entry point the way a consumer does —
``python/pyproject.toml`` declares the package, and this runner imports
``arccade_game_sdk`` as a top-level module — and asserts the package directory is
the one the project metadata ships. Nothing here reaches into
``python/arccade_game_sdk/<module>.py`` by path: a capability only reachable
through a file the distribution does not carry is a capability a consumer does
not have.

This runner is the sibling of ``run.mjs`` and matches its contract exactly: the
same flags, the same JSON Lines record shapes, the same five-value status
vocabulary, the same exit codes and the same ``.verdicts`` file. That is the
point of the suite — two runners given the same manifest and the same profiles
must produce BYTE-IDENTICAL ``.verdicts``, and a ``diff`` between them is itself
the finding.

Two rules this runner will not bend:

  1. A case it cannot execute is a FAILURE, never a skip. ``unsupported`` (no
     published API path) and ``error`` (an unclassifiable raise) both count red.
     A runner that skips what it does not understand reports parity it has not
     demonstrated.
  2. Rejections are classified by a table keyed on capability GROUP, never on
     case id. A per-case map would let the runner pass by naming the answer. No
     rule in the table may be a catch-all.

Usage:
  python3 run.py [--manifest <path>] [--out <path.jsonl>]
                 [--profiles a,b,c|all] [--case <id>]... [--group <name>]...
                 [--list-capabilities] [--list-profiles] [--traits] [--quiet]

``--profiles`` names profiles out of the MANIFEST's own ``profiles`` object, and
a case belongs to the profile its GROUP declares. ``--list-profiles`` prints
that set with the case count each name selects; run-all.sh compares the three
runners' answers against the manifest, so a profile that is declared and
unreachable — or reachable in one runner and not another — fails the build.

``--profiles all`` selects every declared profile. It exists because the Java
runner already spells the whole set that way, and the cross-runner
``.verdicts`` diff is only a parity claim if one invocation shape drives all
three over the SAME case set. See ``conformance/run-all.sh``.

Exit codes (design section 4.5):
  0  every selected case passed (or was not-applicable)
  1  at least one fail or error
  2  manifest / integrity problem — the run is not trustworthy
  3  no fails, but a declared profile contains an unsupported capability
  4  uncaught exception in the runner itself
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import struct
import sys
import time
import traceback
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFORMANCE = HERE.parent
REPO = CONFORMANCE.parent


def die(code: int, msg: str):
    print(f"run.py: {msg}", file=sys.stderr)
    raise SystemExit(code)


# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------

def parse_args(argv):
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--manifest")
    ap.add_argument("--out")
    ap.add_argument("--profiles")
    ap.add_argument("--case", action="append", default=[])
    ap.add_argument("--group", action="append", default=[])
    ap.add_argument("--list-capabilities", action="store_true")
    ap.add_argument("--list-profiles", action="store_true")
    ap.add_argument("--traits", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("-h", "--help", action="store_true")
    try:
        flags, extra = ap.parse_known_args(argv)
    except SystemExit:
        die(2, "bad flags")
    if extra:
        die(2, f"unknown flag {extra[0]}")
    return flags


FLAGS = parse_args(sys.argv[1:])
if FLAGS.help:
    print(__doc__)
    raise SystemExit(0)

MANIFEST_PATH = Path(FLAGS.manifest).resolve() if FLAGS.manifest else CONFORMANCE / "manifest.json"
OUT_PATH = Path(FLAGS.out).resolve() if FLAGS.out else HERE / "results" / "python.jsonl"


# ---------------------------------------------------------------------------
# Resolve the implementation the way a third-party consumer would.
# ---------------------------------------------------------------------------

PY_ROOT = REPO / "python"
PYPROJECT = PY_ROOT / "pyproject.toml"
if not PYPROJECT.exists():
    die(2, f"no project metadata at {PYPROJECT}")

_meta = PYPROJECT.read_text(encoding="utf-8")
_name = re.search(r'^\s*name\s*=\s*"([^"]+)"', _meta, re.M)
if not _name:
    die(2, "python/pyproject.toml declares no distribution name")
DIST_NAME = _name.group(1)
_packages = re.search(r"^\s*packages\s*=\s*\[([^\]]*)\]", _meta, re.M)
if not _packages or "arccade_game_sdk" not in _packages.group(1):
    die(2, 'python/pyproject.toml does not ship "arccade_game_sdk"; '
           "a consumer could not import it")

# Importable as a top-level package, exactly as `pip install ./python` would
# leave it. The source directory goes on the path only because this checkout is
# not installed; the import itself is the consumer-shaped one.
sys.path.insert(0, str(PY_ROOT))
try:
    import arccade_game_sdk as sdk
except Exception as exc:                                   # noqa: BLE001
    die(2, f"cannot import arccade_game_sdk: {exc}")

ENTRY_PATH = Path(sdk.__file__).resolve().parent
NAMED_ENTRY = (REPO / "python" / "arccade_game_sdk").resolve()
if ENTRY_PATH != NAMED_ENTRY:
    die(2, f"imported package {ENTRY_PATH} is not the expected {NAMED_ENTRY}")

TRAITS = {
    # Python has a native binary float, so the float-refusal cases apply.
    "hasNativeFloat": True,
    # Python strings are sequences of code points, not UTF-16 units, so the
    # cases gated on a UTF-16 hazard do not apply to this runtime.
    "hasUtf16Strings": False,
    "hasArbitraryPrecisionInt": True,
}

if FLAGS.traits:
    print(json.dumps(TRAITS, indent=2))
    raise SystemExit(0)


# ---------------------------------------------------------------------------
# Tagged values. Mirrors the manifest's ArgValue domain exactly; a mismatch in
# which nodes carry vHex would show up as a whole-group failure, not silence.
# ---------------------------------------------------------------------------

def utf8hex(s: str) -> str:
    return s.encode("utf-8").hex()


def text_pin(s: str) -> dict:
    return {"v": s, "vHex": utf8hex(s)}


INT64_MAX = 9223372036854775807
INT64_MIN = -9223372036854775808


class A:
    @staticmethod
    def text(v):
        return {"t": "text", "v": v, "vHex": utf8hex(v)}

    @staticmethod
    def int(v):
        n = int(v)
        o = {"t": "int", "v": str(n)}
        if n > INT64_MAX or n < INT64_MIN:
            o["wide"] = True
        return o

    @staticmethod
    def bool(v):
        return {"t": "bool", "v": bool(v)}

    @staticmethod
    def party(v):
        return {"t": "party", "v": v, "vHex": utf8hex(v)}

    @staticmethod
    def hex64(v):
        return {"t": "hex64", "v": v}

    @staticmethod
    def nul():
        return {"t": "null", "v": None}

    @staticmethod
    def list(v):
        return {"t": "list", "v": v}

    @staticmethod
    def pairs(v):
        return {"t": "pairs", "v": v}

    @staticmethod
    def steps(v):
        return {"t": "steps", "v": v}

    @staticmethod
    def json(v):
        return {"t": "json", "v": v}


class ManifestError(Exception):
    pass


class MissingExport(Exception):
    pass


def decode(a):
    if not isinstance(a, dict) or not isinstance(a.get("t"), str):
        raise ManifestError(f"argument is not a tagged value: {json.dumps(a)}")
    t = a["t"]
    if t in ("text", "party", "hex64", "raw"):
        return a["v"]
    if t in ("int", "micros"):
        return int(a["v"])
    if t == "dec":
        # An exact decimal literal. Never a binary float, and never widened
        # through one on the way in.
        return Decimal(a["v"])
    if t == "bool":
        return a["v"]
    if t == "null":
        return None
    if t == "list":
        return [decode(x) for x in a["v"]]
    if t == "pairs":
        return [[decode(k), decode(v)] for k, v in a["v"]]
    if t == "record":
        return {k: decode(v) for k, v in a["v"]["fields"].items()}
    if t == "steps":
        return [sdk.MerkleStep(bool(s["siblingOnLeft"]), s["sibling"]) for s in a["v"]]
    if t == "float64":
        return struct.unpack(">d", bytes.fromhex(a["v"]["bits"]))[0]
    if t == "json":
        return json.loads(json.dumps(a["v"]))
    raise ManifestError(f'unknown ArgValue tag "{t}"')


# ---------------------------------------------------------------------------
# Reject classification.
#
# This table is the RUNNER's, declared in its header record, keyed by capability
# group. It is cross-checked against the manifest's own rejectMap at startup:
# drift is printed, because a rule this runner lacks would turn a correct
# rejection into `error`, and a rule the manifest lacks means either the two
# disagree about what a class means, or this client refuses something the
# reference client does not.
# ---------------------------------------------------------------------------

REJECT_CLASSES = [
    "bad-type", "bad-format", "out-of-range", "precision-loss",
    "unknown-tag", "invariant-violated", "not-injective",
]

REJECT_MAP = [
    {"group": "digest.amount", "match": "kayipsiz cevrilemedi", "class": "precision-loss"},
    {"group": "digest.amount", "match": "bandin disinda", "class": "out-of-range"},
    {"group": "digest.amount", "match": "Number olarak verilemez", "class": "bad-type"},
    {"group": "digest.amount", "match": "desteklenmeyen tutar turu", "class": "bad-type"},
    {"group": "digest.amount", "match": "gecersiz ondalik tutar", "class": "bad-format"},
    # Python-only rules. This client refuses three things the JavaScript client
    # accepts (decisions D9, D7 and D8), so the classes exist here and not in
    # the manifest's map, which was written from the JavaScript messages.
    {"group": "digest.scalar", "match": "desteklenmeyen tamsayi turu", "class": "bad-type"},
    {"group": "digest.scalar", "match": "desteklenmeyen zaman turu", "class": "bad-type"},
    {"group": "digest.scalar", "match": "Cannot convert", "class": "bad-format"},
    {"group": "digest.text", "match": "bos metin digest'lenemez", "class": "bad-format"},
    {"group": "value-documents", "match": "belgesi bileseni '|' iceremez", "class": "not-injective"},
    {"group": "digest.fields", "match": "alan adi ASCII", "class": "bad-format"},
    {"group": "audit", "match": "gecersiz disposition", "class": "unknown-tag"},
    {"group": "audit", "match": "unknown disposition", "class": "unknown-tag"},
    {"group": "audit", "match": "unparsable ledger timestamp", "class": "bad-format"},
    {"group": "identity", "match": "iceremez", "class": "not-injective"},
    {"group": "identity", "match": "olamaz (ad alani ayiricisi)", "class": "not-injective"},
    {"group": "identity", "match": "gecersiz cycleId", "class": "out-of-range"},
    {"group": "identity", "match": "gecersiz tradeId", "class": "out-of-range"},
    {"group": "identity", "match": "64 karakterlik kucuk harf sha256", "class": "bad-format"},
    {"group": "identity", "match": "gecersiz varlik kimligi", "class": "bad-format"},
    {"group": "identity", "match": "gecersiz ornek kimligi", "class": "bad-format"},
    {"group": "identity", "match": "gecersiz kiraci kimligi", "class": "bad-format"},
    {"group": "identity", "match": "ardisik tire", "class": "bad-format"},
    {"group": "identity", "match": "gecersiz item kimligi", "class": "bad-format"},
    {"group": "identity", "match": "item kimliginde", "class": "not-injective"},
    {"group": "identity", "match": "kiraci izolasyonu ihlali", "class": "invariant-violated"},
    {"group": "assets", "match": "benzersiz varligin miktari", "class": "invariant-violated"},
    {"group": "assets", "match": "varlik miktari pozitif olmali", "class": "out-of-range"},
    {"group": "assets", "match": "ozellik degeri tamsayi ya da metin olmali", "class": "bad-type"},
    {"group": "value-documents", "match": "tutari pozitif olmali", "class": "out-of-range"},
    {"group": "value-documents", "match": "sender ve receiver ayni olamaz", "class": "invariant-violated"},
    {"group": "value-documents", "match": "sender ve receiver ister", "class": "bad-type"},
    {"group": "value-documents", "match": "instrumentId {admin, id} olmali", "class": "bad-type"},
    {"group": "value-documents", "match": "gecersiz tradeId", "class": "out-of-range"},
    {"group": "value-documents", "match": "tradeId ':' veya '|' iceremez", "class": "not-injective"},
    {"group": "builder", "match": "ReturnedInFull stake in tamamini", "class": "invariant-violated"},
    {"group": "builder", "match": "ForfeitedInFull hicbir sey", "class": "invariant-violated"},
    {"group": "builder", "match": "outcomeDocument ya da outcomeDigest", "class": "bad-type"},
    # D10: an omitted amount is refused rather than serialised as text.
    {"group": "builder", "match": "verilmeli: eksik tutar", "class": "bad-type"},
    {"group": "builder", "match": "inputAmuletCids bos olamaz", "class": "invariant-violated"},
    {"group": "builder", "match": "en az bir alici gerekli", "class": "invariant-violated"},
    {"group": "builder", "match": "takas iki bacak ister", "class": "invariant-violated"},
    {"group": "builder", "match": "settle icin her bacagin", "class": "invariant-violated"},
    {"group": "builder", "match": "iceremez", "class": "not-injective"},
    {"group": "builder", "match": "gecersiz cycleId", "class": "out-of-range"},
    {"group": "builder", "match": "64 karakterlik kucuk harf sha256", "class": "bad-format"},
    {"group": "builder", "match": "bilinmeyen sebep", "class": "unknown-tag"},
    {"group": "builder", "match": "kendine transfer reddedilir", "class": "invariant-violated"},
    {"group": "builder", "match": "ayni alici tekrar edemez", "class": "invariant-violated"},
    {"group": "builder", "match": "transfer tutari pozitif olmali", "class": "out-of-range"},
    {"group": "quota", "match": "gecersiz kiraci kimligi", "class": "bad-format"},
    {"group": "quota", "match": "ardisik tire", "class": "bad-format"},
    {"group": "audit", "match": "must equal the stake", "class": "invariant-violated"},
    {"group": "audit", "match": "cannot forfeit", "class": "invariant-violated"},
    {"group": "audit", "match": "cannot return", "class": "invariant-violated"},
    {"group": "audit", "match": "needs both sides non-zero", "class": "invariant-violated"},
    {"group": "audit", "match": "return the stake in full", "class": "invariant-violated"},
    {"group": "audit", "match": "negative settlement amount", "class": "out-of-range"},
    {"group": "audit", "match": "payout above the policy cap", "class": "invariant-violated"},
    {"group": "audit", "match": "duplicate cycleId in a period", "class": "invariant-violated"},
    {"group": "audit", "match": "Cannot convert", "class": "bad-format"},
]

for _r in REJECT_MAP:
    if _r["class"] not in REJECT_CLASSES:
        die(2, f"reject map: unknown class {_r['class']}")
    # No catch-all. A rule broad enough to swallow a surprise is how a runner
    # turns an unknown failure into a pass.
    if not isinstance(_r["match"], str) or len(_r["match"]) < 4 or _r["match"] == ".*":
        die(2, f"reject map: rule too broad to be evidence: {_r['match']!r}")
    _r["used"] = 0


def classify(group, message):
    for r in REJECT_MAP:
        if r["group"] == group and r["match"] in str(message):
            r["used"] += 1
            return r["class"]
    return None


# ---------------------------------------------------------------------------
# Dispatch: capability id -> the published API call.
#
# `exports` names the entry-point attributes the call needs. If one is missing
# from the published package the capability is `unsupported` for this client —
# determined by looking at the module, not by trusting the manifest's own
# `impl.python` field.
#
# A capability with no entry here is unsupported too, and every case on it is
# counted red.
# ---------------------------------------------------------------------------

def as_doc(text):
    return {"text": text, "digest": sdk.text_digest(text)}


def instr_arg(i):
    return A.pairs([[A.text("admin"), A.party(i["admin"])],
                    [A.text("id"), A.text(i["id"])]])


def row_arg(r):
    return {"t": "record", "v": {"schema": "cycle-audit-row", "fields": {
        "cycleId": A.text(r["cycleId"]),
        "player": A.party(r["player"]),
        "gameCode": A.text(r["gameCode"]),
        "concurrencyIndex": A.int(r["concurrencyIndex"]),
        "entryDigest": A.text(r["entryDigest"]),
        "outcomeDigest": A.text(r["outcomeDigest"]),
        "committedUnits": A.int(r["committedUnits"]),
        "feeUnits": A.int(r["feeUnits"]),
        "returnedUnits": A.int(r["returnedUnits"]),
        "forfeitedUnits": A.int(r["forfeitedUnits"]),
        "payoutUnits": A.int(r["payoutUnits"]),
        "disposition": A.text(r["disposition"]),
        "committedAtMicros": A.int(r["committedAtMicros"]),
        "settledAtMicros": A.int(r["settledAtMicros"]),
        "custodyTag": A.text(r["custodyTag"]),
    }}}


def json_pin(v):
    return A.json(json.loads(json.dumps(v)))


def _constant(args):
    name = args[0]
    v = getattr(sdk, name, None)
    # Not a reject-map path: a missing wire constant is an unclassifiable raise
    # and must surface as `error`, not as a tidy rejection.
    if v is None:
        raise MissingExport(f'published entry exports no constant "{name}"')
    if isinstance(v, (list, tuple)):
        return A.list([A.text(x) for x in v])
    return A.text(str(v))


def _rows(args):
    report = sdk.rows_from_transactions(args[0])
    return A.list([row_arg(sdk.to_leaf_row(r)) for r in report.rows])


def _unmatched(args):
    r = sdk.rows_from_transactions(args[0])
    return A.pairs([
        [A.text("openStakes"), A.list([A.text(x) for x in r.open_stakes])],
        [A.text("orphanClosings"), A.list([A.text(x) for x in r.orphan_closings])],
    ])


def _warnings(args):
    r = sdk.rows_from_transactions(args[0])
    return A.list([A.pairs([
        [A.text("cycleId"), A.text(w["cycleId"])],
        [A.text("kind"), A.text(w["kind"])],
        [A.text("stated"), A.int(w["stated"])],
        [A.text("unlocked"), A.int(w["unlocked"])],
    ]) for w in r.warnings])


def _leg(args):
    l = args[0]
    r = sdk.leg({"sender": l["sender"], "receiver": l["receiver"],
                 "instrumentId": l["instrumentId"], "amount": l["amount"]})
    return A.pairs([
        [A.text("sender"), A.party(r["sender"])],
        [A.text("receiver"), A.party(r["receiver"])],
        [A.text("instrument"), A.text(r["instrumentId"]["id"])],
        [A.text("amount"), A.text(r["amount"])],
    ])


def _quota(args):
    cfg, steps = args
    q = sdk.TenantQuota(window_seconds=int(cfg["windowSeconds"]),
                        max_writes=int(cfg["maxWrites"]))
    out = []
    for s in steps:
        r = q.consume(s["tenantId"], int(s["nowMs"]), int(s["cost"]))
        out.append(A.pairs([
            [A.text("allowed"), A.bool(r["allowed"])],
            [A.text("remaining"), A.int(r["remaining"])],
            [A.text("resetAt"), A.int(r["resetAt"])],
        ]))
    return A.list(out)


def _accept(fn, keep):
    """An assertion capability: run the check, then hand back the value it accepted."""
    return lambda args: (fn(args), args[keep])[1]


DISPATCH = {
    # -- core-digest --------------------------------------------------------
    "digest.canon": (["canon"], lambda a: sdk.canon(a[0], a[1])),
    "digest.canonText": (["canon_text"], lambda a: sdk.canon_text(a[0])),
    "digest.canonInt": (["canon_int"], lambda a: sdk.canon_int(a[0])),
    "digest.canonBool": (["canon_bool"], lambda a: sdk.canon_bool(a[0])),
    "digest.canonDecimal": (["canon_decimal"], lambda a: sdk.canon_decimal(a[0])),
    "digest.canonTimeMicros": (["canon_time_micros"], lambda a: sdk.canon_time_micros(a[0])),
    "digest.canonTime": (["canon_time"], lambda a: sdk.canon_time(a[0])),
    "digest.canonParty": (["canon_party"], lambda a: sdk.canon_party(a[0])),
    "digest.canonOptional": (["canon_optional", "canon_text"],
                             lambda a: sdk.canon_optional(sdk.canon_text, a[0])),
    "digest.canonList": (["canon_list"], lambda a: sdk.canon_list(a[0])),
    "digest.canonFields": (["canon_fields"], lambda a: sdk.canon_fields(a[0])),
    "digest.codePointLength": (["code_point_length"], lambda a: sdk.code_point_length(a[0])),
    "digest.amountUnits": (["amount_units"], lambda a: sdk.amount_units(a[0])),
    "digest.canonDocument": (["canon_document", "text_digest"],
                             lambda a: as_doc(sdk.canon_document(a[0], a[1], a[2]))),
    "digest.textDigest": (["text_digest"], lambda a: sdk.text_digest(a[0])),
    "digest.constant": ([], _constant),

    # -- merkle -------------------------------------------------------------
    "merkle.merkleEmpty": (["merkle_empty"], lambda a: sdk.merkle_empty()),
    "merkle.merkleNode": (["merkle_node"], lambda a: sdk.merkle_node(a[0], a[1])),
    "merkle.merklePairUp": (["merkle_pair_up"],
                            lambda a: A.list([A.hex64(h) for h in sdk.merkle_pair_up(a[0])])),
    "merkle.merkleRoot": (["merkle_root"], lambda a: sdk.merkle_root(a[0])),
    "merkle.merkleProof": (["merkle_proof"], lambda a: sdk.merkle_proof(a[0], a[1])),
    "merkle.merkleFold": (["merkle_fold"], lambda a: sdk.merkle_fold(a[0], a[1])),
    "merkle.merkleVerify": (["merkle_verify"], lambda a: sdk.merkle_verify(a[0], a[1], a[2])),

    # -- audit --------------------------------------------------------------
    "audit.periodLeafDocument": (["period_leaf_document", "text_digest"],
                                 lambda a: as_doc(sdk.period_leaf_document(a[0]))),
    "audit.periodRowVerify": (["period_row_verify"],
                              lambda a: sdk.period_row_verify(a[0], a[1], a[2])),
    "audit.isoToMicros": (["iso_to_micros"], lambda a: sdk.iso_to_micros(a[0])),
    "audit.rowsFromTransactions": (["rows_from_transactions", "to_leaf_row"], _rows),
    "audit.reportOrder": (["rows_from_transactions"],
                          lambda a: [r["cycleId"] for r in sdk.rows_from_transactions(a[0]).rows]),
    "audit.unmatchedHalves": (["rows_from_transactions"], _unmatched),
    "audit.unlockWarnings": (["rows_from_transactions"], _warnings),
    "audit.anchorDocument": (["anchor_document", "text_digest"],
                             lambda a: as_doc(sdk.anchor_document(a[0]))),
    "audit.anchorTotals": (["anchor_totals"], lambda a: A.pairs([
        [A.text(k), A.int(v)] for k, v in sdk.anchor_totals(a[0]).items()])),
    "policy.policyDocument": (["policy_document", "text_digest"],
                              lambda a: as_doc(sdk.policy_document(a[0]))),
    "policy.validPolicy": (["valid_policy"], lambda a: sdk.valid_policy(a[0])),
    "settlement.assertSettlementValid": (["assert_settlement_valid"],
                                         lambda a: sdk.assert_settlement_valid(a[0])),

    # -- identity -----------------------------------------------------------
    "cycle.assertValidCycleId": (["assert_valid_cycle_id"],
                                 _accept(lambda a: sdk.assert_valid_cycle_id(a[0]), 0)),
    "cycle.assertHex64": (["assert_hex64"], _accept(lambda a: sdk.assert_hex64(a[0]), 0)),
    "cycle.custodyTagFor": (["custody_tag_for"], lambda a: sdk.custody_tag_for(a[0], a[1])),
    "trade.assertValidTradeId": (["assert_valid_trade_id"],
                                 _accept(lambda a: sdk.assert_valid_trade_id(a[0]), 0)),
    "assets.assertValidLocalId": (["assert_valid_local_id"],
                                  _accept(lambda a: sdk.assert_valid_local_id(a[0]), 0)),
    "tenant.assertValidTenantId": (["assert_valid_tenant_id"],
                                   _accept(lambda a: sdk.assert_valid_tenant_id(a[0]), 0)),
    "tenant.namespacedInstrumentId": (["namespaced_instrument_id"],
                                      lambda a: instr_arg(
                                          sdk.namespaced_instrument_id(a[0], a[1], a[2]))),
    "tenant.parseInstrumentId": (["parse_instrument_id"], lambda a: (
        lambda p: A.pairs([
            [A.text("tenantId"), A.nul() if p["tenantId"] is None else A.text(p["tenantId"])],
            [A.text("localId"), A.text(p["localId"])],
        ]))(sdk.parse_instrument_id(a[0]))),
    "tenant.assertTenantOwnsInstrument": (["assert_tenant_owns_instrument"],
                                          _accept(lambda a: sdk.assert_tenant_owns_instrument(
                                              a[0], a[1]), 0)),
    "tenant.assertTenantLegs": (["assert_tenant_legs"],
                                _accept(lambda a: sdk.assert_tenant_legs(
                                    a[0], dict((k, v) for k, v in a[1])), 0)),
    "tenant.hashTenantKey": (["hash_tenant_key"], lambda a: sdk.hash_tenant_key(a[0])),
    "tenant.tenantIdFromKey": (["tenant_id_from_key"], lambda a: (
        lambda r: A.nul() if r is None else A.text(r))(sdk.tenant_id_from_key(a[0]))),
    "tenant.verifyTenantKey": (["verify_tenant_key"],
                               lambda a: sdk.verify_tenant_key(a[0], a[1])),
    "assets.fungibleInstrument": (["fungible_instrument"],
                                  lambda a: instr_arg(sdk.fungible_instrument(a[0], a[1], a[2]))),
    "assets.uniqueInstrument": (["unique_instrument"],
                                lambda a: instr_arg(
                                    sdk.unique_instrument(a[0], a[1], a[2], a[3]))),
    "assets.parseAsset": (["parse_asset"], lambda a: (
        lambda p: A.pairs([
            [A.text("tenantId"), A.nul() if p["tenantId"] is None else A.text(p["tenantId"])],
            [A.text("localId"), A.text(p["localId"])],
            [A.text("instanceId"), A.nul() if p["instanceId"] is None else A.text(p["instanceId"])],
            [A.text("assetClass"), A.text(p["assetClass"])],
        ]))(sdk.parse_asset(a[0]))),
    "assets.isUnique": (["is_unique"], lambda a: sdk.is_unique(a[0])),
    "assets.assertAmountValidForAsset": (["assert_amount_valid_for_asset"],
                                         lambda a: (sdk.assert_amount_valid_for_asset(a[0], a[1]),
                                                    str(a[1]))[1]),
    "assets.assetAttributeDocument": (["asset_attribute_document", "text_digest"],
                                      lambda a: as_doc(
                                          sdk.asset_attribute_document(a[0], a[1]))),
    "assets.deriveInstanceId": (["derive_instance_id"],
                                lambda a: A.text(
                                    sdk.derive_instance_id(a[0], a[1], a[2], a[3]))),

    # -- value documents ----------------------------------------------------
    "trade.tradeDocument": (["trade_document", "text_digest"], lambda a: as_doc(
        sdk.trade_document({
            "tradeId": a[0]["tradeId"], "maker": a[0]["maker"], "taker": a[0]["taker"],
            "legs": a[0]["legs"], "expiresAt": a[0]["expiresAt"],
            "meta": a[0].get("meta") or [],
        }))),
    "trade.leg": (["leg"], _leg),
    "transfer.transferDocument": (["transfer_document", "text_digest"], lambda a: as_doc(
        sdk.transfer_document({
            "transferId": a[0]["transferId"], "sender": a[0]["sender"],
            "reason": a[0]["reason"], "recipients": a[0]["recipients"],
            "meta": a[0].get("meta") or [],
        }))),

    # -- time ---------------------------------------------------------------
    "time.intDivide": (["int_divide"], lambda a: sdk.int_divide(a[0], a[1])),
    "time.epochSeconds": (["epoch_seconds"], lambda a: sdk.epoch_seconds(a[0])),
    "time.secondsBetween": (["seconds_between"], lambda a: sdk.seconds_between(a[0], a[1])),
    "time.addSeconds": (["add_seconds"], lambda a: sdk.add_seconds(a[0], a[1])),

    # -- quota --------------------------------------------------------------
    "quota.consume": (["TenantQuota"], _quota),

    # -- builder ------------------------------------------------------------
    "builder.buildCommitCommands": (["build_commit_commands"],
                                    lambda a: json_pin(sdk.build_commit_commands(a[0]))),
    "builder.buildDryRunCommitCommands": (["build_dry_run_commit_commands"],
                                          lambda a: json_pin(
                                              sdk.build_dry_run_commit_commands(a[0]))),
    "builder.buildSettleCommands": (["build_settle_commands"],
                                    lambda a: json_pin(sdk.build_settle_commands(a[0]))),
    "builder.buildAbortCommands": (["build_abort_commands"],
                                   lambda a: json_pin(sdk.build_abort_commands(a[0]))),
    "builder.buildExpireCommands": (["build_expire_commands"],
                                    lambda a: json_pin(sdk.build_expire_commands(a[0]))),
    "builder.buildTradeProposalCommands": (["build_trade_proposal_commands"],
                                           lambda a: json_pin(
                                               sdk.build_trade_proposal_commands(a[0]))),
    "builder.buildTradeSettleCommands": (["build_trade_settle_commands"],
                                         lambda a: json_pin(
                                             sdk.build_trade_settle_commands(a[0]))),
    "builder.buildTradeCancelCommands": (["build_trade_cancel_commands"],
                                         lambda a: json_pin(
                                             sdk.build_trade_cancel_commands(a[0]))),
    "builder.buildTransferCommands": (["build_transfer_commands"],
                                      lambda a: json_pin(sdk.build_transfer_commands(a[0]))),
}


# ---------------------------------------------------------------------------
# Load the manifest and check the things that would make a run untrustworthy.
# These exit 2, not 1: "the suite could not be trusted to run" and "this client
# is wrong" are different facts.
# ---------------------------------------------------------------------------

if not MANIFEST_PATH.exists():
    die(2, f"no manifest at {MANIFEST_PATH}")
try:
    MANIFEST = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
except Exception as exc:                                    # noqa: BLE001
    die(2, f"manifest is not valid JSON: {exc}")
if MANIFEST.get("manifestVersion") != "1":
    die(2, f"unsupported manifestVersion {MANIFEST.get('manifestVersion')}")

CAPS = {c["id"]: c for c in MANIFEST.get("capabilities", [])}
if not CAPS:
    die(2, "manifest carries no capability catalog")

# The selectable profile set is the manifest's `profiles` object, and nothing
# else. It used to be derived from the capability catalog in all three runners,
# which silently dropped `games`: the manifest declares it, two groups put 20
# cases in it, and no capability carries it, so `--profiles games` was exit 2 in
# every runner while the cases ran under `--profiles all`. A profile that is
# declared and cannot be named is a claim that cannot be checked.
DECLARED_PROFILES = sorted(MANIFEST.get("profiles", {}))
if not DECLARED_PROFILES:
    die(2, "manifest declares no profiles")

integrity = []


def check_node(node, where):
    """vHex is the byte pin: wherever both halves are present the hex must be the
    UTF-8 of the string. That is what makes a human-readable manifest byte-exact
    rather than merely plausible."""
    if node is None or not isinstance(node, (dict, list)):
        return
    if isinstance(node, list):
        for i, n in enumerate(node):
            check_node(n, f"{where}[{i}]")
        return
    # Ledger API shapes are not our domain; they carry raw JSON numbers by
    # construction and are skipped whole.
    if node.get("t") == "json":
        return
    if isinstance(node.get("v"), str) and isinstance(node.get("vHex"), str):
        want = utf8hex(node["v"])
        if want != node["vHex"]:
            integrity.append(f"{where}: vHex does not encode v "
                             f"(v={json.dumps(node['v'])} vHex={node['vHex']} expected={want})")
    for k, v in node.items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            integrity.append(f"{where}.{k}: JSON number {v}; every value must be a tagged string")
        check_node(v, f"{where}.{k}")


ALL_CASES = []
SEEN_IDS = set()
CAP_CASE_COUNT = {}

for g in MANIFEST.get("groups", []):
    for c in g.get("cases", []):
        if c["id"] in SEEN_IDS:
            integrity.append(f"duplicate case id {c['id']}")
        SEEN_IDS.add(c["id"])
        if c["id"] in MANIFEST.get("retiredIds", []):
            integrity.append(f"case {c['id']} is listed in retiredIds")
        cap = CAPS.get(c["capability"])
        if cap is None:
            integrity.append(f"case {c['id']}: capability {c['capability']} is not in the catalog")
        if len(c.get("expect", {})) != 1:
            integrity.append(f"case {c['id']}: expect must carry exactly one key, "
                             f"got {sorted(c.get('expect', {}))}")
        check_node(c.get("input"), f"{c['id']}.input")
        check_node(c.get("expect"), f"{c['id']}.expect")
        CAP_CASE_COUNT[c["capability"]] = CAP_CASE_COUNT.get(c["capability"], 0) + 1
        row = dict(c)
        # The profile a case is SELECTED BY is its GROUP's, not its capability's.
        # The two disagree for 26 of the 469 cases, and taking the capability's
        # made `games` unreachable — every one of its 20 cases exercises a
        # core-digest capability. All three runners now read this same field, so
        # they still select identical case sets from one `--profiles` value,
        # which is the property the .verdicts diff depends on.
        row["profile"] = g["profile"]
        ALL_CASES.append(row)

# A capability with zero cases is a hole, not a pass.
for cid in CAPS:
    if cid not in CAP_CASE_COUNT:
        integrity.append(f"capability {cid} has no case; a capability with zero cases "
                         f"is a hole, not a pass")

declared_total = MANIFEST.get("summary", {}).get("totalCases")
if declared_total and int(declared_total) != len(ALL_CASES):
    integrity.append(f"manifest.summary.totalCases={declared_total} but the file carries "
                     f"{len(ALL_CASES)} cases")
for g in MANIFEST.get("groups", []):
    declared = MANIFEST.get("summary", {}).get("byGroup", {}).get(g["group"])
    if declared is not None and int(declared) != len(g.get("cases", [])):
        integrity.append(f"group {g['group']}: summary says {declared} cases, "
                         f"file carries {len(g.get('cases', []))}")

# Every group's profile must be one the manifest declares, or `--profiles` can
# never reach the cases in it.
for g in MANIFEST.get("groups", []):
    if g["profile"] not in DECLARED_PROFILES:
        integrity.append(f"group {g['group']} declares profile {g['profile']}, "
                         f"which manifest.profiles does not list")

# A declared profile with no case is the same defect seen from the other side:
# a name the caller can pass that selects nothing.
CASES_PER_PROFILE = {p: 0 for p in DECLARED_PROFILES}
for c in ALL_CASES:
    if c["profile"] in CASES_PER_PROFILE:
        CASES_PER_PROFILE[c["profile"]] += 1
for p in DECLARED_PROFILES:
    if CASES_PER_PROFILE[p] == 0:
        integrity.append(f"profile {p} is declared in manifest.profiles and no case is "
                         f"in it; `--profiles {p}` would select nothing")

# And the manifest's own byProfile table must agree with what this runner just
# counted. That table was built from a hardcoded 8-key literal keyed on the
# capability profile, so it reported the 20 games cases under core-digest and
# merkle and omitted the profile they are declared in. Nothing could contradict
# it; this does.
_by_profile = MANIFEST.get("summary", {}).get("byProfile")
if _by_profile is not None:
    for p in _by_profile:
        if p not in DECLARED_PROFILES:
            integrity.append(f"summary.byProfile names profile {p}, which "
                             f"manifest.profiles does not declare")
    for p in DECLARED_PROFILES:
        want = _by_profile.get(p)
        if want is None:
            integrity.append(f"summary.byProfile has no entry for the declared profile {p}")
        elif int(want) != CASES_PER_PROFILE[p]:
            integrity.append(f"summary.byProfile.{p}={want} but the file carries "
                             f"{CASES_PER_PROFILE[p]} case(s) in that profile")

# The catalog's `impl.python` is a claim about THIS client, and this runner is
# the only thing that knows whether it is true. Checked here rather than
# trusted: a null beside a capability this runner dispatches means the manifest
# is slandering a client that works, and a name beside one it cannot dispatch
# means the suite is about to report `unsupported` for something the catalog
# swears exists. Both are manifest errors, and both stop the run.
#
# This is the check that caught 42 capabilities recorded as unimplemented in
# Python while Python passed all 469 cases, and printed "37 are implemented by
# no client in any language" in its own summary.
for _cid, _cap in sorted(CAPS.items()):
    _claimed = (_cap.get("impl") or {}).get("python")
    _d = DISPATCH.get(_cid)
    _missing = [e for e in (_d[0] if _d else []) if getattr(sdk, e, None) is None]
    _dispatchable = bool(_d) and not _missing
    if _claimed is not None and not _dispatchable:
        _why = f"missing export(s): {', '.join(_missing)}" if _d else "no dispatch entry in run.py"
        integrity.append(f"capability {_cid}: the catalog says impl.python is "
                         f"\"{_claimed}\", but this runner cannot drive it ({_why})")
    if _claimed is None and _dispatchable:
        integrity.append(f"capability {_cid}: the catalog says impl.python is null, but this "
                         f"runner drives it through {', '.join(_d[0]) or 'the module itself'}. "
                         "Regenerate the manifest.")

# Reject-map drift, against THIS language's entry. The manifest used to publish
# one `rejectMap` -- the JavaScript client's -- under a name that read as though
# it were every client's, so this runner found eight rules of its own missing
# from it, printed a NOTE, and exited 0. Python legitimately refuses three
# things JavaScript does not (D7, D8, D9), so the drift was real and permanent
# and the note was never going to be acted on. The manifest now publishes one
# map per language, harvested from each runner's own source; a difference means
# this runner classifies refusals by rules the manifest does not describe, and
# that is a manifest error.
_declared = (MANIFEST.get("rejectMaps") or {}).get("python", {}).get("rules")
if not isinstance(_declared, list):
    integrity.append("manifest has no rejectMaps.python.rules; regenerate it with the "
                     "current generate.mjs")
else:
    MANIFEST_RULES = {(r["group"], r["match"], r["class"]) for r in _declared}
    RUNNER_RULES = {(r["group"], r["match"], r["class"]) for r in REJECT_MAP}
    for g, m, c in sorted(MANIFEST_RULES - RUNNER_RULES):
        integrity.append(f"reject-map drift: the manifest has a rule this runner lacks: {g} | {m} | {c}")
    for g, m, c in sorted(RUNNER_RULES - MANIFEST_RULES):
        integrity.append(f"reject-map drift: this runner has a rule the manifest lacks: {g} | {m} | {c}")

if integrity:
    for m in integrity:
        print(f"run.py: manifest integrity: {m}", file=sys.stderr)
    raise SystemExit(2)

if FLAGS.list_capabilities:
    rows = []
    for cid, cap in sorted(CAPS.items()):
        d = DISPATCH.get(cid)
        missing = [e for e in (d[0] if d else []) if getattr(sdk, e, None) is None]
        rows.append({"capability": cid, "profile": cap["profile"],
                     "cases": cap.get("cases"),
                     "supported": bool(d) and not missing,
                     "missingExports": missing})
    print(json.dumps({"language": "python", "capabilities": rows}, indent=2))
    raise SystemExit(0)


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------

PROFILES_AVAILABLE = DECLARED_PROFILES

# `all` is a spelling of "every profile the manifest declares", not a profile.
# The Java
# runner accepted it and this one did not, so the three runners could not be
# driven over one case set by one invocation shape — and a .verdicts diff
# between two different case sets is not the parity claim it looks like. It is
# rejected in combination with a named profile rather than quietly widened:
# `--profiles all,merkle` reads like a narrowing to whoever typed it.
REQUESTED = ([p.strip() for p in FLAGS.profiles.split(",") if p.strip()]
             if FLAGS.profiles else None)
ALL_PROFILES = REQUESTED is not None and "all" in REQUESTED
if ALL_PROFILES and len(REQUESTED) != 1:
    die(2, "--profiles all already selects every profile; drop "
           + ", ".join(p for p in REQUESTED if p != "all"))
PROFILES = PROFILES_AVAILABLE if (ALL_PROFILES or REQUESTED is None) else REQUESTED
for p in PROFILES:
    if p not in PROFILES_AVAILABLE:
        die(2, f"unknown profile {p}; known: {', '.join(PROFILES_AVAILABLE)}, all")
CASE_FILTER = set(FLAGS.case)
GROUP_FILTER = set(FLAGS.group)
for cid in CASE_FILTER:
    if cid not in SEEN_IDS:
        die(2, f"--case {cid}: no such case in the manifest")
for gname in GROUP_FILTER:
    if not any(x["group"] == gname for x in MANIFEST.get("groups", [])):
        die(2, f"--group {gname}: no such group")



def select_by_profiles(profiles):
    """One definition of "the cases in these profiles". ``--list-profiles``
    reports what this same function returns for each declared name, so the
    listing cannot claim a profile is reachable while the selector disagrees."""
    return [c for c in ALL_CASES if c["profile"] in profiles]


if FLAGS.list_profiles:
    print(json.dumps({"language": "python", "profiles": [
        {"profile": p,
         "cases": str(len(select_by_profiles([p]))),
         "description": MANIFEST["profiles"][p]}
        for p in DECLARED_PROFILES]}, indent=2))
    raise SystemExit(0)

SELECTED = [c for c in select_by_profiles(PROFILES)
            if (not CASE_FILTER or c["id"] in CASE_FILTER)
            and (not GROUP_FILTER or c["group"] in GROUP_FILTER)]


# ---------------------------------------------------------------------------
# Structural comparison. Never a native == across types: both sides are
# normalised into the same JSON domain and compared key-set by key-set.
# ---------------------------------------------------------------------------

def deep_equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, list) or isinstance(b, list):
        if not isinstance(a, list) or not isinstance(b, list) or len(a) != len(b):
            return False
        return all(deep_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) or isinstance(b, dict):
        if not isinstance(a, dict) or not isinstance(b, dict):
            return False
        if sorted(a) != sorted(b):
            return False
        return all(deep_equal(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


def first_divergent_byte(a, b):
    x, y = a.encode("utf-8"), b.encode("utf-8")
    for i in range(min(len(x), len(y))):
        if x[i] != y[i]:
            return i
    return None if len(x) == len(y) else min(len(x), len(y))


def observed_expect(returns, v):
    """Lifts a raw observed result into the manifest's expectation domain, so the
    two sides are compared in the same shape rather than by coincidence."""
    if returns == "text":
        return {"text": text_pin(v)}
    if returns == "digest":
        return {"digest": v}
    if returns == "document":
        return {"document": {"text": text_pin(v["text"]), "digest": v["digest"]}}
    if returns == "int":
        return {"value": A.int(v)}
    if returns == "bool":
        return {"bool": bool(v)}
    if returns == "order":
        return {"order": v}
    if returns == "steps":
        return {"value": A.steps([{"siblingOnLeft": bool(s.sibling_on_left),
                                   "sibling": s.sibling} for s in v])}
    if returns == "accept":
        return {"value": A.text(v)}
    if returns == "value":
        return {"value": v}
    raise ManifestError(f'unknown capability "returns" kind: {returns}')


# ---------------------------------------------------------------------------
# Execute one case.
# ---------------------------------------------------------------------------

def run_case(c):
    cap = CAPS[c["capability"]]
    rec = {"rec": "case", "id": c["id"], "group": c["group"],
           "capability": c["capability"], "profile": c["profile"],
           "status": None, "expected": c["expect"], "observed": {}}
    if c.get("decision"):
        rec["decision"] = c["decision"]

    for trait, want in (c.get("appliesWhen") or {}).items():
        if bool(TRAITS.get(trait)) != bool(want):
            rec["status"] = "not-applicable"
            rec["observed"] = {"reason": f"runtime trait {trait}={bool(TRAITS.get(trait))}, "
                                         f"case needs {want}"}
            return rec

    d = DISPATCH.get(c["capability"])
    if d is None:
        rec["status"] = "unsupported"
        rec["observed"] = {"reason": "no published API path: the package exposes nothing "
                                     "that computes this capability"}
        return rec
    missing = [e for e in d[0] if getattr(sdk, e, None) is None]
    if missing:
        rec["status"] = "unsupported"
        rec["observed"] = {"reason": f"published package does not export: {', '.join(missing)}"}
        return rec

    # Decoding is part of the case. A tag this runner does not understand is an
    # error, not a skip: it means the runner cannot demonstrate the case either
    # way.
    try:
        args = [decode(a) for a in (c.get("input", {}).get("args") or [])]
    except Exception as exc:                                # noqa: BLE001
        rec["status"] = "error"
        rec["observed"] = {"reason": f"could not decode input: {exc}", "errorText": str(exc)}
        return rec

    value = None
    thrown = None
    try:
        value = d[1](args)
    except BaseException as exc:                            # noqa: BLE001
        thrown = exc

    wants_reject = "reject" in c["expect"]

    if thrown is not None:
        error_text = str(thrown)
        # The raw text is recorded on every raise, pass included: message drift
        # is then visible in review even while the class still matches.
        rec["observed"]["errorText"] = error_text
        if isinstance(thrown, (MissingExport, ManifestError)):
            rec["status"] = "error"
            rec["observed"]["reason"] = error_text
            return rec
        cls = classify(cap.get("rejectGroup"), error_text)
        if cls is None:
            # Unclassifiable. Never a pass; widening the table to a catch-all is
            # the move this refuses to make.
            rec["status"] = "error"
            rec["observed"]["reason"] = ("unclassifiable raise in reject group "
                                         f"\"{cap.get('rejectGroup')}\"")
            return rec
        rec["observed"]["reject"] = {"class": cls}
        rec["status"] = "pass" if (wants_reject and c["expect"]["reject"]["class"] == cls) else "fail"
        return rec

    try:
        obs = observed_expect(cap["returns"], value)
    except Exception as exc:                                # noqa: BLE001
        rec["status"] = "error"
        rec["observed"] = {"reason": "could not lift the result into the expectation "
                                     f"domain: {exc}"}
        return rec
    rec["observed"].update(obs)

    if wants_reject:
        rec["observed"]["errorText"] = None
        rec["status"] = "fail"
        return rec

    rec["status"] = "pass" if deep_equal(c["expect"], obs) else "fail"
    if rec["status"] == "fail" and "text" in c["expect"] and "text" in obs:
        i = first_divergent_byte(c["expect"]["text"]["v"], obs["text"]["v"])
        if i is not None:
            rec["observed"]["firstDivergentByte"] = str(i)
    if rec["status"] == "fail" and "document" in c["expect"] and "document" in obs:
        i = first_divergent_byte(c["expect"]["document"]["text"]["v"],
                                 obs["document"]["text"]["v"])
        if i is not None:
            rec["observed"]["firstDivergentByte"] = str(i)
    return rec


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def main() -> int:
    started = time.time()
    records = [run_case(c) for c in sorted(SELECTED, key=lambda c: c["id"])]
    wall_ms = int((time.time() - started) * 1000)

    def by_status(s):
        return [r for r in records if r["status"] == s]

    PASS = len(by_status("pass"))
    FAIL = len(by_status("fail"))
    ERROR = len(by_status("error"))
    UNSUPPORTED = len(by_status("unsupported"))
    NA = len(by_status("not-applicable"))
    RED = FAIL + ERROR + UNSUPPORTED

    EXIT = 1 if (FAIL + ERROR) > 0 else (3 if UNSUPPORTED > 0 else 0)

    header = {
        "rec": "runner", "schema": "1", "language": "python",
        "implementation": f"{DIST_NAME}@{sdk.__version__} (package arccade_game_sdk)",
        "runtime": f"python {platform.python_version()}",
        "manifest": os.path.relpath(MANIFEST_PATH, REPO),
        "manifestSpec": MANIFEST.get("spec"),
        "profilesDeclared": PROFILES,
        "traits": TRAITS,
        "rejectMap": [{"group": r["group"], "match": r["match"], "class": r["class"]}
                      for r in REJECT_MAP],
    }
    summary = {
        "rec": "summary", "total": len(records), "pass": PASS, "fail": FAIL,
        "error": ERROR, "unsupported": UNSUPPORTED, "notApplicable": NA,
        "exitCode": EXIT, "wallMs": wall_ms,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines = ([json.dumps(header, ensure_ascii=False)]
             + [json.dumps(r, ensure_ascii=False) for r in records]
             + [json.dumps(summary, ensure_ascii=False)])
    OUT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    Path(str(OUT_PATH) + ".verdicts").write_text(
        "\n".join(f"{r['id']} {r['status']}" for r in records) + "\n", encoding="utf-8")

    if FLAGS.quiet:
        return EXIT

    W = 78
    divergence_by_case = {d["caseId"]: d for d in MANIFEST.get("divergences", [])}

    def short(o, n=150):
        s = json.dumps(o, ensure_ascii=False)
        return s if len(s) <= n else s[:n] + "..."

    print("=" * W)
    print("arCCade Game SDK conformance - python runner")
    print("=" * W)
    print(f"implementation   {header['implementation']}")
    print(f"entry point      {os.path.relpath(ENTRY_PATH, REPO)}  "
          f"(imported as the top-level package pyproject.toml ships)")
    print(f"runtime          {header['runtime']}")
    print(f"manifest         {header['manifest']}  "
          f"({MANIFEST.get('spec')}, {len(ALL_CASES)} cases)")
    print(f"profiles         {', '.join(PROFILES)}")
    print(f"traits           {' '.join(f'{k}={str(v).lower()}' for k, v in TRAITS.items())}")
    print(f"selected         {len(records)} case(s)")
    print("")

    groups_in_order = [g["group"] for g in MANIFEST.get("groups", [])]

    def pad(s, n):
        return str(s).ljust(n)

    def lpad(s, n):
        return str(s).rjust(n)

    print(f"{pad('GROUP', 24)} {lpad('CASES', 6)} {lpad('PASS', 5)} {lpad('FAIL', 5)} "
          f"{lpad('ERR', 4)} {lpad('UNSUP', 6)} {lpad('N/A', 4)}")
    print("-" * W)
    for g in groups_in_order:
        rs = [r for r in records if r["group"] == g]
        if not rs:
            continue
        p = len([r for r in rs if r["status"] == "pass"])
        f = len([r for r in rs if r["status"] == "fail"])
        e = len([r for r in rs if r["status"] == "error"])
        u = len([r for r in rs if r["status"] == "unsupported"])
        n = len([r for r in rs if r["status"] == "not-applicable"])
        mark = " RED" if (f + e + u) else ""
        print(f"{pad(g, 24)} {lpad(len(rs), 6)} {lpad(p, 5)} {lpad(f, 5)} {lpad(e, 4)} "
              f"{lpad(u, 6)} {lpad(n, 4)}{mark}")
    print("-" * W)
    print(f"{pad('TOTAL', 24)} {lpad(len(records), 6)} {lpad(PASS, 5)} {lpad(FAIL, 5)} "
          f"{lpad(ERROR, 4)} {lpad(UNSUPPORTED, 6)} {lpad(NA, 4)}")
    print("")

    # Profile matrix. A profile carrying an unsupported capability is not
    # conformant, whatever its pass count says.
    print(f"{pad('PROFILE', 20)} {lpad('CASES', 6)} {lpad('PASS', 5)} {lpad('RED', 5)}  VERDICT")
    print("-" * W)
    for p in PROFILES:
        rs = [r for r in records if r["profile"] == p]
        if not rs:
            continue
        pa = len([r for r in rs if r["status"] == "pass"])
        red = len([r for r in rs if r["status"] in ("fail", "error", "unsupported")])
        un = len([r for r in rs if r["status"] == "unsupported"])
        if red == 0:
            verdict = "CONFORMANT"
        elif un == red:
            verdict = f"NOT CONFORMANT ({un} unsupported)"
        else:
            verdict = f"NOT CONFORMANT ({red - un} wrong, {un} unsupported)"
        print(f"{pad(p, 20)} {lpad(len(rs), 6)} {lpad(pa, 5)} {lpad(red, 5)}  {verdict}")
    print("")

    reds = [r for r in records if r["status"] in ("fail", "error", "unsupported")]
    if reds:
        print("=" * W)
        print(f"RED CASES ({len(reds)})")
        print("=" * W)
        last_group = None
        for r in sorted(reds, key=lambda r: (groups_in_order.index(r["group"])
                                             if r["group"] in groups_in_order else 999, r["id"])):
            if r["group"] != last_group:
                print("")
                print(f"-- {r['group']} --")
                last_group = r["group"]
            dv = divergence_by_case.get(r["id"])
            tag = f"  [manifest records a {dv['language']} divergence, {dv['decision']}]" if dv else ""
            print(f"  {r['status'].upper()}  {r['id']}{tag}")
            if r["status"] == "unsupported":
                print(f"        capability {r['capability']}: {r['observed'].get('reason')}")
            elif r["status"] == "error":
                print(f"        capability {r['capability']}: {r['observed'].get('reason')}")
                if r["observed"].get("errorText"):
                    print(f"        errorText: {r['observed']['errorText']}")
            else:
                print(f"        expected: {short(r['expected'])}")
                print(f"        observed: {short({k: v for k, v in r['observed'].items() if k != 'errorText'})}")
                if r["observed"].get("errorText"):
                    print(f"        errorText: {r['observed']['errorText']}")
                if r["observed"].get("firstDivergentByte") is not None:
                    print(f"        first divergent byte: {r['observed']['firstDivergentByte']}")
                if dv:
                    print(f"        the manifest records this as {dv['language']}'s divergence: {dv['reason']}")
        print("")

    # A rule that never fires is a rule nothing exercises. Say so rather than
    # letting the table look better covered than it is.
    whole_run = (not CASE_FILTER and not GROUP_FILTER
                 and len(PROFILES) == len(PROFILES_AVAILABLE))
    unused = [r for r in REJECT_MAP if r["used"] == 0]
    if unused and whole_run:
        print(f"reject-map rules never exercised by this run ({len(unused)}):")
        for r in unused:
            print(f"  {r['group']} | {r['match']} | {r['class']}")
        print("")

    print("=" * W)
    print("SUMMARY")
    print("=" * W)
    print(f"total {len(records)}  pass {PASS}  fail {FAIL}  error {ERROR}  "
          f"unsupported {UNSUPPORTED}  not-applicable {NA}")

    # The manifest states, up front, how much red it expects — but every
    # divergence it records belongs to another client. For this runner the
    # honest accounting is: red on a capability the catalog says Python does not
    # implement is predicted; everything else is a surprise, and a surprise is
    # the only thing here worth waking someone for.
    known_divergent = [r for r in reds
                       if r["status"] == "fail"
                       and divergence_by_case.get(r["id"], {}).get("language") == "python"]
    predicted_unsupported = [r for r in reds
                             if r["status"] == "unsupported"
                             and (CAPS.get(r["capability"], {}).get("impl", {}).get("python")
                                  is None)]
    no_client_at_all = [r for r in predicted_unsupported
                        if CAPS.get(r["capability"], {}).get("implementedByAnyClient") is False]
    unaccounted = [r for r in reds
                   if r not in known_divergent and r not in predicted_unsupported]
    print(f"red {RED}")
    print(f"  {len(known_divergent)} divergences the manifest records against python")
    print(f"  {len(predicted_unsupported)} on capabilities the catalog records as unimplemented in python")
    print(f"    of those, {len(no_client_at_all)} are implemented by no client in any language")
    print(f"  {len(unaccounted)} unaccounted")
    for r in unaccounted:
        print(f"    UNACCOUNTED {r['status']} {r['id']} ({r['capability']})")
    print(f"wall {wall_ms} ms")
    print(f"results  {os.path.relpath(OUT_PATH, REPO)}")
    print(f"verdicts {os.path.relpath(OUT_PATH, REPO)}.verdicts")
    print(f"exit {EXIT}  (0 all green, 1 fail/error, 2 manifest, 3 unsupported in a declared profile)")
    return EXIT


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:                                   # noqa: BLE001
        # Exit 4 is "the runner itself broke". Kept distinct from 1 so a crash in
        # the harness can never be read as a client failing a case.
        traceback.print_exc()
        raise SystemExit(4)
