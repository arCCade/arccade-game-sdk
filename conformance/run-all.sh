#!/usr/bin/env bash
#
# Drive every conformance runner over the IDENTICAL case set and compare what
# they said, case by case.
#
# The suite's headline claim is not "the tests pass" — the suite is expected to
# ship red — it is:
#
#     Two runners invoked with the same manifest and the same profiles MUST
#     produce byte-identical .verdicts files.
#
# Nothing in this repository performed that comparison. The three runners could
# not even be driven over one case set by one invocation shape: `--profiles all`
# was a Java-only spelling and exited 2 in the other two. Both are fixed here and
# in the runners; this script is where the claim becomes a check that can fail.
#
# WHAT FAILS THE BUILD, AND WHY IT IS NOT "ANY RED"
#
# Requiring three green runs would mean deleting the suite's whole premise: 15
# JavaScript cases disagree with a normative pin on purpose, Java implements
# five of the eight profiles and reports 189 cases `unsupported`, and every one
# of those is a recorded, argued decision. Requiring an empty three-way diff
# would fail for the same reason on day one and stay failing, which is a check
# nobody reads.
#
# So the unit that is frozen is the per-case VERDICT TRIPLE — (javascript,
# python, java) — for every case where the three runners are not unanimously
# `pass`. That set is written down below, and this script fails when the run
# does not reproduce it exactly:
#
#   UNRECORDED  a case went non-green, or the three stopped agreeing, and no
#               line below says so. This is the regression gate.
#   MOVED       a recorded case's triple changed. A `fail` becoming `pass` is
#               as much a change to review as the reverse: the suite records
#               that a stale pin is as misleading as a stale waiver.
#   STALE       a line below names a case that is now unanimously green, or a
#               case id the manifest no longer carries. A waiver nobody can
#               reach is a waiver nobody rechecks.
#
# The mechanism is deliberately dumb, and that is the argument for it. It does
# not infer which divergences are acceptable from the manifest's `decisions` and
# `divergences` — those record what JavaScript does against a pin, and a gate
# that inferred a waiver from them would be inventing one. Every line below had
# to be written by someone re-freezing the file, and re-freezing shows up as a
# diff in review with the case ids spelled out.
#
# There is ONE thing this script does read out of the manifest, and it reads it
# to refute it rather than to excuse anything: `decisions[].goesRed`, the list
# of clients each normative pin claims to be violated by. `generate.mjs` can
# only measure the JavaScript half of that claim — it imports the JavaScript
# package entry point and cannot import the other two — so the Python and Java
# halves went unchecked for as long as they existed, and six decisions named
# Python and three named Java while both clients had already adopted the pin.
# This script has all three .verdicts files, so it is the place that closes it:
# for every decision, the set of languages actually red on its cases must equal
# `goesRed`, in both directions. A stale claim and a silent one both fail.
#
# What it does NOT catch, stated so nobody assumes otherwise: a divergence that
# was already present when the baseline was taken and is wrong. The `why` column
# is documentation for the reviewer, not a check — the frozen triple is the
# check. `generate.mjs --check` is what holds the JavaScript expectations
# themselves to the Daml vectors and the published goldens.
#
# Usage:
#   conformance/run-all.sh                 run the three runners and compare
#   conformance/run-all.sh --out <dir>     write results elsewhere
#   conformance/run-all.sh --freeze        re-record the baseline in THIS file
#
# THE PROFILE SET IS CHECKED BEFORE ANYTHING IS RUN
#
# The manifest declares nine profiles. Every runner used to derive its
# selectable set from the CAPABILITY CATALOG instead, which has eight: `games`
# is a grouping profile, no capability carries it, and so `--profiles games`
# was exit 2 in all three while its 20 cases ran happily under `--profiles all`.
# The manifest's own summary hid it too — byProfile was a hardcoded eight-key
# literal bucketed by capability, so those 20 cases were filed under core-digest
# and merkle and the totals still added up to 469.
#
# A profile that is declared and cannot be named is a claim that cannot be
# checked, so it is now checked here: each runner is asked, with
# `--list-profiles`, which profiles it will answer to and how many cases each
# one selects, and the three answers must agree with each other, with
# `manifest.profiles`, and with `summary.byProfile`. A profile with no cases
# fails the same check. This runs before the case comparison, because a
# selection the three runners do not spell the same way makes the .verdicts
# diff meaningless.
#
# Exit codes:
#   0  every runner ran, and the verdict triples reproduce the baseline exactly
#   1  an unrecorded divergence, a moved triple, a stale waiver, or a
#      decisions[].goesRed claim the three runners contradict
#   2  a runner could not be trusted (exit 2 or 4), the three did not agree on
#      the declared profile set, or they did not run the same case set — no
#      comparison was made
#
# A runner exiting 1 (fails) or 3 (unsupported in a declared profile) is NOT a
# failure of this script: those are the facts being compared, not errors.

