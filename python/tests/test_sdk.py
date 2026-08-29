"""Unit tests for the Python client.

The conformance suite (``conformance/runners/run.py``) is the cross-language
contract and covers 468 cases; these tests cover what a unit suite is better at:
the refusals, the class of each refusal at the API surface, and the decisions
where this client is deliberately stricter than the JavaScript one. Before this
file existed, none of the Python guards had a test — the two ``main()``
self-checks asserted golden vectors and exercised no error path at all.

Run:  python3 -m unittest discover -s python/tests
"""

from __future__ import annotations

import subprocess
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import arccade_game_sdk as sdk  # noqa: E402


class TestCanonicalEncoding(unittest.TestCase):
    def test_length_is_code_points(self):
        self.assertEqual(sdk.canon_text("abc"), "t:3:abc")
        self.assertEqual(sdk.canon_text("\U0001f3ae"), "t:1:\U0001f3ae")
        self.assertEqual(sdk.code_point_length("\U0001f3ae"), 1)
        # The ZWJ family is seven code points, not one grapheme.
        self.assertEqual(sdk.code_point_length("\U0001f468‍\U0001f469‍"
                                               "\U0001f467‍\U0001f466"), 7)

    def test_fields_sort_by_ascii_name_and_keep_duplicates(self):
        self.assertEqual(sdk.canon_fields([("b", "2"), ("a", "1")]),
                         "r:16:k:1:a=1;k:1:b=2;")
        self.assertEqual(sdk.canon_fields([("a", "1"), ("a", "2")]),
                         "r:16:k:1:a=1;k:1:a=2;")
        self.assertEqual(sdk.canon_fields([("a", "1"), ("A", "2")]),
                         "r:16:k:1:A=2;k:1:a=1;")

    def test_field_names_are_ascii_only(self):
        # D6. Python was the one implementation that did not enforce this, which
        # inverted the point of having an independent reference.
        for bad in ("ücret", "a b", "a_b", "", "a.b", "\U0001f3ae"):
            with self.assertRaises(ValueError, msg=bad):
                sdk.canon_fields([(bad, "1")])
        self.assertEqual(sdk.canon_fields([("a-b-9", "1")]), "r:12:k:5:a-b-9=1;")

    def test_list_count_disambiguates_an_embedded_pipe(self):
        self.assertEqual(sdk.canon_list(["a|b"]), "l:5:1:a|b")
        self.assertEqual(sdk.canon_list(["a", "b"]), "l:5:2:a|b")

    def test_canon_int_refuses_a_boolean_and_a_decimal_string(self):
        # D9: str(True) would yield i:4:True here and i:1:1 in JavaScript.
        with self.assertRaises(TypeError):
            sdk.canon_int(True)
        with self.assertRaises(ValueError):
            sdk.canon_int("100.0")
        self.assertEqual(sdk.canon_int("42"), "i:2:42")

    def test_text_digest_refuses_the_empty_string(self):
        # D7: Daml's toHex "" is a runtime error, so the chain can never produce
        # sha256(""). A client that returns it computes an impossible value.
        with self.assertRaises(ValueError):
            sdk.text_digest("")
        self.assertEqual(sdk.text_digest("arccade"),
                         "140f371fce01eea5068da54d3de6bb719d68dc325f494be284ce56a52da44079")

    def test_text_digest_matches_plain_sha256sum(self):
        # The claim the package rests on: a third party reproduces the digest
        # with a shell tool and no library.
        out = subprocess.run(["sha256sum"], input=b"arccade",
                             capture_output=True, check=True).stdout
        self.assertEqual(out.split()[0].decode(), sdk.text_digest("arccade"))

    def test_document_envelope(self):
        self.assertEqual(sdk.canon_document("s", 1, []),
                         "arccade-sdk-digest-v1|t:1:si:1:1r:0:")


