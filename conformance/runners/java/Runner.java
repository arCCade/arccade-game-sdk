import io.arccade.gamesdk.ArccadeDigest;
import io.arccade.gamesdk.ArccadeMerkle;
import io.arccade.gamesdk.ArccadeMerkle.MerkleStep;
import io.arccade.gamesdk.Assets;
import io.arccade.gamesdk.CycleAuditReader;
import io.arccade.gamesdk.CycleCommands;
import io.arccade.gamesdk.InstrumentId;
import io.arccade.gamesdk.Json;
import io.arccade.gamesdk.LedgerTime;
import io.arccade.gamesdk.PeriodAnchorDocuments;
import io.arccade.gamesdk.PeriodAnchorDocuments.AnchorTotals;
import io.arccade.gamesdk.PeriodAnchorDocuments.PeriodAnchor;
import io.arccade.gamesdk.PeriodAuditDocuments;
import io.arccade.gamesdk.PeriodAuditDocuments.CycleAuditRow;
import io.arccade.gamesdk.PolicyDocuments;
import io.arccade.gamesdk.PolicyDocuments.VenuePolicy;
import io.arccade.gamesdk.SettlementInvariants;
import io.arccade.gamesdk.SettlementInvariants.Settlement;
import io.arccade.gamesdk.Tenancy;
import io.arccade.gamesdk.TenantQuota;
import io.arccade.gamesdk.TradeCommands;
import io.arccade.gamesdk.TradeCommands.TradeLeg;
import io.arccade.gamesdk.TransferCommands;
import io.arccade.gamesdk.TransferCommands.Recipient;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * The Java conformance runner: drives io.arccade:game-sdk through every case in
 * conformance/manifest.json and reports what it observed.
 *
 * <h2>What this is for</h2>
 *
 * <p>"Feature parity" between four implementations is a sentence until the same
 * case is run in more than one of them. This runner is the Java half of making
 * that checkable. It reads the manifest as a third party would — it never
 * consults generate.mjs, and it resolves the SDK through the packaged jar, so a
 * class that does not ship cannot be made to look supported.
 *
 * <h2>What it refuses to do</h2>
 *
 * <ul>
 *   <li><b>It never maps an exception to a reject class per case.</b> The map is
 *       keyed by capability GROUP and declared in the header record; a per-case
 *       map would let this client pass by naming the answer. Every rule names a
 *       concrete exception type, and a rule whose type is Exception,
 *       RuntimeException or Throwable with no message predicate is rejected at
 *       startup as a catch-all (exit 2).</li>
 *   <li><b>It never reports pass for a throw it could not classify.</b> That is
 *       status error, which is red.</li>
 *   <li><b>It never quietly widens a type.</b> Where the manifest's neutral
 *       value has no Java counterpart — a decimal string handed to a method that
 *       takes BigDecimal, a native double, a boolean where a long is required —
 *       the conversion this runner performed is written down in the header under
 *       "coercions". Several failures below are caused by those conversions, and
 *       an auditor has to be able to see which.</li>
 * </ul>
 *
 * <h2>The coercion question, answered once</h2>
 *
 * <p>An earlier version of this runner converted every amount with new
 * BigDecimal(String), because the SDK had no String overload, and recorded the
 * conversion as a coercion. That is how the suite found the gap: BigDecimal
 * accepts "+1", ".5", "1e3" and "1E+2", the manifest requires a refusal, and
 * four cases were red for a reason that lived in the conversion rather than in
 * the SDK. The SDK now carries the decimal grammar itself and the conversion is
 * gone — which is the outcome a coercion record is FOR. A coercion is a place a
 * runner had to decide something, and the right end state for one is that it
 * stops existing.
 *
 * <p>What remains is listed in COERCIONS and each one is a real difference
 * between the manifest's value domain and Java's, not a decision this runner
 * made to be comfortable. The float64 entry is the one worth reading twice: the
 * double is NOT converted, it is handed to an overload that refuses, because
 * converting it would have produced an answer and the answer was the defect.
 */
public final class Runner {

    static final String SCHEMA = "1";
    static final String IMPLEMENTATION = "io.arccade:game-sdk:1.5.1 (packaged jar)";

    /**
     * Profiles this client claims, which is every profile the MANIFEST declares
     * — read out of its {@code profiles} object in run(), never spelled here. A
     * declared profile containing an unsupported capability is exit 3: "we do
     * not implement what we claim" is a different fact from "a case failed",
     * and the two must not collapse into one.
     *
     * <p>This client used to declare three and answer "unsupported" 189 times,
     * which is a survey result and not a claim; a client at parity has to be
     * willing to be wrong about every profile. It then declared a hardcoded
     * eight, which was the same mistake one level up: the manifest declares
     * nine, and `games` — 20 cases in two groups — was a profile no runner
     * would answer to. Empty until run() fills it.
     */
    static final List<String> PROFILES_DECLARED = new ArrayList<>();

    static final Map<String, Boolean> TRAITS = new LinkedHashMap<>();

    static {
        TRAITS.put("hasNativeFloat", true);
        TRAITS.put("hasUtf16Strings", true);
        TRAITS.put("hasArbitraryPrecisionInt", true);
        TRAITS.put("hasExactDecimal", true);
    }

    /** One rule of the throw-to-class map. Group-keyed, never case-keyed. */
    record RejectRule(String group, String type, String contains, String cls) {
    }

    /**
     * The map. Two exception types come out of one method by design:
     * amountUnits throws IllegalArgumentException for precision loss and
     * ArithmeticException for band overflow, and those are genuinely different
     * refusals, so they get different classes. That is the clearest argument in
     * the whole suite for classing refusals rather than pinning exception types.
     */
    static final List<RejectRule> REJECT_MAP = List.of(
            new RejectRule("digest.amount", "NumberFormatException",
                    "", "bad-format"),
            new RejectRule("digest.amount", "IllegalArgumentException",
                    "a native double cannot be an amount", "bad-type"),
            new RejectRule("digest.amount", "IllegalArgumentException",
                    "an amount cannot be null", "bad-type"),
            new RejectRule("digest.amount", "IllegalArgumentException",
                    "not representable in 1e-10 units", "precision-loss"),
            new RejectRule("digest.amount", "ArithmeticException",
                    "", "out-of-range"),
            new RejectRule("digest.fields", "IllegalArgumentException",
                    "field name must be ASCII", "bad-format"),
            new RejectRule("digest.fields", "IllegalArgumentException",
                    "empty field name", "bad-format"),
            new RejectRule("digest.scalar", "StaticTypeRefusal",
                    "", "bad-type"),
            new RejectRule("digest.text", "IllegalArgumentException",
                    "refusing to digest the empty string", "bad-format"),

            new RejectRule("audit", "IllegalArgumentException",
                    "invalid disposition", "unknown-tag"),
            new RejectRule("audit", "IllegalArgumentException",
                    "unknown disposition", "unknown-tag"),
            new RejectRule("audit", "IllegalArgumentException",
                    "unparsable ledger timestamp", "bad-format"),
            new RejectRule("audit", "IllegalArgumentException",
                    "negative settlement amount", "out-of-range"),
            new RejectRule("audit", "IllegalArgumentException",
                    "must equal the stake", "invariant-violated"),
            new RejectRule("audit", "IllegalArgumentException",
                    "cannot forfeit", "invariant-violated"),
            new RejectRule("audit", "IllegalArgumentException",
                    "cannot return", "invariant-violated"),
            new RejectRule("audit", "IllegalArgumentException",
                    "needs both sides non-zero", "invariant-violated"),
            new RejectRule("audit", "IllegalArgumentException",
                    "must return the stake in full", "invariant-violated"),
            new RejectRule("audit", "IllegalArgumentException",
                    "payout above the policy cap", "invariant-violated"),
            new RejectRule("audit", "IllegalArgumentException",
                    "duplicate cycleId in a period", "invariant-violated"),
            new RejectRule("audit", "NumberFormatException",
                    "", "bad-format"),

            // identity: the refusals that protect an identifier's shape. "cannot
            // contain" is not-injective rather than bad-format because the
            // character it names would make two different values encode to one
            // string, which is a different defect from a malformed id.
            new RejectRule("identity", "IllegalArgumentException",
                    "cannot contain", "not-injective"),
            new RejectRule("identity", "IllegalArgumentException",
                    "invalid cycleId", "out-of-range"),
            new RejectRule("identity", "IllegalArgumentException",
                    "invalid tradeId", "out-of-range"),
            new RejectRule("identity", "IllegalArgumentException",
                    "expected a 64-character lowercase sha256", "bad-format"),
            new RejectRule("identity", "IllegalArgumentException",
                    "invalid asset id", "bad-format"),
            new RejectRule("identity", "IllegalArgumentException",
                    "invalid instance id", "bad-format"),
            new RejectRule("identity", "IllegalArgumentException",
                    "invalid tenant id", "bad-format"),
            new RejectRule("identity", "IllegalArgumentException",
                    "must not have consecutive hyphens", "bad-format"),
            new RejectRule("identity", "IllegalArgumentException",
                    "must be 1-96 characters", "bad-format"),
            new RejectRule("identity", "IllegalArgumentException",
                    "tenant isolation violated", "invariant-violated"),

            new RejectRule("assets", "IllegalArgumentException",
                    "a unique asset's amount must be 1", "invariant-violated"),
            new RejectRule("assets", "IllegalArgumentException",
                    "amount must be positive", "out-of-range"),
            new RejectRule("assets", "IllegalArgumentException",
                    "attribute value must be an integer or text", "bad-type"),

            new RejectRule("value-documents", "IllegalArgumentException",
                    "cannot contain", "not-injective"),
            new RejectRule("value-documents", "IllegalArgumentException",
                    "sender and receiver must differ", "invariant-violated"),
            new RejectRule("value-documents", "IllegalArgumentException",
                    "needs a sender and a receiver", "bad-type"),
            new RejectRule("value-documents", "IllegalArgumentException",
                    "instrumentId needs an admin and an id", "bad-type"),
            new RejectRule("value-documents", "IllegalArgumentException",
                    "amount must be positive", "out-of-range"),

            new RejectRule("builder", "IllegalArgumentException",
                    "cannot contain", "not-injective"),
            new RejectRule("builder", "IllegalArgumentException",
                    "invalid cycleId", "out-of-range"),
            new RejectRule("builder", "IllegalArgumentException",
                    "expected a 64-character lowercase sha256", "bad-format"),
            new RejectRule("builder", "IllegalArgumentException",
                    "is required and must be decimal text", "bad-type"),
            new RejectRule("builder", "IllegalArgumentException",
                    "outcomeDocument or outcomeDigest is required", "bad-type"),
            new RejectRule("builder", "IllegalArgumentException",
                    "inputAmuletCids cannot be empty", "invariant-violated"),
            new RejectRule("builder", "IllegalArgumentException",
                    "ReturnedInFull must return the whole stake", "invariant-violated"),
            new RejectRule("builder", "IllegalArgumentException",
                    "ForfeitedInFull must return nothing", "invariant-violated"),
            new RejectRule("builder", "IllegalArgumentException",
                    "a trade needs two legs", "invariant-violated"),
            new RejectRule("builder", "IllegalArgumentException",
                    "settle needs an allocation", "invariant-violated"),
            new RejectRule("builder", "IllegalArgumentException",
                    "at least one recipient", "invariant-violated"),
            new RejectRule("builder", "IllegalArgumentException",
                    "unknown transfer reason", "unknown-tag"),
            new RejectRule("builder", "IllegalArgumentException",
                    "a self-transfer is refused", "invariant-violated"),
            new RejectRule("builder", "IllegalArgumentException",
                    "a recipient cannot repeat", "invariant-violated"),
            new RejectRule("builder", "IllegalArgumentException",
                    "transfer amount must be positive", "out-of-range"),

            new RejectRule("quota", "IllegalArgumentException",
                    "invalid tenant id", "bad-format"),
            new RejectRule("quota", "IllegalArgumentException",
                    "must not have consecutive hyphens", "bad-format"));

    /**
     * Every place a manifest value had no direct Java counterpart, and what was
     * done about it. Written into the header so a failure caused by a conversion
     * can be told apart from a failure caused by the SDK.
     */
    static final Map<String, String> COERCIONS = new LinkedHashMap<>();

