package io.arccade.gamesdk;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The two-write cycle's command builders.
 *
 * <p>This is where the SDK earns its keep: the cycle discipline is turned into
 * code so a game developer cannot get it wrong. Three rules in particular:
 *
 * <ul>
 *   <li><b>WRITE 1 is exactly TWO commands and they MUST travel in one
 *       submission.</b> Sent separately, the link between the lock and the
 *       {@code GameStake} breaks: the commit can succeed while the transfer
 *       fails, or the reverse, and a {@code GameStake} that exists unfunded is
 *       the failure this design exists to prevent.</li>
 *   <li><b>In WRITE 2 the ORDER matters.</b> {@code GameStake_Settle} READS the
 *       lock through the {@code Holding} interface, so it must come BEFORE the
 *       {@code LockedAmulet_UnlockV2} that archives it. Reversed, settlement is
 *       rejected for want of custody proof.</li>
 *   <li><b>{@code optContext} carries the custody tag.</b> Writing generic text
 *       there ("arCCade game stake") makes the stake unusable: settlement
 *       cannot verify the tag and the cycle can only be aborted.</li>
 * </ul>
 *
 * <p>The commands are JSON Ledger API v2 payloads; submitting them is left to
 * the caller ({@code submit-and-wait-for-transaction}).
 */
public final class CycleCommands {

    /** First component of every custody tag on the ledger. A wire constant. */
    public static final String CUSTODY_TAG_PREFIX = "arccade-game-sdk:1:";

    /** The prefix a venue id must carry to run in dry-run mode. */
    public static final String DRY_RUN_VENUE_PREFIX = "dryrun-";

    private static final String CYCLE_MODULE = "ArCCade.GameSdk.Cycle";
    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");

    private CycleCommands() {
    }

    /** {@code arccade-game-sdk:1:<cycleId>:<entryDigest>} */
    public static String custodyTagFor(String cycleId, String entryDigest) {
        assertValidCycleId(cycleId);
        assertHex64(entryDigest);
        return CUSTODY_TAG_PREFIX + cycleId + ":" + entryDigest;
    }

    /**
     * A new, unique cycle id.
     *
     * <p>UNIQUENESS MATTERS: there is no contract key, so the ledger cannot stop
     * the same {@code cycleId} + {@code entryDigest} pair being used twice, and
     * one lock carrying that tag could then appear to prove more than one cycle.
     * That is a known and reported limit of the design. The SDK closes it at
     * source — take the id from here, never hand-roll one.
     */
    public static String newCycleId() {
        return newCycleId("c");
    }

    public static String newCycleId(String prefix) {
        return assertValidCycleId(prefix + "-" + UUID.randomUUID());
    }

    /**
     * The length limit is 64 CODE POINTS, not 64 UTF-16 units.
     *
     * <p>Daml's {@code T.length} counts code points, so a 64-emoji id is one the
     * ledger accepts. A client measuring UTF-16 units refuses it — and refuses
     * it on the AUDIT path, against a cycle that is already committed, which is
     * the worst place to discover a length rule.
     */
    public static String assertValidCycleId(String cycleId) {
        if (cycleId == null || cycleId.isEmpty()
                || ArccadeDigest.codePointLength(cycleId) > 64) {
            throw new IllegalArgumentException(
                    "invalid cycleId (non-empty, at most 64 code points): " + cycleId);
        }
        if (cycleId.indexOf(':') >= 0 || cycleId.indexOf('|') >= 0) {
            // The tag is parsed by splitting on ':', so an id containing one
            // makes the tag ambiguous rather than merely ugly.
            throw new IllegalArgumentException("a cycleId cannot contain ':' or '|': " + cycleId);
        }
        return cycleId;
    }

    /** A lowercase 64-character sha256. Uppercase is refused, not folded. */
    public static String assertHex64(String h) {
        if (h == null || !HEX64.matcher(h).matches()) {
            throw new IllegalArgumentException(
                    "expected a 64-character lowercase sha256: " + h);
        }
        return h;
    }

    // ------------------------------------------------------- write 1: commit