class TestAmounts(unittest.TestCase):
    def test_pinned_conversions(self):
        for given, want in (("1.0", 10000000000), ("12.3456789012", 123456789012),
                            ("0.0000000001", 1), ("-1.5", -15000000000),
                            ("1.50000000000000", 15000000000), ("1.", 10000000000),
                            ("-0.0", 0), ("100", 1000000000000)):
            self.assertEqual(sdk.amount_units(given), want, given)

    def test_truncation_is_toward_zero(self):
        self.assertEqual(sdk.amount_units("922337203.6854775807"), 9223372036854775807)
        self.assertEqual(sdk.amount_units("-922337203.6854775808"), -9223372036854775808)

    def test_band_is_enforced(self):
        # D5. Accepting an amount the ledger cannot hold makes the reference
        # useless for rejecting one.
        for over in ("922337203.6854775808", "-922337203.6854775809", "1000000000.0"):
            with self.assertRaises(ValueError, msg=over):
                sdk.amount_units(over)

    def test_precision_loss_is_refused(self):
        for lossy in ("0.00000000005", "1.23456789012", "-0.00000000019"):
            with self.assertRaises(ValueError, msg=lossy):
                sdk.amount_units(lossy)

    def test_grammar_is_strict(self):
        for bad in ("+1", ".5", "1e3", "1E+2", "abc", "", "1.2.3", "1,5", " 1.5"):
            with self.assertRaises(ValueError, msg=bad):
                sdk.amount_units(bad)

    def test_a_native_float_is_refused(self):
        # D4. canon_decimal(123456789.0123456789) used to return
        # d:19:1234567890123456700 here and ...456789 in JavaScript, both
        # reporting success.
        with self.assertRaises(TypeError):
            sdk.amount_units(123456789.0123456789)
        with self.assertRaises(TypeError):
            sdk.canon_decimal(1.5)
        with self.assertRaises(TypeError):
            sdk.amount_units(None)

    def test_decimal_input_is_exact(self):
        self.assertEqual(sdk.amount_units(Decimal("12.3456789012")), 123456789012)


class TestMerkle(unittest.TestCase):
    LEAVES = [
        "4140bf0e8569ed03ec838871ff2f190e9b3ea86bc083d7e9901049f75f00e855",
        "649837ddcb7e1967086d7d35aaef7b975c513815d96fc6e70015e93a2bfe0f9a",
        "9fde56c376760bd399b82eb8569229a2dff19219411ac71154dfeab2cf502454",
    ]

    def test_goldens(self):
        self.assertEqual(sdk.merkle_empty(),
                         "c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0")
        self.assertEqual(sdk.merkle_root(self.LEAVES),
                         "f31cc766e62a52c3c3156e05d53fde76f54fed6067d283dc9a3d8ada9d0ceedf")

    def test_a_lone_node_is_promoted_not_duplicated(self):
        # CVE-2012-2459: duplicating would let [a,b,c] and [a,b,c,c] share a root.
        three = sdk.merkle_root(self.LEAVES)
        four = sdk.merkle_root(self.LEAVES + [self.LEAVES[2]])
        self.assertNotEqual(three, four)

    def test_single_leaf_is_returned_verbatim(self):
        self.assertEqual(sdk.merkle_root([self.LEAVES[0]]), self.LEAVES[0])

    def test_every_index_at_every_size_verifies(self):
        for n in range(1, 10):
            leaves = [sdk.text_digest(f"x-{i}") for i in range(n)]
            root = sdk.merkle_root(leaves)
            for ix in range(n):
                self.assertTrue(
                    sdk.merkle_verify(leaves[ix], sdk.merkle_proof(ix, leaves), root),
                    f"n={n} ix={ix}")

    def test_out_of_range_index_returns_an_empty_proof(self):
        # Not an exception: an empty proof is indistinguishable from a one-leaf
        # tree, which is why a caller must not read [] as proof of anything.
        self.assertEqual(sdk.merkle_proof(9, self.LEAVES), [])
        self.assertEqual(sdk.merkle_proof(-1, self.LEAVES), [])


GOLDEN_ROW = {
    "cycleId": "cycle-golden", "player": "auditor-golden-party",
    "gameCode": "pixel-race-v1", "concurrencyIndex": 0,
    "entryDigest": "0" * 63 + "1", "outcomeDigest": "0" * 63 + "2",
    "committedUnits": 300000000000, "feeUnits": 100000000,
    "returnedUnits": 300000000000, "forfeitedUnits": 0, "payoutUnits": 0,
    "disposition": "returned-in-full", "committedAtMicros": 1700000000000000,
    "settledAtMicros": 1700000003600000,
    "custodyTag": "arccade-game-sdk:1:cycle-golden:x",
}