set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
CONFORMANCE="$(dirname "$SELF")"
REPO="$(cd "$CONFORMANCE/.." && pwd)"
MANIFEST="$CONFORMANCE/manifest.json"

OUT="$CONFORMANCE/runners/results"
FREEZE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --freeze) FREEZE=1; shift ;;
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF"; exit 0 ;;
    *) echo "run-all.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# The frozen baseline. One line per case where the three runners are not
# unanimously `pass`:  <case-id> <javascript> <python> <java>  # why
#
# The `why` column is generated from manifest.decisions and the capability
# catalog when the file is frozen, and is documentation only — REVIEW means the
# freeze could not attribute the divergence to anything recorded, which is
# exactly the line a reviewer should stop on.
# ---------------------------------------------------------------------------
frozen_verdicts() {
# BEGIN FROZEN VERDICTS
cat <<'FROZEN'
amount-rejects-untrimmed-whitespace        fail pass pass  # G03-whitespace js:fail recorded-divergence
builder-commit-rejects-missing-fee-amount  fail pass pass  # D10 js:fail recorded-divergence
canon-int-boolean-rejected                 fail pass pass  # D9 js:fail recorded-divergence
canon-time-truncates-to-milliseconds       fail pass pass  # D3 js:fail recorded-divergence
custody-tag-astral-cycle-id                fail pass pass  # D2 js:fail recorded-divergence
cycleid-64-astral-codepoints               fail pass pass  # D2 js:fail recorded-divergence
report-order-astral-vs-replacement         fail pass pass  # D1 js:fail recorded-divergence
report-order-constant-names-a-collation    fail pass pass  # D11 js:fail recorded-divergence
report-order-mixed-case-hyphenated         fail pass pass  # D1 js:fail recorded-divergence
report-order-underscore-vs-hyphen          fail pass pass  # D1 js:fail recorded-divergence
report-order-uppercase-b-vs-lowercase-a    fail pass pass  # D1 js:fail recorded-divergence
text-digest-empty-rejected                 fail pass pass  # D7 js:fail recorded-divergence
trade-document-rejects-pipe-in-meta-value  fail pass pass  # D8 js:fail recorded-divergence
trade-document-rejects-pipe-in-party       fail pass pass  # D8 js:fail recorded-divergence
transfer-document-rejects-pipe-in-meta     fail pass pass  # D8 js:fail recorded-divergence
FROZEN
# END FROZEN VERDICTS
}

# ---------------------------------------------------------------------------
# Run the three runners. One invocation shape, one manifest, one case set.
# ---------------------------------------------------------------------------

mkdir -p "$OUT"