    /**
     * Everything {@code AmuletRules_Transfer} and {@code Entitlement_Commit}
     * need, in the order they appear in the payload.
     *
     * <p>{@code stakeAmount} and {@code feeAmount} are decimal TEXT. Neither may
     * be null: a builder that serialises a missing amount writes the literal
     * text of whatever its language calls "absent" into a ledger field, which is
     * a submission failure at best and a zero-fee stake at worst.
     */
    public record CommitOptions(String sdkPackageId, String amuletPackageId, String venue,
                                String operator, String player, String entitlementCid,
                                String gameCode, String cycleId, String entryDigest,
                                String stakeAmount, String feeAmount, InstrumentId instrumentId,
                                String lockExpiresAt, String amuletRulesCid,
                                String openMiningRoundCid, List<String> inputAmuletCids,
                                String dsoParty, String commandId, Map<String, String> stakeMeta) {
    }

    /**
     * WRITE 1 — commitment. Two commands, one submission, one updateId.
     *
     * <ol>
     *   <li>{@code AmuletRules_Transfer} — the non-refundable fee to the venue,
     *       the stake to the player under a {@code TimeLock} (a real
     *       {@code LockedAmulet}), and the change.</li>
     *   <li>{@code Entitlement_Commit} — consumes the slot and creates the
     *       {@code GameStake}.</li>
     * </ol>
     *
     * <p>The two commands CANNOT see each other: there is no output-to-input
     * chaining within one submission. The link between them is therefore
     * atomicity plus the custody tag, and it is verified at settlement.
     */
    public static Json buildCommitCommands(CommitOptions o) {
        assertValidCycleId(o.cycleId());
        assertHex64(o.entryDigest());
        requireAmount("stakeAmount", o.stakeAmount());
        requireAmount("feeAmount", o.feeAmount());
        if (o.inputAmuletCids() == null || o.inputAmuletCids().isEmpty()) {
            throw new IllegalArgumentException(
                    "inputAmuletCids cannot be empty: there is no Amulet input to lock");
        }
        String custodyTag = custodyTagFor(o.cycleId(), o.entryDigest());

        List<Json> outputs = new ArrayList<>();
        if (ArccadeDigest.amountUnits(o.feeAmount()) > 0) {
            outputs.add(Json.object()
                    .put("receiver", o.venue())
                    .put("amount", o.feeAmount())
                    .put("receiverFeeRatio", "0.0")
                    .build());
        }
        outputs.add(Json.object()
                .put("receiver", o.player())
                .put("amount", o.stakeAmount())
                .put("receiverFeeRatio", "0.0")
                .put("lock", Json.object()
                        .put("holders", LedgerPayloads.parties(List.of(o.venue())))
                        .put("expiresAt", o.lockExpiresAt())
                        // The field that binds the lock to the cycle. Do NOT
                        // write generic text here.
                        .put("optContext", custodyTag)
                        .build())
                .build());

        Json transferCmd = LedgerPayloads.exercise(
                LedgerPayloads.templateId(o.amuletPackageId(), "Splice.AmuletRules", "AmuletRules"),
                o.amuletRulesCid(), "AmuletRules_Transfer",
                Json.object()
                        .put("transfer", Json.object()
                                .put("sender", o.player())
                                .put("provider", o.venue())
                                .put("inputs", amuletInputs(o.inputAmuletCids()))
                                .put("outputs", Json.array(outputs))
                                .put("beneficiaries", Json.nul())
                                .build())
                        .put("context", transferContext(o.openMiningRoundCid()))
                        .put("expectedDso", o.dsoParty())
                        .build());

        Json commitCmd = commitCommand(o.sdkPackageId(), o.entitlementCid(), o.gameCode(),
                o.cycleId(), o.stakeAmount(), o.feeAmount(), o.venue(), o.instrumentId(),
                o.lockExpiresAt(), custodyTag, o.entryDigest(), o.stakeMeta());

        // Transfer first. Being in one transaction, the order is technically
        // free; writing the transfer first shows the lock before the stake in
        // the event stream, which is the order a report reads in.
        List<Json> commands = List.of(transferCmd, commitCmd);
        List<String> actAs = List.of(o.player(), o.venue(), o.operator());
        List<String> readAs = List.of(o.player(), o.venue());
        return Json.object()
                .put("custodyTag", custodyTag)
                .put("cycleId", o.cycleId())
                .put("commands", Json.array(commands))
                .put("actAs", LedgerPayloads.parties(actAs))
                .put("readAs", LedgerPayloads.parties(readAs))
                .put("submission", LedgerPayloads.submission(commands,
                        LedgerPayloads.orElse(o.commandId(), "commit-" + o.cycleId()),
                        actAs, readAs))
                .build();
    }

