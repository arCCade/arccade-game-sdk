#!/usr/bin/env node
/**
 * arCCade Game SDK — JavaScript conformance runner.
 *
 * Reads ../manifest.json and executes every case against the PUBLISHED public
 * API of @arccade/game-sdk. It resolves the entry point the way a consumer
 * does — through js/package.json `exports["."].import`, which is
 * ../../js/src/index.js — and asserts that entry is covered by package.json
 * `files`. Nothing here reaches into js/src/*.js directly: a capability that is
 * only reachable from a file the package does not ship is a capability a
 * consumer does not have.
 *
 * Two rules this runner will not bend:
 *
 *   1. A case it cannot execute is a FAILURE, never a skip. `unsupported`
 *      (no published API path) and `error` (an unclassifiable throw) both
 *      count red. A runner that skips what it does not understand reports
 *      parity it has not demonstrated.
 *   2. Rejections are classified by a table keyed on capability GROUP, never
 *      on case id. A per-case map would let the runner pass by naming the
 *      answer. No rule in the table may be a catch-all.
 *
 * Usage:
 *   node run.mjs [--manifest <path>] [--out <path.jsonl>]
 *                [--profiles a,b,c|all] [--case <id>]... [--group <name>]...
 *                [--list-capabilities] [--list-profiles] [--traits] [--quiet]
 *
 * `--profiles` names profiles out of the MANIFEST's own `profiles` object, and
 * a case belongs to the profile its GROUP declares. `--list-profiles` prints
 * that set with the case count each name selects; run-all.sh compares the three
 * runners' answers against the manifest, so a profile that is declared and
 * unreachable — or reachable in one runner and not another — fails the build.
 *
 * `--profiles all` selects every declared profile. It exists
 * because the Java runner already spells the whole set that way, and the
 * cross-runner .verdicts diff is only a parity claim if one invocation shape
 * drives all three over the SAME case set. See conformance/run-all.sh.
 *
 * Exit codes (design section 4.5):
 *   0  every selected case passed (or was not-applicable)
 *   1  at least one fail or error
 *   2  manifest / integrity problem — the run is not trustworthy
 *   3  no fails, but a declared profile contains an unsupported capability
 *   4  uncaught exception in the runner itself
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFORMANCE = resolve(HERE, '..')
const REPO = resolve(CONFORMANCE, '..')

// Exit 4 is "the runner itself broke". It is kept distinct from 1 so a crash in
// the harness can never be read as a client failing a case.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (e) => {
    console.error(`run.mjs: ${ev}: ${e && e.stack ? e.stack : e}`)
    process.exit(4)
  })
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { manifest: null, out: null, profiles: null, cases: [], groups: [],
              listCapabilities: false, listProfiles: false, traits: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const need = () => { const v = argv[++i]; if (v === undefined) die(2, `flag ${a} needs a value`); return v }
    switch (a) {
      case '--manifest': o.manifest = need(); break
      case '--out': o.out = need(); break
      case '--profiles': o.profiles = need().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--case': o.cases.push(need()); break
      case '--group': o.groups.push(need()); break
      case '--list-capabilities': o.listCapabilities = true; break
      case '--list-profiles': o.listProfiles = true; break
      case '--traits': o.traits = true; break
      case '--quiet': o.quiet = true; break
      case '-h': case '--help':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0)
        break
      default: die(2, `unknown flag ${a}`)
    }
  }
  return o
}

const FLAGS = parseArgs(process.argv.slice(2))
const MANIFEST_PATH = FLAGS.manifest ? resolve(FLAGS.manifest) : join(CONFORMANCE, 'manifest.json')
const OUT_PATH = FLAGS.out ? resolve(FLAGS.out) : join(HERE, 'results', 'javascript.jsonl')

function die(code, msg) {
  console.error(`run.mjs: ${msg}`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Resolve the implementation the way a third-party consumer would.
// ---------------------------------------------------------------------------

const pkgPath = join(REPO, 'js', 'package.json')
if (!existsSync(pkgPath)) die(2, `no package manifest at ${pkgPath}`)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const entryRel = pkg.exports?.['.']?.import ?? pkg.main
if (!entryRel) die(2, 'js/package.json declares no entry point')
const entryPath = resolve(join(REPO, 'js'), entryRel)
if (!existsSync(entryPath)) die(2, `package entry does not exist: ${entryPath}`)
if (!(pkg.files ?? []).some((f) => entryRel.replace(/^\.\//, '').startsWith(f))) {
  die(2, `package entry ${entryRel} is not covered by package.json "files"; a consumer could not import it`)
}
// The brief names ../../js/src/index.js. Assert the consumer-shaped resolution
// lands there, so the two descriptions of the entry point cannot drift apart.
const NAMED_ENTRY = resolve(HERE, '..', '..', 'js', 'src', 'index.js')
if (entryPath !== NAMED_ENTRY) {
  die(2, `package entry ${entryPath} is not the expected ${NAMED_ENTRY}`)
}
const sdk = await import(pathToFileURL(entryPath).href)

const TRAITS = {
  hasNativeFloat: true,
  hasUtf16Strings: true,
  hasArbitraryPrecisionInt: true,
}

if (FLAGS.traits) { console.log(JSON.stringify(TRAITS, null, 2)); process.exit(0) }

// ---------------------------------------------------------------------------
// Tagged values. Mirrors the manifest's ArgValue domain exactly; a mismatch in
// which nodes carry vHex would show up as a whole-group failure, not silence.
// ---------------------------------------------------------------------------

const utf8 = (s) => Buffer.from(s, 'utf8')
const utf8hex = (s) => utf8(s).toString('hex')
const textPin = (s) => ({ v: s, vHex: utf8hex(s) })

const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

const A = {
  text: (v) => ({ t: 'text', v, vHex: utf8hex(v) }),
  int: (v) => {
    const b = BigInt(v)
    const o = { t: 'int', v: b.toString() }
    if (b > INT64_MAX || b < INT64_MIN) o.wide = true
    return o
  },
  bool: (v) => ({ t: 'bool', v }),
  party: (v) => ({ t: 'party', v, vHex: utf8hex(v) }),
  hex64: (v) => ({ t: 'hex64', v }),
  nul: () => ({ t: 'null', v: null }),
  list: (v) => ({ t: 'list', v }),
  pairs: (v) => ({ t: 'pairs', v }),
  steps: (v) => ({ t: 'steps', v }),
  json: (v) => ({ t: 'json', v }),
}

function decode(a) {
  if (a === null || typeof a !== 'object' || typeof a.t !== 'string') {
    throw new ManifestError(`argument is not a tagged value: ${JSON.stringify(a)}`)
  }
  switch (a.t) {
    case 'text': case 'party': case 'hex64': case 'raw': return a.v
    case 'int': case 'micros': return BigInt(a.v)
    case 'dec': return a.v
    case 'bool': return a.v
    case 'null': return null
    case 'list': return a.v.map(decode)
    case 'pairs': return a.v.map(([k, v]) => [decode(k), decode(v)])
    case 'record': {
      const out = {}
      for (const [k, v] of Object.entries(a.v.fields)) out[k] = decode(v)
      return out
    }
    case 'steps': return a.v.map((s) => ({ siblingOnLeft: s.siblingOnLeft, sibling: s.sibling }))
    case 'float64': return Buffer.from(a.v.bits, 'hex').readDoubleBE()
    case 'json': return JSON.parse(JSON.stringify(a.v))
    default: throw new ManifestError(`unknown ArgValue tag "${a.t}"`)
  }
}

class ManifestError extends Error {}

// ---------------------------------------------------------------------------
// Reject classification.
//
// This table is the RUNNER's, declared in its header record, keyed by
// capability group. It is cross-checked against the manifest's own rejectMap
// at startup: drift is printed, because a rule this runner lacks would turn a
// correct rejection into `error`, and a rule the manifest lacks would mean the
// two disagree about what a class means.
// ---------------------------------------------------------------------------

const REJECT_CLASSES = [
  'bad-type', 'bad-format', 'out-of-range', 'precision-loss',
  'unknown-tag', 'invariant-violated', 'not-injective',
]

const REJECT_MAP = [
  { group: "digest.amount", match: "kayipsiz cevrilemedi", class: "precision-loss" },
  { group: "digest.amount", match: "bandin disinda", class: "out-of-range" },
  { group: "digest.amount", match: "Number olarak verilemez", class: "bad-type" },
  { group: "digest.amount", match: "desteklenmeyen tutar turu", class: "bad-type" },
  { group: "digest.amount", match: "gecersiz ondalik tutar", class: "bad-format" },
  { group: "digest.fields", match: "alan adi ASCII", class: "bad-format" },
  { group: "audit", match: "gecersiz disposition", class: "unknown-tag" },
  { group: "audit", match: "unknown disposition", class: "unknown-tag" },
  { group: "audit", match: "unparsable ledger timestamp", class: "bad-format" },
  { group: "identity", match: "iceremez", class: "not-injective" },
  { group: "identity", match: "gecersiz cycleId", class: "out-of-range" },
  { group: "identity", match: "gecersiz tradeId", class: "out-of-range" },
  { group: "identity", match: "64 karakterlik kucuk harf sha256", class: "bad-format" },
  { group: "identity", match: "gecersiz varlik kimligi", class: "bad-format" },
  { group: "identity", match: "gecersiz ornek kimligi", class: "bad-format" },
  { group: "identity", match: "gecersiz kiraci kimligi", class: "bad-format" },
  { group: "identity", match: "ardisik tire", class: "bad-format" },
  { group: "identity", match: "gecersiz item kimligi", class: "bad-format" },
  { group: "identity", match: "item kimliginde", class: "not-injective" },
  { group: "identity", match: "kiraci izolasyonu ihlali", class: "invariant-violated" },
  { group: "assets", match: "benzersiz varligin miktari", class: "invariant-violated" },
  { group: "assets", match: "varlik miktari pozitif olmali", class: "out-of-range" },
  { group: "assets", match: "ozellik degeri tamsayi ya da metin olmali", class: "bad-type" },
  { group: "value-documents", match: "tutari pozitif olmali", class: "out-of-range" },
  { group: "value-documents", match: "sender ve receiver ayni olamaz", class: "invariant-violated" },
  { group: "value-documents", match: "sender ve receiver ister", class: "bad-type" },
  { group: "value-documents", match: "instrumentId {admin, id} olmali", class: "bad-type" },
  { group: "builder", match: "ReturnedInFull stake in tamamini", class: "invariant-violated" },
  { group: "builder", match: "ForfeitedInFull hicbir sey", class: "invariant-violated" },
  { group: "builder", match: "outcomeDocument ya da outcomeDigest", class: "bad-type" },
  { group: "builder", match: "inputAmuletCids bos olamaz", class: "invariant-violated" },
  { group: "builder", match: "en az bir alici gerekli", class: "invariant-violated" },
  { group: "builder", match: "takas iki bacak ister", class: "invariant-violated" },
  { group: "builder", match: "settle icin her bacagin", class: "invariant-violated" },
  { group: "builder", match: "iceremez", class: "not-injective" },
  { group: "builder", match: "gecersiz cycleId", class: "out-of-range" },
  { group: "builder", match: "64 karakterlik kucuk harf sha256", class: "bad-format" },
  { group: "builder", match: "bilinmeyen sebep", class: "unknown-tag" },
  { group: "builder", match: "kendine transfer reddedilir", class: "invariant-violated" },
  { group: "builder", match: "ayni alici tekrar edemez", class: "invariant-violated" },
  { group: "builder", match: "transfer tutari pozitif olmali", class: "out-of-range" },
  { group: "quota", match: "gecersiz kiraci kimligi", class: "bad-format" },
  { group: "audit", match: "must equal the stake", class: "invariant-violated" },
  { group: "audit", match: "cannot forfeit", class: "invariant-violated" },
  { group: "audit", match: "cannot return", class: "invariant-violated" },
  { group: "audit", match: "needs both sides non-zero", class: "invariant-violated" },
  { group: "audit", match: "return the stake in full", class: "invariant-violated" },
  { group: "audit", match: "negative settlement amount", class: "out-of-range" },
  { group: "audit", match: "payout above the policy cap", class: "invariant-violated" },
  { group: "audit", match: "duplicate cycleId in a period", class: "invariant-violated" },
  { group: "digest.scalar", match: "desteklenmeyen tamsayi turu", class: "bad-type" },
  { group: "digest.text", match: "gecersiz bos metin", class: "bad-format" },
  { group: "value-documents", match: "belge bileseni '|' iceremez", class: "not-injective" },
  { group: "builder", match: "feeAmount zorunlu", class: "bad-type" },
  { group: "audit", match: "Cannot convert", class: "bad-format" },]

for (const r of REJECT_MAP) {
  if (!REJECT_CLASSES.includes(r.class)) die(2, `reject map: unknown class ${r.class}`)
  // No catch-all. A rule broad enough to swallow a surprise is how a runner
  // turns an unknown failure into a pass.
  if (typeof r.match !== 'string' || r.match.length < 4 || r.match === '.*') {
    die(2, `reject map: rule too broad to be evidence: ${JSON.stringify(r.match)}`)
  }
  r.used = 0
}

function classify(group, message) {
  for (const r of REJECT_MAP) {
    if (r.group === group && String(message).includes(r.match)) { r.used += 1; return r.class }
  }
  return null
}

// ---------------------------------------------------------------------------
// Dispatch: capability id -> the published API call.
//
// `exports` names the entry-point exports the call needs. If one is missing
// from the published module the capability is `unsupported` for this client —
// determined by looking at the module, not by trusting the manifest's own
// `impl.js` field.
//
// A capability with no entry here is unsupported too, and every case on it is
// counted red.
// ---------------------------------------------------------------------------

const asDoc = (text) => ({ text, digest: sdk.textDigest(text) })
const instrArg = (i) => A.pairs([[A.text('admin'), A.party(i.admin)], [A.text('id'), A.text(i.id)]])

function rowArg(r) {
  return { t: 'record', v: { schema: 'cycle-audit-row', fields: {
    cycleId: A.text(r.cycleId),
    player: A.party(r.player),
    gameCode: A.text(r.gameCode),
    concurrencyIndex: A.int(r.concurrencyIndex),
    entryDigest: A.text(r.entryDigest),
    outcomeDigest: A.text(r.outcomeDigest),
    committedUnits: A.int(r.committedUnits),
    feeUnits: A.int(r.feeUnits),
    returnedUnits: A.int(r.returnedUnits),
    forfeitedUnits: A.int(r.forfeitedUnits),
    payoutUnits: A.int(r.payoutUnits),
    disposition: A.text(r.disposition),
    committedAtMicros: A.int(r.committedAtMicros),
    settledAtMicros: A.int(r.settledAtMicros),
    custodyTag: A.text(r.custodyTag),
  } } }
}

const jsonPin = (v) => A.json(JSON.parse(JSON.stringify(v)))

const DISPATCH = {
  // -- core-digest ---------------------------------------------------------
  'digest.canon': { exports: ['canon'], run: ([tag, value]) => sdk.canon(tag, value) },
  'digest.canonText': { exports: ['canonText'], run: ([s]) => sdk.canonText(s) },
  'digest.canonInt': { exports: ['canonInt'], run: ([i]) => sdk.canonInt(i) },
  'digest.canonBool': { exports: ['canonBool'], run: ([b]) => sdk.canonBool(b) },
  'digest.canonDecimal': { exports: ['canonDecimal'], run: ([d]) => sdk.canonDecimal(d) },
  'digest.canonTimeMicros': { exports: ['canonTimeMicros'], run: ([m]) => sdk.canonTimeMicros(BigInt(m)) },
  'digest.canonTime': { exports: ['canonTime'], run: ([iso]) => sdk.canonTime(iso) },
  'digest.canonParty': { exports: ['canonParty'], run: ([p]) => sdk.canonParty(p) },
  'digest.canonOptional': {
    exports: ['canonOptional', 'canonText'],
    run: ([x]) => sdk.canonOptional(sdk.canonText, x),
  },
  'digest.canonList': { exports: ['canonList'], run: ([xs]) => sdk.canonList(xs) },
  'digest.canonFields': { exports: ['canonFields'], run: ([kvs]) => sdk.canonFields(kvs) },
  'digest.codePointLength': { exports: ['codePointLength'], run: ([s]) => BigInt(sdk.codePointLength(s)) },
  'digest.amountUnits': { exports: ['amountUnits'], run: ([d]) => sdk.amountUnits(d) },
  'digest.canonDocument': {
    exports: ['canonDocument', 'textDigest'],
    run: ([schema, version, kvs]) => asDoc(sdk.canonDocument(schema, version, kvs)),
  },
  'digest.textDigest': { exports: ['textDigest'], run: ([t]) => sdk.textDigest(t) },
  'digest.constant': {
    exports: [],
    run: ([name]) => {
      const v = sdk[name]
      // Not a reject-map path: a missing wire constant is an unclassifiable
      // throw and must surface as `error`, not as a tidy rejection.
      if (v === undefined) throw new MissingExport(`published entry exports no constant "${name}"`)
      return Array.isArray(v) ? A.list(v.map((x) => A.text(x))) : A.text(String(v))
    },
  },

  // -- merkle --------------------------------------------------------------
  'merkle.merkleEmpty': { exports: ['merkleEmpty'], run: () => sdk.merkleEmpty() },
  'merkle.merkleNode': { exports: ['merkleNode'], run: ([l, r]) => sdk.merkleNode(l, r) },
  'merkle.merklePairUp': {
    exports: ['merklePairUp'],
    run: ([level]) => A.list(sdk.merklePairUp(level).map((h) => A.hex64(h))),
  },
  'merkle.merkleRoot': { exports: ['merkleRoot'], run: ([leaves]) => sdk.merkleRoot(leaves) },
  'merkle.merkleProof': { exports: ['merkleProof'], run: ([ix, leaves]) => sdk.merkleProof(Number(ix), leaves) },
  'merkle.merkleFold': { exports: ['merkleFold'], run: ([leaf, steps]) => sdk.merkleFold(leaf, steps) },
  'merkle.merkleVerify': { exports: ['merkleVerify'], run: ([leaf, steps, root]) => sdk.merkleVerify(leaf, steps, root) },

  // -- audit ---------------------------------------------------------------
  'audit.periodLeafDocument': {
    exports: ['periodLeafDocument', 'textDigest'],
    run: ([row]) => asDoc(sdk.periodLeafDocument(row)),
  },
  'audit.periodRowVerify': {
    exports: ['periodRowVerify'],
    run: ([row, steps, root]) => sdk.periodRowVerify(row, steps, root),
  },
  'audit.isoToMicros': { exports: ['isoToMicros'], run: ([iso]) => sdk.isoToMicros(iso) },
  'audit.rowsFromTransactions': {
    exports: ['rowsFromTransactions', 'toLeafRow'],
    run: ([txs]) => A.list(sdk.rowsFromTransactions(txs).rows.map((r) => rowArg(sdk.toLeafRow(r)))),
  },
  'audit.reportOrder': {
    exports: ['rowsFromTransactions'],
    run: ([txs]) => sdk.rowsFromTransactions(txs).rows.map((r) => r.cycleId),
  },
  'audit.unmatchedHalves': {
    exports: ['rowsFromTransactions'],
    run: ([txs]) => {
      const r = sdk.rowsFromTransactions(txs)
      return A.pairs([
        [A.text('openStakes'), A.list(r.openStakes.map((x) => A.text(x)))],
        [A.text('orphanClosings'), A.list(r.orphanClosings.map((x) => A.text(x)))],
      ])
    },
  },
  'audit.unlockWarnings': {
    exports: ['rowsFromTransactions'],
    run: ([txs]) => A.list(sdk.rowsFromTransactions(txs).warnings.map((w) => A.pairs([
      [A.text('cycleId'), A.text(w.cycleId)],
      [A.text('kind'), A.text(w.kind)],
      [A.text('stated'), A.int(w.stated)],
      [A.text('unlocked'), A.int(w.unlocked)],
    ]))),
  },

  'audit.anchorDocument': {
    exports: ['anchorDocument', 'textDigest'],
    run: ([a]) => asDoc(sdk.anchorDocument(a)),
  },
  'audit.anchorTotals': {
    exports: ['anchorTotals'],
    // Object key order is ANCHOR_TOTAL_FIELDS order, which is the order the
    // manifest's pairs are in; a client that reordered them would fail here
    // rather than be silently re-sorted into agreement.
    run: ([rows]) => A.pairs(Object.entries(sdk.anchorTotals(rows)).map(([k, v]) => [A.text(k), A.int(v)])),
  },
  'policy.policyDocument': {
    exports: ['policyDocument', 'textDigest'],
    run: ([p]) => asDoc(sdk.policyDocument(p)),
  },
  'policy.validPolicy': { exports: ['validPolicy'], run: ([p]) => sdk.validPolicy(p) },
  'settlement.assertSettlementValid': {
    exports: ['assertSettlementValid'],
    run: ([st]) => sdk.assertSettlementValid(st),
  },

  // -- time ----------------------------------------------------------------
  //
  // These return BigInt under `returns: "int"`. Passing the decoded argument
  // through unconverted is deliberate: the SDK's own int64 coercion is what
  // the time cases are about, and a `Number()` here would do the rounding the
  // client is supposed to refuse.
  'time.epochSeconds': { exports: ['epochSeconds'], run: ([m]) => sdk.epochSeconds(m) },
  'time.secondsBetween': { exports: ['secondsBetween'], run: ([a, b]) => sdk.secondsBetween(a, b) },
  'time.addSeconds': { exports: ['addSeconds'], run: ([m, s]) => sdk.addSeconds(m, s) },
  'time.intDivide': { exports: ['intDivide'], run: ([a, b]) => sdk.intDivide(a, b) },

  // -- identity ------------------------------------------------------------
  'cycle.assertValidCycleId': { exports: ['assertValidCycleId'], run: ([id]) => { sdk.assertValidCycleId(id); return id } },
  'cycle.assertHex64': { exports: ['assertHex64'], run: ([h]) => { sdk.assertHex64(h); return h } },
  'cycle.custodyTagFor': { exports: ['custodyTagFor'], run: ([id, d]) => sdk.custodyTagFor(id, d) },
  'trade.assertValidTradeId': { exports: ['assertValidTradeId'], run: ([id]) => { sdk.assertValidTradeId(id); return id } },
  'assets.assertValidLocalId': { exports: ['assertValidLocalId'], run: ([id]) => { sdk.assertValidLocalId(id); return id } },
  'tenant.assertValidTenantId': { exports: ['assertValidTenantId'], run: ([id]) => { sdk.assertValidTenantId(id); return id } },
  'tenant.namespacedInstrumentId': {
    exports: ['namespacedInstrumentId'],
    run: ([reg, tid, lid]) => instrArg(sdk.namespacedInstrumentId(reg, tid, lid)),
  },
  'tenant.parseInstrumentId': {
    exports: ['parseInstrumentId'],
    run: ([i]) => {
      const p = sdk.parseInstrumentId(i)
      return A.pairs([
        [A.text('tenantId'), p.tenantId === null ? A.nul() : A.text(p.tenantId)],
        [A.text('localId'), A.text(p.localId)],
      ])
    },
  },
  'tenant.assertTenantOwnsInstrument': {
    exports: ['assertTenantOwnsInstrument'],
    run: ([tid, i]) => { sdk.assertTenantOwnsInstrument(tid, i); return tid },
  },
  'tenant.assertTenantLegs': {
    exports: ['assertTenantLegs'],
    run: ([tid, legs]) => { sdk.assertTenantLegs(tid, Object.fromEntries(legs)); return tid },
  },
  'tenant.hashTenantKey': { exports: ['hashTenantKey'], run: ([s]) => sdk.hashTenantKey(s) },
  'tenant.tenantIdFromKey': {
    exports: ['tenantIdFromKey'],
    run: ([s]) => { const r = sdk.tenantIdFromKey(s); return r === null ? A.nul() : A.text(r) },
  },
  'tenant.verifyTenantKey': { exports: ['verifyTenantKey'], run: ([s, h]) => sdk.verifyTenantKey(s, h) },
  'assets.fungibleInstrument': {
    exports: ['fungibleInstrument'],
    run: ([reg, tid, lid]) => instrArg(sdk.fungibleInstrument(reg, tid, lid)),
  },
  'assets.uniqueInstrument': {
    exports: ['uniqueInstrument'],
    run: ([reg, tid, lid, iid]) => instrArg(sdk.uniqueInstrument(reg, tid, lid, iid)),
  },
  'assets.parseAsset': {
    exports: ['parseAsset'],
    run: ([i]) => {
      const p = sdk.parseAsset(i)
      return A.pairs([
        [A.text('tenantId'), p.tenantId === null ? A.nul() : A.text(p.tenantId)],
        [A.text('localId'), A.text(p.localId)],
        [A.text('instanceId'), p.instanceId === null ? A.nul() : A.text(p.instanceId)],
        [A.text('assetClass'), A.text(p.assetClass)],
      ])
    },
  },
  'assets.isUnique': { exports: ['isUnique'], run: ([i]) => sdk.isUnique(i) },
  'assets.assertAmountValidForAsset': {
    exports: ['assertAmountValidForAsset'],
    run: ([i, amt]) => { sdk.assertAmountValidForAsset(i, amt); return amt },
  },
  'assets.assetAttributeDocument': {
    exports: ['assetAttributeDocument', 'textDigest'],
    run: ([instrumentId, attrs]) => asDoc(sdk.assetAttributeDocument({
      instrumentId, attributes: Object.fromEntries(attrs),
    })),
  },
  'assets.deriveInstanceId': {
    exports: ['deriveInstanceId'],
    run: ([tenantId, localId, attrs, salt]) => A.text(sdk.deriveInstanceId({
      tenantId, localId, attributes: Object.fromEntries(attrs), salt,
    })),
  },

  // -- value documents -----------------------------------------------------
  'trade.tradeDocument': {
    exports: ['tradeDocument', 'textDigest'],
    run: ([t]) => asDoc(sdk.tradeDocument({
      tradeId: t.tradeId, maker: t.maker, taker: t.taker,
      legs: Object.fromEntries(t.legs), expiresAt: t.expiresAt,
      meta: Object.fromEntries(t.meta ?? []),
    })),
  },
  'trade.leg': {
    exports: ['leg'],
    run: ([l]) => {
      const r = sdk.leg({ sender: l.sender, receiver: l.receiver, instrumentId: l.instrumentId, amount: l.amount })
      return A.pairs([
        [A.text('sender'), A.party(r.sender)],
        [A.text('receiver'), A.party(r.receiver)],
        [A.text('instrument'), A.text(r.instrumentId.id)],
        [A.text('amount'), A.text(r.amount)],
      ])
    },
  },
  'transfer.transferDocument': {
    exports: ['transferDocument', 'textDigest'],
    run: ([t]) => asDoc(sdk.transferDocument({
      transferId: t.transferId, sender: t.sender, reason: t.reason,
      recipients: t.recipients, meta: Object.fromEntries(t.meta ?? []),
    })),
  },

  // -- quota ---------------------------------------------------------------
  'quota.consume': {
    exports: ['TenantQuota'],
    run: ([cfg, steps]) => {
      const q = new sdk.TenantQuota({
        windowSeconds: Number(cfg.windowSeconds), maxWrites: Number(cfg.maxWrites),
      })
      return A.list(steps.map((s) => {
        const r = q.consume(s.tenantId, Number(s.nowMs), Number(s.cost))
        return A.pairs([
          [A.text('allowed'), A.bool(r.allowed)],
          [A.text('remaining'), A.int(r.remaining)],
          [A.text('resetAt'), A.int(r.resetAt)],
        ])
      }))
    },
  },

  // -- builder -------------------------------------------------------------
  'builder.buildCommitCommands': { exports: ['buildCommitCommands'], run: ([o]) => jsonPin(sdk.buildCommitCommands(o)) },
  'builder.buildDryRunCommitCommands': { exports: ['buildDryRunCommitCommands'], run: ([o]) => jsonPin(sdk.buildDryRunCommitCommands(o)) },
  'builder.buildSettleCommands': { exports: ['buildSettleCommands'], run: ([o]) => jsonPin(sdk.buildSettleCommands(o)) },
  'builder.buildAbortCommands': { exports: ['buildAbortCommands'], run: ([o]) => jsonPin(sdk.buildAbortCommands(o)) },
  'builder.buildExpireCommands': { exports: ['buildExpireCommands'], run: ([o]) => jsonPin(sdk.buildExpireCommands(o)) },
  'builder.buildTradeProposalCommands': { exports: ['buildTradeProposalCommands'], run: ([o]) => jsonPin(sdk.buildTradeProposalCommands(o)) },
  'builder.buildTradeSettleCommands': { exports: ['buildTradeSettleCommands'], run: ([o]) => jsonPin(sdk.buildTradeSettleCommands(o)) },
  'builder.buildTradeCancelCommands': { exports: ['buildTradeCancelCommands'], run: ([o]) => jsonPin(sdk.buildTradeCancelCommands(o)) },
  'builder.buildTransferCommands': { exports: ['buildTransferCommands'], run: ([o]) => jsonPin(sdk.buildTransferCommands(o)) },
}

class MissingExport extends Error {}

// ---------------------------------------------------------------------------
// Load the manifest and check the things that would make a run untrustworthy.
// These exit 2, not 1: "the suite could not be trusted to run" and "this client
// is wrong" are different facts.
// ---------------------------------------------------------------------------

if (!existsSync(MANIFEST_PATH)) die(2, `no manifest at ${MANIFEST_PATH}`)
let MANIFEST
try {
  MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
} catch (e) {
  die(2, `manifest is not valid JSON: ${e.message}`)
}
if (MANIFEST.manifestVersion !== '1') die(2, `unsupported manifestVersion ${MANIFEST.manifestVersion}`)

const CAPS = new Map((MANIFEST.capabilities ?? []).map((c) => [c.id, c]))
if (CAPS.size === 0) die(2, 'manifest carries no capability catalog')

// The selectable profile set is the manifest's `profiles` object, and nothing
// else. It used to be derived from the capability catalog in all three runners,
// which silently dropped `games`: the manifest declares it, two groups put 20
// cases in it, and no capability carries it, so `--profiles games` was exit 2
// in every runner while the cases ran under `--profiles all`. A profile that is
// declared and cannot be named is a claim that cannot be checked.
const DECLARED_PROFILES = Object.keys(MANIFEST.profiles ?? {}).sort()
if (DECLARED_PROFILES.length === 0) die(2, 'manifest declares no profiles')

const integrity = []

// vHex is the byte pin. Where a node carries both v and vHex, the bytes must be
// the UTF-8 of the string: that is what makes a human-readable manifest
// byte-exact rather than merely plausible.
function checkNode(node, where) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((n, i) => checkNode(n, `${where}[${i}]`)); return }
  // Ledger API shapes are not our domain; they carry raw JSON numbers by
  // construction and are skipped whole.
  if (node.t === 'json') return
  // Applies to tagged values and to bare {v, vHex} text pins alike: wherever
  // both halves are present the hex must be the UTF-8 of the string.
  if (typeof node.v === 'string' && typeof node.vHex === 'string') {
    const want = utf8hex(node.v)
    if (want !== node.vHex) {
      integrity.push(`${where}: vHex does not encode v (v=${JSON.stringify(node.v)} vHex=${node.vHex} expected=${want})`)
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'number') integrity.push(`${where}.${k}: JSON number ${v}; every value must be a tagged string`)
    checkNode(v, `${where}.${k}`)
  }
}

const ALL_CASES = []
const SEEN_IDS = new Set()
const CAP_CASE_COUNT = new Map()

for (const g of MANIFEST.groups ?? []) {
  for (const c of g.cases ?? []) {
    if (SEEN_IDS.has(c.id)) integrity.push(`duplicate case id ${c.id}`)
    SEEN_IDS.add(c.id)
    if ((MANIFEST.retiredIds ?? []).includes(c.id)) integrity.push(`case ${c.id} is listed in retiredIds`)
    const cap = CAPS.get(c.capability)
    if (!cap) integrity.push(`case ${c.id}: capability ${c.capability} is not in the catalog`)
    if (Object.keys(c.expect ?? {}).length !== 1) {
      integrity.push(`case ${c.id}: expect must carry exactly one key, got ${JSON.stringify(Object.keys(c.expect ?? {}))}`)
    }
    checkNode(c.input, `${c.id}.input`)
    checkNode(c.expect, `${c.id}.expect`)
    CAP_CASE_COUNT.set(c.capability, (CAP_CASE_COUNT.get(c.capability) ?? 0) + 1)
    // The profile a case is SELECTED BY is its GROUP's, not its capability's.
    // The two disagree for 26 of the 469 cases, and taking the capability's
    // made `games` unreachable — every one of its 20 cases exercises a
    // core-digest capability. All three runners now read this same field, so
    // they still select identical case sets from one `--profiles` value, which
    // is the property the .verdicts diff depends on.
    ALL_CASES.push({ ...c, profile: g.profile })
  }
}

// Every group's profile must be one the manifest declares, or `--profiles` can
// never reach the cases in it.
for (const g of MANIFEST.groups ?? []) {
  if (!DECLARED_PROFILES.includes(g.profile)) {
    integrity.push(`group ${g.group} declares profile ${g.profile}, which manifest.profiles does not list`)
  }
}
// A declared profile with no case is the same defect seen from the other side:
// a name the caller can pass that selects nothing.
const CASES_PER_PROFILE = new Map(DECLARED_PROFILES.map((p) => [p, 0]))
for (const c of ALL_CASES) {
  if (CASES_PER_PROFILE.has(c.profile)) CASES_PER_PROFILE.set(c.profile, CASES_PER_PROFILE.get(c.profile) + 1)
}
for (const p of DECLARED_PROFILES) {
  if (CASES_PER_PROFILE.get(p) === 0) {
    integrity.push(`profile ${p} is declared in manifest.profiles and no case is in it; ` +
      '`--profiles ' + p + '` would select nothing')
  }
}
// And the manifest's own byProfile table must agree with what this runner just
// counted. That table was built from a hardcoded 8-key literal keyed on the
// capability profile, so it reported the 20 games cases under core-digest and
// merkle and omitted the profile they are declared in. Nothing could contradict
// it; this does.
{
  const declared = MANIFEST.summary?.byProfile
  if (declared !== undefined) {
    for (const p of Object.keys(declared)) {
      if (!DECLARED_PROFILES.includes(p)) {
        integrity.push(`summary.byProfile names profile ${p}, which manifest.profiles does not declare`)
      }
    }
    for (const p of DECLARED_PROFILES) {
      const want = declared[p]
      if (want === undefined) {
        integrity.push(`summary.byProfile has no entry for the declared profile ${p}`)
      } else if (Number(want) !== CASES_PER_PROFILE.get(p)) {
        integrity.push(`summary.byProfile.${p}=${want} but the file carries ${CASES_PER_PROFILE.get(p)} case(s) in that profile`)
      }
    }
  }
}

// A capability with zero cases is a hole, not a pass.
for (const [id] of CAPS) {
  if (!CAP_CASE_COUNT.has(id)) integrity.push(`capability ${id} has no case; a capability with zero cases is a hole, not a pass`)
}
// The manifest states its own counts. If they disagree with the file, one of
// the two is stale and the run means nothing.
if (MANIFEST.summary?.totalCases && Number(MANIFEST.summary.totalCases) !== ALL_CASES.length) {
  integrity.push(`manifest.summary.totalCases=${MANIFEST.summary.totalCases} but the file carries ${ALL_CASES.length} cases`)
}
for (const g of MANIFEST.groups ?? []) {
  const declared = MANIFEST.summary?.byGroup?.[g.group]
  if (declared !== undefined && Number(declared) !== g.cases.length) {
    integrity.push(`group ${g.group}: summary says ${declared} cases, file carries ${g.cases.length}`)
  }
}

// The catalog's `impl.js` is a claim about THIS client, and this runner is the
// only thing that knows whether it is true. Checked here rather than trusted:
// a null beside a capability the runner dispatches means the manifest is
// slandering a client that works, and a name beside one it cannot dispatch
// means the suite is about to report `unsupported` for something the catalog
// swears exists. Both are manifest errors, and both stop the run.
//
// This is the check that caught 42 capabilities recorded as unimplemented in
// Python and 43 in Java while both clients passed all 469 cases.
for (const [id, cap] of CAPS) {
  const claimed = cap.impl?.js ?? null
  const dispatchable = Boolean(DISPATCH[id])
      && DISPATCH[id].exports.every((e) => sdk[e] !== undefined)
  if (claimed !== null && !dispatchable) {
    const missing = DISPATCH[id]
      ? `missing export(s): ${DISPATCH[id].exports.filter((e) => sdk[e] === undefined).join(', ')}`
      : 'no dispatch entry in run.mjs'
    integrity.push(`capability ${id}: the catalog says impl.js is "${claimed}", but this runner cannot drive it (${missing})`)
  }
  if (claimed === null && dispatchable) {
    integrity.push(`capability ${id}: the catalog says impl.js is null, but this runner drives it through ${DISPATCH[id].exports.join(', ')}. Regenerate the manifest.`)
  }
}

// Reject-map drift, against THIS language's entry. The manifest used to publish
// one `rejectMap` — the JavaScript client's — under a name that read as though
// it were every client's, so every runner found drift, printed it, and exited
// 0. It now publishes one map per language, harvested from each runner's own
// source, and a difference is a manifest error: this runner would be classing
// refusals by rules the manifest does not describe.
{
  const mapKey = (r) => `${r.group} | ${r.match} | ${r.class}`
  const declared = MANIFEST.rejectMaps?.javascript?.rules
  if (!Array.isArray(declared)) {
    integrity.push('manifest has no rejectMaps.javascript.rules; regenerate it with the current generate.mjs')
  } else {
    const mine = new Set(REJECT_MAP.map(mapKey))
    const theirs = new Set(declared.map(mapKey))
    for (const k of theirs) if (!mine.has(k)) integrity.push(`reject-map drift: manifest has a rule this runner lacks: ${k}`)
    for (const k of mine) if (!theirs.has(k)) integrity.push(`reject-map drift: this runner has a rule the manifest lacks: ${k}`)
  }
}

if (integrity.length) {
  console.error('run.mjs: the manifest is not trustworthy; no cases were run.')
  for (const m of integrity.slice(0, 40)) console.error(`  - ${m}`)
  if (integrity.length > 40) console.error(`  ... and ${integrity.length - 40} more`)
  process.exit(2)
}

if (FLAGS.listCapabilities) {
  const rows = [...CAPS.values()].map((c) => ({
    id: c.id, profile: c.profile, cases: CAP_CASE_COUNT.get(c.id) ?? 0,
    executable: Boolean(DISPATCH[c.id]),
    missingExports: DISPATCH[c.id] ? DISPATCH[c.id].exports.filter((e) => sdk[e] === undefined) : null,
  }))
  console.log(JSON.stringify({ language: 'javascript', capabilities: rows }, null, 2))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const PROFILES_AVAILABLE = DECLARED_PROFILES

// `all` is a spelling of "every profile the manifest declares", not a
// profile. The
// Java runner accepted it and this one did not, so the three runners could not
// be driven over one case set by one invocation shape — and a .verdicts diff
// between two different case sets is not the parity claim it looks like. It is
// rejected in combination with a named profile rather than quietly widened:
// `--profiles all,merkle` reads like a narrowing to whoever typed it.
const ALL_PROFILES = (FLAGS.profiles ?? []).includes('all')
if (ALL_PROFILES && FLAGS.profiles.length !== 1) {
  die(2, `--profiles all already selects every profile; drop ${FLAGS.profiles.filter((p) => p !== 'all').join(', ')}`)
}
const PROFILES = ALL_PROFILES ? PROFILES_AVAILABLE : (FLAGS.profiles ?? PROFILES_AVAILABLE)
for (const p of PROFILES) {
  if (!PROFILES_AVAILABLE.includes(p)) die(2, `unknown profile ${p}; known: ${PROFILES_AVAILABLE.join(', ')}, all`)
}
const caseFilter = new Set(FLAGS.cases)
const groupFilter = new Set(FLAGS.groups)
for (const id of caseFilter) if (!SEEN_IDS.has(id)) die(2, `--case ${id}: no such case in the manifest`)
for (const g of groupFilter) if (!(MANIFEST.groups ?? []).some((x) => x.group === g)) die(2, `--group ${g}: no such group`)

// One definition of "the cases in these profiles". `--list-profiles` reports
// what this same function returns for each declared name, so the listing cannot
// claim a profile is reachable while the selector disagrees.
const selectByProfiles = (profiles) => ALL_CASES.filter((c) => profiles.includes(c.profile))

if (FLAGS.listProfiles) {
  console.log(JSON.stringify({
    language: 'javascript',
    profiles: DECLARED_PROFILES.map((p) => ({
      profile: p,
      cases: String(selectByProfiles([p]).length),
      description: MANIFEST.profiles[p],
    })),
  }, null, 2))
  process.exit(0)
}

const SELECTED = selectByProfiles(PROFILES).filter((c) => {
  if (caseFilter.size && !caseFilter.has(c.id)) return false
  if (groupFilter.size && !groupFilter.has(c.group)) return false
  return true
})

// ---------------------------------------------------------------------------
// Structural comparison. Never a native == across types: both sides are
// normalised into the same JSON domain and compared key-set by key-set.
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false
    return ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

function firstDivergentByte(a, b) {
  const x = utf8(a), y = utf8(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i
  return x.length === y.length ? null : n
}

// Lift a raw observed result into the manifest's expectation domain, so the two
// sides are compared in the same shape rather than by coincidence.
function observedExpect(returns, v) {
  switch (returns) {
    case 'text': return { text: textPin(v) }
    case 'digest': return { digest: v }
    case 'document': return { document: { text: textPin(v.text), digest: v.digest } }
    case 'int': return { value: A.int(v) }
    case 'bool': return { bool: v }
    case 'order': return { order: v }
    case 'steps': return { value: A.steps(v.map((s) => ({ siblingOnLeft: s.siblingOnLeft, sibling: s.sibling }))) }
    case 'accept': return { value: A.text(v) }
    case 'value': return { value: v }
    default: throw new ManifestError(`unknown capability "returns" kind: ${returns}`)
  }
}

// ---------------------------------------------------------------------------
// Execute one case.
//
// Status vocabulary, and what each one costs:
//   pass            observed matched expected (a correct rejection is a pass)
//   fail            observed differed, or a value came back where a rejection
//                   was required                                       -> red
//   error           threw where a value was expected and the throw could not
//                   be classified, or the case could not be executed    -> red
//   unsupported     no published API path to this capability            -> red
//   not-applicable  appliesWhen trait absent in this runtime        -> neutral
//
// There is deliberately no `skip`.
// ---------------------------------------------------------------------------

function runCase(c) {
  const cap = CAPS.get(c.capability)
  const rec = {
    rec: 'case', id: c.id, group: c.group, capability: c.capability,
    profile: c.profile, status: null, expected: c.expect, observed: {},
  }
  if (c.decision) rec.decision = c.decision

  if (c.appliesWhen) {
    for (const [trait, want] of Object.entries(c.appliesWhen)) {
      if (Boolean(TRAITS[trait]) !== Boolean(want)) {
        rec.status = 'not-applicable'
        rec.observed = { reason: `runtime trait ${trait}=${Boolean(TRAITS[trait])}, case needs ${want}` }
        return rec
      }
    }
  }

  const d = DISPATCH[c.capability]
  if (!d) {
    rec.status = 'unsupported'
    rec.observed = { reason: 'no published API path: the entry point exposes nothing that computes this capability' }
    return rec
  }
  const missing = d.exports.filter((e) => sdk[e] === undefined)
  if (missing.length) {
    rec.status = 'unsupported'
    rec.observed = { reason: `published entry does not export: ${missing.join(', ')}` }
    return rec
  }

  // Decoding is part of the case. A tag this runner does not understand is an
  // error, not a skip: it means the runner cannot demonstrate the case either
  // way.
  let args
  try {
    args = (c.input?.args ?? []).map(decode)
  } catch (e) {
    rec.status = 'error'
    rec.observed = { reason: `could not decode input: ${e.message}`, errorText: e.message }
    return rec
  }

  let value, thrown = null
  try {
    value = d.run(args)
  } catch (e) {
    thrown = e
  }

  const wantsReject = Object.prototype.hasOwnProperty.call(c.expect, 'reject')

  if (thrown) {
    const errorText = thrown && thrown.message !== undefined ? String(thrown.message) : String(thrown)
    // The raw text is recorded on every throw, pass included: message drift is
    // then visible in review even while the class still matches.
    rec.observed.errorText = errorText
    if (thrown instanceof MissingExport || thrown instanceof ManifestError) {
      rec.status = 'error'
      rec.observed.reason = errorText
      return rec
    }
    const cls = classify(cap.rejectGroup, errorText)
    if (cls === null) {
      // Unclassifiable. Never a pass; widening the table to a catch-all is the
      // move this refuses to make.
      rec.status = 'error'
      rec.observed.reason = `unclassifiable throw in reject group "${cap.rejectGroup}"`
      return rec
    }
    rec.observed.reject = { class: cls }
    rec.status = wantsReject && c.expect.reject.class === cls ? 'pass' : 'fail'
    return rec
  }

  // A value came back.
  let obs
  try {
    obs = observedExpect(cap.returns, value)
  } catch (e) {
    rec.status = 'error'
    rec.observed = { reason: `could not lift the result into the expectation domain: ${e.message}` }
    return rec
  }
  Object.assign(rec.observed, obs)

  if (wantsReject) {
    rec.observed.errorText = null
    rec.status = 'fail'
    return rec
  }

  rec.status = deepEqual(c.expect, obs) ? 'pass' : 'fail'
  if (rec.status === 'fail' && c.expect.text && obs.text) {
    const i = firstDivergentByte(c.expect.text.v, obs.text.v)
    if (i !== null) rec.observed.firstDivergentByte = String(i)
  }
  if (rec.status === 'fail' && c.expect.document && obs.document) {
    const i = firstDivergentByte(c.expect.document.text.v, obs.document.text.v)
    if (i !== null) rec.observed.firstDivergentByte = String(i)
  }
  return rec
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const started = Date.now()
const records = []
for (const c of [...SELECTED].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
  records.push(runCase(c))
}
const wallMs = Date.now() - started

const byStatus = (s) => records.filter((r) => r.status === s)
const PASS = byStatus('pass').length
const FAIL = byStatus('fail').length
const ERROR = byStatus('error').length
const UNSUPPORTED = byStatus('unsupported').length
const NA = byStatus('not-applicable').length
const RED = FAIL + ERROR + UNSUPPORTED

let SUMMARY_MISMATCH = false
const EXIT = (FAIL + ERROR) > 0 ? 1 : UNSUPPORTED > 0 ? 3 : 0

// ---------------------------------------------------------------------------
// JSONL output plus the .verdicts file the cross-language diff runs on.
// ---------------------------------------------------------------------------

const header = {
  rec: 'runner', schema: '1', language: 'javascript',
  implementation: `${pkg.name}@${pkg.version} (package entry ${entryRel})`,
  runtime: `node ${process.version}`,
  manifest: relative(REPO, MANIFEST_PATH),
  manifestSpec: MANIFEST.spec ?? null,
  profilesDeclared: PROFILES,
  traits: TRAITS,
  rejectMap: REJECT_MAP.map((r) => ({ group: r.group, match: r.match, class: r.class })),
}
const summary = {
  rec: 'summary', total: records.length, pass: PASS, fail: FAIL, error: ERROR,
  unsupported: UNSUPPORTED, notApplicable: NA, exitCode: EXIT, wallMs,
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
const lines = [JSON.stringify(header), ...records.map((r) => JSON.stringify(r)), JSON.stringify(summary)]
writeFileSync(OUT_PATH, lines.join('\n') + '\n', 'utf8')
writeFileSync(`${OUT_PATH}.verdicts`,
  records.map((r) => `${r.id} ${r.status}`).join('\n') + '\n', 'utf8')

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

const short = (o, n = 150) => {
  const s = JSON.stringify(o)
  return s === undefined ? 'undefined' : s.length > n ? `${s.slice(0, n)}...` : s
}

const DIVERGENCE_BY_CASE = new Map((MANIFEST.divergences ?? []).map((d) => [d.caseId, d]))

if (!FLAGS.quiet) {
  const W = 78
  console.log('='.repeat(W))
  console.log('arCCade Game SDK conformance - javascript runner')
  console.log('='.repeat(W))
  console.log(`implementation   ${header.implementation}`)
  console.log(`entry point      ${relative(REPO, entryPath)}  (resolved through package exports["."])`)
  console.log(`runtime          ${header.runtime}`)
  console.log(`manifest         ${header.manifest}  (${MANIFEST.spec}, ${ALL_CASES.length} cases)`)
  console.log(`profiles         ${PROFILES.join(', ')}`)
  console.log(`traits           ${Object.entries(TRAITS).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  console.log(`selected         ${records.length} case(s)`)
  console.log('')

  const groupsInOrder = (MANIFEST.groups ?? []).map((g) => g.group)
  const pad = (s, n) => String(s).padEnd(n)
  const lpad = (s, n) => String(s).padStart(n)

  console.log(`${pad('GROUP', 24)} ${lpad('CASES', 6)} ${lpad('PASS', 5)} ${lpad('FAIL', 5)} ${lpad('ERR', 4)} ${lpad('UNSUP', 6)} ${lpad('N/A', 4)}`)
  console.log('-'.repeat(W))
  for (const g of groupsInOrder) {
    const rs = records.filter((r) => r.group === g)
    if (!rs.length) continue
    const p = rs.filter((r) => r.status === 'pass').length
    const f = rs.filter((r) => r.status === 'fail').length
    const e = rs.filter((r) => r.status === 'error').length
    const u = rs.filter((r) => r.status === 'unsupported').length
    const n = rs.filter((r) => r.status === 'not-applicable').length
    const mark = (f + e + u) ? ' RED' : ''
    console.log(`${pad(g, 24)} ${lpad(rs.length, 6)} ${lpad(p, 5)} ${lpad(f, 5)} ${lpad(e, 4)} ${lpad(u, 6)} ${lpad(n, 4)}${mark}`)
  }
  console.log('-'.repeat(W))
  console.log(`${pad('TOTAL', 24)} ${lpad(records.length, 6)} ${lpad(PASS, 5)} ${lpad(FAIL, 5)} ${lpad(ERROR, 4)} ${lpad(UNSUPPORTED, 6)} ${lpad(NA, 4)}`)
  console.log('')

  // Profile matrix. A profile carrying an unsupported capability is not
  // conformant, whatever its pass count says.
  console.log(`${pad('PROFILE', 20)} ${lpad('CASES', 6)} ${lpad('PASS', 5)} ${lpad('RED', 5)}  VERDICT`)
  console.log('-'.repeat(W))
  for (const p of PROFILES) {
    const rs = records.filter((r) => r.profile === p)
    if (!rs.length) continue
    const pa = rs.filter((r) => r.status === 'pass').length
    const red = rs.filter((r) => ['fail', 'error', 'unsupported'].includes(r.status)).length
    const un = rs.filter((r) => r.status === 'unsupported').length
    const verdict = red === 0 ? 'CONFORMANT'
      : un === red ? `NOT CONFORMANT (${un} unsupported)`
        : `NOT CONFORMANT (${red - un} wrong, ${un} unsupported)`
    console.log(`${pad(p, 20)} ${lpad(rs.length, 6)} ${lpad(pa, 5)} ${lpad(red, 5)}  ${verdict}`)
  }
  console.log('')

  const reds = records.filter((r) => ['fail', 'error', 'unsupported'].includes(r.status))
  if (reds.length) {
    console.log('='.repeat(W))
    console.log(`RED CASES (${reds.length})`)
    console.log('='.repeat(W))
    let lastGroup = null
    for (const r of [...reds].sort((a, b) => {
      const ga = groupsInOrder.indexOf(a.group), gb = groupsInOrder.indexOf(b.group)
      return ga !== gb ? ga - gb : (a.id < b.id ? -1 : 1)
    })) {
      if (r.group !== lastGroup) { console.log(''); console.log(`-- ${r.group} --`); lastGroup = r.group }
      const dv = DIVERGENCE_BY_CASE.get(r.id)
      const tag = dv ? `  [recorded divergence ${dv.decision}]` : ''
      console.log(`  ${r.status.toUpperCase()}  ${r.id}${tag}`)
      if (r.status === 'unsupported') {
        console.log(`        capability ${r.capability}: ${r.observed.reason}`)
      } else if (r.status === 'error') {
        console.log(`        capability ${r.capability}: ${r.observed.reason}`)
        if (r.observed.errorText) console.log(`        errorText: ${r.observed.errorText}`)
      } else {
        console.log(`        expected: ${short(r.expected)}`)
        console.log(`        observed: ${short({ ...r.observed, errorText: undefined })}`)
        if (r.observed.errorText) console.log(`        errorText: ${r.observed.errorText}`)
        if (r.observed.firstDivergentByte !== undefined) {
          console.log(`        first divergent byte: ${r.observed.firstDivergentByte}`)
        }
        if (dv) console.log(`        why it is red on purpose: ${dv.reason}`)
      }
    }
    console.log('')
  }

  // A rule that never fires is a rule nothing exercises. Say so rather than
  // letting the table look better covered than it is.
  const unusedRules = REJECT_MAP.filter((r) => r.used === 0)
  if (unusedRules.length && !caseFilter.size && !groupFilter.size && PROFILES.length === PROFILES_AVAILABLE.length) {
    console.log(`reject-map rules never exercised by this run (${unusedRules.length}):`)
    for (const r of unusedRules) console.log(`  ${r.group} | ${r.match} | ${r.class}`)
    console.log('')
  }

  console.log('='.repeat(W))
  console.log('SUMMARY')
  console.log('='.repeat(W))
  console.log(`total ${records.length}  pass ${PASS}  fail ${FAIL}  error ${ERROR}  unsupported ${UNSUPPORTED}  not-applicable ${NA}`)

  // The manifest states, up front, how much red it expects: which cases are
  // recorded divergences from a normative decision, and how many sit on a
  // capability no client implements. Anything red beyond those two sets is a
  // surprise, and a surprise is the only thing here worth waking someone for.
  const knownDivergent = reds.filter((r) => r.status === 'fail' && DIVERGENCE_BY_CASE.has(r.id))
  // The manifest's own catalog predicts, per client, which capabilities have no
  // implementation: `impl.js === null`. An unsupported case on a capability the
  // catalog says JS DOES implement is not expected red, it is a gap between the
  // catalog and the published entry point, and it lands in `unaccounted`.
  const predictedUnsupported = reds.filter((r) =>
    r.status === 'unsupported' && (CAPS.get(r.capability)?.impl?.js ?? null) === null)
  const noClientAtAll = predictedUnsupported.filter((r) =>
    CAPS.get(r.capability)?.implementedByAnyClient === false)
  const unaccounted = reds.filter((r) =>
    !knownDivergent.includes(r) && !predictedUnsupported.includes(r))
  console.log(`red ${RED}`)
  console.log(`  ${knownDivergent.length} recorded divergences (the suite ships red by design)`)
  console.log(`  ${predictedUnsupported.length} on capabilities the catalog records as unimplemented in JS`)
  console.log(`    of those, ${noClientAtAll.length} are implemented by no client in any language`)
  console.log(`  ${unaccounted.length} unaccounted`)
  for (const r of unaccounted) console.log(`    UNACCOUNTED ${r.status} ${r.id} (${r.capability})`)

  // Cross-check against the counts the manifest publishes about itself. A
  // disagreement means either the manifest's stated red or this client moved,
  // and either way the headline "413 pass" would be describing something else.
  const wholeRun = !caseFilter.size && !groupFilter.size && PROFILES.length === PROFILES_AVAILABLE.length
  if (wholeRun) {
    const claims = [
      ['divergentCases', MANIFEST.summary?.divergentCases, FAIL],
      ['casesWithNoJavaScriptImpl', MANIFEST.summary?.casesWithNoJavaScriptImpl, UNSUPPORTED],
    ]
    // These two counts are claims the manifest makes about THIS client, and a
    // whole run is exactly the evidence that settles them. Printing the
    // mismatch and exiting 0 left the headline "414 pass" describing a manifest
    // that had already moved, so a mismatch is now a failure.
    for (const [name, declared, actual] of claims) {
      if (declared !== undefined && Number(declared) !== actual) {
        console.log(`  MISMATCH manifest.summary.${name}=${declared} but this run produced ${actual}`)
        SUMMARY_MISMATCH = true
      }
    }
  }
  console.log(`wall ${wallMs} ms`)
  console.log(`results  ${relative(REPO, OUT_PATH)}`)
  console.log(`verdicts ${relative(REPO, OUT_PATH)}.verdicts`)
  console.log(`exit ${EXIT}  (0 all green, 1 fail/error, 2 manifest, 3 unsupported in a declared profile)`)
}

// A manifest whose stated counts do not match what this client just did is a
// manifest problem, and exit 2 says exactly that: nothing about the run can be
// read until the file is regenerated.
process.exit(SUMMARY_MISMATCH ? 2 : EXIT)
