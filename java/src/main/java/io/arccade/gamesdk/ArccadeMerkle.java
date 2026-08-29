package io.arccade.gamesdk;

import java.util.ArrayList;
import java.util.List;

import static io.arccade.gamesdk.ArccadeDigest.canonText;
import static io.arccade.gamesdk.ArccadeDigest.documentDigest;
import static io.arccade.gamesdk.ArccadeDigest.f;

/**
 * Merkle tree behind the period anchor — the mechanism that lets an auditor
 * prove a cycle was OMITTED from a published report.
 *
 * <p>Mirrors {@code ArCCade.GameSdk.Digest} in the SDK. Copied in spirit from
 * {@code Splice.Amulet.CryptoHash} and never imported, so no splice-amulet
 * package id is pinned into anything.
 *
 * <p>{@code GameVenue_AnchorPeriod} recomputes the root on-ledger from the rows
 * it is handed, so this class does not decide what gets anchored. It exists so
 * the backend can check its own report against what the ledger will compute
 * BEFORE submitting, and so a JVM consumer can verify an inclusion proof.
 *
 * <h2>Two classic Merkle mistakes this avoids</h2>
 *
 * <ol>
 *   <li><b>A lone node is promoted, not duplicated.</b> Bitcoin's convention of
 *       pairing the last node with itself lets two DIFFERENT leaf sets produce
 *       the same root (CVE-2012-2459): {@code [a,b,c]} and {@code [a,b,c,c]}
 *       collide. Here the odd node moves up a level unchanged.</li>
 *   <li><b>Leaves and internal nodes hash under different schemas.</b> Note
 *       carefully where that protects: NOT inside {@link #merkleVerify}, which
 *       folds a hash and cannot know whether it started from a leaf or a node.
 *       The protection is that claiming leaf-hood means exhibiting a preimage,
 *       and a leaf's preimage is an {@code arccade.cycle-audit-row} document —
 *       so passing an internal node off as a cycle means finding a sha256
 *       collision across two schemas. Use
 *       {@link PeriodAuditDocuments#periodRowVerify}, which derives the leaf
 *       from the row, rather than {@link #merkleVerify} on a bare hash.</li>
 * </ol>
 *
 * <p>Golden vectors in {@code ArccadeMerkleTest} pin this against the Daml,
 * JavaScript and Python implementations. A divergence would not surface until
 * an auditor's proof failed to verify, which is the worst possible moment.
 */
public final class ArccadeMerkle {

    private ArccadeMerkle() {
    }

    /**
     * Root of an empty period.
     *
     * <p>A day with no cycles is still anchored — otherwise "nothing happened"
     * and "we did not report" are indistinguishable.
     */
    public static String merkleEmpty() {
        return documentDigest("arccade.merkle-empty", 1, List.of());
    }

    /** Internal node. Separate schema from leaves; see the class notes. */
    public static String merkleNode(String left, String right) {
        return documentDigest("arccade.merkle-node", 1,
                List.of(f("l", canonText(left)), f("r", canonText(right))));
    }

    /** Combines one level pairwise; a lone trailing node is PROMOTED. */
    public static List<String> merklePairUp(List<String> level) {
        List<String> out = new ArrayList<>((level.size() + 1) / 2);
        for (int i = 0; i < level.size(); i += 2) {
            out.add(i + 1 < level.size() ? merkleNode(level.get(i), level.get(i + 1)) : level.get(i));
        }
        return out;
    }

    public static String merkleRoot(List<String> leaves) {
        if (leaves.isEmpty()) {
            return merkleEmpty();
        }
        List<String> level = leaves;
        while (level.size() > 1) {
            level = merklePairUp(level);
        }
        return level.get(0);
    }

    /** One step of an inclusion proof: the sibling, and which side it is on. */
    public record MerkleStep(boolean siblingOnLeft, String sibling) {
    }

    /**
     * Inclusion proof for the leaf at {@code index}.
     *
     * <p>Publishing a root without shipping a way to produce proofs is half a
     * feature: an auditor left to build the proof themselves has to guess the
     * tree convention, including the promotion rule above.
     */
    public static List<MerkleStep> merkleProof(int index, List<String> leaves) {
        List<MerkleStep> steps = new ArrayList<>();
        if (index < 0 || index >= leaves.size()) {
            return steps;
        }
        List<String> level = leaves;
        int i = index;
        while (level.size() > 1) {
            int sibling = (i % 2 == 0) ? i + 1 : i - 1;
            // A promoted node has no sibling at this level.
            if (sibling < level.size()) {
                steps.add(new MerkleStep(i % 2 == 1, level.get(sibling)));
            }
            level = merklePairUp(level);
            i /= 2;
        }
        return steps;
    }

    /** Folds a proof from the leaf up to a root. */
    public static String merkleFold(String leaf, List<MerkleStep> steps) {
        String acc = leaf;
        for (MerkleStep s : steps) {
            acc = s.siblingOnLeft() ? merkleNode(s.sibling(), acc) : merkleNode(acc, s.sibling());
        }
        return acc;
    }

    /**
     * Whether a LEAF HASH sits under this root.
     *
     * <p>Prefer {@link PeriodAuditDocuments#periodRowVerify} when the claim is
     * "this cycle is in the report" — see the class notes on why verifying a
     * bare hash is weaker than verifying a row.
     */
    public static boolean merkleVerify(String leaf, List<MerkleStep> steps, String root) {
        return merkleFold(leaf, steps).equals(root);
    }
}