    static {
        COERCIONS.put("dec/int/text -> amountUnits(String)",
                "handed to the SDK as text, unconverted. The SDK now carries the decimal "
                        + "grammar itself, so BigDecimal's laxer one is no longer on the path "
                        + "and the runner has nothing to decide.");
        COERCIONS.put("float64 -> amountUnits(double)",
                "the double overload, which refuses. Nothing is converted: "
                        + "BigDecimal.valueOf(double) would have produced an answer, and the "
                        + "answer is the defect.");
        COERCIONS.put("int with wide:true -> BigInteger",
                "ArccadeDigest.canonInt(BigInteger), the wide overload. Values inside int64 "
                        + "take canonInt(long); the manifest's own type table says the same.");
        COERCIONS.put("bool -> canonInt/amountUnits",
                "not attempted: no overload accepts a boolean. Recorded as StaticTypeRefusal, "
                        + "which the map classes as bad-type — a refusal at compile time is still "
                        + "a refusal, and the strongest kind.");
        COERCIONS.put("text -> Instant (canonTime)", "Instant.parse(String), microsecond exact");
        COERCIONS.put("record cycle-audit-row -> CycleAuditRow",
                "Long.parseLong for the ten integer fields; a non-integral field such as \"100.0\" "
                        + "throws NumberFormatException, classed bad-format");
        COERCIONS.put("CycleAuditReader.Warning -> neutral pairs",
                "field 'observed' is emitted under the manifest's name 'unlocked'; the value is "
                        + "unchanged");
        COERCIONS.put("record/pairs -> SDK records",
                "instrument-id, trade-leg, transfer-recipient, venue-policy, settlement, "
                        + "period-anchor, quota-config and quota-step are read field by field into "
                        + "the matching record. A record's own constructor does the refusing, so "
                        + "a malformed carrier fails inside the SDK and not in this decoder.");
        COERCIONS.put("json -> builder options",
                "a builder's options object is read field by field into its options record; an "
                        + "ABSENT field becomes null and the SDK decides what that means, which "
                        + "is how a missing feeAmount stays a refusal instead of becoming a "
                        + "default.");
        COERCIONS.put("json -> Json", "io.arccade.gamesdk.Json, this artifact's own reader");
        COERCIONS.put("builder output -> t:json",
                "the built payload is compared as JSON with object keys sorted on both sides; "
                        + "field ORDER is not part of the Ledger API contract and pinning it "
                        + "would fail this client for a difference the ledger cannot see.");
    }

    /**
     * Capabilities this client implements. Everything else is unsupported.
     *
     * <p>Listed by hand rather than derived from the manifest on purpose: a set
     * computed from the catalogue would claim every capability the catalogue
     * names, which is the one thing this file must not be able to do.
     */
    static final Set<String> SUPPORTED = new LinkedHashSet<>(List.of(
            "digest.canon", "digest.canonText", "digest.canonInt", "digest.canonBool",
            "digest.canonDecimal", "digest.canonTimeMicros", "digest.canonTime",
            "digest.canonParty", "digest.canonOptional", "digest.canonList",
            "digest.canonFields", "digest.codePointLength", "digest.amountUnits",
            "digest.canonDocument", "digest.textDigest", "digest.constant",
            "merkle.merkleEmpty", "merkle.merkleNode", "merkle.merklePairUp",
            "merkle.merkleRoot", "merkle.merkleProof", "merkle.merkleFold",
            "merkle.merkleVerify",
            "audit.periodLeafDocument", "audit.periodRowVerify", "audit.isoToMicros",
            "audit.rowsFromTransactions", "audit.reportOrder", "audit.unmatchedHalves",
            "audit.unlockWarnings", "audit.anchorDocument", "audit.anchorTotals",
            "policy.policyDocument", "policy.validPolicy",
            "settlement.assertSettlementValid",
            "cycle.assertValidCycleId", "cycle.assertHex64", "cycle.custodyTagFor",
            "trade.assertValidTradeId", "assets.assertValidLocalId",
            "tenant.assertValidTenantId", "tenant.namespacedInstrumentId",
            "tenant.parseInstrumentId", "tenant.assertTenantOwnsInstrument",
            "tenant.assertTenantLegs", "tenant.hashTenantKey", "tenant.tenantIdFromKey",
            "tenant.verifyTenantKey",
            "assets.fungibleInstrument", "assets.uniqueInstrument", "assets.parseAsset",
            "assets.isUnique", "assets.assertAmountValidForAsset",
            "assets.assetAttributeDocument", "assets.deriveInstanceId",
            "trade.tradeDocument", "trade.leg", "transfer.transferDocument",
            "time.epochSeconds", "time.secondsBetween", "time.addSeconds", "time.intDivide",
            "quota.consume",
            "builder.buildCommitCommands", "builder.buildDryRunCommitCommands",
            "builder.buildSettleCommands", "builder.buildAbortCommands",
            "builder.buildExpireCommands", "builder.buildTradeProposalCommands",
            "builder.buildTradeSettleCommands", "builder.buildTradeCancelCommands",
            "builder.buildTransferCommands"));

    /**
     * Capability -> reject group, read from the manifest's own catalogue at
     * startup. Filled in run(); empty until then.
     */
    static final Map<String, String> CAPABILITY_REJECT_GROUP = new LinkedHashMap<>();

    /** Constants this client exposes, by the manifest's name for them. */
    static final Map<String, String> CONSTANTS = new LinkedHashMap<>();

    static {
        CONSTANTS.put("SCHEME_PREFIX", ArccadeDigest.SCHEME_PREFIX);
        CONSTANTS.put("DIGEST_ALG_ID", ArccadeDigest.DIGEST_ALG_ID);
        CONSTANTS.put("CUSTODY_TAG_PREFIX", CycleCommands.CUSTODY_TAG_PREFIX);
        CONSTANTS.put("DRY_RUN_VENUE_PREFIX", CycleCommands.DRY_RUN_VENUE_PREFIX);
        CONSTANTS.put("TRADE_TAG_PREFIX", TradeCommands.TRADE_TAG_PREFIX);
        CONSTANTS.put("TRANSFER_TAG_PREFIX", TransferCommands.TRANSFER_TAG_PREFIX);
        CONSTANTS.put("INSTANCE_SEPARATOR", Assets.INSTANCE_SEPARATOR);
        CONSTANTS.put("LEG_OFFER", TradeCommands.LEG_OFFER);
        CONSTANTS.put("LEG_ASK", TradeCommands.LEG_ASK);
        CONSTANTS.put("REASON_REWARD", TransferCommands.REASON_REWARD);
        CONSTANTS.put("REPORT_ORDER", CycleAuditReader.REPORT_ORDER);
    }

    // ---------------------------------------------------------------- errors

    /** A problem with the manifest or the environment: exit 2, nothing ran. */
    static final class ManifestError extends RuntimeException {
        private static final long serialVersionUID = 1L;

        ManifestError(String m) {
            super(m);
        }
    }

    /**
     * The language itself refused the call: there is no overload that accepts
     * the argument the manifest supplies. Carried through the same path as a
     * runtime throw so the reject map, not this class, decides the class.
     */
    static final class StaticTypeRefusal extends RuntimeException {
        private static final long serialVersionUID = 1L;

        StaticTypeRefusal(String m) {
            super(m);
        }
    }

    /** What a capability produced. Exactly one field is non-null. */
    record Produced(String text, String valueJson, Boolean bool, List<String> order) {
        static Produced text(String s) {
            return new Produced(s, null, null, null);
        }

        static Produced value(String json) {
            return new Produced(null, json, null, null);
        }

        static Produced bool(boolean b) {
            return new Produced(null, null, b, null);
        }

        static Produced order(List<String> o) {
            return new Produced(null, null, null, o);
        }
    }

    // ------------------------------------------------------------------ main

    public static void main(String[] argv) {
        try {
            System.exit(run(argv));
        } catch (ManifestError e) {
            System.err.println("manifest: " + e.getMessage());
            System.exit(2);
        } catch (Throwable t) {
            System.err.println("runner failed: " + t);
            t.printStackTrace();
            System.exit(4);
        }
    }