    /**
     * The dry-run half of {@link CommitOptions}: no lock, so no Amulet inputs,
     * no {@code AmuletRules} contract and no DSO party.
     */
    public record DryRunCommitOptions(String sdkPackageId, String venue, String operator,
                                      String player, String entitlementCid, String gameCode,
                                      String cycleId, String entryDigest, String stakeAmount,
                                      InstrumentId instrumentId, String lockExpiresAt,
                                      String commandId, Map<String, String> stakeMeta) {
    }

    /**
     * A DRY-RUN commit — ONE command, no lock.
     *
     * <p>It is a separate function because {@link #buildCommitCommands} is for
     * live custody and demands {@code inputAmuletCids}, {@code amuletRulesCid},
     * {@code openMiningRoundCid} and the DSO party. The learning ramp is the dry
     * run: a full stake-and-settle cycle with no Canton Coin and no disclosed
     * contracts from Scan. What should be learned in the first hour is this SDK,
     * not Splice's transfer mechanics.
     *
     * <p>{@code ModeDryRun} is already constrained by the venue contract — the
     * venue id must start with {@code dryrun-}, and both the fee floor and the
     * maximum payout must be ZERO — so a dry-run cycle cannot be REPORTED as a
     * real one.
     *
     * <p>The custody tag is still computed and written into the terms.
     * Settlement verifies it against the cycle's identity and entry commitment
     * even with no lock present; skipping it here would create a difference that
     * first appeared on the day a game went live.
     */
    public static Json buildDryRunCommitCommands(DryRunCommitOptions o) {
        assertValidCycleId(o.cycleId());
        assertHex64(o.entryDigest());
        requireAmount("stakeAmount", o.stakeAmount());
        String custodyTag = custodyTagFor(o.cycleId(), o.entryDigest());

        // The fee is written as an explicit zero rather than left out: mode
        // discipline enforces zero in the contract, and a caller who thought
        // they could charge should see the zero they are actually sending.
        Json commitCmd = commitCommand(o.sdkPackageId(), o.entitlementCid(), o.gameCode(),
                o.cycleId(), o.stakeAmount(), "0.0", o.venue(), o.instrumentId(),
                o.lockExpiresAt(), custodyTag, o.entryDigest(), o.stakeMeta());

        List<Json> commands = List.of(commitCmd);
        List<String> actAs = List.of(o.player(), o.venue(), o.operator());
        List<String> readAs = List.of(o.player(), o.venue());
        return Json.object()
                .put("custodyTag", custodyTag)
                .put("cycleId", o.cycleId())
                .put("commands", Json.array(commands))
                .put("actAs", LedgerPayloads.parties(actAs))
                .put("readAs", LedgerPayloads.parties(readAs))
                .put("submission", LedgerPayloads.submission(commands,
                        LedgerPayloads.orElse(o.commandId(), "dryrun-commit-" + o.cycleId()),
                        actAs, readAs))
                .build();
    }

    // ----------------------------------------------------- write 2: settle

    /**
     * A settlement.
     *
     * <p>Exactly one of {@code outcomeDocument} and {@code outcomeDigest} is
     * enough; giving the document lets the builder derive the digest and, with
     * {@code revealOutcome}, publish the document on-ledger alongside it.
     */
    public record SettleOptions(String sdkPackageId, String amuletPackageId, String venue,
                                String operator, String player, String stakeCid,
                                String lockedAmuletCid, String disposition, String returnedAmount,
                                String forfeitedAmount, String payoutAmount,
                                String outcomeDocument, String outcomeDigest,
                                boolean revealOutcome, String revealedEntry, String commandId,
                                Map<String, String> settlementMeta) {
    }

