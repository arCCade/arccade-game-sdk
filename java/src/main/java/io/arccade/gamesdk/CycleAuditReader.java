package io.arccade.gamesdk;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import io.arccade.gamesdk.PeriodAuditDocuments.CycleAuditRow;

/**
 * Rebuilds period-report rows from the ledger's TRANSACTION TREE stream.
 *
 * <p>A period anchor whose rows come from the game's own database is a
 * signature on our own bookkeeping. It is evidence only if the rows derive
 * from the stream an auditor reads — and that derivation must be runnable by
 * anyone, in whatever language they have, or "verifiable" quietly means
 * "verifiable by arCCade".
 *
 * <p>So the rules do not live in this class. They live in the SDK's fixtures,
 * and this is one of several implementations pinned to them:
 *
 * <pre>
 *   test-vectors/cycle-trees.json   real TestNet transactions (LEDGER_EFFECTS)
 *   test-vectors/cycle-rows.json    the rows, leaves and root they must produce
 * </pre>
 *
 * JavaScript ({@code js/src/cycleAudit.js}) and Python
 * ({@code tools/cycle_audit_reference.py}) assert against the same pair.
 * {@code CycleAuditReaderTest} is this implementation's half of that contract.
 *
 * <h2>What reading a real tree established</h2>
 *
 * <ul>
 *   <li><b>The join key is the STAKE CONTRACT ID, not cycleId.</b> A closing
 *       choice does not repeat cycleId — it lives on the contract being
 *       exercised — so the commit's {@code exerciseResult} is the only thing
 *       linking the two halves in the stream.</li>
 *   <li><b>Abort carries only a reason and expiry carries nothing.</b> Their
 *       amounts are DERIVED from the mechanic: unlocking a TimeLockedHolding
 *       always pays the owner in full and this mechanic cannot forfeit, so the
 *       stake comes back and nothing else moves. Their disposition comes from
 *       the choice NAME. The outcome digest is empty because no outcome ever
 *       existed, not because a lookup failed.</li>
 *   <li><b>The unlock is sometimes in the same transaction and sometimes
 *       not.</b> When it is, the created Amulet is an independent second
 *       reading of the returned amount, and a disagreement is REPORTED rather
 *       than trusted away.</li>
 * </ul>
 *
 * <p>Report order is {@code committedAtMicros} then {@code cycleId}. Left
 * unspecified, two honest implementations would compute different roots over
 * the same set of cycles.
 *
 * <h2>Why the tree arrives as {@link Json} and not a Jackson {@code JsonNode}</h2>
 *
 * <p>This class reads six fields out of a transaction tree. Making that cost
 * every JVM consumer a {@code jackson-databind} dependency — the most commonly
 * pre-pinned artifact on the platform, and one whose audit surface dwarfs this
 * whole SDK — would be a poor trade for an artifact whose selling point is that
 * an auditor can drop one jar on the classpath and check an anchor. The full
 * argument, and the two places {@link Json} is deliberately stricter than
 * Jackson, are in that class's notes.
 *
 * <p>A caller who already holds a Jackson {@code JsonNode} pays one line at the
 * boundary: {@code Json.parse(node.toString())}.
 */
public final class CycleAuditReader {

    /**
     * The report's ordering, named down to its collation.
     *
     * <p>"committedAtMicros, then cycleId" is not enough: {@code String::compareTo}
     * is UTF-16 code-UNIT order, JavaScript's {@code localeCompare} is
     * locale- and ICU-version-dependent, and Daml sorts by code point. Three
     * honest implementations, three orders, three different Merkle roots over
     * the same cycles — and a tie only has to break differently ONCE for an
     * auditor's inclusion proof to fail against a root nobody can show is
     * wrong. The collation belongs in the constant, where a caller reading it
     * at the call site can see which one they are getting.
     */
    public static final String REPORT_ORDER =
            "committedAtMicros ascending, then cycleId ascending by Unicode code point";

    private static final String SDK_MODULE = "ArCCade.GameSdk.Cycle";

    /** Closing choice to disposition tag; null means the argument states it. */
    private static final Map<String, String> CLOSING_CHOICES = Map.of(
            "GameStake_Settle", "",
            "GameStake_Abort", "aborted",
            "GameStake_ExpireUnsettled", "expired-unsettled");