class TestAuditRows(unittest.TestCase):
    def test_golden_leaf(self):
        self.assertEqual(sdk.period_leaf(GOLDEN_ROW),
                         "01e89a905ec52a23012354b602cdf583a7bc6dd92d9c36a19aa0346a1cf26237")

    def test_disposition_must_be_a_tag_not_a_constructor(self):
        for ctor in ("ReturnedInFull", "ReturnedWithForfeit", "ForfeitedInFull",
                     "Aborted", "ExpiredUnsettled"):
            with self.assertRaises(ValueError, msg=ctor):
                sdk.period_leaf_document(dict(GOLDEN_ROW, disposition=ctor))

    def test_amounts_in_a_row_are_units_not_decimals(self):
        with self.assertRaises(ValueError):
            sdk.period_leaf_document(dict(GOLDEN_ROW, committedUnits="100.0"))

    def test_a_tampered_row_does_not_verify(self):
        rows = [dict(GOLDEN_ROW, cycleId=f"c-{i}") for i in range(5)]
        leaves = [sdk.period_leaf(r) for r in rows]
        root = sdk.merkle_root(leaves)
        proof = sdk.merkle_proof(2, leaves)
        self.assertTrue(sdk.period_row_verify(rows[2], proof, root))
        for field, value in (("payoutUnits", 999900000000),
                             ("committedUnits", 999900000000),
                             ("player", "someone-else")):
            self.assertFalse(sdk.period_row_verify(dict(rows[2], **{field: value}),
                                                   proof, root), field)

    def test_raw_merkle_verify_accepts_an_internal_node(self):
        # This is why period_row_verify exists and raw merkle_verify is not the
        # auditor's endpoint: folding cannot know what it started from, so an
        # internal node verifies just as a leaf would. Deriving the leaf from the
        # row is what binds the claim to the cycle-audit-row schema.
        rows = [dict(GOLDEN_ROW, cycleId=f"c-{i}") for i in range(4)]
        leaves = [sdk.period_leaf(r) for r in rows]
        left = sdk.merkle_node(leaves[0], leaves[1])
        right = sdk.merkle_node(leaves[2], leaves[3])
        root = sdk.merkle_node(left, right)
        self.assertEqual(root, sdk.merkle_root(leaves))
        self.assertTrue(sdk.merkle_verify(left, [sdk.MerkleStep(False, right)], root))
        self.assertNotIn(left, leaves)

    def test_iso_to_micros_is_microsecond_exact_and_utc_only(self):
        self.assertEqual(sdk.iso_to_micros("2026-08-22T22:29:07.372202Z"), 1787437747372202)
        self.assertEqual(sdk.iso_to_micros("1970-01-01T00:00:00Z"), 0)
        for bad in ("2026-08-22T22:29:07.372202", "2026-08-22T22:29:07.372202+02:00"):
            with self.assertRaises(ValueError, msg=bad):
                sdk.iso_to_micros(bad)

    def test_canon_time_keeps_microseconds(self):
        # D3: a millisecond-precision parser would give m:16:1787605091258000.
        self.assertEqual(sdk.canon_time("2026-08-24T20:58:11.258920Z"),
                         "m:16:1787605091258920")

    def test_report_order_names_its_collation(self):
        # D11: the previous wording left the tie-break open, and two honest
        # implementations published two different Merkle roots.
        self.assertIn("Unicode code point", sdk.REPORT_ORDER)


class TestIdentifiers(unittest.TestCase):
    def test_cycle_id_limit_is_in_code_points(self):
        # D2: the ledger accepts a 64-code-point id containing astral
        # characters; a UTF-16 count would refuse a cycle that already exists.
        sdk.assert_valid_cycle_id("\U0001f3ae" * 64)
        with self.assertRaises(ValueError):
            sdk.assert_valid_cycle_id("\U0001f3ae" * 65)
        with self.assertRaises(ValueError):
            sdk.assert_valid_cycle_id("")

    def test_cycle_id_separators_are_refused(self):
        for bad in ("tw:1", "tw|1"):
            with self.assertRaises(ValueError, msg=bad):
                sdk.assert_valid_cycle_id(bad)

    def test_hex64(self):
        good = "fd8d8db1d08ba84d3325137b8adf0c7dc7c894e3bd099b36c9464b618f190d4b"
        self.assertEqual(sdk.assert_hex64(good), good)
        for bad in (good.upper(), good[:-1], good + "a", good[:-1] + "z", ""):
            with self.assertRaises(ValueError):
                sdk.assert_hex64(bad)

    def test_custody_tag(self):
        tag = sdk.custody_tag_for(
            "tw-testnet-1787437747",
            "5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852")
        self.assertTrue(tag.startswith(sdk.CUSTODY_TAG_PREFIX))
        self.assertEqual(tag.count(":"), 3)