[ -f "$MANIFEST" ] || { echo "run-all.sh: no manifest at $MANIFEST" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The Java runner builds its own jar with `mvnw -o`, which needs a populated
# local repository. On a clean checkout there is none, so the jar is built here
# — online — and the runner then finds it and skips its offline build.
#
# It is also rebuilt whenever java/src is newer than the jar. The runner resolves
# the SDK through the PACKAGED JAR precisely so that a class which does not ship
# is a class the suite cannot see; a stale jar turns that guarantee into its
# opposite, and the java column of the parity claim would then describe bytes
# nobody has any more. A build failure is exit 2 — no fallback to the old jar,
# because "the client does not compile" is not a verdict about a case.
JAR="$(ls -t "$REPO"/java/target/game-sdk-*.jar 2>/dev/null | head -1)"
if [ -z "$JAR" ] || [ -n "$(find "$REPO/java/src" -newer "$JAR" -print -quit 2>/dev/null)" ]; then
  if [ -z "$JAR" ]; then why="none in java/target"; else why="java/src is newer than $(basename "$JAR")"; fi
  echo "--- building the Java SDK jar ($why)"
  ( cd "$REPO/java" && ./mvnw -B -q -DskipTests package ) || {
    echo "run-all.sh: the Java SDK does not build — the parity claim cannot be measured" >&2
    exit 2; }
fi

run_one() { # name  out-basename  command...
  local name="$1" base="$2"; shift 2
  local out="$OUT/$base.jsonl" log="$OUT/$base.log" code
  "$@" --manifest "$MANIFEST" --out "$out" --profiles all >"$log" 2>&1
  code=$?
  case $code in
    0|1|3) printf '%-11s exit %d  %s\n' "$name" "$code" "$out.verdicts" ;;
    *)
      echo "run-all.sh: the $name runner exited $code — the run cannot be trusted" >&2
      echo "--- tail of $log" >&2
      tail -n 25 "$log" >&2
      exit 2 ;;
  esac
  [ -s "$out.verdicts" ] || {
    echo "run-all.sh: the $name runner wrote no verdicts" >&2; exit 2; }
}

# ---------------------------------------------------------------------------
# The declared profile set must be the reachable profile set, in all three.
#
# Asked of each runner rather than assumed: `--list-profiles` reports, from the
# selector each one actually uses, which names it answers to and how many cases
# each name selects. Three answers, one manifest -- they must be the same list,
# with the same counts, those counts must be `summary.byProfile`, and they must
# add up to `summary.totalCases`.
#
# This runs before any case does. A selection the three runners do not spell the
# same way makes the .verdicts diff meaningless, and a profile nobody can name
# makes the manifest's profile list a decoration.
# ---------------------------------------------------------------------------

echo "=== profile reachability: declared == selectable, in every runner"
list_profiles() { # name  command...
  local name="$1"; shift
  if ! "$@" --manifest "$MANIFEST" --list-profiles >"$WORK/profiles.$name" 2>"$WORK/profiles.$name.err"; then
    echo "run-all.sh: the $name runner could not list its profiles" >&2
    tail -n 20 "$WORK/profiles.$name.err" >&2
    exit 2
  fi
}
list_profiles javascript node    "$CONFORMANCE/runners/run.mjs"
list_profiles python     python3 "$CONFORMANCE/runners/run.py"
list_profiles java       "$CONFORMANCE/runners/java/run"

python3 - "$MANIFEST" "$WORK/profiles.javascript" "$WORK/profiles.python" "$WORK/profiles.java" <<'PY'
import json, sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
langs = ("javascript", "python", "java")
declared = sorted(manifest.get("profiles", {}))
summary = manifest.get("summary", {})
by_profile = {k: int(v) for k, v in (summary.get("byProfile") or {}).items()}

seen = {}
for lang, path in zip(langs, sys.argv[2:5]):
    rows = json.load(open(path, encoding="utf-8"))["profiles"]
    seen[lang] = {r["profile"]: int(r["cases"]) for r in rows}

problems = []
if not declared:
    problems.append("manifest.profiles is empty")
for lang in langs:
    missing = [p for p in declared if p not in seen[lang]]
    extra = [p for p in seen[lang] if p not in declared]
    if missing:
        problems.append(f"{lang} cannot select declared profile(s): " + ", ".join(missing))
    if extra:
        problems.append(f"{lang} offers profile(s) the manifest does not declare: "
                        + ", ".join(extra))