    /** Daml constructor to the tag that goes into the canonical document. */
    private static final Map<String, String> DISPOSITION_TAGS = Map.of(
            "ReturnedInFull", "returned-in-full",
            "ReturnedWithForfeit", "returned-with-forfeit",
            "ForfeitedInFull", "forfeited-in-full",
            "Aborted", "aborted",
            "ExpiredUnsettled", "expired-unsettled");

    private CycleAuditReader() {
    }

    /** A row, plus the two transactions it was built from. */
    public record ReportRow(CycleAuditRow row, String venueId,
                            String commitUpdateId, String closingUpdateId) {
    }

    /** Something that does not stop the report but must not be swallowed. */
    public record Warning(String cycleId, String kind, String stated, String observed) {
    }

    /**
     * @param rows            closed cycles, in report order
     * @param warnings        disagreements found while building them
     * @param openStakeIds    commits with no closing in this window
     * @param orphanClosingIds closings with no commit in this window
     */
    public record Result(List<ReportRow> rows, List<Warning> warnings,
                         List<String> openStakeIds, List<String> orphanClosingIds) {
    }

    private static final Pattern TIMESTAMP =
            Pattern.compile("^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d+))?Z$");

    /**
     * ISO 8601 to integer microseconds.
     *
     * <p>Ledger stamps carry microseconds. Anything that goes through
     * milliseconds — {@code Instant.toEpochMilli}, {@code Date} — truncates
     * them, and the canonical document stops matching Daml's.
     */
    public static long isoToMicros(String iso) {
        Matcher m = TIMESTAMP.matcher(iso);
        if (!m.matches()) {
            throw new IllegalArgumentException("arccade-game-sdk: unparsable ledger timestamp: " + iso);
        }
        long seconds = OffsetDateTime.parse(m.group(1) + "Z", DateTimeFormatter.ISO_OFFSET_DATE_TIME)
                .toInstant().getEpochSecond();
        String fraction = ((m.group(2) == null ? "" : m.group(2)) + "000000").substring(0, 6);
        return seconds * 1_000_000L + Long.parseLong(fraction);
    }

    private static boolean isSdk(Json node, String entity) {
        return node.path("templateId").asText("").contains(SDK_MODULE + ":" + entity);
    }

    private static List<Json> nodesOfKind(Json transaction, String kind) {
        List<Json> out = new ArrayList<>();
        for (Json e : transaction.path("events")) {
            if (e.has(kind)) {
                out.add(e.get(kind));
            }
        }
        return out;
    }

    private record Commit(String stakeContractId, String updateId, String venueId, String cycleId,
                          String player, String gameCode, long concurrencyIndex, String entryDigest,
                          long committedAtMicros, long committedUnits, long feeUnits,
                          String custodyTag) {
    }

    private record Closing(String stakeContractId, String updateId, String choice,
                           long settledAtMicros, Json argument, Long unlockedUnits) {
    }

    private static Optional<Commit> commitFacts(Json transaction) {
        boolean isCommit = nodesOfKind(transaction, "ExercisedEvent").stream()
                .anyMatch(x -> "Entitlement_Commit".equals(x.path("choice").asText())
                        && isSdk(x, "PlayerEntitlement"));
        if (!isCommit) {
            return Optional.empty();
        }
        Optional<Json> stake = nodesOfKind(transaction, "CreatedEvent").stream()
                .filter(c -> isSdk(c, "GameStake")).findFirst();
        if (stake.isEmpty()) {
            return Optional.empty();
        }
        Json a = stake.get().path("createArgument");
        Json terms = a.path("terms");
        return Optional.of(new Commit(
                stake.get().path("contractId").asText(),
                transaction.path("updateId").asText(),
                a.path("venueId").asText(),
                a.path("cycleId").asText(),
                a.path("player").asText(),
                a.path("gameCode").asText(),
                Long.parseLong(a.path("concurrencyIndex").asText("0")),
                a.path("entryDigest").asText(),
                isoToMicros(a.path("committedAt").asText()),
                ArccadeDigest.amountUnits(new BigDecimal(terms.path("stakeAmount").asText())),
                ArccadeDigest.amountUnits(new BigDecimal(terms.path("feeAmount").asText())),
                terms.path("custodyTag").asText()));
    }

