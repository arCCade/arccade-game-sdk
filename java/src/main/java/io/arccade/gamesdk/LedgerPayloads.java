package io.arccade.gamesdk;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/**
 * The shapes every command builder shares, in one place.
 *
 * <p>The builders in {@link CycleCommands}, {@link TradeCommands} and
 * {@link TransferCommands} all emit JSON Ledger API v2 payloads, and the parts
 * they have in common — a template id, an exercise node, a submission envelope,
 * a deduplicated party set — are written once here so that a change to the wire
 * format is a change to one file rather than a search.
 *
 * <p>Submission is left to the caller. These builders produce the payload and
 * nothing else: they open no connection, hold no credentials and retry nothing,
 * which is what lets the conformance suite pin their output byte for byte.
 */
final class LedgerPayloads {

    private LedgerPayloads() {
    }

    /** {@code <packageId>:<module>:<entity>}, the Ledger API's template id. */
    static String templateId(String packageId, String module, String entity) {
        return packageId + ":" + module + ":" + entity;
    }

    static Json exercise(String templateId, String contractId, String choice, Json argument) {
        return Json.object()
                .put("ExerciseCommand", Json.object()
                        .put("templateId", templateId)
                        .put("contractId", contractId)
                        .put("choice", choice)
                        .put("choiceArgument", argument)
                        .build())
                .build();
    }

    /** Daml's {@code TextMap}, as the JSON API spells it. */
    static Json values(Map<String, String> entries) {
        Json.ObjectBuilder inner = Json.object();
        if (entries != null) {
            entries.forEach(inner::put);
        }
        return Json.object().put("values", inner.build()).build();
    }

    static Json instrument(InstrumentId id) {
        return Json.object().put("admin", id.admin()).put("id", id.id()).build();
    }

    static Json parties(List<String> parties) {
        List<Json> out = new ArrayList<>();
        for (String p : parties) {
            out.add(Json.string(p));
        }
        return Json.array(out);
    }

    /**
     * The submission envelope.
     *
     * <p>{@code readAs} is omitted entirely when null rather than written as an
     * empty array: an absent read set and an explicitly empty one are different
     * requests, and the second one is the kind of thing that reads as harmless
     * and then hides a contract from the party that needed to see it.
     */
    static Json submission(List<Json> commands, String commandId, List<String> actAs,
                           List<String> readAs) {
        Json.ObjectBuilder inner = Json.object()
                .put("commands", Json.array(commands))
                .put("commandId", commandId)
                .put("actAs", parties(actAs));
        if (readAs != null) {
            inner.put("readAs", parties(readAs));
        }
        return Json.object().put("commands", inner.build()).build();
    }

    /** Order-preserving deduplication; nulls are dropped. */
    static List<String> distinct(List<String> parties) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (String p : parties) {
            if (p != null) {
                out.add(p);
            }
        }
        return List.copyOf(out);
    }

    static String orElse(String value, String fallback) {
        return value == null ? fallback : value;
    }

    /** The prefix of a contract id used in a generated command id. */
    static String shortId(String contractId) {
        return contractId.length() <= 16 ? contractId : contractId.substring(0, 16);
    }
}
