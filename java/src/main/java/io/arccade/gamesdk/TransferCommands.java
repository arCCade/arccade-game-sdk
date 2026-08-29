package io.arccade.gamesdk;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * A plain transfer of value — the THIRD and last kind of value event written to
 * the ledger.
 *
 * <p>Reward distribution, player-to-player sends, tournament payouts, refunds.
 * It differs from a trade in having no consideration, and from a cycle in
 * having no lock and no settlement.
 *
 * <p>THIS IS THE MOST ABUSABLE ENDPOINT and it is deliberately the narrowest:
 *
 * <ul>
 *   <li>One-way, with nothing coming back. If what you are writing has two
 *       directions, it is a trade.</li>
 *   <li>The sender ALWAYS signs. A tenant cannot move a player's balance
 *       without that player's signature.</li>
 *   <li>A transfer to oneself is refused: it is the cheapest way to manufacture
 *       volume.</li>
 *   <li>A batch cannot repeat a receiver. Paying one party twice in one
 *       transaction is one payment split in two, and splitting is how a
 *       transaction count gets inflated.</li>
 * </ul>
 *
 * <p>A player can still generate volume by sending small amounts repeatedly —
 * but each one burns real Canton Coin and a real network fee. Beyond that
 * economic deterrence, the defence is the per-tenant quota in
 * {@link TenantQuota}.
 */
public final class TransferCommands {

    /** First component of every transfer document. A wire constant. */
    public static final String TRANSFER_TAG_PREFIX = "arccade-game-sdk:transfer:1:";

    /** The reason a transfer happened. It is INSIDE the hashed document. */
    public static final String REASON_REWARD = "reward";
    public static final String REASON_PAYOUT = "payout";
    public static final String REASON_REFUND = "refund";
    public static final String REASON_P2P = "p2p";

    /** A list, not a set: the order is what an error message shows a caller. */
    private static final List<String> REASONS =
            List.of(REASON_REWARD, REASON_PAYOUT, REASON_REFUND, REASON_P2P);

    private TransferCommands() {
    }

    /** One line of a payout: who receives how much of what. */
    public record Recipient(String receiver, String amount, InstrumentId instrumentId) {
        public Recipient {
            if (receiver == null || receiver.isEmpty()) {
                throw new IllegalArgumentException("a recipient needs a receiver party");
            }
            if (instrumentId == null) {
                throw new IllegalArgumentException("instrumentId needs an admin and an id: null");
            }
        }
    }

    /**
     * A transfer as it will be published.
     *
     * <p>Recipient order is PRESERVED in the document, unlike meta, which is
     * sorted. The order is the batch's own: it is what the ledger will be asked
     * to execute, and reordering it here would make the published document
     * describe a different transaction from the one submitted.
     */
    public record Transfer(String transferId, String sender, String reason,
                           List<Recipient> recipients, Map<String, String> meta) {
    }

    /**
     * The transfer's canonical document.
     *
     * <p>A pipe in any component is refused for the reason given in
     * {@link TradeCommands#tradeDocument}: the v1 format has no length
     * prefixes, so a pipe inside a value reshapes the document instead of
     * appearing in it.
     */
    public static String transferDocument(Transfer t) {
        List<String> parts = new ArrayList<>();
        parts.add("transferId=" + TradeCommands.noPipe("transferId", t.transferId()));
        parts.add("sender=" + TradeCommands.noPipe("sender", t.sender()));
        parts.add("reason=" + TradeCommands.noPipe("reason", t.reason()));
        for (Recipient r : t.recipients()) {
            parts.add("to=" + TradeCommands.noPipe("receiver", r.receiver())
                    + ":" + TradeCommands.noPipe("amount", r.amount())
                    + ":" + TradeCommands.noPipe("registry", r.instrumentId().admin())
                    + "/" + TradeCommands.noPipe("instrument", r.instrumentId().id()));
        }
        Map<String, String> meta = new TreeMap<>(ArccadeDigest.CODE_POINT_ORDER);
        if (t.meta() != null) {
            meta.putAll(t.meta());
        }
        for (Map.Entry<String, String> e : meta.entrySet()) {
            parts.add("meta." + TradeCommands.noPipe("meta key", e.getKey())
                    + "=" + TradeCommands.noPipe("meta value", e.getValue()));
        }
        return TRANSFER_TAG_PREFIX + String.join("|", parts);
    }