    private static Optional<Closing> closingFacts(Json transaction) {
        Optional<Json> closing = nodesOfKind(transaction, "ExercisedEvent").stream()
                .filter(x -> isSdk(x, "GameStake")
                        && CLOSING_CHOICES.containsKey(x.path("choice").asText()))
                .findFirst();
        if (closing.isEmpty()) {
            return Optional.empty();
        }
        Long unlocked = nodesOfKind(transaction, "CreatedEvent").stream()
                .filter(c -> c.path("templateId").asText("").endsWith(":Amulet"))
                .findFirst()
                .map(c -> ArccadeDigest.amountUnits(new BigDecimal(
                        c.path("createArgument").path("amount").path("initialAmount").asText())))
                .orElse(null);
        return Optional.of(new Closing(
                closing.get().path("contractId").asText(),
                transaction.path("updateId").asText(),
                closing.get().path("choice").asText(),
                isoToMicros(transaction.path("effectiveAt").asText()),
                closing.get().path("choiceArgument"),
                unlocked));
    }

    private record Exit(String disposition, String outcomeDigest,
                        long returnedUnits, long forfeitedUnits, long payoutUnits) {
    }

    private static Exit exitAmounts(Commit commit, Closing closing) {
        if ("GameStake_Settle".equals(closing.choice())) {
            Json arg = closing.argument();
            String constructor = arg.path("disposition").asText();
            String tag = DISPOSITION_TAGS.get(constructor);
            if (tag == null) {
                throw new IllegalArgumentException(
                        "arccade-game-sdk: unknown disposition: " + constructor);
            }
            return new Exit(tag, arg.path("outcomeDigest").asText(""),
                    ArccadeDigest.amountUnits(new BigDecimal(arg.path("returnedAmount").asText())),
                    ArccadeDigest.amountUnits(new BigDecimal(arg.path("forfeitedAmount").asText())),
                    ArccadeDigest.amountUnits(new BigDecimal(arg.path("payoutAmount").asText())));
        }
        // Abort and expiry state no amounts; see the class notes.
        return new Exit(CLOSING_CHOICES.get(closing.choice()), "",
                commit.committedUnits(), 0L, 0L);
    }

    /** Joins commit and closing halves into report rows. */
    public static Result rowsFromTransactions(List<Json> transactions) {
        Map<String, Commit> commits = new LinkedHashMap<>();
        Map<String, Closing> closings = new LinkedHashMap<>();
        for (Json t : transactions) {
            commitFacts(t).ifPresent(c -> commits.put(c.stakeContractId(), c));
            closingFacts(t).ifPresent(z -> closings.put(z.stakeContractId(), z));
        }

        List<ReportRow> rows = new ArrayList<>();
        List<Warning> warnings = new ArrayList<>();
        for (Map.Entry<String, Commit> e : commits.entrySet()) {
            Closing closing = closings.get(e.getKey());
            if (closing == null) {
                continue;
            }
            Commit commit = e.getValue();
            Exit exit = exitAmounts(commit, closing);
            if (closing.unlockedUnits() != null && closing.unlockedUnits() != exit.returnedUnits()) {
                warnings.add(new Warning(commit.cycleId(), "returned-amount-disagrees-with-unlock",
                        Long.toString(exit.returnedUnits()),
                        Long.toString(closing.unlockedUnits())));
            }
            rows.add(new ReportRow(new CycleAuditRow(
                    commit.cycleId(), commit.player(), commit.gameCode(), commit.concurrencyIndex(),
                    commit.entryDigest(), exit.outcomeDigest(), commit.committedUnits(),
                    commit.feeUnits(), exit.returnedUnits(), exit.forfeitedUnits(),
                    exit.payoutUnits(), exit.disposition(), commit.committedAtMicros(),
                    closing.settledAtMicros(), commit.custodyTag()),
                    commit.venueId(), commit.updateId(), closing.updateId()));
        }

        List<String> open = commits.keySet().stream().filter(k -> !closings.containsKey(k)).toList();
        List<String> orphans = closings.keySet().stream().filter(k -> !commits.containsKey(k)).toList();

        rows.sort(Comparator.comparingLong((ReportRow r) -> r.row().committedAtMicros())
                .thenComparing(r -> r.row().cycleId(), ArccadeDigest.CODE_POINT_ORDER));
        return new Result(rows, warnings, open, orphans);
    }

    /** Root over a whole period, in report order. */
    public static String periodRoot(List<ReportRow> rows) {
        return PeriodAuditDocuments.periodRoot(rows.stream().map(ReportRow::row).toList());
    }

    /** Convenience for callers that already hold ledger timestamps. */
    public static long instantToMicros(Instant t) {
        return Math.multiplyExact(t.getEpochSecond(), 1_000_000L) + t.getNano() / 1_000L;
    }
}