for p in declared:
    counts = {lang: seen[lang].get(p) for lang in langs}
    if any(c == 0 for c in counts.values()):
        problems.append(f"profile {p} selects no case; a profile that can be named and "
                        "returns nothing is a claim nothing can check")
    if len({c for c in counts.values() if c is not None}) > 1:
        problems.append(f"profile {p}: the runners disagree on how many cases it selects: "
                        + ", ".join(f"{lang}={counts[lang]}" for lang in langs))
    if p in by_profile and counts["javascript"] is not None \
            and by_profile[p] != counts["javascript"]:
        problems.append(f"profile {p}: summary.byProfile says {by_profile[p]}, "
                        f"the runners select {counts['javascript']}")
for p in by_profile:
    if p not in declared:
        problems.append(f"summary.byProfile names {p}, which manifest.profiles does not declare")
total = sum(by_profile.values())
if summary.get("totalCases") is not None and total != int(summary["totalCases"]):
    problems.append(f"summary.byProfile accounts for {total} cases, "
                    f"summary.totalCases says {summary['totalCases']}")

if problems:
    print("PROFILE CHECK FAILED - the declared profile set is not the reachable one:")
    for x in problems:
        print("  - " + x)
    print("")
    print("  Profiles are declared in generate.mjs (PROFILES) and reached by every runner")
    print("  through manifest.profiles plus each group's `profile` field. Nothing may")
    print("  hardcode the list.")
    raise SystemExit(1)

print(f"profiles    {len(declared)} declared, all selectable in all three runners, "
      f"{total} cases accounted for")
print("            " + "  ".join(f"{p}={by_profile[p]}" for p in declared))
PY
profile_rc=$?
if [ "$profile_rc" -ne 0 ]; then
  exit 2
fi
echo

echo "=== running the three conformance runners --profiles all"
echo "manifest    $MANIFEST"
echo "sha256      $(sha256sum "$MANIFEST" | cut -d' ' -f1)"
echo "results     $OUT"
echo
run_one javascript javascript node       "$CONFORMANCE/runners/run.mjs"
run_one python     python     python3    "$CONFORMANCE/runners/run.py"
run_one java       java       "$CONFORMANCE/runners/java/run"
echo

JS="$OUT/javascript.jsonl.verdicts"
PY="$OUT/python.jsonl.verdicts"
JV="$OUT/java.jsonl.verdicts"

# ---------------------------------------------------------------------------
# Did they run the same cases? A .verdicts diff between two different case sets
# is not a parity claim, it is a selection bug wearing one.
# ---------------------------------------------------------------------------

cut -d' ' -f1 "$JS" >"$WORK/ids.js"
cut -d' ' -f1 "$PY" >"$WORK/ids.py"
cut -d' ' -f1 "$JV" >"$WORK/ids.jv"
for other in py jv; do
  if ! cmp -s "$WORK/ids.js" "$WORK/ids.$other"; then
    echo "run-all.sh: the runners did not run the same case set (javascript vs $other)" >&2
    diff "$WORK/ids.js" "$WORK/ids.$other" | head -20 >&2
    exit 2
  fi
done
echo "case set    $(wc -l <"$JS") cases, identical id column in all three"

# ---------------------------------------------------------------------------
# The three-way diff itself, reported before it is judged.
# ---------------------------------------------------------------------------

pairdiff() { diff "$1" "$2" | grep -c '^<'; }
echo "pairwise    javascript/python $(pairdiff "$JS" "$PY") · javascript/java $(pairdiff "$JS" "$JV") · python/java $(pairdiff "$PY" "$JV")  case(s) differ"
echo

paste -d' ' "$WORK/ids.js" <(cut -d' ' -f2 "$JS") <(cut -d' ' -f2 "$PY") <(cut -d' ' -f2 "$JV") \
  >"$WORK/triples"
awk '$2 != "pass" || $3 != "pass" || $4 != "pass"' "$WORK/triples" | sort >"$WORK/observed"

unanimous=$(awk '$2 == "pass" && $3 == "pass" && $4 == "pass"' "$WORK/triples" | wc -l)
echo "unanimous   $unanimous case(s) pass in all three"
echo "divergent   $(wc -l <"$WORK/observed") case(s) are not unanimously pass"
echo