class TestTenantAndAssets(unittest.TestCase):
    def test_isolation(self):
        sdk.assert_tenant_owns_instrument("mygame", {"admin": "r", "id": "mygame/gold"})
        sdk.assert_tenant_owns_instrument("mygame", {"admin": "dso", "id": "Amulet"})
        with self.assertRaises(ValueError):
            sdk.assert_tenant_owns_instrument("mygame", {"admin": "r", "id": "other/gold"})

    def test_key_round_trip(self):
        key = sdk.generate_tenant_key("mygame")
        self.assertEqual(sdk.tenant_id_from_key(key["secret"]), "mygame")
        self.assertTrue(sdk.verify_tenant_key(key["secret"], key["hash"]))
        self.assertFalse(sdk.verify_tenant_key(key["secret"] + "x", key["hash"]))
        self.assertFalse(sdk.verify_tenant_key(key["secret"], "deadbeef"))

    def test_new_cycle_id_is_always_valid(self):
        for _ in range(100):
            sdk.assert_valid_cycle_id(sdk.new_cycle_id())

    def test_new_trade_id_is_always_valid(self):
        for _ in range(100):
            sdk.assert_valid_trade_id(sdk.new_trade_id())

    def test_unique_asset_amount_must_be_one(self):
        unique = {"admin": "r", "id": "mygame/sword#4a91c8f2"}
        sdk.assert_amount_valid_for_asset(unique, "1")
        with self.assertRaises(ValueError):
            sdk.assert_amount_valid_for_asset(unique, "3")
        with self.assertRaises(ValueError):
            sdk.assert_amount_valid_for_asset({"admin": "r", "id": "mygame/gold"}, "0")

    def test_attribute_document_refuses_a_float(self):
        with self.assertRaises(TypeError):
            sdk.asset_attribute_document({"admin": "r", "id": "mygame/sword#4a91c8f2"},
                                         [("weight", 1.5)])


class TestValueDocuments(unittest.TestCase):
    LEGS = [("offer", {"sender": "m", "receiver": "t",
                       "instrumentId": {"admin": "r", "id": "mygame/sword#4a91c8f2"},
                       "amount": "1"}),
            ("ask", {"sender": "t", "receiver": "m",
                     "instrumentId": {"admin": "dso", "id": "Amulet"},
                     "amount": "25.0"})]

    def test_pipe_in_a_component_is_refused(self):
        # D8: the format has no length prefixes, so a pipe inside a value
        # silently reshapes the document.
        with self.assertRaises(ValueError):
            sdk.trade_document({"tradeId": "t-1", "maker": "m|x", "taker": "t",
                                "expiresAt": "2026-08-30T00:00:00Z", "legs": self.LEGS})
        with self.assertRaises(ValueError):
            sdk.trade_document({"tradeId": "t-1", "maker": "m", "taker": "t",
                                "expiresAt": "2026-08-30T00:00:00Z", "legs": self.LEGS,
                                "meta": [("memo", "for the|sword")]})

    def test_transfer_guards(self):
        base = dict(amuletPackageId="a", sender="v", provider="v",
                    inputAmuletCids=["c"], amuletRulesCid="r",
                    openMiningRoundCid="o", dsoParty="d", transferId="x-1")
        rec = {"receiver": "p1", "amount": "5.0",
               "instrumentId": {"admin": "dso", "id": "Amulet"}}
        with self.assertRaises(ValueError):          # self-transfer
            sdk.build_transfer_commands(dict(base, recipients=[dict(rec, receiver="v")]))
        with self.assertRaises(ValueError):          # repeated recipient
            sdk.build_transfer_commands(dict(base, recipients=[rec, dict(rec)]))
        with self.assertRaises(ValueError):          # unknown reason
            sdk.build_transfer_commands(dict(base, recipients=[rec], reason="airdrop"))
        with self.assertRaises(ValueError):          # non-positive amount
            sdk.build_transfer_commands(dict(base, recipients=[dict(rec, amount="0")]))


