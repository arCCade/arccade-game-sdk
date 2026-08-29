package io.arccade.gamesdk;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static io.arccade.gamesdk.ArccadeDigest.canonDecimal;
import static io.arccade.gamesdk.ArccadeDigest.canonFields;
import static io.arccade.gamesdk.ArccadeDigest.canonInt;
import static io.arccade.gamesdk.ArccadeDigest.canonList;
import static io.arccade.gamesdk.ArccadeDigest.canonText;
import static io.arccade.gamesdk.ArccadeDigest.f;

/**
 * The two documents a Pixel Race cycle commits to.
 *
 * <p>Entry is committed before play and settles nothing on its own; outcome is
 * revealed at settlement, where {@code GameStake_Settle} recomputes both
 * digests on-ledger. The field sets mirror
 * {@code ArCCade.GameSdk.Games.PixelRace} exactly — a field added on one side
 * only changes the digest and makes the stake unsettleable.
 */
public final class PixelRaceDocuments {

    public static final String GAME_CODE = "pixel-race-v1";
    public static final String ENTRY_SCHEMA = "arccade-pixel-race-entry";
    public static final String OUTCOME_SCHEMA = "arccade-pixel-race-outcome";
    public static final int SCHEMA_VERSION = 1;

    private PixelRaceDocuments() {
    }

    /** What the player commits to before the session starts. */
    public record Entry(String cycleId, String tier, int maxGamesPerSession, String rngSeedCommit) {
    }

    /** One game within a session. */
    public record Play(int gameNumber, int score, int maxLevel, int coinsCollected,
                       int survivalSeconds) {
    }

    /** What the session produced, revealed at settlement. */
    public record Outcome(String cycleId, List<Play> plays, int totalScore, String rngSeed,
                          BigDecimal returnedAmount, BigDecimal forfeitedAmount,
                          BigDecimal xpAwarded) {
    }

    public static String entryDocument(Entry e) {
        return ArccadeDigest.canonDocument(ENTRY_SCHEMA, SCHEMA_VERSION, List.of(
                f("cycle-id", canonText(e.cycleId())),
                f("game-code", canonText(GAME_CODE)),
                f("max-games-per-session", canonInt(e.maxGamesPerSession())),
                f("rng-seed-commit", canonText(e.rngSeedCommit())),
                f("tier", canonText(e.tier()))));
    }

    public static String entryDigest(Entry e) {
        return ArccadeDigest.textDigest(entryDocument(e));
    }

    private static String canonPlay(Play p) {
        List<Map.Entry<String, String>> fields = List.of(
                f("coins-collected", canonInt(p.coinsCollected())),
                f("game-number", canonInt(p.gameNumber())),
                f("max-level", canonInt(p.maxLevel())),
                f("score", canonInt(p.score())),
                f("survival-seconds", canonInt(p.survivalSeconds())));
        return canonFields(fields);
    }

    public static String outcomeDocument(Outcome o) {
        List<String> plays = new ArrayList<>();
        for (Play p : o.plays()) {
            plays.add(canonPlay(p));
        }
        return ArccadeDigest.canonDocument(OUTCOME_SCHEMA, SCHEMA_VERSION, List.of(
                f("cycle-id", canonText(o.cycleId())),
                f("forfeited-amount", canonDecimal(o.forfeitedAmount())),
                f("game-code", canonText(GAME_CODE)),
                f("plays", canonList(plays)),
                f("returned-amount", canonDecimal(o.returnedAmount())),
                f("rng-seed", canonText(o.rngSeed())),
                f("total-score", canonInt(o.totalScore())),
                f("xp-awarded", canonDecimal(o.xpAwarded()))));
    }

    public static String outcomeDigest(Outcome o) {
        return ArccadeDigest.textDigest(outcomeDocument(o));
    }
}