    public static String transferDigest(Transfer t) {
        return ArccadeDigest.textDigest(transferDocument(t));
    }

    public record TransferOptions(String amuletPackageId, String sender, String provider,
                                  List<Recipient> recipients, List<String> inputAmuletCids,
                                  String amuletRulesCid, String openMiningRoundCid,
                                  String dsoParty, String transferId, String reason,
                                  String commandId, Map<String, String> meta) {
    }

    /**
     * A Canton Coin transfer to one or more receivers, as a single
     * {@code AmuletRules_Transfer}.
     *
     * <p>A batch is ONE transaction: rewarding N players costs one write, not
     * N. That is cheaper, and it also keeps a qualifying-activity count honest —
     * this SDK does not make it easy to inflate a transaction count by splitting
     * one payment.
     */
    public static Json buildTransferCommands(TransferOptions o) {
        if (o.recipients() == null || o.recipients().isEmpty()) {
            throw new IllegalArgumentException("a transfer needs at least one recipient");
        }
        String reason = o.reason() == null ? REASON_P2P : o.reason();
        if (!REASONS.contains(reason)) {
            throw new IllegalArgumentException("unknown transfer reason: " + reason
                    + " (expected one of " + String.join(", ", REASONS) + ")");
        }
        if (o.inputAmuletCids() == null || o.inputAmuletCids().isEmpty()) {
            throw new IllegalArgumentException("inputAmuletCids cannot be empty");
        }

        Set<String> seen = new LinkedHashSet<>();
        List<Json> outputs = new ArrayList<>();
        for (Recipient r : o.recipients()) {
            if (r.receiver().equals(o.sender())) {
                throw new IllegalArgumentException("a self-transfer is refused: " + r.receiver());
            }
            if (!seen.add(r.receiver())) {
                throw new IllegalArgumentException("a recipient cannot repeat: " + r.receiver());
            }
            if (ArccadeDigest.amountUnits(r.amount()) <= 0) {
                throw new IllegalArgumentException(
                        "a transfer amount must be positive: " + r.amount());
            }
            outputs.add(Json.object()
                    .put("receiver", r.receiver())
                    .put("amount", r.amount())
                    .put("receiverFeeRatio", "0.0")
                    .build());
        }

        Json cmd = LedgerPayloads.exercise(
                LedgerPayloads.templateId(o.amuletPackageId(), "Splice.AmuletRules", "AmuletRules"),
                o.amuletRulesCid(), "AmuletRules_Transfer",
                Json.object()
                        .put("transfer", Json.object()
                                .put("sender", o.sender())
                                .put("provider", o.provider())
                                .put("inputs", CycleCommands.amuletInputs(o.inputAmuletCids()))
                                .put("outputs", Json.array(outputs))
                                .put("beneficiaries", Json.nul())
                                .build())
                        .put("context", CycleCommands.transferContext(o.openMiningRoundCid()))
                        .put("expectedDso", o.dsoParty())
                        .build());

        Transfer transfer = new Transfer(o.transferId(), o.sender(), reason, o.recipients(),
                o.meta());
        List<Json> commands = List.of(cmd);
        // The sender ALWAYS signs: a tenant cannot move a player's balance
        // without them. Deduplicated because sender and provider are the same
        // party whenever a venue pays out of its own funds.
        List<String> actAs = LedgerPayloads.distinct(List.of(o.sender(), o.provider()));
        return Json.object()
                .put("transferId", o.transferId())
                // The document is published by the application; only the reason
                // and the amounts reach the ledger, through the digest.
                .put("document", transferDocument(transfer))
                .put("digest", transferDigest(transfer))
                .put("commands", Json.array(commands))
                .put("actAs", LedgerPayloads.parties(actAs))
                .put("submission", LedgerPayloads.submission(commands,
                        LedgerPayloads.orElse(o.commandId(), "transfer-" + o.transferId()),
                        actAs, actAs))
                .build();
    }
}