class TestBuilders(unittest.TestCase):
    COMMIT = dict(
        sdkPackageId="sdk", amuletPackageId="amulet", venue="v", operator="o",
        player="p", entitlementCid="e", gameCode="g", cycleId="c-1",
        entryDigest="5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852",
        stakeAmount="100.0", feeAmount="0.5",
        instrumentId={"admin": "dso", "id": "Amulet"},
        lockExpiresAt="2026-08-23T00:29:07Z", amuletRulesCid="rules",
        openMiningRoundCid="round", inputAmuletCids=["amulet-1"], dsoParty="dso")

    def test_write_one_is_two_commands_in_one_submission(self):
        out = sdk.build_commit_commands(self.COMMIT)
        self.assertEqual(len(out["commands"]), 2)
        self.assertEqual(out["commands"], out["submission"]["commands"]["commands"])

    def test_custody_tag_reaches_opt_context(self):
        out = sdk.build_commit_commands(self.COMMIT)
        lock = out["commands"][0]["ExerciseCommand"]["choiceArgument"]["transfer"]["outputs"][-1]["lock"]
        self.assertEqual(lock["optContext"], out["custodyTag"])

    def test_a_missing_fee_amount_is_refused(self):
        # D10: bare string coercion sent the literal text "undefined" to the
        # ledger. Verified on the JavaScript client.
        opts = dict(self.COMMIT)
        del opts["feeAmount"]
        with self.assertRaises(TypeError):
            sdk.build_commit_commands(opts)

    def test_settle_comes_before_unlock(self):
        out = sdk.build_settle_commands(dict(
            sdkPackageId="sdk", amuletPackageId="amulet", venue="v", operator="o",
            player="p", stakeCid="stake-1", lockedAmuletCid="locked-1",
            returnedAmount="100.0",
            outcomeDigest="124de70ecc959cfe2d9f01362a414e9a493df2e10b521551ffd262c1f29d2f0a"))
        choices = [c["ExerciseCommand"]["choice"] for c in out["commands"]]
        self.assertEqual(choices, ["GameStake_Settle", "LockedAmulet_UnlockV2"])


class TestPolicyAnchorSettlement(unittest.TestCase):
    POLICY = {"min-stake-amount": "1.0", "max-stake-amount": "1000.0",
              "min-platform-fee": "0.5", "max-payout-amount": "5000.0",
              "min-lock-seconds": 7200, "max-lock-seconds": 86400,
              "min-cycle-seconds": 60, "max-cycle-seconds": 3600,
              "cooldown-seconds": 30, "abort-cooldown-seconds": 300,
              "concurrency-limit": 3, "require-custody-proof": True}

    def test_valid_policy(self):
        self.assertTrue(sdk.valid_policy(self.POLICY))
        # A lock that can expire mid-cycle is not a lock.
        self.assertFalse(sdk.valid_policy(dict(self.POLICY, **{"min-lock-seconds": 30})))
        self.assertFalse(sdk.valid_policy(dict(self.POLICY, **{"min-stake-amount": "0.0"})))
        self.assertFalse(sdk.valid_policy(dict(self.POLICY, **{"concurrency-limit": 0})))

    def test_live_testnet_anchor_reproduces(self):
        # The anchor written to TestNet on 2026-08-27. Until this client existed
        # no shipped implementation could re-derive it outside Daml.
        anchor = {
            "venueId": "tradewars/testnet-arena-v2", "periodId": "2026-08-27",
            "periodStartMicros": 1787788800000000, "periodEndMicros": 1787875200000000,
            "cycleCount": 0, "committedUnits": 0, "feeUnits": 0, "returnedUnits": 0,
            "forfeitedUnits": 0, "payoutUnits": 0, "qualifyingTxCount": 0,
            "nonQualifyingTxCount": 1, "merkleRootHex": sdk.merkle_empty(),
            "reportDigest": "b4fda252f5064e39a0ed7a6e2914794545a3523b965e631eb94920f38be973fb",
            "prevAnchorDigest": "caa2d6f54dc9d0be9d165e505757cc760a421c13c75a21a6ac69e194e0470fc6",
        }
        self.assertEqual(
            sdk.anchor_digest(anchor),
            "f3e0805b9c3b9b9147f8b7b866ddd34d157d5d1e1e60b5942e14335909a6bd2a")

    def test_anchor_totals_refuse_a_duplicate_cycle_id(self):
        row = dict(GOLDEN_ROW)
        self.assertEqual(sdk.anchor_totals([row])["cycleCount"], 1)
        with self.assertRaises(ValueError):
            sdk.anchor_totals([row, dict(row)])

    def test_settlement_invariants(self):
        base = {"disposition": "returned-in-full", "stakeUnits": 1000,
                "returnedUnits": 1000, "forfeitedUnits": 0, "payoutUnits": 0,
                "maxPayoutUnits": 5000}
        self.assertTrue(sdk.assert_settlement_valid(base))
        with self.assertRaises(ValueError):      # conservation
            sdk.assert_settlement_valid(dict(base, returnedUnits=900))
        with self.assertRaises(ValueError):      # tag contradicts the amounts
            sdk.assert_settlement_valid(dict(base, returnedUnits=900, forfeitedUnits=100))
        with self.assertRaises(ValueError):      # payout above the cap
            sdk.assert_settlement_valid(dict(base, payoutUnits=6000))
        self.assertTrue(sdk.assert_settlement_valid(dict(base, payoutUnits=5000)))
        with self.assertRaises(ValueError):      # negative leg
            sdk.assert_settlement_valid(dict(base, returnedUnits=-1000, forfeitedUnits=2000))