# ---------------------------------------------------------------------------
# decisions[].goesRed, checked against all three runners.
#
# The manifest's `divergences` array is a JavaScript observation and says so in
# `divergenceCoverage`. `goesRed` is the broader claim -- which CLIENTS violate
# each pin -- and nothing could contradict its python and java entries until
# there were three .verdicts files in one place. There are, here.
#
# "Red" for this check means fail or error: a client that VIOLATES the pin.
# `unsupported` is not a violation, it is an absence, and the catalog's `impl`
# column is what records that (each runner now refuses to run at all if that
# column is wrong about it).
# ---------------------------------------------------------------------------

python3 - "$MANIFEST" "$JS" "$PY" "$JV" <<'PY'
import json, sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
langs = ("javascript", "python", "java")
verdict = {}
for lang, path in zip(langs, sys.argv[2:5]):
    verdict[lang] = dict(line.split() for line in open(path, encoding="utf-8"))

problems = []
for d in manifest.get("decisions", []):
    cases = d.get("cases", [])
    if not cases:
        problems.append(f"{d['id']}: names no case, so goesRed {d.get('goesRed')} "
                        f"cannot be checked by anything")
        continue
    observed = sorted(
        lang for lang in langs
        if any(verdict[lang].get(c) in ("fail", "error") for c in cases))
    declared = sorted(d.get("goesRed", []))
    if observed != declared:
        missing = [x for x in declared if x not in observed]
        extra = [x for x in observed if x not in declared]
        detail = []
        if missing:
            detail.append("claims red but is green in " + ", ".join(missing))
        if extra:
            detail.append("is red in " + ", ".join(extra) + " and does not say so")
        problems.append(f"{d['id']} ({d['title']}): " + "; ".join(detail)
                        + f"\n      cases: {', '.join(cases)}"
                        + "".join(f"\n      {lang:<10} "
                                  + " ".join(f"{c}={verdict[lang].get(c, '?')}" for c in cases)
                                  for lang in langs))

if problems:
    print("DECISION CHECK FAILED - goesRed does not match what the three runners did:")
    for p in problems:
        print("  - " + p)
    print("")
    print("  Correct decisions[].goesRed in conformance/generate.mjs and regenerate.")
    print("  A decision no client violates any more is a description of the code:")
    print("  drop the language from goesRed and list its cases under `governs`, so")
    print("  the decision still goes red if a client regresses.")
    raise SystemExit(1)
print(f"decisions   {len(manifest.get('decisions', []))} goesRed claim(s) match the three runners")
PY
decision_rc=$?
if [ "$decision_rc" -ne 0 ]; then
  exit "$decision_rc"
fi
echo

# ---------------------------------------------------------------------------
# --freeze: re-record the baseline in this file.
# ---------------------------------------------------------------------------

if [ "$FREEZE" = 1 ]; then
  python3 - "$MANIFEST" "$WORK/observed" >"$WORK/block" <<'PY' || exit 2
import json, sys

manifest, observed = json.load(open(sys.argv[1], encoding="utf-8")), sys.argv[2]

cap_of = {}
for g in manifest.get("groups", []):
    for c in g.get("cases", []):
        cap_of[c["id"]] = c["capability"]
impl = {c["id"]: (c.get("impl") or {}) for c in manifest.get("capabilities", [])}
decisions = {}
for d in manifest.get("decisions", []):
    for cid in d.get("cases", []):
        decisions.setdefault(cid, []).append(d["id"])
diverged = {d["caseId"] for d in manifest.get("divergences", [])}

rows = []
for line in open(observed, encoding="utf-8"):
    cid, js, py, jv = line.split()
    cap = cap_of.get(cid)
    why = []
    if cid in decisions:
        why.append("+".join(sorted(set(decisions[cid]))))
    unsupported, broken = [], []
    for lang, status in (("js", js), ("python", py), ("java", jv)):
        if status == "unsupported":
            # The catalog already records who implements what. An `unsupported`
            # that contradicts it is drift worth naming in the file.
            claimed = (impl.get(cap) or {}).get(lang)
            unsupported.append(lang + ("!" if claimed else ""))
        elif status in ("fail", "error"):
            broken.append(f"{lang}:{status}")
    if unsupported:
        why.append("no-impl:" + ",".join(unsupported))
    if broken and cid not in decisions:
        why.append("unexplained " + ",".join(broken))
    elif broken:
        why.append(",".join(broken))
    if cid in diverged and "divergence" not in why:
        why.append("recorded-divergence")
    rows.append((cid, js, py, jv, " ".join(why) or "REVIEW"))