    static int run(String[] argv) throws IOException {
        Path manifestPath = null;
        Path out = null;
        List<String> profiles = null;
        List<String> onlyCases = new ArrayList<>();
        List<String> onlyGroups = new ArrayList<>();
        boolean listCapabilities = false;
        boolean listProfiles = false;
        boolean printTraits = false;

        for (int i = 0; i < argv.length; i++) {
            switch (argv[i]) {
                case "--manifest" -> manifestPath = Path.of(need(argv, ++i, "--manifest"));
                case "--out" -> out = Path.of(need(argv, ++i, "--out"));
                case "--profiles" -> profiles = List.of(need(argv, ++i, "--profiles").split(","));
                case "--case" -> onlyCases.add(need(argv, ++i, "--case"));
                case "--group" -> onlyGroups.add(need(argv, ++i, "--group"));
                case "--list-capabilities" -> listCapabilities = true;
                case "--list-profiles" -> listProfiles = true;
                case "--traits" -> printTraits = true;
                case "--help", "-h" -> {
                    System.out.println(USAGE);
                    return 0;
                }
                default -> throw new ManifestError("unknown flag: " + argv[i]);
            }
        }

        if (printTraits) {
            System.out.println(jsonOfBoolMap(TRAITS));
            return 0;
        }
        if (listCapabilities) {
            if (manifestPath == null) {
                throw new ManifestError("--list-capabilities needs --manifest");
            }
            printCapabilityCoverage(Json.parse(Files.readString(manifestPath)));
            return 0;
        }
        if (listProfiles) {
            if (manifestPath == null) {
                throw new ManifestError("--list-profiles needs --manifest");
            }
            Json m = Json.parse(Files.readString(manifestPath));
            declareProfiles(m);
            checkProfilesAreReachable(m);
            printProfileCoverage(m);
            return 0;
        }
        if (manifestPath == null || out == null) {
            throw new ManifestError("--manifest and --out are both required\n" + USAGE);
        }

        byte[] manifestBytes = Files.readAllBytes(manifestPath);
        String manifestSha = sha256Hex(manifestBytes);
        Json manifest = Json.parse(new String(manifestBytes, StandardCharsets.UTF_8));

        checkRejectMapHasNoCatchAll();
        checkCatalogImplClaims(manifest);
        checkRejectMapAgainstManifest(manifest);
        declareProfiles(manifest);
        checkProfilesAreReachable(manifest);
        int hexChecked = assertVHexAgreesWithV(manifest);
        assertNoJsonNumbersInCases(manifest);
        System.err.println("manifest ok: sha256 " + manifestSha
                + ", " + hexChecked + " vHex/v pairs agreed, no JSON numbers under input/expect");

        // The DEFAULT IS EVERY CASE. It used to be the profiles this runner
        // declared, which meant the bare invocation printed "317 cases" over a
        // manifest of 469 and said nothing about the 152 it had skipped -- a
        // number that reads as a total unless you already knew better. A
        // conformance run that silently narrows its own scope is worse than one
        // that fails: the failure is visible.
        boolean allProfiles = profiles == null
                || (profiles.size() == 1 && profiles.get(0).equals("all"));
        List<String> selected = profiles == null ? PROFILES_DECLARED : profiles;
        if (profiles != null && !allProfiles) {
            for (String p : profiles) {
                if (!PROFILES_DECLARED.contains(p)) {
                    throw new ManifestError("unknown profile: " + p + "; known: "
                            + String.join(", ", PROFILES_DECLARED) + ", all");
                }
            }
        }

        // A case's profile is its GROUP's, not its capability's. The two
        // disagree for 26 of the 469 cases -- merkle-root-over-fixture-leaves
        // sits in the period-leaf group but exercises merkle.merkleRoot, and the
        // twenty game cases sit in the "games" group while every one of them
        // exercises a core-digest capability. This runner used to take the
        // capability's, which is what made `games` unreachable: the manifest
        // declares the profile, two groups put 20 cases in it, and no capability
        // carries it, so no --profiles value could name those cases. What made
        // the old choice look necessary was that the three runners had to agree
        // -- and they do, because all three now read this one field out of the
        // manifest instead of each deriving a second opinion.
        for (Json cap : manifest.path("capabilities")) {
            // The reject GROUP is read from the catalogue too. Deriving it from
            // the capability id, as this runner used to, is a second opinion
            // about a fact the manifest already states, and the two drifted:
            // digest.textDigest sits in "digest.text" and was being classed
            // under "digest.scalar".
            if (cap.path("rejectGroup").isString()) {
                CAPABILITY_REJECT_GROUP.put(cap.path("id").asText(),
                        cap.path("rejectGroup").asText());
            }
        }

        // Collect and sort by id. Sorting is what makes two runners' output
        // comparable line by line without trusting either of them.
        List<Json> cases = new ArrayList<>();
        Map<String, String> caseProfile = new LinkedHashMap<>();
        Map<String, String> caseGroup = new LinkedHashMap<>();
        List<CaseEntry> everyCase = allCases(manifest);
        int totalInManifest = everyCase.size();
        for (CaseEntry e : everyCase) {
            if (!onlyGroups.isEmpty() && !onlyGroups.contains(e.group())) {
                continue;
            }
            if (!allProfiles && !selected.contains(e.profile())) {
                continue;
            }
            if (!onlyCases.isEmpty() && !onlyCases.contains(e.id())) {
                continue;
            }
            cases.add(e.json());
            caseProfile.put(e.id(), e.profile());
            caseGroup.put(e.id(), e.group());
        }

        List<String> narrowing = new ArrayList<>();
        if (!allProfiles) {
            narrowing.add("--profiles " + String.join(",", selected));
        }
        if (!onlyGroups.isEmpty()) {
            narrowing.add("--group " + String.join(",", onlyGroups));
        }
        if (!onlyCases.isEmpty()) {
            narrowing.add("--case " + String.join(",", onlyCases));
        }
        String narrowedBy = narrowing.isEmpty() ? "nothing" : String.join(" ", narrowing);
        cases.sort(Comparator.comparing(c -> c.path("id").asText()));
        if (cases.isEmpty()) {
            throw new ManifestError("selection matched no cases");
        }

        long started = System.currentTimeMillis();
        StringBuilder jsonl = new StringBuilder();
        StringBuilder verdicts = new StringBuilder();
        jsonl.append(headerRecord(manifestSha)).append('\n');

        Map<String, Integer> counts = new TreeMap<>();
        Map<String, Integer> ruleUses = new LinkedHashMap<>();
        boolean unsupportedInDeclared = false;

        for (Json c : cases) {
            String id = c.path("id").asText();
            String cap = c.path("capability").asText();
            String profile = caseProfile.get(id);
            CaseResult r = evaluate(c, cap, ruleUses);
            // Exit 3 covers a profile this client DECLARES and also one the
            // caller explicitly asked for: naming --profiles identity is asking
            // this client to prove identity, and answering "88 unsupported,
            // exit 0" would be exactly the wave-through the exit codes exist to
            // prevent. --profiles all is the one exception, because a survey of
            // every profile is not a claim about any of them.
            if (r.status.equals("unsupported")
                    && (PROFILES_DECLARED.contains(profile)
                        || (!allProfiles && profiles != null && profiles.contains(profile)))) {
                unsupportedInDeclared = true;
            }
            counts.merge(r.status, 1, Integer::sum);
            jsonl.append(caseRecord(id, caseGroup.get(id), cap, profile, c, r)).append('\n');
            verdicts.append(id).append(' ').append(r.status).append('\n');
        }

        int pass = counts.getOrDefault("pass", 0);
        int fail = counts.getOrDefault("fail", 0);
        int error = counts.getOrDefault("error", 0);
        int unsupported = counts.getOrDefault("unsupported", 0);
        int notApplicable = counts.getOrDefault("not-applicable", 0);

        int exit;
        if (fail > 0 || error > 0) {
            exit = 1;
        } else if (unsupportedInDeclared) {
            exit = 3;
        } else {
            exit = 0;
        }

        jsonl.append("{\"rec\":\"summary\",\"total\":").append(cases.size())
                .append(",\"totalInManifest\":").append(totalInManifest)
                .append(",\"omitted\":").append(totalInManifest - cases.size())
                .append(",\"narrowedBy\":").append(str(narrowedBy))
                .append(",\"pass\":").append(pass)
                .append(",\"fail\":").append(fail)
                .append(",\"error\":").append(error)
                .append(",\"unsupported\":").append(unsupported)
                .append(",\"notApplicable\":").append(notApplicable)
                .append(",\"exitCode\":").append(exit)
                .append(",\"wallMs\":").append(System.currentTimeMillis() - started)
                .append("}\n");

        if (out.getParent() != null) {
            Files.createDirectories(out.getParent());
        }
        Files.writeString(out, jsonl.toString(), StandardCharsets.UTF_8);
        Files.writeString(Path.of(out + ".verdicts"), verdicts.toString(), StandardCharsets.UTF_8);

        // Both facts, always, so exit-code precedence never hides one of them.
        System.err.printf(
                "%d of %d cases: %d pass, %d fail, %d error, %d unsupported, %d not-applicable%n",
                cases.size(), totalInManifest, pass, fail, error, unsupported, notApplicable);
        if (cases.size() < totalInManifest) {
            // Never a bare count. A selection that ran less than the manifest
            // has to say so, in the same breath, with the flags that caused it.
            System.err.printf("OMITTED %d of %d cases -- this run is a SUBSET, not a "
                            + "conformance result. Narrowed by: %s%n",
                    totalInManifest - cases.size(), totalInManifest, narrowedBy);
        }
        if (unsupportedInDeclared) {
            System.err.println("a declared or explicitly requested profile contains an "
                    + "unsupported capability"
                    + (exit == 1 ? " (exit 1 takes precedence over 3, but the fact stands)" : ""));
        }
        // A rule nothing exercised is a rule nothing checked. Reported against
        // the SELECTION that ran, so a subset run does not read as a defect.
        for (RejectRule rule : REJECT_MAP) {
            if (ruleUses.getOrDefault(ruleKey(rule), 0) == 0) {
                System.err.println("reject rule not exercised by this selection: " + ruleKey(rule));
            }
        }
        System.err.println("wrote " + out + " and " + out + ".verdicts; exit " + exit);
        return exit;
    }

    static final String USAGE = """
            runners/java/run --manifest <manifest.json> --out <path.jsonl> [flags]
              --profiles <a,b,c>   default: EVERY case in the manifest. Naming profiles narrows
                                   the run, and the summary then says how many cases it omitted
              --case <id>          repeatable
              --group <name>       repeatable
              --list-capabilities  catalog coverage as JSON (needs --manifest), exit 0
              --list-profiles      the manifest's declared profiles, with the case count each
                                   one selects here, as JSON (needs --manifest), exit 0
              --traits             declared traits as JSON, exit 0""";

    static String need(String[] argv, int i, String flag) {
        if (i >= argv.length) {
            throw new ManifestError(flag + " needs a value");
        }
        return argv[i];
    }

    // ------------------------------------------------------- case evaluation

    record CaseResult(String status, String observedJson) {
    }

    static CaseResult evaluate(Json c, String cap, Map<String, Integer> ruleUses) {
        Json expect = c.path("expect");
        Json args = c.path("input").path("args");

        if (!isSupported(cap, args)) {
            return new CaseResult("unsupported",
                    "{\"reason\":\"capability not implemented in this client\",\"errorText\":null}");
        }

        Produced produced;
        Throwable thrown = null;
        try {
            produced = invoke(cap, args);
        } catch (ManifestError e) {
            throw e;
        } catch (Throwable t) {
            produced = null;
            thrown = t;
        }

        String errorText = thrown == null ? null
                : thrown.getClass().getSimpleName()
                        + (thrown.getMessage() == null ? "" : ": " + thrown.getMessage());

        if (expect.has("reject")) {
            String want = expect.path("reject").path("class").asText();
            if (thrown == null) {
                return new CaseResult("fail", "{" + producedJson(produced)
                        + ",\"errorText\":null,\"note\":\"a value came back where a refusal was required\"}");
            }
            String got = classify(cap, thrown, ruleUses);
            if (got == null) {
                return new CaseResult("error", "{\"reject\":null,\"errorText\":" + str(errorText)
                        + ",\"note\":\"threw, but no reject-map rule for this group matched\"}");
            }
            String obs = "{\"reject\":{\"class\":" + str(got) + "},\"errorText\":" + str(errorText) + "}";
            return new CaseResult(got.equals(want) ? "pass" : "fail", obs);
        }

        if (thrown instanceof StaticTypeRefusal) {
            // The language refused the call outright. Where a refusal was wanted
            // that is a pass (handled above); where a VALUE was wanted it is a
            // definite fail -- this client cannot produce it -- and not an
            // error, which is reserved for a throw nobody could classify.
            return new CaseResult("fail", "{\"value\":null,\"errorText\":" + str(errorText)
                    + ",\"note\":\"the client has no representation for this argument\"}");
        }

        if (thrown != null) {
            // A throw where a value was required. Classifying it would dress a
            // failure up as a considered refusal, so it is an error either way;
            // the class is reported only to make the cause legible.
            String got = classify(cap, thrown, ruleUses);
            return new CaseResult("error", "{\"reject\":" + (got == null ? "null" : "{\"class\":" + str(got) + "}")
                    + ",\"errorText\":" + str(errorText) + "}");
        }

        return compare(expect, produced, errorText);
    }