    /**
     * WRITE 2 — settlement.
     *
     * <p>ORDER IS MANDATORY: {@code GameStake_Settle} pulls the lock through the
     * {@code Holding} interface, so it must precede the
     * {@code LockedAmulet_UnlockV2} that archives it. Reversed, settlement is
     * rejected with "no custody proof".
     */
    public static Json buildSettleCommands(SettleOptions o) {
        String digest = o.outcomeDigest() != null ? o.outcomeDigest()
                : (o.outcomeDocument() != null ? ArccadeDigest.textDigest(o.outcomeDocument())
                        : null);
        if (digest == null) {
            throw new IllegalArgumentException(
                    "outcomeDocument or outcomeDigest is required to settle");
        }
        assertHex64(digest);

        String disposition = LedgerPayloads.orElse(o.disposition(), "ReturnedInFull");
        if (disposition.equals("ReturnedInFull")
                && ArccadeDigest.amountUnits(o.forfeitedAmount()) != 0) {
            throw new IllegalArgumentException(
                    "ReturnedInFull must return the whole stake (forfeitedAmount must be 0): "
                            + o.forfeitedAmount());
        }
        if (disposition.equals("ForfeitedInFull")
                && ArccadeDigest.amountUnits(o.returnedAmount()) != 0) {
            throw new IllegalArgumentException(
                    "ForfeitedInFull must return nothing (returnedAmount must be 0): "
                            + o.returnedAmount());
        }

        Json settleCmd = LedgerPayloads.exercise(
                LedgerPayloads.templateId(o.sdkPackageId(), CYCLE_MODULE, "GameStake"),
                o.stakeCid(), "GameStake_Settle",
                Json.object()
                        .put("disposition", disposition)
                        .put("returnedAmount", o.returnedAmount())
                        .put("forfeitedAmount", o.forfeitedAmount())
                        .put("payoutAmount", o.payoutAmount())
                        .put("outcomeDigest", digest)
                        .put("revealedOutcome",
                                o.revealOutcome() && o.outcomeDocument() != null
                                        ? Json.string(o.outcomeDocument()) : Json.nul())
                        .put("revealedEntry", o.revealedEntry())
                        .put("custodyRef", holdingRef(o.lockedAmuletCid()))
                        .put("settlementMeta", LedgerPayloads.values(o.settlementMeta()))
                        .build());

        List<Json> commands = new ArrayList<>();
        commands.add(settleCmd);
        if (o.lockedAmuletCid() != null) {
            commands.add(LedgerPayloads.exercise(
                    LedgerPayloads.templateId(o.amuletPackageId(), "Splice.Amulet", "LockedAmulet"),
                    o.lockedAmuletCid(), "LockedAmulet_UnlockV2", Json.object().build()));
        }
        List<String> parties = List.of(o.operator(), o.venue(), o.player());
        return Json.object()
                .put("commands", Json.array(commands))
                .put("actAs", LedgerPayloads.parties(parties))
                .put("readAs", LedgerPayloads.parties(parties))
                .put("outcomeDigest", digest)
                .put("submission", LedgerPayloads.submission(commands,
                        LedgerPayloads.orElse(o.commandId(),
                                "settle-" + LedgerPayloads.shortId(o.stakeCid())),
                        parties, parties))
                .build();
    }

    public record AbortOptions(String sdkPackageId, String venue, String operator, String player,
                               String stakeCid, String reason, String lockedAmuletCid,
                               String commandId) {
    }

    /**
     * Aborting a cycle. The custody proof is optional ON PURPOSE: the reason
     * abort exists is that the lock may never have been created. The cycle does
     * NOT count, and a longer {@code abortCooldownSeconds} keeps the slot out of
     * use so that abort cannot be used to churn cheaply.
     */
    public static Json buildAbortCommands(AbortOptions o) {
        Json cmd = LedgerPayloads.exercise(
                LedgerPayloads.templateId(o.sdkPackageId(), CYCLE_MODULE, "GameStake"),
                o.stakeCid(), "GameStake_Abort",
                Json.object()
                        .put("reason", o.reason())
                        .put("custodyRef", holdingRef(o.lockedAmuletCid()))
                        .build());
        List<Json> commands = List.of(cmd);
        List<String> actAs = List.of(o.operator(), o.player());
        return Json.object()
                .put("commands", Json.array(commands))
                .put("actAs", LedgerPayloads.parties(actAs))
                .put("submission", LedgerPayloads.submission(commands,
                        LedgerPayloads.orElse(o.commandId(),
                                "abort-" + LedgerPayloads.shortId(o.stakeCid())),
                        actAs, List.of(o.operator(), o.venue(), o.player())))
                .build();
    }