class TestLedgerTime(unittest.TestCase):
    def test_division_truncates_toward_zero(self):
        self.assertEqual(sdk.int_divide(-7, 2), -3)
        self.assertEqual(sdk.epoch_seconds(-500000), 0)

    def test_each_endpoint_is_truncated_independently(self):
        # 0.9s to 60.0s is SIXTY seconds, not fifty-nine. A client computing
        # (b - a) / 1e6 refuses cycles the ledger accepts.
        self.assertEqual(sdk.seconds_between(900000, 60000000), 60)
        self.assertEqual(sdk.seconds_between(1999999, 2000000), 1)
        self.assertEqual(sdk.seconds_between(60000000, 900000), -60)

    def test_add_seconds(self):
        self.assertEqual(sdk.add_seconds(1787437775189712, 30), 1787437805189712)
        self.assertEqual(sdk.add_seconds(1787437775189712, 0), 1787437775189712)


class TestGameAdapters(unittest.TestCase):
    def test_entry_goldens(self):
        self.assertEqual(
            sdk.tw_entry_digest("tw-sample-1", "silver", "10000.0",
                                [("BTC", "60.0"), ("ETH", "40.0")],
                                [("BTC", "60000.0", "binance", 1000000),
                                 ("ETH", "3000.0", "binance", 1000000)]),
            "5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852")
        self.assertEqual(
            sdk.pr_entry_digest("pr-sample-1", "bronze", 3, "0" * 64),
            "0b2349e05633cf279ca0ee1d3f5efd8b2308f3e2ee947a32f5c3397e456d0204")

    def test_seed_commitment(self):
        seed = "pixel-race-seed-2026-08-24"
        self.assertTrue(sdk.seed_matches_commit(seed, sdk.text_digest(seed)))
        self.assertFalse(sdk.seed_matches_commit(seed, "0" * 64))

    def test_allocation_order_changes_the_digest(self):
        a = sdk.tw_entry_digest("c", "silver", "1.0",
                                [("BTC", "60.0"), ("ETH", "40.0")], [])
        b = sdk.tw_entry_digest("c", "silver", "1.0",
                                [("ETH", "40.0"), ("BTC", "60.0")], [])
        self.assertNotEqual(a, b)


class TestTransactionTrees(unittest.TestCase):
    def test_the_published_fixture_reproduces(self):
        import json
        root = Path(__file__).resolve().parent.parent.parent
        trees = json.loads((root / "test-vectors" / "cycle-trees.json").read_text())
        expected = json.loads((root / "test-vectors" / "cycle-rows.json").read_text())
        txs = [t for c in trees["cases"]
               for t in (c["commitTransaction"], c["closingTransaction"])]
        report = sdk.rows_from_transactions(txs)
        leaves = [sdk.period_leaf(r) for r in report.rows]
        self.assertEqual(leaves, expected["leaves"])
        self.assertEqual(sdk.merkle_root(leaves), expected["merkleRoot"])
        self.assertEqual((report.warnings, report.open_stakes, report.orphan_closings),
                         ([], [], []))

    def test_report_order_breaks_ties_by_code_point(self):
        # D1. The fixture never reaches the tie-break: its three timestamps are
        # all distinct, which is how CI stayed green on a divergence that would
        # break the exact claim the period anchor exists to make.
        rows = [{"committedAtMicros": 1, "cycleId": c} for c in ("B", "a", "_z", "Z")]
        rows.sort(key=lambda r: (r["committedAtMicros"], r["cycleId"]))
        self.assertEqual([r["cycleId"] for r in rows], ["B", "Z", "_z", "a"])


if __name__ == "__main__":
    unittest.main()