    static CaseResult compare(Json expect, Produced p, String errorText) {
        if (expect.has("text")) {
            String want = expect.path("text").path("v").asText();
            String got = requireText(p, "text");
            String obs = "{\"text\":{\"v\":" + str(got) + ",\"vHex\":" + str(utf8Hex(got))
                    + "},\"errorText\":" + str(errorText) + divergence(want, got) + "}";
            return new CaseResult(want.equals(got) ? "pass" : "fail", obs);
        }
        if (expect.has("digest")) {
            String want = expect.path("digest").asText();
            String got = requireText(p, "digest");
            return new CaseResult(want.equals(got) ? "pass" : "fail",
                    "{\"digest\":" + str(got) + ",\"errorText\":" + str(errorText) + "}");
        }
        if (expect.has("document")) {
            String wantText = expect.path("document").path("text").path("v").asText();
            String wantDigest = expect.path("document").path("digest").asText();
            String gotText = requireText(p, "document");
            String gotDigest = ArccadeDigest.textDigest(gotText);
            boolean ok = wantText.equals(gotText) && wantDigest.equals(gotDigest);
            String obs = "{\"document\":{\"text\":{\"v\":" + str(gotText) + ",\"vHex\":"
                    + str(utf8Hex(gotText)) + "},\"digest\":" + str(gotDigest)
                    + "},\"errorText\":" + str(errorText) + divergence(wantText, gotText) + "}";
            return new CaseResult(ok ? "pass" : "fail", obs);
        }
        if (expect.has("bool")) {
            boolean want = expect.path("bool").asText().equals("true");
            if (p.bool() == null) {
                throw new ManifestError("expected a boolean but the capability produced none");
            }
            return new CaseResult(want == p.bool() ? "pass" : "fail",
                    "{\"bool\":" + p.bool() + ",\"errorText\":" + str(errorText) + "}");
        }
        if (expect.has("order")) {
            List<String> want = new ArrayList<>();
            for (Json e : expect.path("order")) {
                want.add(e.asText());
            }
            if (p.order() == null) {
                throw new ManifestError("expected an order but the capability produced none");
            }
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < p.order().size(); i++) {
                sb.append(i == 0 ? "" : ",").append(str(p.order().get(i)));
            }
            sb.append(']');
            return new CaseResult(want.equals(p.order()) ? "pass" : "fail",
                    "{\"order\":" + sb + ",\"errorText\":" + str(errorText) + "}");
        }
        if (expect.has("value")) {
            String want = normalize(expect.path("value"));
            if (p.valueJson() == null) {
                throw new ManifestError("expected a value but the capability produced none");
            }
            return new CaseResult(want.equals(p.valueJson()) ? "pass" : "fail",
                    "{\"value\":" + p.valueJson() + ",\"errorText\":" + str(errorText) + "}");
        }
        throw new ManifestError("case has no recognised expectation form");
    }

    static String requireText(Produced p, String form) {
        if (p.text() == null) {
            throw new ManifestError("expected " + form + " but the capability produced none");
        }
        return p.text();
    }

    /** Index of the first differing UTF-8 byte, as a string. Absent when equal. */
    static String divergence(String want, String got) {
        if (want.equals(got)) {
            return "";
        }
        byte[] a = want.getBytes(StandardCharsets.UTF_8);
        byte[] b = got.getBytes(StandardCharsets.UTF_8);
        int i = 0;
        while (i < a.length && i < b.length && a[i] == b[i]) {
            i++;
        }
        return ",\"firstDivergentByte\":\"" + i + "\"";
    }

    static String producedJson(Produced p) {
        if (p == null) {
            return "\"value\":null";
        }
        if (p.text() != null) {
            return "\"text\":{\"v\":" + str(p.text()) + ",\"vHex\":" + str(utf8Hex(p.text())) + "}";
        }
        if (p.valueJson() != null) {
            return "\"value\":" + p.valueJson();
        }
        if (p.bool() != null) {
            return "\"bool\":" + p.bool();
        }
        StringBuilder sb = new StringBuilder("\"order\":[");
        for (int i = 0; i < p.order().size(); i++) {
            sb.append(i == 0 ? "" : ",").append(str(p.order().get(i)));
        }
        return sb.append(']').toString();
    }

    // ------------------------------------------------------- reject classing

    static String rejectGroup(String cap) {
        String declared = CAPABILITY_REJECT_GROUP.get(cap);
        if (declared != null) {
            return declared;
        }
        // Fallback for a capability the catalogue does not classify. It is a
        // guess, and a guess that lands on a group with no matching rule ends
        // as `error`, which is the visible outcome.
        if (cap.equals("digest.amountUnits") || cap.equals("digest.canonDecimal")) {
            return "digest.amount";
        }
        if (cap.equals("digest.canonFields") || cap.equals("digest.canonDocument")) {
            return "digest.fields";
        }
        if (cap.startsWith("digest.")) {
            return "digest.scalar";
        }
        if (cap.startsWith("audit.")) {
            return "audit";
        }
        if (cap.startsWith("merkle.")) {
            return "merkle";
        }
        return cap.substring(0, cap.indexOf('.'));
    }

    static String ruleKey(RejectRule r) {
        return r.group() + "/" + r.type() + (r.contains().isEmpty() ? "" : "/" + r.contains());
    }

    static String classify(String cap, Throwable t, Map<String, Integer> ruleUses) {
        String group = rejectGroup(cap);
        String type = t.getClass().getSimpleName();
        String message = t.getMessage() == null ? "" : t.getMessage();
        for (RejectRule r : REJECT_MAP) {
            if (r.group().equals(group) && r.type().equals(type)
                    && (r.contains().isEmpty() || message.contains(r.contains()))) {
                ruleUses.merge(ruleKey(r), 1, Integer::sum);
                return r.cls();
            }
        }
        return null;
    }

    /**
     * A rule that could swallow anything is not a rule. Checked at startup so a
     * widened catch cannot be introduced quietly to make a red case go green.
     */
    static void checkRejectMapHasNoCatchAll() {
        for (RejectRule r : REJECT_MAP) {
            if (r.type().isEmpty()) {
                throw new ManifestError("reject rule with no exception type: " + ruleKey(r));
            }
            boolean broad = r.type().equals("Exception") || r.type().equals("RuntimeException")
                    || r.type().equals("Throwable");
            if (broad && r.contains().isEmpty()) {
                throw new ManifestError("catch-all reject rule: " + ruleKey(r));
            }
        }
    }

    /**
     * The selectable profile set is the manifest's {@code profiles} object and
     * nothing else. All three runners used to derive it from the capability
     * catalog, which silently dropped {@code games}: the manifest declares it,
     * two groups put 20 cases in it, and no capability carries it, so
     * {@code --profiles games} was exit 2 in every runner while those cases ran
     * under {@code --profiles all}. A profile that is declared and cannot be
     * named is a claim that cannot be checked.
     */
    static void declareProfiles(Json manifest) {
        PROFILES_DECLARED.clear();
        List<String> names = new ArrayList<>(manifest.path("profiles").names());
        names.sort(Comparator.naturalOrder());
        PROFILES_DECLARED.addAll(names);
        if (PROFILES_DECLARED.isEmpty()) {
            throw new ManifestError("manifest declares no profiles");
        }
    }

    /**
     * One case, with the group it is in and the profile that group declares.
     * The profile is the GROUP's and not the capability's -- see the comment in
     * run() where the selection loop walks this list.
     */
    record CaseEntry(String id, String group, String profile, Json json) {
    }

    /**
     * Every case in the manifest, in document order. The selection loop walks
     * this list and so does {@link #casesPerProfile}, so "the cases in profile
     * P" has one definition here rather than one per caller.
     */
    static List<CaseEntry> allCases(Json manifest) {
        List<CaseEntry> out = new ArrayList<>();
        for (Json g : manifest.path("groups")) {
            String group = g.path("group").asText();
            String profile = g.path("profile").asText();
            for (Json c : g.path("cases")) {
                out.add(new CaseEntry(c.path("id").asText(), group, profile, c));
            }
        }
        return out;
    }

    /** Cases per declared profile, counted the way selection counts them. */
    static Map<String, Integer> casesPerProfile(Json manifest) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String p : PROFILES_DECLARED) {
            counts.put(p, 0);
        }
        for (CaseEntry e : allCases(manifest)) {
            if (counts.containsKey(e.profile())) {
                counts.put(e.profile(), counts.get(e.profile()) + 1);
            }
        }
        return counts;
    }

    /**
     * The declared profile set and the reachable profile set are one set, in
     * both directions: a group may not name a profile the manifest does not
     * declare, and a declared profile with no case is a name the caller can
     * pass that selects nothing.
     *
     * <p>The published {@code summary.byProfile} table is checked against the
     * same count. It was built from a hardcoded eight-key literal keyed on the
     * capability profile, so it filed the 20 games cases under core-digest and
     * merkle and omitted the profile they are declared in — and the totals
     * still summed to 469, which is the hard kind of wrong answer to see.
     * Nothing could contradict that table; this does.
     */
    static void checkProfilesAreReachable(Json manifest) {
        List<String> problems = new ArrayList<>();
        for (Json g : manifest.path("groups")) {
            String profile = g.path("profile").asText();
            if (!PROFILES_DECLARED.contains(profile)) {
                problems.add("group " + g.path("group").asText() + " declares profile "
                        + profile + ", which manifest.profiles does not list");
            }
        }
        Map<String, Integer> counts = casesPerProfile(manifest);
        for (String p : PROFILES_DECLARED) {
            if (counts.get(p) == 0) {
                problems.add("profile " + p + " is declared in manifest.profiles and no case "
                        + "is in it; `--profiles " + p + "` would select nothing");
            }
        }
        Json byProfile = manifest.path("summary").path("byProfile");
        if (byProfile.isObject()) {
            for (String p : byProfile.names()) {
                if (!PROFILES_DECLARED.contains(p)) {
                    problems.add("summary.byProfile names profile " + p
                            + ", which manifest.profiles does not declare");
                }
            }
            for (String p : PROFILES_DECLARED) {
                Json want = byProfile.path(p);
                if (want.isMissing()) {
                    problems.add("summary.byProfile has no entry for the declared profile " + p);
                } else if (Integer.parseInt(want.asText()) != counts.get(p)) {
                    problems.add("summary.byProfile." + p + "=" + want.asText()
                            + " but the file carries " + counts.get(p)
                            + " case(s) in that profile");
                }
            }
        }
        if (!problems.isEmpty()) {
            throw new ManifestError("profile declaration is not reachable:\n  - "
                    + String.join("\n  - ", problems));
        }
    }

    /**
     * The catalog's {@code impl.java} is a claim about THIS client, and this
     * runner is the only thing that knows whether it is true. Checked rather
     * than trusted: a null beside a capability this runner dispatches means the
     * manifest is slandering a client that works, and a name beside one it
     * cannot dispatch means the suite is about to report {@code unsupported}
     * for something the catalog swears exists. Both are manifest errors, and
     * both stop the run before a single case is executed.
     *
     * <p>This is the check that caught 43 capabilities recorded as
     * unimplemented in Java while Java passed all 469 cases.
     */
    static void checkCatalogImplClaims(Json manifest) {
        List<String> problems = new ArrayList<>();
        for (Json cap : manifest.path("capabilities")) {
            String id = cap.path("id").asText();
            Json claim = cap.path("impl").path("java");
            boolean claimed = claim.isString();
            boolean dispatchable = SUPPORTED.contains(id);
            if (claimed && !dispatchable) {
                problems.add("capability " + id + ": the catalog says impl.java is \""
                        + claim.asText() + "\", but this runner has no dispatch entry for it");
            }
            if (!claimed && dispatchable) {
                problems.add("capability " + id + ": the catalog says impl.java is null, but this "
                        + "runner drives it. Regenerate the manifest.");
            }
        }
        if (!problems.isEmpty()) {
            throw new ManifestError(String.join("\n", problems));
        }
    }

    /**
     * Reject-map drift against THIS language's entry.
     *
     * <p>The manifest used to publish one {@code rejectMap} — the JavaScript
     * client's — under a name that read as though it were every client's. This
     * runner never compared against it at all, and the two runners that did
     * printed the drift and exited 0. A drift report nobody's exit code depends
     * on is a comment.
     *
     * <p>Java cannot share that table even in principle: it classes a refusal by
     * exception type first and message second, where the other two match a
     * substring of their own error text. So the manifest now carries one map per
     * language, harvested from each runner's own source, and this compares
     * against {@code rejectMaps.java.rules}. A difference means this runner
     * classifies refusals by rules the manifest does not describe, which makes
     * every {@code reject.class} verdict below unreadable — hence exit 2 rather
     * than a note.
     */
    static void checkRejectMapAgainstManifest(Json manifest) {
        Json declared = manifest.path("rejectMaps").path("java").path("rules");
        List<String> theirs = new ArrayList<>();
        for (Json r : declared) {
            theirs.add(r.path("group").asText() + " | " + r.path("type").asText()
                    + " | " + r.path("contains").asText() + " | " + r.path("class").asText());
        }
        if (theirs.isEmpty()) {
            throw new ManifestError("manifest has no rejectMaps.java.rules; regenerate it with "
                    + "the current generate.mjs");
        }
        List<String> mine = new ArrayList<>();
        for (RejectRule r : REJECT_MAP) {
            mine.add(r.group() + " | " + r.type() + " | " + r.contains() + " | " + r.cls());
        }
        List<String> problems = new ArrayList<>();
        for (String k : theirs) {
            if (!mine.contains(k)) {
                problems.add("reject-map drift: the manifest has a rule this runner lacks: " + k);
            }
        }
        for (String k : mine) {
            if (!theirs.contains(k)) {
                problems.add("reject-map drift: this runner has a rule the manifest lacks: " + k);
            }
        }
        if (!problems.isEmpty()) {
            throw new ManifestError(String.join("\n", problems));
        }
    }

    // ------------------------------------------------------------- dispatch

    static boolean isSupported(String cap, Json args) {
        if (!SUPPORTED.contains(cap)) {
            return false;
        }
        if (cap.equals("digest.constant")) {
            return CONSTANTS.containsKey(args.path(0).path("v").asText())
                    || args.path(0).path("v").asText().equals("DISPOSITIONS");
        }
        return true;
    }

    static Produced invoke(String cap, Json a) {
        switch (cap) {
            case "digest.canon":
                return Produced.text(ArccadeDigest.canon(str0(a, 0), str0(a, 1)));
            case "digest.canonText":
                return Produced.text(ArccadeDigest.canonText(str0(a, 0)));
            case "digest.canonInt":
                return Produced.text(isWide(a.path(0))
                        ? ArccadeDigest.canonInt(bigIntArg(a.path(0)))
                        : ArccadeDigest.canonInt(longArg(a.path(0))));
            case "digest.canonBool":
                return Produced.text(ArccadeDigest.canonBool(boolArg(a.path(0))));
            case "digest.canonDecimal":
                return amountArg(a.path(0), true);
            case "digest.canonTimeMicros":
                return Produced.text(ArccadeDigest.canonTimeMicros(longArg(a.path(0))));
            case "digest.canonTime":
                return Produced.text(ArccadeDigest.canonTime(Instant.parse(str0(a, 0))));
            case "digest.canonParty":
                return Produced.text(ArccadeDigest.canonParty(str0(a, 0)));
            case "digest.canonOptional": {
                Json v = a.path(0);
                String value = v.path("t").asText().equals("null") ? null : v.path("v").asText();
                return Produced.text(ArccadeDigest.canonOptional(ArccadeDigest::canonText, value));
            }
            case "digest.canonList":
                return Produced.text(ArccadeDigest.canonList(stringList(a.path(0))));
            case "digest.canonFields":
                return Produced.text(ArccadeDigest.canonFields(fieldList(a.path(0))));
            case "digest.codePointLength":
                return Produced.value(intValue(ArccadeDigest.codePointLength(str0(a, 0))));
            case "digest.amountUnits":
                return amountArg(a.path(0), false);
            case "digest.canonDocument":
                return Produced.text(ArccadeDigest.canonDocument(
                        str0(a, 0), (int) longArg(a.path(1)), fieldList(a.path(2))));
            case "digest.textDigest":
                return Produced.text(ArccadeDigest.textDigest(str0(a, 0)));
            case "digest.constant":
                return constant(str0(a, 0));

            case "merkle.merkleEmpty":
                return Produced.text(ArccadeMerkle.merkleEmpty());
            case "merkle.merkleNode":
                return Produced.text(ArccadeMerkle.merkleNode(str0(a, 0), str0(a, 1)));
            case "merkle.merklePairUp":
                return Produced.value(hexListValue(ArccadeMerkle.merklePairUp(stringList(a.path(0)))));
            case "merkle.merkleRoot":
                return Produced.text(ArccadeMerkle.merkleRoot(stringList(a.path(0))));
            case "merkle.merkleProof":
                return Produced.value(stepsValue(
                        ArccadeMerkle.merkleProof((int) longArg(a.path(0)), stringList(a.path(1)))));
            case "merkle.merkleFold":
                return Produced.text(ArccadeMerkle.merkleFold(str0(a, 0), stepList(a.path(1))));
            case "merkle.merkleVerify":
                return Produced.bool(ArccadeMerkle.merkleVerify(
                        str0(a, 0), stepList(a.path(1)), str0(a, 2)));

            case "audit.periodLeafDocument":
                return Produced.text(PeriodAuditDocuments.periodLeafDocument(rowArg(a.path(0))));
            case "audit.periodRowVerify":
                return Produced.bool(PeriodAuditDocuments.periodRowVerify(
                        rowArg(a.path(0)), stepList(a.path(1)), str0(a, 2)));
            case "audit.isoToMicros":
                return Produced.value(intValue(CycleAuditReader.isoToMicros(str0(a, 0))));
            case "audit.rowsFromTransactions": {
                CycleAuditReader.Result r = CycleAuditReader.rowsFromTransactions(transactions(a.path(0)));
                StringBuilder sb = new StringBuilder("{\"t\":\"list\",\"v\":[");
                for (int i = 0; i < r.rows().size(); i++) {
                    sb.append(i == 0 ? "" : ",").append(rowValue(r.rows().get(i).row()));
                }
                return Produced.value(sb.append("]}").toString());
            }
            case "audit.reportOrder": {
                CycleAuditReader.Result r = CycleAuditReader.rowsFromTransactions(transactions(a.path(0)));
                List<String> ids = new ArrayList<>();
                r.rows().forEach(row -> ids.add(row.row().cycleId()));
                return Produced.order(ids);
            }
            case "audit.unmatchedHalves": {
                CycleAuditReader.Result r = CycleAuditReader.rowsFromTransactions(transactions(a.path(0)));
                return Produced.value("{\"t\":\"pairs\",\"v\":["
                        + "[" + textValue("openStakes") + "," + textListValue(r.openStakeIds()) + "],"
                        + "[" + textValue("orphanClosings") + "," + textListValue(r.orphanClosingIds()) + "]"
                        + "]}");
            }
            case "audit.unlockWarnings": {
                CycleAuditReader.Result r = CycleAuditReader.rowsFromTransactions(transactions(a.path(0)));
                StringBuilder sb = new StringBuilder("{\"t\":\"list\",\"v\":[");
                for (int i = 0; i < r.warnings().size(); i++) {
                    CycleAuditReader.Warning w = r.warnings().get(i);
                    sb.append(i == 0 ? "" : ",")
                            .append("{\"t\":\"pairs\",\"v\":[")
                            .append('[').append(textValue("cycleId")).append(',')
                            .append(textValue(w.cycleId())).append("],")
                            .append('[').append(textValue("kind")).append(',')
                            .append(textValue(w.kind())).append("],")
                            .append('[').append(textValue("stated")).append(',')
                            .append("{\"t\":\"int\",\"v\":").append(str(w.stated())).append("}],")
                            // Java's field is 'observed'; the manifest's neutral
                            // name for the same number is 'unlocked'.
                            .append('[').append(textValue("unlocked")).append(',')
                            .append("{\"t\":\"int\",\"v\":").append(str(w.observed())).append("}]")
                            .append("]}");
                }
                return Produced.value(sb.append("]}").toString());
            }
            case "audit.anchorDocument":
                return Produced.text(PeriodAnchorDocuments.anchorDocument(anchorArg(a.path(0))));
            case "audit.anchorTotals": {
                AnchorTotals t = PeriodAnchorDocuments.anchorTotals(rowList(a.path(0)));
                return Produced.value(pairs(
                        pair("cycleCount", intValue(t.cycleCount())),
                        pair("committedUnits", intValue(t.committedUnits())),
                        pair("feeUnits", intValue(t.feeUnits())),
                        pair("returnedUnits", intValue(t.returnedUnits())),
                        pair("forfeitedUnits", intValue(t.forfeitedUnits())),
                        pair("payoutUnits", intValue(t.payoutUnits()))));
            }
            case "policy.policyDocument":
                return Produced.text(PolicyDocuments.policyDocument(policyArg(a.path(0))));
            case "policy.validPolicy":
                return Produced.bool(PolicyDocuments.validPolicy(policyArg(a.path(0))));
            case "settlement.assertSettlementValid":
                return Produced.bool(
                        SettlementInvariants.assertSettlementValid(settlementArg(a.path(0))));

            case "cycle.assertValidCycleId":
                return Produced.value(textValue(CycleCommands.assertValidCycleId(str0(a, 0))));
            case "cycle.assertHex64":
                return Produced.value(textValue(CycleCommands.assertHex64(str0(a, 0))));
            case "cycle.custodyTagFor":
                return Produced.text(CycleCommands.custodyTagFor(str0(a, 0), str0(a, 1)));
            case "trade.assertValidTradeId":
                return Produced.value(textValue(TradeCommands.assertValidTradeId(str0(a, 0))));
            case "assets.assertValidLocalId":
                return Produced.value(textValue(Assets.assertValidLocalId(str0(a, 0))));

            case "tenant.assertValidTenantId":
                return Produced.value(textValue(Tenancy.assertValidTenantId(str0(a, 0))));
            case "tenant.namespacedInstrumentId":
                return Produced.value(instrumentValue(
                        Tenancy.namespacedInstrumentId(str0(a, 0), str0(a, 1), str0(a, 2))));
            case "tenant.parseInstrumentId": {
                Tenancy.ParsedInstrumentId p = Tenancy.parseInstrumentId(instrumentArg(a.path(0)));
                return Produced.value(pairs(
                        pair("tenantId", nullableText(p.tenantId())),
                        pair("localId", textValue(p.localId()))));
            }
            case "tenant.assertTenantOwnsInstrument":
                return Produced.value(textValue(Tenancy.assertTenantOwnsInstrument(
                        str0(a, 0), instrumentArg(a.path(1)))));
            case "tenant.assertTenantLegs":
                return Produced.value(textValue(
                        Tenancy.assertTenantLegs(str0(a, 0), legMap(a.path(1)).values())));
            case "tenant.hashTenantKey":
                return Produced.text(Tenancy.hashTenantKey(str0(a, 0)));
            case "tenant.tenantIdFromKey":
                return Produced.value(nullableText(Tenancy.tenantIdFromKey(str0(a, 0))));
            case "tenant.verifyTenantKey":
                return Produced.bool(Tenancy.verifyTenantKey(str0(a, 0), str0(a, 1)));

            case "assets.fungibleInstrument":
                return Produced.value(instrumentValue(
                        Assets.fungibleInstrument(str0(a, 0), str0(a, 1), str0(a, 2))));
            case "assets.uniqueInstrument":
                return Produced.value(instrumentValue(Assets.uniqueInstrument(
                        str0(a, 0), str0(a, 1), str0(a, 2), str0(a, 3))));
            case "assets.parseAsset": {
                Assets.ParsedAsset p = Assets.parseAsset(instrumentArg(a.path(0)));
                return Produced.value(pairs(
                        pair("tenantId", nullableText(p.tenantId())),
                        pair("localId", textValue(p.localId())),
                        pair("instanceId", nullableText(p.instanceId())),
                        pair("assetClass", textValue(p.assetClass()))));
            }
            case "assets.isUnique":
                return Produced.bool(Assets.isUnique(instrumentArg(a.path(0))));
            case "assets.assertAmountValidForAsset":
                return Produced.value(textValue(Assets.assertAmountValidForAsset(
                        instrumentArg(a.path(0)), a.path(1).path("v").asText())));
            case "assets.assetAttributeDocument":
                return Produced.text(Assets.assetAttributeDocument(
                        instrumentArg(a.path(0)), attributeList(a.path(1))));
            case "assets.deriveInstanceId":
                return Produced.value(textValue(Assets.deriveInstanceId(
                        str0(a, 0), str0(a, 1), attributeList(a.path(2)), str0(a, 3))));

            case "trade.tradeDocument":
                return Produced.text(TradeCommands.tradeDocument(tradeArg(a.path(0))));
            case "trade.leg": {
                TradeLeg l = legArg(a.path(0));
                return Produced.value(pairs(
                        pair("sender", partyValue(l.sender())),
                        pair("receiver", partyValue(l.receiver())),
                        pair("instrument", textValue(l.instrumentId().id())),
                        pair("amount", textValue(l.amount()))));
            }
            case "transfer.transferDocument":
                return Produced.text(TransferCommands.transferDocument(transferArg(a.path(0))));

            case "time.intDivide":
                return Produced.value(intValue(
                        LedgerTime.intDivide(longArg(a.path(0)), longArg(a.path(1)))));
            case "time.epochSeconds":
                return Produced.value(intValue(LedgerTime.epochSeconds(longArg(a.path(0)))));
            case "time.secondsBetween":
                return Produced.value(intValue(
                        LedgerTime.secondsBetween(longArg(a.path(0)), longArg(a.path(1)))));
            case "time.addSeconds":
                return Produced.value(intValue(
                        LedgerTime.addSeconds(longArg(a.path(0)), longArg(a.path(1)))));

            case "quota.consume": {
                Json cfg = a.path(0).path("v").path("fields");
                TenantQuota quota = new TenantQuota(
                        Long.parseLong(cfg.path("windowSeconds").path("v").asText()),
                        Long.parseLong(cfg.path("maxWrites").path("v").asText()));
                List<String> decisions = new ArrayList<>();
                for (Json step : a.path(1).path("v")) {
                    Json f = step.path("v").path("fields");
                    TenantQuota.Decision d = quota.consume(
                            f.path("tenantId").path("v").asText(),
                            Long.parseLong(f.path("nowMs").path("v").asText()),
                            Long.parseLong(f.path("cost").path("v").asText()));
                    decisions.add(pairs(
                            pair("allowed", boolValue(d.allowed())),
                            pair("remaining", intValue(d.remaining())),
                            pair("resetAt", intValue(d.resetAt()))));
                }
                return Produced.value(listValue(decisions));
            }

            case "builder.buildCommitCommands":
                return jsonValue(CycleCommands.buildCommitCommands(commitOptions(json(a.path(0)))));
            case "builder.buildDryRunCommitCommands":
                return jsonValue(CycleCommands.buildDryRunCommitCommands(
                        dryRunOptions(json(a.path(0)))));
            case "builder.buildSettleCommands":
                return jsonValue(CycleCommands.buildSettleCommands(settleOptions(json(a.path(0)))));
            case "builder.buildAbortCommands":
                return jsonValue(CycleCommands.buildAbortCommands(abortOptions(json(a.path(0)))));
            case "builder.buildExpireCommands":
                return jsonValue(CycleCommands.buildExpireCommands(expireOptions(json(a.path(0)))));
            case "builder.buildTradeProposalCommands":
                return jsonValue(TradeCommands.buildTradeProposalCommands(
                        proposalOptions(json(a.path(0)))));
            case "builder.buildTradeSettleCommands":
                return jsonValue(TradeCommands.buildTradeSettleCommands(
                        tradeSettleOptions(json(a.path(0)))));
            case "builder.buildTradeCancelCommands":
                return jsonValue(TradeCommands.buildTradeCancelCommands(
                        tradeCancelOptions(json(a.path(0)))));
            case "builder.buildTransferCommands":
                return jsonValue(TransferCommands.buildTransferCommands(
                        transferOptions(json(a.path(0)))));

            default:
                throw new ManifestError("no dispatch for a supported capability: " + cap);
        }
    }

    static Produced constant(String name) {
        if (name.equals("DISPOSITIONS")) {
            return Produced.value(textListValue(PeriodAuditDocuments.DISPOSITIONS));
        }
        String v = CONSTANTS.get(name);
        if (v == null) {
            throw new ManifestError("unsupported constant reached dispatch: " + name);
        }
        return Produced.value(textValue(v));
    }

    // ------------------------------------------------------- argument decode

    static String str0(Json args, int i) {
        return strArg(args.path(i));
    }

    static String strArg(Json v) {
        String t = v.path("t").asText();
        return switch (t) {
            case "text", "party", "hex64", "raw", "dec", "int", "micros" -> v.path("v").asText();
            case "null" -> throw new StaticTypeRefusal("null where a String is required");
            default -> throw new ManifestError("cannot read a String from a " + t + " value");
        };
    }

    static long longArg(Json v) {
        String t = v.path("t").asText();
        return switch (t) {
            case "int", "micros" -> {
                String text = v.path("v").asText();
                try {
                    yield Long.parseLong(text);
                } catch (NumberFormatException e) {
                    throw new StaticTypeRefusal("no long can represent " + text);
                }
            }
            case "bool" -> throw new StaticTypeRefusal(
                    "ArccadeDigest.canonInt(long) has no overload accepting a boolean");
            default -> throw new ManifestError("cannot read a long from a " + t + " value");
        };
    }

    /** True for an integer the manifest itself flags as wider than an int64. */
    static boolean isWide(Json v) {
        return v.path("wide").asText().equals("true");
    }

    static BigInteger bigIntArg(Json v) {
        return new BigInteger(v.path("v").asText());
    }

    static boolean boolArg(Json v) {
        if (!v.path("t").asText().equals("bool")) {
            throw new ManifestError("cannot read a boolean from a " + v.path("t").asText() + " value");
        }
        return v.path("v").asText().equals("true");
    }

    /**
     * An amount argument. See COERCIONS: this is the whole of the policy.
     *
     * <p>A float64 is NOT converted. It is handed to amountUnits(double), which
     * refuses — the overload exists precisely so that this decoder does not
     * have to pick a conversion and then own the answer.
     */
    static Produced amountArg(Json v, boolean asDocument) {
        String t = v.path("t").asText();
        return switch (t) {
            case "dec", "int", "text", "null" -> {
                String text = v.path("t").asText().equals("null") ? null : v.path("v").asText();
                yield asDocument
                        ? Produced.text(ArccadeDigest.canonDecimal(text))
                        : Produced.value(intValue(ArccadeDigest.amountUnits(text)));
            }
            case "float64" -> {
                double d = Double.longBitsToDouble(
                        Long.parseUnsignedLong(v.path("v").path("bits").asText(), 16));
                yield asDocument
                        ? Produced.text(ArccadeDigest.canonDecimal(d))
                        : Produced.value(intValue(ArccadeDigest.amountUnits(d)));
            }
            case "bool" -> throw new StaticTypeRefusal(
                    "ArccadeDigest.amountUnits has no overload accepting a boolean");
            default -> throw new ManifestError("cannot read an amount from a " + t + " value");
        };
    }

    static List<String> stringList(Json v) {
        if (!v.path("t").asText().equals("list")) {
            throw new ManifestError("expected a list, got " + v.path("t").asText());
        }
        List<String> out = new ArrayList<>();
        for (Json e : v.path("v")) {
            out.add(strArg(e));
        }
        return out;
    }

    static List<Map.Entry<String, String>> fieldList(Json v) {
        if (!v.path("t").asText().equals("pairs")) {
            throw new ManifestError("expected pairs, got " + v.path("t").asText());
        }
        List<Map.Entry<String, String>> out = new ArrayList<>();
        for (Json pair : v.path("v")) {
            // Map.entry rejects nulls, and a field name must be able to be "",
            // so the entry is built by hand rather than via ArccadeDigest.f.
            String name = strArg(pair.path(0));
            String value = strArg(pair.path(1));
            out.add(new java.util.AbstractMap.SimpleImmutableEntry<>(name, value));
        }
        return out;
    }

    static List<MerkleStep> stepList(Json v) {
        if (!v.path("t").asText().equals("steps")) {
            throw new ManifestError("expected steps, got " + v.path("t").asText());
        }
        List<MerkleStep> out = new ArrayList<>();
        for (Json s : v.path("v")) {
            out.add(new MerkleStep(s.path("siblingOnLeft").asText().equals("true"),
                    s.path("sibling").asText()));
        }
        return out;
    }

    static List<Json> transactions(Json v) {
        if (!v.path("t").asText().equals("list")) {
            throw new ManifestError("expected a list of transactions, got " + v.path("t").asText());
        }
        List<Json> out = new ArrayList<>();
        for (Json e : v.path("v")) {
            if (!e.path("t").asText().equals("json")) {
                throw new ManifestError("expected a json value, got " + e.path("t").asText());
            }
            out.add(e.path("v"));
        }
        return out;
    }

    static final List<String> ROW_LONGS = List.of("concurrencyIndex", "committedUnits", "feeUnits",
            "returnedUnits", "forfeitedUnits", "payoutUnits", "committedAtMicros", "settledAtMicros");

    static CycleAuditRow rowArg(Json v) {
        if (!v.path("t").asText().equals("record")
                || !v.path("v").path("schema").asText().equals("cycle-audit-row")) {
            throw new ManifestError("expected a cycle-audit-row record");
        }
        Json f = v.path("v").path("fields");
        return new CycleAuditRow(
                f.path("cycleId").path("v").asText(),
                f.path("player").path("v").asText(),
                f.path("gameCode").path("v").asText(),
                rowLong(f, "concurrencyIndex"),
                f.path("entryDigest").path("v").asText(),
                f.path("outcomeDigest").path("v").asText(),
                rowLong(f, "committedUnits"),
                rowLong(f, "feeUnits"),
                rowLong(f, "returnedUnits"),
                rowLong(f, "forfeitedUnits"),
                rowLong(f, "payoutUnits"),
                f.path("disposition").path("v").asText(),
                rowLong(f, "committedAtMicros"),
                rowLong(f, "settledAtMicros"),
                f.path("custodyTag").path("v").asText());
    }

    // A row field that is not integral -- "100.0" where units belong -- throws
    // NumberFormatException here, which the map classes bad-format. That is the
    // forged-row-amount-as-decimal case, and refusing it in the decoder is
    // correct: CycleAuditRow has no representation for it.
    static long rowLong(Json fields, String name) {
        return Long.parseLong(fields.path(name).path("v").asText());
    }

    // ------------------------------------------- typed carriers -> SDK types

    /** The {"t":"json"} payload a builder case carries, unwrapped. */
    static Json json(Json v) {
        if (!v.path("t").asText().equals("json")) {
            throw new ManifestError("expected a json value, got " + v.path("t").asText());
        }
        return v.path("v");
    }

    /**
     * A field of a plain JSON options object, or null when ABSENT.
     *
     * <p>Absent stays null all the way into the SDK. Supplying this runner's own
     * default would answer a question the case is asking: whether the client
     * refuses a missing feeAmount or invents one.
     */
    static String field(Json o, String name) {
        Json v = o.path(name);
        return v.isMissing() || v.isNull() ? null : v.asText();
    }

    static List<String> fieldList(Json o, String name) {
        Json v = o.path(name);
        if (v.isMissing() || v.isNull()) {
            return null;
        }
        List<String> out = new ArrayList<>();
        for (Json e : v) {
            out.add(e.asText());
        }
        return out;
    }

    static Map<String, String> fieldMap(Json o, String name) {
        Json v = o.path(name);
        if (v.isMissing() || v.isNull()) {
            return null;
        }
        Map<String, String> out = new LinkedHashMap<>();
        for (String key : v.names()) {
            out.put(key, v.path(key).asText());
        }
        return out;
    }

    static InstrumentId instrumentOf(Json o) {
        return new InstrumentId(o.path("admin").asText(), o.path("id").asText());
    }

    /** The {"t":"record","v":{"schema":"instrument-id"}} carrier. */
    static InstrumentId instrumentArg(Json v) {
        Json f = recordFields(v, "instrument-id");
        return new InstrumentId(f.path("admin").path("v").asText(),
                f.path("id").path("v").asText());
    }

    static Json recordFields(Json v, String schema) {
        if (!v.path("t").asText().equals("record")
                || !v.path("v").path("schema").asText().equals(schema)) {
            throw new ManifestError("expected a " + schema + " record, got "
                    + v.path("t").asText() + "/" + v.path("v").path("schema").asText());
        }
        return v.path("v").path("fields");
    }

    static TradeLeg legArg(Json v) {
        Json f = recordFields(v, "trade-leg");
        return TradeCommands.leg(
                f.path("sender").path("v").asText(),
                f.path("receiver").path("v").asText(),
                instrumentArg(f.path("instrumentId")),
                f.path("amount").path("v").asText());
    }

    /** An ordered leg map from a pairs carrier; the order is the case's own. */
    static Map<String, TradeLeg> legMap(Json v) {
        if (!v.path("t").asText().equals("pairs")) {
            throw new ManifestError("expected pairs of legs, got " + v.path("t").asText());
        }
        Map<String, TradeLeg> out = new LinkedHashMap<>();
        for (Json pair : v.path("v")) {
            out.put(pair.path(0).path("v").asText(), legArg(pair.path(1)));
        }
        return out;
    }

    static Map<String, String> textPairs(Json v) {
        Map<String, String> out = new LinkedHashMap<>();
        if (v.isMissing() || v.path("v").isMissing()) {
            return out;
        }
        for (Json pair : v.path("v")) {
            out.put(pair.path(0).path("v").asText(), pair.path(1).path("v").asText());
        }
        return out;
    }

    static TradeCommands.Trade tradeArg(Json v) {
        Json f = recordFields(v, "trade");
        String taker = f.path("taker").path("t").asText().equals("null")
                ? null : f.path("taker").path("v").asText();
        return new TradeCommands.Trade(
                f.path("tradeId").path("v").asText(),
                f.path("maker").path("v").asText(),
                taker,
                legMap(f.path("legs")),
                f.path("expiresAt").path("v").asText(),
                textPairs(f.path("meta")));
    }

    static TransferCommands.Transfer transferArg(Json v) {
        Json f = recordFields(v, "transfer");
        List<Recipient> recipients = new ArrayList<>();
        for (Json r : f.path("recipients").path("v")) {
            Json rf = recordFields(r, "transfer-recipient");
            recipients.add(new Recipient(
                    rf.path("receiver").path("v").asText(),
                    rf.path("amount").path("v").asText(),
                    instrumentArg(rf.path("instrumentId"))));
        }
        return new TransferCommands.Transfer(
                f.path("transferId").path("v").asText(),
                f.path("sender").path("v").asText(),
                f.path("reason").path("v").asText(),
                recipients,
                textPairs(f.path("meta")));
    }

    /**
     * Attribute pairs. A float64 attribute is handed over AS a Double, so the
     * SDK's own type check is what refuses it rather than this decoder.
     */
    static List<Assets.Attribute> attributeList(Json v) {
        if (!v.path("t").asText().equals("pairs")) {
            throw new ManifestError("expected attribute pairs, got " + v.path("t").asText());
        }
        List<Assets.Attribute> out = new ArrayList<>();
        for (Json pair : v.path("v")) {
            String name = pair.path(0).path("v").asText();
            Json value = pair.path(1);
            Object raw = switch (value.path("t").asText()) {
                case "int" -> Long.valueOf(value.path("v").asText());
                case "text" -> value.path("v").asText();
                case "float64" -> Double.valueOf(Double.longBitsToDouble(
                        Long.parseUnsignedLong(value.path("v").path("bits").asText(), 16)));
                default -> throw new ManifestError(
                        "cannot read an attribute from a " + value.path("t").asText() + " value");
            };
            out.add(Assets.Attribute.of(name, raw));
        }
        return out;
    }

    static VenuePolicy policyArg(Json v) {
        Json f = recordFields(v, "venue-policy");
        return new VenuePolicy(
                f.path("min-stake-amount").path("v").asText(),
                f.path("max-stake-amount").path("v").asText(),
                f.path("min-platform-fee").path("v").asText(),
                f.path("max-payout-amount").path("v").asText(),
                policyLong(f, "min-lock-seconds"),
                policyLong(f, "max-lock-seconds"),
                policyLong(f, "min-cycle-seconds"),
                policyLong(f, "max-cycle-seconds"),
                policyLong(f, "cooldown-seconds"),
                policyLong(f, "abort-cooldown-seconds"),
                policyLong(f, "concurrency-limit"),
                f.path("require-custody-proof").path("v").asText().equals("true"));
    }

    static long policyLong(Json fields, String name) {
        return Long.parseLong(fields.path(name).path("v").asText());
    }

    static Settlement settlementArg(Json v) {
        Json f = recordFields(v, "settlement");
        return new Settlement(
                f.path("disposition").path("v").asText(),
                policyLong(f, "stakeUnits"),
                policyLong(f, "returnedUnits"),
                policyLong(f, "forfeitedUnits"),
                policyLong(f, "payoutUnits"),
                policyLong(f, "maxPayoutUnits"));
    }

    static PeriodAnchor anchorArg(Json v) {
        Json f = recordFields(v, "period-anchor");
        return new PeriodAnchor(
                f.path("venueId").path("v").asText(),
                f.path("periodId").path("v").asText(),
                policyLong(f, "periodStartMicros"),
                policyLong(f, "periodEndMicros"),
                policyLong(f, "cycleCount"),
                policyLong(f, "committedUnits"),
                policyLong(f, "feeUnits"),
                policyLong(f, "returnedUnits"),
                policyLong(f, "forfeitedUnits"),
                policyLong(f, "payoutUnits"),
                policyLong(f, "qualifyingTxCount"),
                policyLong(f, "nonQualifyingTxCount"),
                f.path("merkleRootHex").path("v").asText(),
                f.path("reportDigest").path("v").asText(),
                f.path("prevAnchorDigest").path("v").asText());
    }

    static List<CycleAuditRow> rowList(Json v) {
        if (!v.path("t").asText().equals("list")) {
            throw new ManifestError("expected a list of rows, got " + v.path("t").asText());
        }
        List<CycleAuditRow> out = new ArrayList<>();
        for (Json e : v.path("v")) {
            out.add(rowArg(e));
        }
        return out;
    }

    // ------------------------------------------------ builder option records

    static CycleCommands.CommitOptions commitOptions(Json o) {
        return new CycleCommands.CommitOptions(
                field(o, "sdkPackageId"), field(o, "amuletPackageId"), field(o, "venue"),
                field(o, "operator"), field(o, "player"), field(o, "entitlementCid"),
                field(o, "gameCode"), field(o, "cycleId"), field(o, "entryDigest"),
                field(o, "stakeAmount"), field(o, "feeAmount"),
                instrumentOf(o.path("instrumentId")), field(o, "lockExpiresAt"),
                field(o, "amuletRulesCid"), field(o, "openMiningRoundCid"),
                fieldList(o, "inputAmuletCids"), field(o, "dsoParty"), field(o, "commandId"),
                fieldMap(o, "stakeMeta"));
    }

    static CycleCommands.DryRunCommitOptions dryRunOptions(Json o) {
        return new CycleCommands.DryRunCommitOptions(
                field(o, "sdkPackageId"), field(o, "venue"), field(o, "operator"),
                field(o, "player"), field(o, "entitlementCid"), field(o, "gameCode"),
                field(o, "cycleId"), field(o, "entryDigest"), field(o, "stakeAmount"),
                instrumentOf(o.path("instrumentId")), field(o, "lockExpiresAt"),
                field(o, "commandId"), fieldMap(o, "stakeMeta"));
    }

    static CycleCommands.SettleOptions settleOptions(Json o) {
        return new CycleCommands.SettleOptions(
                field(o, "sdkPackageId"), field(o, "amuletPackageId"), field(o, "venue"),
                field(o, "operator"), field(o, "player"), field(o, "stakeCid"),
                field(o, "lockedAmuletCid"), field(o, "disposition"), field(o, "returnedAmount"),
                field(o, "forfeitedAmount"), field(o, "payoutAmount"), field(o, "outcomeDocument"),
                field(o, "outcomeDigest"),
                !o.has("revealOutcome") || o.path("revealOutcome").asText().equals("true"),
                field(o, "revealedEntry"), field(o, "commandId"), fieldMap(o, "settlementMeta"));
    }

    static CycleCommands.AbortOptions abortOptions(Json o) {
        return new CycleCommands.AbortOptions(
                field(o, "sdkPackageId"), field(o, "venue"), field(o, "operator"),
                field(o, "player"), field(o, "stakeCid"), field(o, "reason"),
                field(o, "lockedAmuletCid"), field(o, "commandId"));
    }

    static CycleCommands.ExpireOptions expireOptions(Json o) {
        return new CycleCommands.ExpireOptions(
                field(o, "sdkPackageId"), field(o, "amuletPackageId"), field(o, "player"),
                field(o, "stakeCid"), field(o, "lockedAmuletCid"), field(o, "commandId"));
    }

    static TradeCommands.ProposalOptions proposalOptions(Json o) {
        Map<String, TradeLeg> legs = new LinkedHashMap<>();
        for (String key : o.path("legs").names()) {
            Json l = o.path("legs").path(key);
            legs.put(key, TradeCommands.leg(l.path("sender").asText(), l.path("receiver").asText(),
                    instrumentOf(l.path("instrumentId")), l.path("amount").asText()));
        }
        return new TradeCommands.ProposalOptions(
                field(o, "sdkPackageId"), field(o, "venue"), field(o, "maker"), field(o, "taker"),
                field(o, "tradeId"), legs, field(o, "expiresAt"), field(o, "settleBefore"),
                field(o, "commandId"), fieldMap(o, "meta"));
    }

    static TradeCommands.SettleOptions tradeSettleOptions(Json o) {
        return new TradeCommands.SettleOptions(
                field(o, "sdkPackageId"), field(o, "venue"), field(o, "maker"), field(o, "taker"),
                field(o, "tradeCid"), fieldMap(o, "allocations"), field(o, "commandId"));
    }

    static TradeCommands.CancelOptions tradeCancelOptions(Json o) {
        return new TradeCommands.CancelOptions(
                field(o, "sdkPackageId"), field(o, "venue"), field(o, "tradeCid"),
                field(o, "reason"), field(o, "commandId"));
    }

    static TransferCommands.TransferOptions transferOptions(Json o) {
        List<Recipient> recipients = new ArrayList<>();
        for (Json r : o.path("recipients")) {
            recipients.add(new Recipient(r.path("receiver").asText(), r.path("amount").asText(),
                    instrumentOf(r.path("instrumentId"))));
        }
        return new TransferCommands.TransferOptions(
                field(o, "amuletPackageId"), field(o, "sender"), field(o, "provider"), recipients,
                fieldList(o, "inputAmuletCids"), field(o, "amuletRulesCid"),
                field(o, "openMiningRoundCid"), field(o, "dsoParty"), field(o, "transferId"),
                field(o, "reason"), field(o, "commandId"), fieldMap(o, "meta"));
    }

    // -------------------------------------------------- neutral value encode

    static String intValue(long v) {
        return "{\"t\":\"int\",\"v\":" + str(Long.toString(v)) + "}";
    }

    static String textValue(String v) {
        return "{\"t\":\"text\",\"v\":" + str(v) + "}";
    }

    static String boolValue(boolean v) {
        return "{\"t\":\"bool\",\"v\":" + v + "}";
    }

    static String partyValue(String v) {
        return "{\"t\":\"party\",\"v\":" + str(v) + "}";
    }

    /** Text, or the neutral null. The two must not collapse into "". */
    static String nullableText(String v) {
        return v == null ? "{\"t\":\"null\"}" : textValue(v);
    }

    static String pair(String name, String value) {
        return "[" + textValue(name) + "," + value + "]";
    }

    static String pairs(String... entries) {
        return "{\"t\":\"pairs\",\"v\":[" + String.join(",", entries) + "]}";
    }

    static String listValue(List<String> encodedElements) {
        return "{\"t\":\"list\",\"v\":[" + String.join(",", encodedElements) + "]}";
    }

    static String instrumentValue(InstrumentId id) {
        return pairs(pair("admin", partyValue(id.admin())), pair("id", textValue(id.id())));
    }

    /**
     * A built ledger payload, as a neutral json value.
     *
     * <p>Serialised with object keys SORTED so that comparison is a string
     * equality over a canonical form. Field order is not part of the Ledger
     * API's contract — the ledger parses JSON — so pinning it would fail this
     * client for a difference no ledger can observe. Array order IS preserved,
     * because the order of commands in a submission is exactly the thing WRITE 2
     * depends on.
     */
    static Produced jsonValue(Json built) {
        return Produced.value("{\"t\":\"json\",\"v\":" + canonicalJson(built) + "}");
    }

    static String canonicalJson(Json n) {
        switch (n.kind()) {
            case STRING:
                return str(n.asText());
            case NUMBER:
            case BOOLEAN:
                return n.asText();
            case NULL:
            case MISSING:
                return "null";
            case ARRAY: {
                List<String> out = new ArrayList<>();
                for (Json e : n) {
                    out.add(canonicalJson(e));
                }
                return "[" + String.join(",", out) + "]";
            }
            default: {
                Map<String, String> sorted = new TreeMap<>();
                for (String name : n.names()) {
                    sorted.put(name, canonicalJson(n.path(name)));
                }
                List<String> out = new ArrayList<>();
                for (Map.Entry<String, String> e : sorted.entrySet()) {
                    out.add(str(e.getKey()) + ":" + e.getValue());
                }
                return "{" + String.join(",", out) + "}";
            }
        }
    }

    static String textListValue(List<String> items) {
        StringBuilder sb = new StringBuilder("{\"t\":\"list\",\"v\":[");
        for (int i = 0; i < items.size(); i++) {
            sb.append(i == 0 ? "" : ",").append(textValue(items.get(i)));
        }
        return sb.append("]}").toString();
    }

    static String hexListValue(List<String> items) {
        StringBuilder sb = new StringBuilder("{\"t\":\"list\",\"v\":[");
        for (int i = 0; i < items.size(); i++) {
            sb.append(i == 0 ? "" : ",").append("{\"t\":\"hex64\",\"v\":").append(str(items.get(i))).append('}');
        }
        return sb.append("]}").toString();
    }

    static String stepsValue(List<MerkleStep> steps) {
        StringBuilder sb = new StringBuilder("{\"t\":\"steps\",\"v\":[");
        for (int i = 0; i < steps.size(); i++) {
            sb.append(i == 0 ? "" : ",")
                    .append("{\"sibling\":").append(str(steps.get(i).sibling()))
                    .append(",\"siblingOnLeft\":").append(steps.get(i).siblingOnLeft()).append('}');
        }
        return sb.append("]}").toString();
    }

    /** Record fields are emitted in sorted order; so are the manifest's. */
    static String rowValue(CycleAuditRow r) {
        Map<String, String> fields = new TreeMap<>();
        fields.put("cycleId", textValue(r.cycleId()));
        fields.put("player", "{\"t\":\"party\",\"v\":" + str(r.player()) + "}");
        fields.put("gameCode", textValue(r.gameCode()));
        fields.put("concurrencyIndex", intValue(r.concurrencyIndex()));
        fields.put("entryDigest", textValue(r.entryDigest()));
        fields.put("outcomeDigest", textValue(r.outcomeDigest()));
        fields.put("committedUnits", intValue(r.committedUnits()));
        fields.put("feeUnits", intValue(r.feeUnits()));
        fields.put("returnedUnits", intValue(r.returnedUnits()));
        fields.put("forfeitedUnits", intValue(r.forfeitedUnits()));
        fields.put("payoutUnits", intValue(r.payoutUnits()));
        fields.put("disposition", textValue(r.disposition()));
        fields.put("committedAtMicros", intValue(r.committedAtMicros()));
        fields.put("settledAtMicros", intValue(r.settledAtMicros()));
        fields.put("custodyTag", textValue(r.custodyTag()));
        StringBuilder sb = new StringBuilder("{\"t\":\"record\",\"v\":{\"schema\":\"cycle-audit-row\",\"fields\":{");
        boolean first = true;
        for (Map.Entry<String, String> e : fields.entrySet()) {
            sb.append(first ? "" : ",").append(str(e.getKey())).append(':').append(e.getValue());
            first = false;
        }
        return sb.append("}}}").toString();
    }

    /**
     * The manifest's expected value, rewritten into exactly the form the encoders
     * above produce: vHex dropped (it was verified up front), record fields
     * sorted, steps keys in a fixed order. Comparison is then a string equality
     * over a canonical form rather than a structural walk that could quietly
     * treat two different shapes as equal.
     */
    static String normalize(Json v) {
        String t = v.path("t").asText();
        switch (t) {
            case "text", "party", "hex64", "raw", "dec", "int", "micros":
                return "{\"t\":" + str(t) + ",\"v\":" + str(v.path("v").asText()) + "}";
            case "bool":
                return "{\"t\":\"bool\",\"v\":" + v.path("v").asText() + "}";
            case "null":
                return "{\"t\":\"null\"}";
            case "list": {
                StringBuilder sb = new StringBuilder("{\"t\":\"list\",\"v\":[");
                boolean first = true;
                for (Json e : v.path("v")) {
                    sb.append(first ? "" : ",").append(normalize(e));
                    first = false;
                }
                return sb.append("]}").toString();
            }
            case "pairs": {
                StringBuilder sb = new StringBuilder("{\"t\":\"pairs\",\"v\":[");
                boolean first = true;
                for (Json e : v.path("v")) {
                    sb.append(first ? "" : ",").append('[')
                            .append(normalize(e.path(0))).append(',')
                            .append(normalize(e.path(1))).append(']');
                    first = false;
                }
                return sb.append("]}").toString();
            }
            case "record": {
                Map<String, String> fields = new TreeMap<>();
                Json f = v.path("v").path("fields");
                for (String name : f.names()) {
                    fields.put(name, normalize(f.path(name)));
                }
                StringBuilder sb = new StringBuilder("{\"t\":\"record\",\"v\":{\"schema\":")
                        .append(str(v.path("v").path("schema").asText())).append(",\"fields\":{");
                boolean first = true;
                for (Map.Entry<String, String> e : fields.entrySet()) {
                    sb.append(first ? "" : ",").append(str(e.getKey())).append(':').append(e.getValue());
                    first = false;
                }
                return sb.append("}}}").toString();
            }
            case "steps": {
                StringBuilder sb = new StringBuilder("{\"t\":\"steps\",\"v\":[");
                boolean first = true;
                for (Json e : v.path("v")) {
                    sb.append(first ? "" : ",")
                            .append("{\"sibling\":").append(str(e.path("sibling").asText()))
                            .append(",\"siblingOnLeft\":").append(e.path("siblingOnLeft").asText())
                            .append('}');
                    first = false;
                }
                return sb.append("]}").toString();
            }
            case "json":
                // The one place the manifest carries the Ledger API's own shape
                // rather than a neutral value. Canonicalised the same way the
                // produced side is, so the comparison is over one form.
                return "{\"t\":\"json\",\"v\":" + canonicalJson(v.path("v")) + "}";
            default:
                throw new ManifestError("cannot normalize an expected value of type " + t);
        }
    }

    // ------------------------------------------------------- manifest checks

    /**
     * Where a value carries both its text and its bytes, they must agree. A
     * mismatch is exit 2 and not a case failure: it means the file cannot be
     * trusted to say what it claims, so no verdict from it would mean anything.
     */
    static int assertVHexAgreesWithV(Json node) {
        int[] n = {0};
        walkVHex(node, n);
        return n[0];
    }

    static void walkVHex(Json node, int[] n) {
        if (node.isObject()) {
            if (node.path("vHex").isString() && node.path("v").isString()) {
                String v = node.path("v").asText();
                String hex = node.path("vHex").asText();
                String decoded = new String(hexBytes(hex), StandardCharsets.UTF_8);
                if (!decoded.equals(v)) {
                    throw new ManifestError("vHex does not decode to v: " + hex);
                }
                n[0]++;
            }
            for (String name : node.names()) {
                walkVHex(node.path(name), n);
            }
        } else if (node.isArray()) {
            for (Json e : node) {
                walkVHex(e, n);
            }
        }
    }

    /**
     * No JSON number may appear under input or expect. The one exception is
     * inside a {"t":"json"} value, which carries the Ledger API's own shape.
     */
    static void assertNoJsonNumbersInCases(Json manifest) {
        for (Json g : manifest.path("groups")) {
            for (Json c : g.path("cases")) {
                noNumbers(c.path("input"), c.path("id").asText() + ".input");
                noNumbers(c.path("expect"), c.path("id").asText() + ".expect");
            }
        }
    }

    static void noNumbers(Json node, String where) {
        if (node.isNumber()) {
            throw new ManifestError("JSON number at " + where + " (value " + node.asText() + ")");
        }
        if (node.isObject()) {
            if (node.path("t").asText().equals("json")) {
                return; // the ledger's shape, not ours
            }
            for (String name : node.names()) {
                noNumbers(node.path(name), where + "." + name);
            }
        } else if (node.isArray()) {
            int i = 0;
            for (Json e : node) {
                noNumbers(e, where + "[" + i++ + "]");
            }
        }
    }

    // ------------------------------------------------------------- reporting

    static String headerRecord(String manifestSha) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"rec\":\"runner\",\"schema\":").append(str(SCHEMA))
                .append(",\"language\":\"java\"")
                .append(",\"implementation\":").append(str(IMPLEMENTATION))
                .append(",\"runtime\":").append(str("java " + System.getProperty("java.version")
                        + " (" + System.getProperty("java.vendor") + ")"))
                .append(",\"manifestSha256\":").append(str(manifestSha))
                .append(",\"profilesDeclared\":[");
        for (int i = 0; i < PROFILES_DECLARED.size(); i++) {
            sb.append(i == 0 ? "" : ",").append(str(PROFILES_DECLARED.get(i)));
        }
        sb.append("],\"traits\":").append(jsonOfBoolMap(TRAITS)).append(",\"rejectMap\":[");
        for (int i = 0; i < REJECT_MAP.size(); i++) {
            RejectRule r = REJECT_MAP.get(i);
            sb.append(i == 0 ? "" : ",")
                    .append("{\"group\":").append(str(r.group()))
                    .append(",\"type\":").append(str(r.type()))
                    .append(",\"contains\":").append(str(r.contains()))
                    .append(",\"class\":").append(str(r.cls())).append('}');
        }
        sb.append("],\"coercions\":{");
        boolean first = true;
        for (Map.Entry<String, String> e : COERCIONS.entrySet()) {
            sb.append(first ? "" : ",").append(str(e.getKey())).append(':').append(str(e.getValue()));
            first = false;
        }
        return sb.append("}}").toString();
    }

    static String caseRecord(String id, String group, String cap, String profile,
                             Json c, CaseResult r) {
        return "{\"rec\":\"case\",\"id\":" + str(id)
                + ",\"group\":" + str(group)
                + ",\"capability\":" + str(cap)
                + ",\"profile\":" + str(profile)
                + ",\"status\":" + str(r.status())
                + ",\"expected\":" + reserialize(c.path("expect"))
                + ",\"observed\":" + r.observedJson() + "}";
    }

    /**
     * The declared profiles with the case count each one selects HERE. Counted
     * by {@link #casesPerProfile}, the same function the reachability check
     * uses and the same field selection reads, so this listing cannot claim a
     * profile is reachable while the selector disagrees. run-all.sh compares
     * the three runners' answers against the manifest.
     */
    static void printProfileCoverage(Json manifest) {
        Map<String, Integer> counts = casesPerProfile(manifest);
        StringBuilder sb = new StringBuilder("{\"language\":\"java\",\"profiles\":[");
        boolean first = true;
        for (String p : PROFILES_DECLARED) {
            sb.append(first ? "" : ",")
                    .append("{\"profile\":").append(str(p))
                    .append(",\"cases\":").append(str(String.valueOf(counts.get(p))))
                    .append(",\"description\":")
                    .append(str(manifest.path("profiles").path(p).asText("")))
                    .append('}');
            first = false;
        }
        System.out.println(sb.append("]}").toString());
    }

    static void printCapabilityCoverage(Json manifest) {
        StringBuilder sb = new StringBuilder("{\"language\":\"java\",\"capabilities\":[");
        boolean first = true;
        for (Json cap : manifest.path("capabilities")) {
            String id = cap.path("id").asText();
            boolean supported = SUPPORTED.contains(id);
            sb.append(first ? "" : ",")
                    .append("{\"id\":").append(str(id))
                    .append(",\"profile\":").append(str(cap.path("profile").asText()))
                    .append(",\"supported\":").append(supported)
                    .append(",\"catalogSaysJava\":").append(cap.path("impl").path("java").isNull()
                            || cap.path("impl").path("java").isMissing()
                            ? "null" : str(cap.path("impl").path("java").asText()))
                    .append('}');
            first = false;
        }
        System.out.println(sb.append("]}").toString());
    }

    // ------------------------------------------------------------ JSON bits

    /** Re-serialises a manifest subtree deterministically, in document order. */
    static String reserialize(Json n) {
        switch (n.kind()) {
            case STRING:
                return str(n.asText());
            case NUMBER:
            case BOOLEAN:
                return n.asText();
            case NULL:
            case MISSING:
                return "null";
            case ARRAY: {
                StringBuilder sb = new StringBuilder("[");
                boolean first = true;
                for (Json e : n) {
                    sb.append(first ? "" : ",").append(reserialize(e));
                    first = false;
                }
                return sb.append(']').toString();
            }
            default: {
                StringBuilder sb = new StringBuilder("{");
                boolean first = true;
                for (String name : n.names()) {
                    sb.append(first ? "" : ",").append(str(name)).append(':')
                            .append(reserialize(n.path(name)));
                    first = false;
                }
                return sb.append('}').toString();
            }
        }
    }

    static String jsonOfBoolMap(Map<String, Boolean> m) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Boolean> e : m.entrySet()) {
            sb.append(first ? "" : ",").append(str(e.getKey())).append(':').append(e.getValue());
            first = false;
        }
        return sb.append('}').toString();
    }

    static String str(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.append('"').toString();
    }

    static byte[] hexBytes(String hex) {
        if (hex.length() % 2 != 0) {
            throw new ManifestError("odd-length hex: " + hex);
        }
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(hex.charAt(2 * i), 16);
            int lo = Character.digit(hex.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) {
                throw new ManifestError("not hex: " + hex);
            }
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    static String utf8Hex(String s) {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) {
            sb.append(Character.forDigit((x >> 4) & 0xF, 16)).append(Character.forDigit(x & 0xF, 16));
        }
        return sb.toString();
    }

    static String sha256Hex(byte[] bytes) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte x : d) {
                sb.append(Character.forDigit((x >> 4) & 0xF, 16)).append(Character.forDigit(x & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private Runner() {
    }
}