    public record ExpireOptions(String sdkPackageId, String amuletPackageId, String player,
                                String stakeCid, String lockedAmuletCid, String commandId) {
    }

    /**
     * The player's unconditional exit: once the lock has expired they recover
     * both their funds and their slot without arCCade and without the DSO.
     *
     * <p>{@code LockedAmulet_OwnerExpireLockV2}'s controller is the owner alone,
     * which is what makes this a right rather than a request.
     */
    public static Json buildExpireCommands(ExpireOptions o) {
        List<Json> commands = new ArrayList<>();
        commands.add(LedgerPayloads.exercise(
                LedgerPayloads.templateId(o.sdkPackageId(), CYCLE_MODULE, "GameStake"),
                o.stakeCid(), "GameStake_ExpireUnsettled", Json.object().build()));
        if (o.lockedAmuletCid() != null) {
            commands.add(LedgerPayloads.exercise(
                    LedgerPayloads.templateId(o.amuletPackageId(), "Splice.Amulet", "LockedAmulet"),
                    o.lockedAmuletCid(), "LockedAmulet_OwnerExpireLockV2", Json.object().build()));
        }
        List<String> actAs = List.of(o.player());
        return Json.object()
                .put("commands", Json.array(commands))
                .put("actAs", LedgerPayloads.parties(actAs))
                .put("submission", LedgerPayloads.submission(commands,
                        LedgerPayloads.orElse(o.commandId(),
                                "expire-" + LedgerPayloads.shortId(o.stakeCid())),
                        actAs, actAs))
                .build();
    }

    // ------------------------------------------------------------- internals

    private static Json commitCommand(String sdkPackageId, String entitlementCid, String gameCode,
                                      String cycleId, String stakeAmount, String feeAmount,
                                      String venue, InstrumentId instrumentId,
                                      String lockExpiresAt, String custodyTag, String entryDigest,
                                      Map<String, String> stakeMeta) {
        return LedgerPayloads.exercise(
                LedgerPayloads.templateId(sdkPackageId, CYCLE_MODULE, "PlayerEntitlement"),
                entitlementCid, "Entitlement_Commit",
                Json.object()
                        .put("gameCode", gameCode)
                        .put("cycleId", cycleId)
                        .put("terms", Json.object()
                                .put("stakeAmount", stakeAmount)
                                .put("feeAmount", feeAmount)
                                .put("feeReceiver", venue)
                                .put("instrumentId", LedgerPayloads.instrument(instrumentId))
                                .put("custody", "TimeLockedHolding")
                                .put("lockHolders", LedgerPayloads.parties(List.of(venue)))
                                .put("lockExpiresAt", lockExpiresAt)
                                .put("custodyTag", custodyTag)
                                .build())
                        .put("entryDigest", entryDigest)
                        .put("stakeMeta", LedgerPayloads.values(stakeMeta))
                        .build());
    }

    static Json amuletInputs(List<String> amuletCids) {
        List<Json> inputs = new ArrayList<>();
        for (String cid : amuletCids) {
            inputs.add(Json.object().put("tag", "InputAmulet").put("value", cid).build());
        }
        return Json.array(inputs);
    }

    static Json transferContext(String openMiningRoundCid) {
        return Json.object()
                .put("openMiningRound", openMiningRoundCid)
                .put("issuingMiningRounds", Json.array(List.of()))
                .put("validatorRights", Json.array(List.of()))
                .build();
    }

    private static Json holdingRef(String lockedAmuletCid) {
        return lockedAmuletCid == null ? Json.nul()
                : Json.object().put("tag", "HoldingRef").put("value", lockedAmuletCid).build();
    }

    /**
     * An amount the payload cannot do without.
     *
     * <p>Null is refused here rather than serialised: the string a language
     * produces for an absent value ({@code "undefined"}, {@code "None"},
     * {@code "null"}) is a legal JSON string, so the ledger sees a field that is
     * present and wrong instead of one that is missing.
     */
    private static void requireAmount(String name, String amount) {
        if (amount == null) {
            throw new IllegalArgumentException(name + " is required and must be decimal text");
        }
        ArccadeDigest.amountUnits(amount);
    }
}