w = max(len(r[0]) for r in rows) if rows else 1
ws = [max((len(r[i]) for r in rows), default=1) for i in (1, 2, 3)]
for cid, js, py, jv, why in rows:
    print(f"{cid:<{w}}  {js:<{ws[0]}} {py:<{ws[1]}} {jv:<{ws[2]}}  # {why}")
PY

  awk -v blk="$WORK/block" '
    $0 == "# BEGIN FROZEN VERDICTS" {
      print
      print "cat <<'"'"'FROZEN'"'"'"
      while ((getline line < blk) > 0) print line
      print "FROZEN"
      skipping = 1
      next
    }
    $0 == "# END FROZEN VERDICTS" { skipping = 0 }
    !skipping { print }
  ' "$SELF" >"$WORK/self" || exit 2
  # A freeze that truncated this script would be worse than a stale baseline.
  grep -q '^# END FROZEN VERDICTS$' "$WORK/self" || {
    echo "run-all.sh: refusing to write a rewritten script with no end marker" >&2; exit 2; }
  cat "$WORK/self" >"$SELF" || exit 2
  echo "frozen      $(wc -l <"$WORK/block") divergence(s) recorded in $SELF"
  echo "            review the diff: every line is a waiver."
  exit 0
fi

# ---------------------------------------------------------------------------
# Judge the run against the baseline.
# ---------------------------------------------------------------------------

frozen_verdicts | sed 's/#.*//' | awk 'NF' | awk '{print $1, $2, $3, $4}' | sort >"$WORK/baseline"

# A baseline line that records three passes is not a waiver of anything, and
# would silently exempt a case from the unanimity requirement.
if pointless=$(awk '$2 == "pass" && $3 == "pass" && $4 == "pass"' "$WORK/baseline") && [ -n "$pointless" ]; then
  echo "run-all.sh: the baseline records unanimously-passing cases; re-freeze:" >&2
  echo "$pointless" >&2
  exit 1
fi

# FILENAME, not the usual FNR==NR: the baseline is legitimately empty on a first
# freeze, and with an empty first file FNR==NR stays true into the second one —
# which would load the observed run as its own baseline and pass everything.
awk -v basefile="$WORK/baseline" '
  FILENAME == basefile { base[$1] = $2 " " $3 " " $4; next }
                       { obs[$1]  = $2 " " $3 " " $4 }
  END {
    for (id in obs) {
      if (!(id in base)) printf "UNRECORDED  %s  observed[%s]\n", id, obs[id]
      else if (base[id] != obs[id]) printf "MOVED       %s  recorded[%s]  observed[%s]\n", id, base[id], obs[id]
    }
    for (id in base) {
      if (!(id in obs)) printf "STALE       %s  recorded[%s]  now unanimous or not in the manifest\n", id, base[id]
    }
  }
' "$WORK/baseline" "$WORK/observed" | sort >"$WORK/verdict"

if [ -s "$WORK/verdict" ]; then
  echo "PARITY CHECK FAILED — $(wc -l <"$WORK/verdict") case(s) do not match the frozen baseline"
  echo "----------------------------------------------------------------------"
  cat "$WORK/verdict"
  echo "----------------------------------------------------------------------"
  echo "Each line is a change to the cross-language parity of this SDK."
  echo "If it is intended, re-freeze it and say why in the review:"
  echo "    conformance/run-all.sh --freeze"
  exit 1
fi

echo "PARITY CHECK PASSED — $(wc -l <"$WORK/observed") recorded divergence(s), none unrecorded"
exit 0
