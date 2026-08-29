#!/usr/bin/env node
/**
 * Regenerates `conformance/manifest.json` by driving the JavaScript client.
 *
 * WHAT THIS SCRIPT IS FOR. The manifest claims that a byte sequence is the
 * canonical encoding of a payload. A hand-typed claim is a claim; a claim
 * produced by running the implementation, checked against the digests the
 * repository has already published, is evidence. So:
 *
 *   - Ordinary expectations are GENERATED. The generator calls the SDK through
 *     its package entry and writes down what came back. Nobody types a digest.
 *   - The already-published goldens (`5669632b…`, `0b2349e0…`, `c950347c…`,
 *     `f31cc766…`, `aa3de793…`, `01e89a90…`, the fixture root `910a515e…` and
 *     the live TestNet anchor `f3e0805b…`) are ASSERTED, not regenerated. If the
 *     implementation drifts away from any of them this script exits non-zero and
 *     writes nothing.
 *   - The normative decisions the design forces (SPEC D1–D11) are PINNED BY
 *     HAND, because no client agrees with them yet. For each one the generator
 *     runs the JS client anyway and records the disagreement as a divergence.
 *     A pinned divergence that has quietly started to agree is a failure too —
 *     a stale divergence is exactly as misleading as a stale waiver.
 *
 * PUBLIC API ONLY. The SDK is loaded by resolving `js/package.json`'s `exports`
 * map, the same path `import '@arccade/game-sdk'` takes for a consumer. Nothing
 * here reaches into `js/src/*.js` by hand, so a capability that does not ship
 * cannot be made to look supported.
 *
 * Usage:
 *   node generate.mjs            write manifest.json
 *   node generate.mjs --check    regenerate in memory, fail if manifest.json differs
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const MANIFEST_PATH = join(HERE, 'manifest.json')

const MANIFEST_VERSION = '1'
const SPEC_VERSION = 'conformance-v1'

// ---------------------------------------------------------------------------
// Load the SDK the way a consumer does: through the package entry point.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(REPO, 'js', 'package.json'), 'utf8'))
const entryRel = pkg.exports?.['.']?.import ?? pkg.main
if (!entryRel) fail('js/package.json declares no entry point')
const entryPath = resolve(join(REPO, 'js'), entryRel)

// ---------------------------------------------------------------------------
// The three clients' own version numbers, read from the three files a consumer
// installs from. `sdk.version` published the JavaScript one under a name that
// read as "the SDK's version", which is a claim only one of the three clients
// can make. They are recorded separately and held to a shared MINOR: a patch
// skew is a release in flight, and a minor skew means the suite is comparing
// two different contracts and calling the result parity.
// ---------------------------------------------------------------------------
function clientVersions() {
  const pyToml = readFileSync(join(REPO, 'python', 'pyproject.toml'), 'utf8')
  const pyMatch = pyToml.match(/^\s*version\s*=\s*"([^"]+)"/m)
  if (!pyMatch) fail('python/pyproject.toml declares no version')
  const pom = readFileSync(join(REPO, 'java', 'pom.xml'), 'utf8')
  // The FIRST <version> under the project element; dependency versions follow.
  const javaMatch = pom.match(/<artifactId>game-sdk<\/artifactId>\s*<version>([^<]+)<\/version>/)
    ?? pom.match(/<version>([^<]+)<\/version>/)
  if (!javaMatch) fail('java/pom.xml declares no version')
  const damlYaml = readFileSync(join(REPO, 'daml.yaml'), 'utf8')
  const damlMatch = damlYaml.match(/^version:\s*(\S+)/m)
  if (!damlMatch) fail('daml.yaml declares no version')
  return {
    javascript: pkg.version,
    python: pyMatch[1],
    java: javaMatch[1],
    daml: damlMatch[1],
  }
}
const CLIENT_VERSIONS = clientVersions()
{
  const minor = (v) => v.split('.').slice(0, 2).join('.')
  const minors = new Set(Object.values(CLIENT_VERSIONS).map(minor))
  if (minors.size !== 1) {
    fail('the clients do not share a minor version: ' +
      Object.entries(CLIENT_VERSIONS).map(([k, v]) => `${k}=${v}`).join(' ') +
      '. A conformance run across two different contracts is not a parity result.')
  }
}
if (!existsSync(entryPath)) fail(`package entry does not exist: ${entryPath}`)
// A capability reachable only from a file the package does not ship is a
// capability a consumer does not have. Assert the entry is inside `files`.
if (!(pkg.files ?? []).some((f) => entryRel.replace(/^\.\//, '').startsWith(f))) {
  fail(`package entry ${entryRel} is not covered by package.json "files"`)
}
const sdk = await import(pathToFileURL(entryPath).href)

const errors = []
function fail(msg) { console.error(`generate.mjs: ${msg}`); process.exit(2) }
function problem(msg) { errors.push(msg) }

// ---------------------------------------------------------------------------
// PACKAGE REFERENCES. `test-vectors/package-ids.json` is the only source.
//
// A bare hex literal in this file is a claim nothing can falsify, and the two
// that used to live here were exactly that: an SDK id five releases stale
// (1.0.0, while the shipped client is 1.5.x and the vetted package is 1.5.0)
// and an "amulet" id that was on no participant at all. Every builder case
// asserted its JSON shape against ids a participant answers with NOT_FOUND, so
// a client could be green on the builder profile and still emit a payload no
// ledger would accept.
//
// Two different questions, two different answers:
//
//   SUBMITTING — a client names OUR templates by package NAME
//   (`#arccade-game-sdk:...`). Canton resolves that to the highest vetted
//   version, so it cannot go stale on upgrade, and it is what
//   docs/INTEGRATION.md 2.3 and 7 tell integrators to pass. The builder cases
//   therefore carry the name reference: they pin the payload a documented
//   integration actually submits.
//
//   READING — the ledger always emits a package-id-qualified templateId, so a
//   name reference can never appear in a transaction stream. The synthetic
//   audit trees carry a real id from this file instead.
//
//   THIRD-PARTY — splice-amulet is DSO-governed and its id moves with every
//   release, which is why gameCustody.js resolves it at runtime off the
//   AmuletRules templateId rather than pinning it. The value recorded here is
//   a WITNESS of what was live when the fixture was cut, not a constant; the
//   builder cases treat it as the caller-supplied parameter it is.
// ---------------------------------------------------------------------------

const PACKAGE_IDS_PATH = join(REPO, 'test-vectors', 'package-ids.json')
const PACKAGE_IDS = JSON.parse(readFileSync(PACKAGE_IDS_PATH, 'utf8'))
const HEX64 = /^[0-9a-f]{64}$/

/** The package-NAME reference for our own package, e.g. `#arccade-game-sdk`. */
const SDK_PACKAGE_REF = PACKAGE_IDS.packageNameReference
if (SDK_PACKAGE_REF !== `#${PACKAGE_IDS.packageName}`) {
  fail(`package-ids.json: packageNameReference ${JSON.stringify(SDK_PACKAGE_REF)} is not #${PACKAGE_IDS.packageName}`)
}

/** A vetted main-package id of ours, by version. Never a literal at the call site. */
function sdkPackageId(version) {
  const id = PACKAGE_IDS.ids?.[version]
  if (!id) fail(`package-ids.json records no id for arccade-game-sdk ${version}`)
  if (!HEX64.test(id)) fail(`package-ids.json: the id for ${version} is not a package id: ${id}`)
  // A reader fixture claims the ledger emitted this id. It cannot have, if the
  // network never vetted the package.
  if (!(PACKAGE_IDS.vettedOnTestNet ?? []).includes(version)) {
    fail(`arccade-game-sdk ${version} is not in vettedOnTestNet; no fixture may claim a ledger emitted it`)
  }
  return id
}

/** A third-party package id, by package name, with its provenance on file. */
function externalPackageId(name) {
  const e = (PACKAGE_IDS.external?.packages ?? []).find((x) => x.packageName === name)
  if (!e) fail(`package-ids.json external.packages records no entry for ${name}`)
  if (!HEX64.test(e.id)) fail(`package-ids.json: the ${name} id is not a package id: ${e.id}`)
  return e.id
}

/** Every package id this repository is willing to name, and what it is. */
const KNOWN_PACKAGE_IDS = new Map([
  ...Object.entries(PACKAGE_IDS.ids ?? {}).map(([v, id]) => [id, `arccade-game-sdk ${v}`]),
  ...(PACKAGE_IDS.external?.packages ?? []).map((p) => [p.id, `${p.packageName} ${p.version}`]),
])

// ---------------------------------------------------------------------------
// Tagged values (ArgValue). No JSON number ever appears under input/expect.
// ---------------------------------------------------------------------------

const utf8hex = (s) => Buffer.from(s, 'utf8').toString('hex')
const textPin = (s) => ({ v: s, vHex: utf8hex(s) })

const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

const A = {
  text: (v) => ({ t: 'text', v, vHex: utf8hex(v) }),
  // Text whose bytes are the point of the case; identical shape, kept separate
  // so the intent reads at the call site.
  bytes: (v) => ({ t: 'text', v, vHex: utf8hex(v) }),
  int: (v) => {
    const b = BigInt(v)
    const o = { t: 'int', v: b.toString() }
    if (b > INT64_MAX || b < INT64_MIN) o.wide = true
    return o
  },
  dec: (v) => ({ t: 'dec', v: String(v) }),
  bool: (v) => ({ t: 'bool', v }),
  micros: (v) => ({ t: 'micros', v: BigInt(v).toString() }),
  party: (v) => ({ t: 'party', v, vHex: utf8hex(v) }),
  hex64: (v) => ({ t: 'hex64', v }),
  raw: (v) => ({ t: 'raw', v, vHex: utf8hex(v) }),
  nul: () => ({ t: 'null', v: null }),
  list: (v) => ({ t: 'list', v }),
  pairs: (v) => ({ t: 'pairs', v }),
  record: (schema, fields) => ({ t: 'record', v: { schema, fields } }),
  steps: (v) => ({ t: 'steps', v }),
  float64: (approx) => {
    const buf = Buffer.alloc(8)
    buf.writeDoubleBE(Number(approx))
    return { t: 'float64', v: { bits: buf.toString('hex'), approx: String(approx) } }
  },
  // v1 extension over the design's enum: a JSON value passed verbatim. Used for
  // ledger transaction trees, whose shape is the Ledger API's, not ours. The
  // no-JSON-numbers rule is enforced over it like everywhere else, which is why
  // the fixtures below carry offsets as strings or not at all.
  json: (v) => ({ t: 'json', v }),
}

function decode(a) {
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
    default: throw new Error(`decode: unknown tag ${a.t}`)
  }
}

// ---------------------------------------------------------------------------
// Reject classes and the table that maps a native throw onto one.
//
// The map is keyed by capability GROUP, never by case: a per-case map would let
// a client pass by naming the answer. No rule may be a catch-all.
// ---------------------------------------------------------------------------

const REJECT_CLASSES = [
  'bad-type', 'bad-format', 'out-of-range', 'precision-loss',
  'unknown-tag', 'invariant-violated', 'not-injective',
]

const REJECT_MAP = [
  { group: 'digest.amount', match: 'kayipsiz cevrilemedi', class: 'precision-loss' },
  { group: 'digest.amount', match: 'bandin disinda', class: 'out-of-range' },
  { group: 'digest.amount', match: 'Number olarak verilemez', class: 'bad-type' },
  { group: 'digest.amount', match: 'desteklenmeyen tutar turu', class: 'bad-type' },
  { group: 'digest.amount', match: 'gecersiz ondalik tutar', class: 'bad-format' },
  { group: 'digest.fields', match: 'alan adi ASCII', class: 'bad-format' },
  { group: 'audit', match: 'gecersiz disposition', class: 'unknown-tag' },
  { group: 'audit', match: 'unknown disposition', class: 'unknown-tag' },
  { group: 'audit', match: 'unparsable ledger timestamp', class: 'bad-format' },
  { group: 'identity', match: "iceremez", class: 'not-injective' },
  { group: 'identity', match: 'gecersiz cycleId', class: 'out-of-range' },
  { group: 'identity', match: 'gecersiz tradeId', class: 'out-of-range' },
  { group: 'identity', match: '64 karakterlik kucuk harf sha256', class: 'bad-format' },
  { group: 'identity', match: 'gecersiz varlik kimligi', class: 'bad-format' },
  { group: 'identity', match: 'gecersiz ornek kimligi', class: 'bad-format' },
  { group: 'identity', match: 'gecersiz kiraci kimligi', class: 'bad-format' },
  { group: 'identity', match: 'ardisik tire', class: 'bad-format' },
  { group: 'identity', match: 'gecersiz item kimligi', class: 'bad-format' },
  { group: 'identity', match: 'item kimliginde', class: 'not-injective' },
  { group: 'identity', match: 'kiraci izolasyonu ihlali', class: 'invariant-violated' },
  { group: 'assets', match: 'benzersiz varligin miktari', class: 'invariant-violated' },
  { group: 'assets', match: 'varlik miktari pozitif olmali', class: 'out-of-range' },
  { group: 'assets', match: 'ozellik degeri tamsayi ya da metin olmali', class: 'bad-type' },
  { group: 'value-documents', match: 'tutari pozitif olmali', class: 'out-of-range' },
  { group: 'value-documents', match: 'sender ve receiver ayni olamaz', class: 'invariant-violated' },
  { group: 'value-documents', match: 'sender ve receiver ister', class: 'bad-type' },
  { group: 'value-documents', match: 'instrumentId {admin, id} olmali', class: 'bad-type' },
  { group: 'builder', match: 'ReturnedInFull stake in tamamini', class: 'invariant-violated' },
  { group: 'builder', match: 'ForfeitedInFull hicbir sey', class: 'invariant-violated' },
  { group: 'builder', match: 'outcomeDocument ya da outcomeDigest', class: 'bad-type' },
  { group: 'builder', match: 'inputAmuletCids bos olamaz', class: 'invariant-violated' },
  { group: 'builder', match: 'en az bir alici gerekli', class: 'invariant-violated' },
  { group: 'builder', match: 'takas iki bacak ister', class: 'invariant-violated' },
  { group: 'builder', match: 'settle icin her bacagin', class: 'invariant-violated' },
  // The builders delegate to the identifier and transfer validators, so their
  // messages have to be classifiable under the builder group as well.
  { group: 'builder', match: 'iceremez', class: 'not-injective' },
  { group: 'builder', match: 'gecersiz cycleId', class: 'out-of-range' },
  { group: 'builder', match: '64 karakterlik kucuk harf sha256', class: 'bad-format' },
  { group: 'builder', match: 'bilinmeyen sebep', class: 'unknown-tag' },
  { group: 'builder', match: 'kendine transfer reddedilir', class: 'invariant-violated' },
  { group: 'builder', match: 'ayni alici tekrar edemez', class: 'invariant-violated' },
  { group: 'builder', match: 'transfer tutari pozitif olmali', class: 'out-of-range' },
  { group: 'quota', match: 'gecersiz kiraci kimligi', class: 'bad-format' },
  // Rejections raised by the references in this file for capabilities no client
  // implements. They are classified by the same table as every other throw, so
  // a runner that later implements the capability can reuse the mapping.
  { group: 'audit', match: 'must equal the stake', class: 'invariant-violated' },
  { group: 'audit', match: 'cannot forfeit', class: 'invariant-violated' },
  { group: 'audit', match: 'cannot return', class: 'invariant-violated' },
  { group: 'audit', match: 'needs both sides non-zero', class: 'invariant-violated' },
  { group: 'audit', match: 'return the stake in full', class: 'invariant-violated' },
  { group: 'audit', match: 'negative settlement amount', class: 'out-of-range' },
  { group: 'audit', match: 'payout above the policy cap', class: 'invariant-violated' },
  { group: 'audit', match: 'duplicate cycleId in a period', class: 'invariant-violated' },
]
for (const r of REJECT_MAP) {
  if (!REJECT_CLASSES.includes(r.class)) fail(`reject map: unknown class ${r.class}`)
  if (r.match.length < 4 || r.match === '.*') fail(`reject map: rule too broad: ${r.match}`)
  r.used = 0
}

function classify(group, message) {
  for (const r of REJECT_MAP) {
    if (r.group === group && message.includes(r.match)) { r.used += 1; return r.class }
  }
  return null
}

// ---------------------------------------------------------------------------
// Capability catalog.
//
// `impl.<lang>` names the published entry point that client reaches for this
// capability, or null when that client does not implement it. It is not an
// exemption: a null still leaves the cases in place, the runner for that
// language reports `unsupported`, and a declared profile is non-conformant.
//
// These strings are NOT free prose. Each runner cross-checks the value for its
// own language against its own dispatch table at startup and exits 2 on
// disagreement (`run.mjs`, `run.py`, `Runner.java`: checkCatalogImplClaims).
// That is what keeps this column from drifting into decoration: the entry that
// says Python does not implement `time.addSeconds` is refuted by the Python
// runner the moment Python does.
//
// The nine remaining nulls are all `js`. The JavaScript client is the one that
// has not caught up with Python and Java, which is the opposite of what this
// column said before it was measured.
// ---------------------------------------------------------------------------

const CAPS = new Map()
function cap(id, spec) {
  if (CAPS.has(id)) fail(`duplicate capability ${id}`)
  CAPS.set(id, { id, args: [], ...spec, cases: 0 })
}

const asDoc = (text) => ({ text, digest: sdk.textDigest(text) })
const canonTimeMicrosBig = (m) => sdk.canonTimeMicros(BigInt(m))

// -- core-digest ------------------------------------------------------------

cap('digest.canon', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'text',
  argTypes: [['text'], ['text']],
  impl: { js: 'canon', python: 'canon', java: 'ArccadeDigest.canon' },
  run: ([tag, value]) => sdk.canon(tag, value),
})
cap('digest.canonText', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'text',
  argTypes: [['text']],
  impl: { js: 'canonText', python: 'canon_text', java: 'ArccadeDigest.canonText' },
  run: ([s]) => sdk.canonText(s),
})
cap('digest.canonInt', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'text',
  argTypes: [['int', 'bool']],
  impl: { js: 'canonInt', python: 'canon_int', java: 'ArccadeDigest.canonInt' },
  run: ([i]) => sdk.canonInt(i),
})
cap('digest.canonBool', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'text',
  argTypes: [['bool']],
  impl: { js: 'canonBool', python: 'canon_bool', java: 'ArccadeDigest.canonBool' },
  run: ([b]) => sdk.canonBool(b),
})
cap('digest.canonDecimal', {
  profile: 'core-digest', rejectGroup: 'digest.amount', returns: 'text',
  argTypes: [['dec', 'int', 'text', 'float64']],
  impl: { js: 'canonDecimal', python: 'canon_decimal', java: 'ArccadeDigest.canonDecimal' },
  run: ([d]) => sdk.canonDecimal(d),
})
cap('digest.canonTimeMicros', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'text',
  argTypes: [['micros']],
  impl: { js: 'canonTimeMicros', python: 'canon_time_micros', java: 'ArccadeDigest.canonTimeMicros' },
  run: ([m]) => canonTimeMicrosBig(m),
})
cap('digest.canonTime', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'text',
  argTypes: [['text']],
  impl: { js: 'canonTime', python: 'canon_time', java: 'ArccadeDigest.canonTime' },
  run: ([iso]) => sdk.canonTime(iso),
})
cap('digest.canonParty', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'text',
  argTypes: [['party']],
  impl: { js: 'canonParty', python: 'canon_party', java: 'ArccadeDigest.canonParty' },
  run: ([p]) => sdk.canonParty(p),
})
cap('digest.canonOptional', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'text',
  argTypes: [['text', 'null']],
  note: 'inner encoder is canonText; that is the only shape any shipped document could use',
  impl: { js: 'canonOptional', python: 'canon_optional', java: 'ArccadeDigest.canonOptional' },
  run: ([x]) => sdk.canonOptional(sdk.canonText, x),
})
cap('digest.canonList', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'text',
  argTypes: [['list']],
  impl: { js: 'canonList', python: 'canon_list', java: 'ArccadeDigest.canonList' },
  run: ([xs]) => sdk.canonList(xs),
})
cap('digest.canonFields', {
  profile: 'core-digest', rejectGroup: 'digest.fields', returns: 'text',
  argTypes: [['pairs']],
  note: 'assertFieldName is not exported; the ASCII field-name rule is reachable only through canonFields, and that is where the suite exercises it',
  impl: { js: 'canonFields', python: 'canon_fields', java: 'ArccadeDigest.canonFields' },
  run: ([kvs]) => sdk.canonFields(kvs),
})
cap('digest.codePointLength', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'int',
  argTypes: [['text']],
  impl: { js: 'codePointLength', python: 'code_point_length', java: 'ArccadeDigest.codePointLength' },
  run: ([s]) => BigInt(sdk.codePointLength(s)),
})
cap('digest.amountUnits', {
  profile: 'core-digest', rejectGroup: 'digest.amount', returns: 'int',
  argTypes: [['dec', 'int', 'text', 'float64']],
  impl: { js: 'amountUnits', python: 'amount_units', java: 'ArccadeDigest.amountUnits' },
  run: ([d]) => sdk.amountUnits(d),
})
cap('digest.canonDocument', {
  profile: 'core-digest', rejectGroup: 'digest.fields', returns: 'document',
  argTypes: [['text'], ['int'], ['pairs']],
  impl: { js: 'canonDocument', python: 'canon_document', java: 'ArccadeDigest.canonDocument' },
  run: ([schema, version, kvs]) => asDoc(sdk.canonDocument(schema, version, kvs)),
})
cap('digest.textDigest', {
  profile: 'core-digest', rejectGroup: 'digest.text', returns: 'digest',
  argTypes: [['text']],
  impl: { js: 'textDigest', python: 'text_digest', java: 'ArccadeDigest.textDigest' },
  run: ([t]) => sdk.textDigest(t),
})
cap('digest.constant', {
  profile: 'core-digest', rejectGroup: 'digest.scalar', returns: 'value',
  argTypes: [['text']],
  note: 'reads an exported wire constant by name; a rename invalidates every commitment already on the ledger, so each constant gets a case',
  impl: { js: 'named export', python: 'module attribute', java: 'static field' },
  run: ([name]) => {
    const v = sdk[name]
    if (v === undefined) throw new Error(`arccade-conformance: unknown constant ${name}`)
    return Array.isArray(v) ? A.list(v.map((x) => A.text(x))) : A.text(String(v))
  },
})

// -- merkle -----------------------------------------------------------------

cap('merkle.merkleEmpty', {
  profile: 'merkle', rejectGroup: 'merkle', returns: 'digest', argTypes: [],
  impl: { js: 'merkleEmpty', python: 'merkle_empty', java: 'ArccadeMerkle.merkleEmpty' },
  run: () => sdk.merkleEmpty(),
})
cap('merkle.merkleNode', {
  profile: 'merkle', rejectGroup: 'merkle', returns: 'digest',
  argTypes: [['hex64'], ['hex64']],
  impl: { js: 'merkleNode', python: 'merkle_node', java: 'ArccadeMerkle.merkleNode' },
  run: ([l, r]) => sdk.merkleNode(l, r),
})
cap('merkle.merklePairUp', {
  profile: 'merkle', rejectGroup: 'merkle', returns: 'value',
  argTypes: [['list']],
  impl: { js: 'merklePairUp', python: 'merkle_pair_up', java: 'ArccadeMerkle.merklePairUp' },
  run: ([level]) => A.list(sdk.merklePairUp(level).map((h) => A.hex64(h))),
})
cap('merkle.merkleRoot', {
  profile: 'merkle', rejectGroup: 'merkle', returns: 'digest',
  argTypes: [['list']],
  impl: { js: 'merkleRoot', python: 'merkle_root', java: 'ArccadeMerkle.merkleRoot' },
  run: ([leaves]) => sdk.merkleRoot(leaves),
})
cap('merkle.merkleProof', {
  profile: 'merkle', rejectGroup: 'merkle', returns: 'steps',
  argTypes: [['int'], ['list']],
  impl: { js: 'merkleProof', python: 'merkle_proof', java: 'ArccadeMerkle.merkleProof' },
  run: ([ix, leaves]) => sdk.merkleProof(Number(ix), leaves),
})
cap('merkle.merkleFold', {
  profile: 'merkle', rejectGroup: 'merkle', returns: 'digest',
  argTypes: [['hex64'], ['steps']],
  impl: { js: 'merkleFold', python: 'merkle_fold', java: 'ArccadeMerkle.merkleFold' },
  run: ([leaf, steps]) => sdk.merkleFold(leaf, steps),
})
cap('merkle.merkleVerify', {
  profile: 'merkle', rejectGroup: 'merkle', returns: 'bool',
  argTypes: [['hex64'], ['steps'], ['hex64']],
  impl: { js: 'merkleVerify', python: 'merkle_verify', java: 'ArccadeMerkle.merkleVerify' },
  run: ([leaf, steps, root]) => sdk.merkleVerify(leaf, steps, root),
})

// -- audit ------------------------------------------------------------------

cap('audit.periodLeafDocument', {
  profile: 'audit', rejectGroup: 'audit', returns: 'document',
  argTypes: [['record']], schema: 'cycle-audit-row',
  impl: { js: 'periodLeafDocument', python: 'period_leaf_document', java: 'PeriodAuditDocuments.periodLeafDocument' },
  run: ([row]) => asDoc(sdk.periodLeafDocument(row)),
})
cap('audit.periodRowVerify', {
  profile: 'audit', rejectGroup: 'audit', returns: 'bool',
  argTypes: [['record'], ['steps'], ['hex64']],
  impl: { js: 'periodRowVerify', python: 'period_row_verify', java: 'PeriodAuditDocuments.periodRowVerify' },
  run: ([row, steps, root]) => sdk.periodRowVerify(row, steps, root),
})
cap('audit.isoToMicros', {
  profile: 'audit', rejectGroup: 'audit', returns: 'int',
  argTypes: [['text']],
  impl: { js: 'isoToMicros', python: 'iso_to_micros', java: 'CycleAuditReader.isoToMicros' },
  run: ([iso]) => sdk.isoToMicros(iso),
})
cap('audit.rowsFromTransactions', {
  profile: 'audit', rejectGroup: 'audit', returns: 'value',
  argTypes: [['list']],
  impl: { js: 'rowsFromTransactions', python: 'rows_from_transactions', java: 'CycleAuditReader.rowsFromTransactions' },
  run: ([txs]) => A.list(sdk.rowsFromTransactions(txs).rows.map((r) => rowArg(sdk.toLeafRow(r)))),
})
cap('audit.reportOrder', {
  profile: 'audit', rejectGroup: 'audit', returns: 'order',
  argTypes: [['list']],
  impl: { js: 'rowsFromTransactions(sort)', python: 'rows_from_transactions(sort)', java: 'CycleAuditReader.rowsFromTransactions(sort)' },
  run: ([txs]) => sdk.rowsFromTransactions(txs).rows.map((r) => r.cycleId),
})
cap('audit.unmatchedHalves', {
  profile: 'audit', rejectGroup: 'audit', returns: 'value',
  argTypes: [['list']],
  note: 'openStakes and orphanClosings must be surfaced, not dropped: a commit whose closing fell outside the window is exactly the omission the anchor exists to make provable',
  impl: { js: 'rowsFromTransactions', python: 'rows_from_transactions', java: 'CycleAuditReader.rowsFromTransactions' },
  run: ([txs]) => {
    const r = sdk.rowsFromTransactions(txs)
    return A.pairs([
      [A.text('openStakes'), A.list(r.openStakes.map((x) => A.text(x)))],
      [A.text('orphanClosings'), A.list(r.orphanClosings.map((x) => A.text(x)))],
    ])
  },
})
cap('audit.unlockWarnings', {
  profile: 'audit', rejectGroup: 'audit', returns: 'value',
  argTypes: [['list']],
  impl: { js: 'rowsFromTransactions', python: 'rows_from_transactions', java: 'CycleAuditReader.rowsFromTransactions' },
  run: ([txs]) => A.list(sdk.rowsFromTransactions(txs).warnings.map((w) => A.pairs([
    [A.text('cycleId'), A.text(w.cycleId)],
    [A.text('kind'), A.text(w.kind)],
    [A.text('stated'), A.int(w.stated)],
    [A.text('unlocked'), A.int(w.unlocked)],
  ]))),
})
cap('audit.anchorDocument', {
  profile: 'audit', rejectGroup: 'audit', returns: 'document',
  argTypes: [['record']], schema: 'period-anchor',
  note: 'Daml decides the period anchor and the live TestNet anchor is on disk. All three shipped clients now recompose it; the expectation is still the generator reference (or a Daml literal), never the client, so the client is measured rather than believed.',
  impl: { js: 'anchorDocument', python: 'anchor_document', java: 'PeriodAnchorDocuments.anchorDocument' },
  run: ([a]) => asDoc(sdk.anchorDocument(a)),
})
cap('audit.anchorTotals', {
  profile: 'audit', rejectGroup: 'audit', returns: 'value',
  argTypes: [['list']],
  note: 'GameVenue_AnchorPeriod derives the totals from the rows rather than taking them; a correct root says nothing about whether the summary fields are correct',
  impl: { js: 'anchorTotals', python: 'anchor_totals', java: 'PeriodAnchorDocuments.anchorTotals' },
  run: ([rows]) => A.pairs(Object.entries(sdk.anchorTotals(rows)).map(([k, v]) => [A.text(k), A.int(v)])),
})
cap('policy.policyDocument', {
  profile: 'audit', rejectGroup: 'audit', returns: 'document',
  argTypes: [['record']], schema: 'venue-policy',
  impl: { js: 'policyDocument', python: 'policy_document', java: 'PolicyDocuments.policyDocument' },
  run: ([p]) => asDoc(sdk.policyDocument(p)),
})
cap('policy.validPolicy', {
  profile: 'audit', rejectGroup: 'audit', returns: 'bool',
  argTypes: [['record']], schema: 'venue-policy',
  impl: { js: 'validPolicy', python: 'valid_policy', java: 'PolicyDocuments.validPolicy' },
  run: ([p]) => sdk.validPolicy(p),
})
cap('settlement.assertSettlementValid', {
  profile: 'audit', rejectGroup: 'audit', returns: 'bool',
  argTypes: [['record']], schema: 'settlement',
  note: 'the settlement arithmetic Cycle.daml enforces; conservation is the one property a Merkle proof cannot express, so a report can otherwise state amounts the ledger would have refused while every proof still verifies. All three clients re-check it.',
  impl: { js: 'assertSettlementValid', python: 'assert_settlement_valid', java: 'SettlementInvariants.assertSettlementValid' },
  run: ([s]) => sdk.assertSettlementValid(s),
})

// -- identity ---------------------------------------------------------------

cap('cycle.assertValidCycleId', {
  profile: 'identity', rejectGroup: 'identity', returns: 'accept',
  argTypes: [['text']],
  impl: { js: 'assertValidCycleId', python: 'assert_valid_cycle_id', java: 'CycleCommands.assertValidCycleId' },
  run: ([id]) => { sdk.assertValidCycleId(id); return id },
})
cap('cycle.assertHex64', {
  profile: 'identity', rejectGroup: 'identity', returns: 'accept',
  argTypes: [['text']],
  impl: { js: 'assertHex64', python: 'assert_hex64', java: 'CycleCommands.assertHex64' },
  run: ([h]) => { sdk.assertHex64(h); return h },
})
cap('cycle.custodyTagFor', {
  profile: 'identity', rejectGroup: 'identity', returns: 'text',
  argTypes: [['text'], ['text']],
  impl: { js: 'custodyTagFor', python: 'custody_tag_for', java: 'CycleCommands.custodyTagFor' },
  run: ([id, d]) => sdk.custodyTagFor(id, d),
})
cap('trade.assertValidTradeId', {
  profile: 'identity', rejectGroup: 'identity', returns: 'accept',
  argTypes: [['text']],
  impl: { js: 'assertValidTradeId', python: 'assert_valid_trade_id', java: 'TradeCommands.assertValidTradeId' },
  run: ([id]) => { sdk.assertValidTradeId(id); return id },
})
cap('assets.assertValidLocalId', {
  profile: 'identity', rejectGroup: 'identity', returns: 'accept',
  argTypes: [['text']],
  impl: { js: 'assertValidLocalId', python: 'assert_valid_local_id', java: 'Assets.assertValidLocalId' },
  run: ([id]) => { sdk.assertValidLocalId(id); return id },
})
cap('tenant.assertValidTenantId', {
  profile: 'identity', rejectGroup: 'identity', returns: 'accept',
  argTypes: [['text']],
  impl: { js: 'assertValidTenantId', python: 'assert_valid_tenant_id', java: 'Tenancy.assertValidTenantId' },
  run: ([id]) => { sdk.assertValidTenantId(id); return id },
})
cap('tenant.namespacedInstrumentId', {
  profile: 'identity', rejectGroup: 'identity', returns: 'value',
  argTypes: [['party'], ['text'], ['text']],
  impl: { js: 'namespacedInstrumentId', python: 'namespaced_instrument_id', java: 'Tenancy.namespacedInstrumentId' },
  run: ([reg, tid, lid]) => instrArg(sdk.namespacedInstrumentId(reg, tid, lid)),
})
cap('tenant.parseInstrumentId', {
  profile: 'identity', rejectGroup: 'identity', returns: 'value',
  argTypes: [['record']], schema: 'instrument-id',
  impl: { js: 'parseInstrumentId', python: 'parse_instrument_id', java: 'Tenancy.parseInstrumentId' },
  run: ([i]) => {
    const p = sdk.parseInstrumentId(i)
    return A.pairs([
      [A.text('tenantId'), p.tenantId === null ? A.nul() : A.text(p.tenantId)],
      [A.text('localId'), A.text(p.localId)],
    ])
  },
})
cap('tenant.assertTenantOwnsInstrument', {
  profile: 'identity', rejectGroup: 'identity', returns: 'accept',
  argTypes: [['text'], ['record']], schema: 'instrument-id',
  impl: { js: 'assertTenantOwnsInstrument', python: 'assert_tenant_owns_instrument', java: 'Tenancy.assertTenantOwnsInstrument' },
  run: ([tid, i]) => { sdk.assertTenantOwnsInstrument(tid, i); return tid },
})
cap('tenant.assertTenantLegs', {
  profile: 'identity', rejectGroup: 'identity', returns: 'accept',
  argTypes: [['text'], ['pairs']],
  impl: { js: 'assertTenantLegs', python: 'assert_tenant_legs', java: 'Tenancy.assertTenantLegs' },
  run: ([tid, legs]) => { sdk.assertTenantLegs(tid, Object.fromEntries(legs)); return tid },
})
cap('tenant.hashTenantKey', {
  profile: 'identity', rejectGroup: 'identity', returns: 'digest',
  argTypes: [['text']],
  impl: { js: 'hashTenantKey', python: 'hash_tenant_key', java: 'Tenancy.hashTenantKey' },
  run: ([s]) => sdk.hashTenantKey(s),
})
cap('tenant.tenantIdFromKey', {
  profile: 'identity', rejectGroup: 'identity', returns: 'value',
  argTypes: [['text']],
  impl: { js: 'tenantIdFromKey', python: 'tenant_id_from_key', java: 'Tenancy.tenantIdFromKey' },
  run: ([s]) => { const r = sdk.tenantIdFromKey(s); return r === null ? A.nul() : A.text(r) },
})
cap('tenant.verifyTenantKey', {
  profile: 'identity', rejectGroup: 'identity', returns: 'bool',
  argTypes: [['text'], ['text']],
  note: 'value behaviour only. The constant-time guarantee is an explicit exclusion: a value-equality harness cannot observe timing, and a synthetic timing assertion would be flaky and defeatable.',
  impl: { js: 'verifyTenantKey', python: 'verify_tenant_key', java: 'Tenancy.verifyTenantKey' },
  run: ([s, h]) => sdk.verifyTenantKey(s, h),
})
cap('assets.fungibleInstrument', {
  profile: 'identity', rejectGroup: 'identity', returns: 'value',
  argTypes: [['party'], ['text'], ['text']],
  impl: { js: 'fungibleInstrument', python: 'fungible_instrument', java: 'Assets.fungibleInstrument' },
  run: ([reg, tid, lid]) => instrArg(sdk.fungibleInstrument(reg, tid, lid)),
})
cap('assets.uniqueInstrument', {
  profile: 'identity', rejectGroup: 'identity', returns: 'value',
  argTypes: [['party'], ['text'], ['text'], ['text']],
  impl: { js: 'uniqueInstrument', python: 'unique_instrument', java: 'Assets.uniqueInstrument' },
  run: ([reg, tid, lid, iid]) => instrArg(sdk.uniqueInstrument(reg, tid, lid, iid)),
})
cap('assets.parseAsset', {
  profile: 'identity', rejectGroup: 'identity', returns: 'value',
  argTypes: [['record']], schema: 'instrument-id',
  impl: { js: 'parseAsset', python: 'parse_asset', java: 'Assets.parseAsset' },
  run: ([i]) => {
    const p = sdk.parseAsset(i)
    return A.pairs([
      [A.text('tenantId'), p.tenantId === null ? A.nul() : A.text(p.tenantId)],
      [A.text('localId'), A.text(p.localId)],
      [A.text('instanceId'), p.instanceId === null ? A.nul() : A.text(p.instanceId)],
      [A.text('assetClass'), A.text(p.assetClass)],
    ])
  },
})
cap('assets.isUnique', {
  profile: 'identity', rejectGroup: 'identity', returns: 'bool',
  argTypes: [['record']], schema: 'instrument-id',
  impl: { js: 'isUnique', python: 'is_unique', java: 'Assets.isUnique' },
  run: ([i]) => sdk.isUnique(i),
})
cap('assets.assertAmountValidForAsset', {
  profile: 'identity', rejectGroup: 'assets', returns: 'accept',
  argTypes: [['record'], ['dec']], schema: 'instrument-id',
  impl: { js: 'assertAmountValidForAsset', python: 'assert_amount_valid_for_asset', java: 'Assets.assertAmountValidForAsset' },
  run: ([i, amt]) => { sdk.assertAmountValidForAsset(i, amt); return amt },
})
cap('assets.assetAttributeDocument', {
  profile: 'identity', rejectGroup: 'assets', returns: 'document',
  argTypes: [['record'], ['pairs']], schema: 'instrument-id',
  impl: { js: 'assetAttributeDocument', python: 'asset_attribute_document', java: 'Assets.assetAttributeDocument' },
  run: ([instrumentId, attrs]) => asDoc(sdk.assetAttributeDocument({
    instrumentId, attributes: Object.fromEntries(attrs),
  })),
})
cap('assets.deriveInstanceId', {
  profile: 'identity', rejectGroup: 'assets', returns: 'value',
  argTypes: [['text'], ['text'], ['pairs'], ['text']],
  impl: { js: 'deriveInstanceId', python: 'derive_instance_id', java: 'Assets.deriveInstanceId' },
  run: ([tenantId, localId, attrs, salt]) => A.text(sdk.deriveInstanceId({
    tenantId, localId, attributes: Object.fromEntries(attrs), salt,
  })),
})

// -- value documents --------------------------------------------------------

cap('trade.tradeDocument', {
  profile: 'value-documents', rejectGroup: 'value-documents', returns: 'document',
  argTypes: [['record']], schema: 'trade',
  impl: { js: 'tradeDocument', python: 'trade_document', java: 'TradeCommands.tradeDocument' },
  run: ([t]) => asDoc(sdk.tradeDocument({
    tradeId: t.tradeId, maker: t.maker, taker: t.taker,
    legs: Object.fromEntries(t.legs), expiresAt: t.expiresAt,
    meta: Object.fromEntries(t.meta ?? []),
  })),
})
cap('trade.leg', {
  profile: 'value-documents', rejectGroup: 'value-documents', returns: 'value',
  argTypes: [['record']], schema: 'trade-leg',
  impl: { js: 'leg', python: 'leg', java: 'TradeLeg' },
  run: ([l]) => {
    const r = sdk.leg({ sender: l.sender, receiver: l.receiver, instrumentId: l.instrumentId, amount: l.amount })
    return A.pairs([
      [A.text('sender'), A.party(r.sender)],
      [A.text('receiver'), A.party(r.receiver)],
      [A.text('instrument'), A.text(r.instrumentId.id)],
      [A.text('amount'), A.text(r.amount)],
    ])
  },
})
cap('transfer.transferDocument', {
  profile: 'value-documents', rejectGroup: 'value-documents', returns: 'document',
  argTypes: [['record']], schema: 'transfer',
  impl: { js: 'transferDocument', python: 'transfer_document', java: 'TransferCommands.transferDocument' },
  run: ([t]) => asDoc(sdk.transferDocument({
    transferId: t.transferId, sender: t.sender, reason: t.reason,
    recipients: t.recipients, meta: Object.fromEntries(t.meta ?? []),
  })),
})

// -- time -------------------------------------------------------------------
//
// Time.daml decides these and no shipped client implements them. The expected
// values are the ones I verified by running the Daml against the 1.5.0 DAR;
// the generator recomputes each with an inline reference so a typo in the pin
// cannot survive.

const truncDiv = (a, b) => {
  const q = a / b // BigInt division already truncates toward zero
  return q
}
const epochSecondsRef = (micros) => truncDiv(BigInt(micros), 1000000n)

cap('time.epochSeconds', {
  profile: 'time', rejectGroup: 'time', returns: 'int',
  argTypes: [['micros']],
  impl: { js: 'epochSeconds', python: 'epoch_seconds', java: 'LedgerTime.epochSeconds' },
  reference: (a) => epochSecondsRef(a[0]),
  run: (a) => sdk.epochSeconds(a[0]),
})
cap('time.secondsBetween', {
  profile: 'time', rejectGroup: 'time', returns: 'int',
  argTypes: [['micros'], ['micros']],
  note: 'each endpoint is truncated to whole seconds INDEPENDENTLY and only then subtracted; a client computing (b-a)/1e6 disagrees by up to a second exactly where policy acceptance flips',
  impl: { js: 'secondsBetween', python: 'seconds_between', java: 'LedgerTime.secondsBetween' },
  reference: (a) => epochSecondsRef(a[1]) - epochSecondsRef(a[0]),
  run: (a) => sdk.secondsBetween(a[0], a[1]),
})
cap('time.addSeconds', {
  profile: 'time', rejectGroup: 'time', returns: 'int',
  argTypes: [['micros'], ['int']],
  impl: { js: 'addSeconds', python: 'add_seconds', java: 'LedgerTime.addSeconds' },
  reference: (a) => BigInt(a[0]) + BigInt(a[1]) * 1000000n,
  run: (a) => sdk.addSeconds(a[0], a[1]),
})
cap('time.intDivide', {
  profile: 'time', rejectGroup: 'time', returns: 'int',
  argTypes: [['int'], ['int']],
  note: 'Daml Int division truncates TOWARD ZERO, not floor; every duration check runs through it',
  impl: { js: 'intDivide', python: 'int_divide', java: 'LedgerTime.intDivide' },
  reference: (a) => truncDiv(BigInt(a[0]), BigInt(a[1])),
  run: (a) => sdk.intDivide(a[0], a[1]),
})

// -- quota ------------------------------------------------------------------

cap('quota.consume', {
  profile: 'quota', rejectGroup: 'quota', returns: 'value',
  argTypes: [['record'], ['list']], schema: 'quota-config',
  note: 'the clock is injected, so the state machine is deterministic and belongs in the suite rather than in the exclusions',
  impl: { js: 'TenantQuota.consume', python: 'TenantQuota.consume', java: 'TenantQuota.consume' },
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
})

// -- builder ----------------------------------------------------------------

const jsonPin = (v) => A.json(JSON.parse(JSON.stringify(v)))

cap('builder.buildCommitCommands', {
  profile: 'builder', rejectGroup: 'builder', returns: 'value',
  argTypes: [['json']],
  impl: { js: 'buildCommitCommands', python: 'build_commit_commands', java: 'CycleCommands.buildCommitCommands' },
  run: ([o]) => jsonPin(sdk.buildCommitCommands(o)),
})
cap('builder.buildDryRunCommitCommands', {
  profile: 'builder', rejectGroup: 'builder', returns: 'value',
  argTypes: [['json']],
  impl: { js: 'buildDryRunCommitCommands', python: 'build_dry_run_commit_commands', java: 'CycleCommands.buildDryRunCommitCommands' },
  run: ([o]) => jsonPin(sdk.buildDryRunCommitCommands(o)),
})
cap('builder.buildSettleCommands', {
  profile: 'builder', rejectGroup: 'builder', returns: 'value',
  argTypes: [['json']],
  impl: { js: 'buildSettleCommands', python: 'build_settle_commands', java: 'CycleCommands.buildSettleCommands' },
  run: ([o]) => jsonPin(sdk.buildSettleCommands(o)),
})
cap('builder.buildAbortCommands', {
  profile: 'builder', rejectGroup: 'builder', returns: 'value',
  argTypes: [['json']],
  impl: { js: 'buildAbortCommands', python: 'build_abort_commands', java: 'CycleCommands.buildAbortCommands' },
  run: ([o]) => jsonPin(sdk.buildAbortCommands(o)),
})
cap('builder.buildExpireCommands', {
  profile: 'builder', rejectGroup: 'builder', returns: 'value',
  argTypes: [['json']],
  impl: { js: 'buildExpireCommands', python: 'build_expire_commands', java: 'CycleCommands.buildExpireCommands' },
  run: ([o]) => jsonPin(sdk.buildExpireCommands(o)),
})
cap('builder.buildTradeProposalCommands', {
  profile: 'builder', rejectGroup: 'builder', returns: 'value',
  argTypes: [['json']],
  impl: { js: 'buildTradeProposalCommands', python: 'build_trade_proposal_commands', java: 'TradeCommands.buildTradeProposalCommands' },
  run: ([o]) => jsonPin(sdk.buildTradeProposalCommands(o)),
})
cap('builder.buildTradeSettleCommands', {
  profile: 'builder', rejectGroup: 'builder', returns: 'value',
  argTypes: [['json']],
  impl: { js: 'buildTradeSettleCommands', python: 'build_trade_settle_commands', java: 'TradeCommands.buildTradeSettleCommands' },
  run: ([o]) => jsonPin(sdk.buildTradeSettleCommands(o)),
})
cap('builder.buildTradeCancelCommands', {
  profile: 'builder', rejectGroup: 'builder', returns: 'value',
  argTypes: [['json']],
  impl: { js: 'buildTradeCancelCommands', python: 'build_trade_cancel_commands', java: 'TradeCommands.buildTradeCancelCommands' },
  run: ([o]) => jsonPin(sdk.buildTradeCancelCommands(o)),
})
cap('builder.buildTransferCommands', {
  profile: 'builder', rejectGroup: 'builder', returns: 'value',
  argTypes: [['json']],
  impl: { js: 'buildTransferCommands', python: 'build_transfer_commands', java: 'TransferCommands.buildTransferCommands' },
  run: ([o]) => jsonPin(sdk.buildTransferCommands(o)),
})

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------

function rowArg(r) {
  return A.record('cycle-audit-row', {
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
  })
}
const instrArg = (i) => A.pairs([[A.text('admin'), A.party(i.admin)], [A.text('id'), A.text(i.id)]])
const instrIn = (admin, id) => A.record('instrument-id', { admin: A.party(admin), id: A.text(id) })

// ---------------------------------------------------------------------------
// References for capabilities no client implements.
//
// These are not a fourth implementation smuggled in. Each is built ONLY from
// the shipped primitives, which is the whole point: it shows the missing
// capability is a composition away, and it is checked against a value the
// ledger already produced (the live anchor) rather than against itself.
// ---------------------------------------------------------------------------

const ANCHOR_FIELDS = [
  'venueId', 'periodId', 'periodStartMicros', 'periodEndMicros', 'cycleCount',
  'committedUnits', 'feeUnits', 'returnedUnits', 'forfeitedUnits', 'payoutUnits',
  'qualifyingTxCount', 'nonQualifyingTxCount', 'merkleRootHex', 'reportDigest',
  'prevAnchorDigest',
]
const ANCHOR_TEXT_FIELDS = new Set(['venueId', 'periodId', 'merkleRootHex', 'reportDigest', 'prevAnchorDigest'])

CAPS.get('audit.anchorDocument').reference = ([a]) => {
  const kvs = ANCHOR_FIELDS.map((f) => [f, ANCHOR_TEXT_FIELDS.has(f) ? sdk.canonText(a[f]) : sdk.canonInt(a[f])])
  return asDoc(sdk.canonDocument('arccade.period-anchor', 1, kvs))
}

const POLICY_DEC = ['min-stake-amount', 'max-stake-amount', 'min-platform-fee', 'max-payout-amount']
const POLICY_INT = ['min-lock-seconds', 'max-lock-seconds', 'min-cycle-seconds', 'max-cycle-seconds',
  'cooldown-seconds', 'abort-cooldown-seconds', 'concurrency-limit']

CAPS.get('policy.policyDocument').reference = ([p]) => {
  const kvs = [
    ...POLICY_DEC.map((f) => [f, sdk.canonDecimal(p[f])]),
    ...POLICY_INT.map((f) => [f, sdk.canonInt(p[f])]),
    ['require-custody-proof', sdk.canonBool(p['require-custody-proof'])],
  ]
  return asDoc(sdk.canonDocument('arccade-venue-policy', 1, kvs))
}

CAPS.get('policy.validPolicy').reference = ([p]) => {
  const u = (f) => sdk.amountUnits(p[f])
  const i = (f) => BigInt(p[f])
  return u('min-stake-amount') > 0n
    && u('max-stake-amount') >= u('min-stake-amount')
    && u('min-platform-fee') >= 0n
    && u('max-payout-amount') >= 0n
    && i('min-lock-seconds') > 0n
    && i('max-lock-seconds') >= i('min-lock-seconds')
    && i('min-cycle-seconds') > 0n
    && i('max-cycle-seconds') >= i('min-cycle-seconds')
    && i('min-lock-seconds') >= i('min-cycle-seconds')
    && i('cooldown-seconds') >= 0n
    && i('abort-cooldown-seconds') >= 0n
    && i('concurrency-limit') > 0n
}

CAPS.get('audit.anchorTotals').reference = ([rows]) => {
  const t = { cycleCount: 0n, committedUnits: 0n, feeUnits: 0n, returnedUnits: 0n, forfeitedUnits: 0n, payoutUnits: 0n }
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.cycleId)) throw new Error('arccade-conformance: duplicate cycleId in a period')
    seen.add(r.cycleId)
    t.cycleCount += 1n
    for (const f of ['committedUnits', 'feeUnits', 'returnedUnits', 'forfeitedUnits', 'payoutUnits']) {
      t[f] += BigInt(r[f])
    }
  }
  return A.pairs(Object.entries(t).map(([k, v]) => [A.text(k), A.int(v)]))
}

CAPS.get('settlement.assertSettlementValid').reference = ([s]) => {
  const stake = BigInt(s.stakeUnits), ret = BigInt(s.returnedUnits)
  const forf = BigInt(s.forfeitedUnits), pay = BigInt(s.payoutUnits)
  const cap_ = BigInt(s.maxPayoutUnits)
  if (ret < 0n || forf < 0n || pay < 0n) throw new Error('arccade-conformance: negative settlement amount')
  if (ret + forf !== stake) throw new Error('arccade-conformance: returned + forfeited must equal the stake')
  if (pay > cap_) throw new Error('arccade-conformance: payout above the policy cap')
  if (s.disposition === 'returned-in-full' && forf !== 0n) throw new Error('arccade-conformance: returned-in-full cannot forfeit')
  if (s.disposition === 'forfeited-in-full' && ret !== 0n) throw new Error('arccade-conformance: forfeited-in-full cannot return')
  if (s.disposition === 'returned-with-forfeit' && !(ret > 0n && forf > 0n)) {
    throw new Error('arccade-conformance: returned-with-forfeit needs both sides non-zero')
  }
  if ((s.disposition === 'aborted' || s.disposition === 'expired-unsettled') && ret !== stake) {
    throw new Error('arccade-conformance: abort and expiry return the stake in full')
  }
  return true
}
for (const c of CAPS.values()) {
  if (!c.run && !c.reference) fail(`capability ${c.id} has neither an implementation nor a reference`)
  // `impl.js` is a published claim about the shipped JavaScript client; `run`
  // is this generator's ability to call it. Letting the two drift is how nine
  // capabilities came to be catalogued `impl.js: null` while the client
  // exported every one of them: nothing in the generator ever compared the
  // claim to a call. The runners check the same equivalence against their own
  // dispatch tables; this one fails earlier and refuses to write.
  if (Boolean(c.impl.js) !== Boolean(c.run)) {
    fail(`capability ${c.id}: impl.js is ${c.impl.js === null ? 'null' : JSON.stringify(c.impl.js)} ` +
      `but the generator ${c.run ? 'CAN' : 'cannot'} drive the JavaScript client. ` +
      'A claim about a client and the ability to call it must move together.')
  }
}

// ---------------------------------------------------------------------------
// Case machinery
// ---------------------------------------------------------------------------

const GROUPS = []
const IDS = new Set()
const DIVERGENCES = []
const GOLDEN_CHECKS = []
let CUR = null

function group(name, profile, note) {
  CUR = { group: name, profile, note, cases: [] }
  GROUPS.push(CUR)
}

// Adds a case to a group that was already opened. Used only at the end of the
// file, where a handful of cases exist to reach a reject-map rule that would
// otherwise be dead code.
function reopen(name) {
  CUR = GROUPS.find((g) => g.group === name)
  if (!CUR) fail(`reopen: no such group ${name}`)
}

// The TEXT half of a pinned golden is produced by RUNNING the client, which is
// only sound because a Daml vector measures the client against the same value a
// few lines later. When the client THREW while producing it the run died here
// with an uncaught stack trace, before a single case had been compared — the
// loudest possible failure and the least informative one, naming no case and no
// vector. It is now reported like any other finding, and the null flows into the
// golden-vs-Daml comparison, which does name both.
function clientText(label, fn) {
  try {
    return textPin(fn())
  } catch (e) {
    problem(`CLIENT THREW while building the pinned text for ${label}: ${e.message}`)
    return null
  }
}

function expectFrom(returns, v) {
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
    default: throw new Error(`expectFrom: unknown returns ${returns}`)
  }
}

// ---------------------------------------------------------------------------
// Normative vectors, HARVESTED from the Daml test package.
//
// This is the answer to the defect that made this generator worthless: it used
// to write down whatever the JavaScript client returned, so breaking the client
// rewrote the expectations to match the break and the suite still passed. Daml
// is the normative source — the ledger recomputes these values inside
// `GameStake_Settle` and rejects a mismatch — so an expectation that Daml has a
// literal for is taken FROM THE DAML SOURCE and the client is measured against
// it. Where the two disagree the generator refuses to write anything.
//
// The vectors are parsed out of `test-package/daml/Test/GameSdk/VectorsTest.daml`
// as SOURCE TEXT, never by running Daml. That matters twice over: the manifest
// can be regenerated without a Daml SDK, and the literal in the file is the same
// bytes `daml test` asserts against, so neither side can drift alone.
// ---------------------------------------------------------------------------

const VECTORS_PATH = join(REPO, 'test-package', 'daml', 'Test', 'GameSdk', 'VectorsTest.daml')

// The escapes this file is allowed to use. Anything else is a parse failure
// rather than a guess: silently mis-decoding one byte of a canonical document
// is exactly the class of bug the whole suite exists to catch.
function unescapeDamlText(key, lit) {
  if (!lit.startsWith('"')) fail(`Daml vector ${key}: expected a Text literal, got ${lit}`)
  let out = ''
  let i = 1
  for (;;) {
    if (i >= lit.length) fail(`Daml vector ${key}: unterminated Text literal`)
    const ch = lit[i]
    if (ch === '"') { i += 1; break }
    if (ch !== '\\') { out += ch; i += 1; continue }
    const esc = lit[i + 1]
    if (esc === '\\' || esc === '"') { out += esc; i += 2; continue }
    if (esc === 'n') { out += '\n'; i += 2; continue }
    if (esc === 't') { out += '\t'; i += 2; continue }
    if (esc === 'r') { out += '\r'; i += 2; continue }
    if (esc === '&') { i += 2; continue }                       // Haskell's empty escape
    if (lit.startsWith('\\NUL', i)) { out += '\0'; i += 4; continue }
    const num = /^\\(\d+)/.exec(lit.slice(i))
    if (num) { out += String.fromCodePoint(Number(num[1])); i += num[0].length; continue }
    fail(`Daml vector ${key}: unsupported escape ${lit.slice(i, i + 6)} — add it to unescapeDamlText deliberately`)
  }
  if (lit.slice(i).trim() !== '') fail(`Daml vector ${key}: trailing text after the literal: ${lit.slice(i)}`)
  return out
}

function parseDamlLiteral(key, raw) {
  const s = raw.trim()
  if (s === 'True') return { kind: 'bool', value: true }
  if (s === 'False') return { kind: 'bool', value: false }
  const int = /^\(\s*(-\d+)\s*\)$|^(-?\d+)$/.exec(s)
  if (int) return { kind: 'int', value: BigInt(int[1] ?? int[2]) }
  if (s.startsWith('"')) return { kind: 'text', value: unescapeDamlText(key, s) }
  fail(`Daml vector ${key}: expected a Text, Int or Bool literal on the right of ===, got: ${s}`)
}

// Parses `-- @vector <key>` followed by an assertion whose right-hand side is a
// literal. The assertion may wrap onto a second line, which is how the long
// digests stay inside a reviewable line length.
function harvestDamlVectors(path) {
  if (!existsSync(path)) fail(`the Daml vector file does not exist: ${path}`)
  const lines = readFileSync(path, 'utf8').split('\n')
  const out = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    const tag = /^\s*--\s*@vector\s+([a-z0-9][a-z0-9.-]*)\s*$/.exec(lines[i])
    if (!tag) continue
    const key = tag[1]
    if (out.has(key)) fail(`Daml vector ${key} is declared twice in ${path}`)
    const body = []
    let j = i + 1
    while (j < lines.length && !lines[j].includes('===')) {
      if (lines[j].trim() === '' || lines[j].trim().startsWith('--')) {
        fail(`Daml vector ${key}: the annotation is not immediately followed by an assertion`)
      }
      body.push(lines[j]); j += 1
    }
    if (j >= lines.length) fail(`Daml vector ${key}: no === assertion follows the annotation`)
    const [before, ...after] = lines[j].split('===')
    body.push(before)
    let rhs = after.join('===').trim()
    if (rhs === '') {
      if (j + 1 >= lines.length) fail(`Daml vector ${key}: === has nothing on its right`)
      rhs = lines[j + 1].trim()
    }
    out.set(key, {
      key,
      line: i + 2,
      expr: body.join(' ').trim().replace(/\s+/g, ' '),
      literal: parseDamlLiteral(key, rhs),
      used: 0,
    })
  }
  if (out.size === 0) fail(`no @vector annotations found in ${path}; the harvest would silently anchor nothing`)
  return out
}

const VECTORS = harvestDamlVectors(VECTORS_PATH)

// Which Daml function each capability is allowed to be anchored by, and how the
// harvested literal turns into an expectation. A capability that is not listed
// here CANNOT carry a vector: a key naming an unreviewed capability is a
// failure, not a shortcut, because the whole value of the anchor is that a
// human checked the Daml expression really is the same operation.
const DAML_ANCHORS = {
  'digest.canon': { symbols: ['canon'] },
  'digest.canonText': { symbols: ['canonText'] },
  'digest.codePointLength': { symbols: ['T.length'] },
  'digest.canonInt': { symbols: ['canonInt'] },
  'digest.canonBool': { symbols: ['canonBool'] },
  'digest.canonDecimal': { symbols: ['canonDecimal'] },
  'digest.canonTimeMicros': { symbols: ['canonTime', 'canon "m"'] },
  'digest.canonParty': { symbols: ['canonParty'] },
  'digest.canonOptional': { symbols: ['canonOptional'] },
  'digest.canonList': { symbols: ['canonList'] },
  'digest.canonFields': { symbols: ['canonFields'] },
  'digest.amountUnits': { symbols: ['amountUnits'] },
  'digest.textDigest': { symbols: ['textDigest'] },
  'digest.canonDocument': { symbols: ['canonDocument', 'documentDigest'] },
  'merkle.merkleEmpty': { symbols: ['merkleEmpty'] },
  'merkle.merkleNode': { symbols: ['merkleNode'] },
  'merkle.merkleRoot': { symbols: ['merkleRoot'] },
  'merkle.merklePairUp': { symbols: ['merklePairUp'], decode: 'hex64-list' },
  'merkle.merkleProof': { symbols: ['merkleProof'], decode: 'steps' },
  'merkle.merkleFold': { symbols: ['merkleFold'] },
  'merkle.merkleVerify': { symbols: ['merkleVerify'] },
  'audit.periodLeafDocument': { symbols: ['periodLeaf', 'periodLeafDocument'] },
  'audit.anchorDocument': { symbols: ['anchorDocument'] },
  'policy.policyDocument': { symbols: ['policyDocument'] },
  'policy.validPolicy': { symbols: ['validPolicy'] },
  'cycle.custodyTagFor': { symbols: ['custodyTagFor'] },
  'digest.constant': {
    symbols: ['schemePrefix', 'digestAlgId', 'custodyTagPrefix', 'dryRunVenuePrefix', 'dispositionTag'],
    decode: 'text-value',
    // Every other constant is one Text. DISPOSITIONS is a LIST, so its vector
    // is the five tags joined with `|` and decoded back into a list here. The
    // override is keyed by case rather than declared on the capability, so a
    // scalar constant cannot quietly be read as a one-element list.
    decodeFor: { 'constant-dispositions-order-and-membership': 'text-list-value' },
  },
  // `intDivide` has no name in Daml: it IS the `/` operator, which is what
  // `epochSeconds` divides with, so the operator is what gets pinned.
  'time.intDivide': { symbols: ['/'] },
  'time.epochSeconds': { symbols: ['epochSeconds'] },
  'time.secondsBetween': { symbols: ['secondsBetween'] },
  'time.addSeconds': { symbols: ['addSeconds'] },
}
for (const id of Object.keys(DAML_ANCHORS)) {
  if (!CAPS.has(id)) fail(`DAML_ANCHORS names an unknown capability: ${id}`)
}

// A symbol must appear as a whole name, so `canon` does not match `canonText`
// and a vector cannot be attached to the wrong encoder by accident.
function mentions(expr, symbol) {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')
  const tail = /[A-Za-z0-9_]$/.test(symbol) ? "(?![A-Za-z0-9_'])" : ''
  return new RegExp(`(?<![A-Za-z0-9_'.])${esc}${tail}`).test(expr)
}

// HEX64 is declared once with the package-reference helpers near the top.
function damlHex(v, key, what) {
  if (!HEX64.test(v)) fail(`Daml vector ${key}: ${what} is not a 64-character lowercase sha256: ${v}`)
  return v
}

// Turns the harvested literal into the same expectation shape a case carries.
function expectFromDaml(cap, vec, textVec) {
  const anchor = DAML_ANCHORS[cap.id]
  const kind = anchor.decodeFor?.[vec.key] ?? anchor.decode ?? cap.returns
  const lit = vec.literal
  const wrongKind = (want) =>
    fail(`Daml vector ${vec.key}: capability ${cap.id} needs a ${want} literal, found a ${lit.kind}`)
  switch (kind) {
    case 'text':
      if (lit.kind !== 'text') wrongKind('Text')
      return { text: textPin(lit.value) }
    case 'text-value':
      if (lit.kind !== 'text') wrongKind('Text')
      return { value: A.text(lit.value) }
    case 'digest':
      if (lit.kind !== 'text') wrongKind('Text')
      return { digest: damlHex(lit.value, vec.key, 'the digest') }
    case 'int':
      if (lit.kind !== 'int') wrongKind('Int')
      return { value: A.int(lit.value) }
    case 'bool':
      if (lit.kind !== 'bool') wrongKind('Bool')
      return { bool: lit.value }
    case 'document': {
      if (lit.kind !== 'text') wrongKind('Text')
      if (!textVec) fail(`Daml vector ${vec.key}: a document expectation also needs a "${vec.key}.text" vector`)
      if (textVec.literal.kind !== 'text') fail(`Daml vector ${vec.key}.text: expected a Text literal`)
      return { document: { text: textPin(textVec.literal.value), digest: damlHex(lit.value, vec.key, 'the digest') } }
    }
    case 'steps': {
      if (lit.kind !== 'text') wrongKind('Text')
      if (lit.value === '') return { value: A.steps([]) }
      return {
        value: A.steps(lit.value.split('|').map((step) => {
          const m = /^([LR]):([0-9a-f]{64})$/.exec(step)
          if (!m) fail(`Daml vector ${vec.key}: "${step}" is not L:<sha256> or R:<sha256>`)
          return { siblingOnLeft: m[1] === 'L', sibling: m[2] }
        })),
      }
    }
    case 'text-list-value': {
      // A list of tags written as one literal. `|` is the separator, so every
      // element has to be a value that cannot contain one; a tag that is not
      // plain kebab-case is a parse failure rather than a silent split.
      if (lit.kind !== 'text') wrongKind('Text')
      const tags = lit.value === '' ? [] : lit.value.split('|')
      for (const t of tags) {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)) {
          fail(`Daml vector ${vec.key}: "${t}" is not a kebab-case tag, so the | separator cannot be trusted`)
        }
      }
      return { value: A.list(tags.map((t) => A.text(t))) }
    }
    case 'hex64-list': {
      if (lit.kind !== 'text') wrongKind('Text')
      const parts = lit.value === '' ? [] : lit.value.split('|')
      return { value: A.list(parts.map((h) => A.hex64(damlHex(h, vec.key, 'a level entry')))) }
    }
    default:
      return fail(`Daml vector ${vec.key}: capability ${cap.id} returns ${kind}, which has no harvest rule`)
  }
}

// Looks up the vector for a case and checks it is attached to the right
// function. Returns null when Daml has no literal for this case.
function damlAnchorFor(caseId, cap) {
  const vec = VECTORS.get(caseId)
  if (!vec) return null
  const anchor = DAML_ANCHORS[cap.id]
  if (!anchor) {
    fail(`Daml vector ${caseId} anchors capability ${cap.id}, which is not in DAML_ANCHORS. ` +
      'Add it there with the Daml symbol it corresponds to, or remove the vector.')
  }
  const textVec = VECTORS.get(`${caseId}.text`)
  for (const v of textVec ? [vec, textVec] : [vec]) {
    if (!anchor.symbols.some((s) => mentions(v.expr, s))) {
      fail(`Daml vector ${v.key} (VectorsTest.daml:${v.line}) is attached to capability ${cap.id}, ` +
        `but its assertion mentions none of [${anchor.symbols.join(', ')}]:\n    ${v.expr}`)
    }
  }
  vec.used += 1
  if (textVec) textVec.used += 1
  return { vec, textVec, expect: expectFromDaml(cap, vec, textVec) }
}

// An `input.*` vector anchors a value the manifest FEEDS to the client rather
// than one it expects back. Without these, breaking textDigest would change the
// Merkle inputs and the expectations together and the mismatch would read as a
// puzzle rather than as the one bug it is.
function damlInputPin(key, actual) {
  const vec = VECTORS.get(key)
  if (!vec) fail(`no Daml input pin "${key}" in VectorsTest.daml`)
  vec.used += 1
  if (vec.literal.kind !== 'text' || vec.literal.value !== actual) {
    problem(`DAML INPUT PIN — ${key} (VectorsTest.daml:${vec.line}): the client does not produce the value ` +
      `the manifest feeds back to it.\n    daml:     ${JSON.stringify(vec.literal.value)}\n` +
      `    observed: ${JSON.stringify(actual)}`)
  }
  return actual
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function C(spec) {
  const c = CAPS.get(spec.capability)
  if (!c) fail(`case ${spec.id}: unknown capability ${spec.capability}`)
  if (IDS.has(spec.id)) fail(`duplicate case id ${spec.id}`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(spec.id)) fail(`case id not in kebab-case: ${spec.id}`)
  if (!spec.why || spec.why.length < 40) fail(`case ${spec.id}: "why" must name the concrete failure (>= 40 chars)`)
  if (/^(tests that|checks the|verifies that)/i.test(spec.why)) fail(`case ${spec.id}: boilerplate "why"`)
  IDS.add(spec.id)
  c.cases += 1

  const args = spec.args ?? []
  // Where a capability has BOTH a generator reference and a shipped client
  // call, the REFERENCE is the expectation and the client is cross-checked
  // against it below. Taking the client's word here would turn 16 cases whose
  // expectation is currently independent of every client into cases that say
  // only "the client agrees with itself".
  const invoke = c.reference ?? c.run
  const usingReference = Boolean(c.reference)
  let observed = null, thrown = null
  try {
    observed = invoke(args.map(decode))
  } catch (e) {
    thrown = e
  }

  let expect, source
  const observedExpect = thrown
    ? { reject: { class: classify(c.rejectGroup, thrown.message) } }
    : expectFrom(c.returns, observed)

  if (thrown && observedExpect.reject.class === null && !spec.expect) {
    problem(`case ${spec.id}: threw an unclassifiable error, and no reject class is pinned: ${thrown.message}`)
    observedExpect.reject.class = 'bad-format'
  }

  // CLIENT vs REFERENCE. A capability that has both is measured twice from two
  // independently written bodies of code, and a disagreement is a finding
  // rather than a preference: either the shipped client is wrong, or the
  // reference the expectation was built from is. Nine capabilities reached
  // this suite recorded as `impl.js: null` — a claim about the JavaScript
  // client that stopped being true once it shipped the functions, and which
  // no check could contradict while the generator never called them.
  if (c.reference && c.run) {
    let clientObserved = null, clientThrew = null
    try {
      clientObserved = c.run(args.map(decode))
    } catch (e) {
      clientThrew = e
    }
    const clientExpect = clientThrew
      ? { reject: { class: classify(c.rejectGroup, clientThrew.message) } }
      : expectFrom(c.returns, clientObserved)
    if (!eq(clientExpect, observedExpect)) {
      problem(`CLIENT vs REFERENCE — case ${spec.id} (capability ${spec.capability}).\n` +
        `    reference ${JSON.stringify(observedExpect)}${thrown ? `  [threw: ${thrown.message}]` : ''}\n` +
        `    js client ${JSON.stringify(clientExpect)}${clientThrew ? `  [threw: ${clientThrew.message}]` : ''}\n` +
        `    impl.js is "${c.impl.js}", so the manifest claims this client computes this. One of the two is wrong.`)
    }
  }

  // THE ANCHOR. If Daml has a literal for this case, that literal IS the
  // expectation and the client is measured against it. The observation is never
  // adopted here — adopting it is precisely the defect this replaces.
  const anchored = damlAnchorFor(spec.id, c)
  if (anchored) {
    if (spec.decision) {
      fail(`case ${spec.id} carries both a normative pin (${spec.decision}) and a Daml vector. ` +
        'Two sources of truth for one case is one too many: keep the Daml vector and retire the pin, or vice versa.')
    }
    if (spec.expect && !eq(spec.expect, anchored.expect)) {
      problem(`GOLDEN vs DAML — case ${spec.id}: the hand-written golden and the Daml vector ` +
        `(VectorsTest.daml:${anchored.vec.line}) are not the same value.\n` +
        `    golden: ${JSON.stringify(spec.expect)}\n    daml:   ${JSON.stringify(anchored.expect)}`)
    }
    if (!eq(anchored.expect, observedExpect)) {
      problem(`DAML MISMATCH — case ${spec.id} (capability ${spec.capability}).\n` +
        `    daml     ${anchored.vec.expr}\n` +
        `             (${VECTORS_PATH.slice(REPO.length + 1)}:${anchored.vec.line})\n` +
        `    expected ${JSON.stringify(anchored.expect)}\n` +
        `    observed ${JSON.stringify(observedExpect)}${thrown ? `  [threw: ${thrown.message}]` : ''}\n` +
        '    The ledger recomputes this value and rejects a mismatch, so the client is wrong, not the vector.')
    }
    if (spec.golden) {
      GOLDEN_CHECKS.push({
        caseId: spec.id, golden: spec.golden, agrees: eq(spec.expect, observedExpect),
        observed: observedExpect, pinned: spec.expect,
        // The Daml vector this case is anchored to. It is a provenance the
        // generator can check by construction: the literal was parsed out of
        // VectorsTest.daml and the client was measured against it above.
        vector: { key: anchored.vec.key, line: anchored.vec.line },
      })
    }
    expect = anchored.expect
    source = spec.golden ? 'daml-vector-golden' : 'daml-vector'
  } else if (spec.expect) {
    expect = spec.expect
    const agrees = eq(expect, observedExpect)
    if (spec.golden) {
      GOLDEN_CHECKS.push({ caseId: spec.id, golden: spec.golden, agrees, observed: observedExpect, pinned: expect })
      if (!agrees) {
        problem(`GOLDEN DRIFT — ${spec.golden} (case ${spec.id}): the implementation no longer produces the published value.\n` +
          `    pinned:   ${JSON.stringify(expect)}\n    observed: ${JSON.stringify(observedExpect)}`)
      }
      source = usingReference ? 'asserted-golden-via-reference' : 'asserted-golden'
    } else if (spec.decision) {
      source = 'normative-pin'
      if (!agrees) {
        DIVERGENCES.push({
          caseId: spec.id, language: 'javascript', decision: spec.decision,
          expected: expect, observed: observedExpect,
          errorText: thrown ? thrown.message : null,
          reason: spec.divergenceReason ?? null,
        })
      } else if (spec.expectDivergence !== false) {
        problem(`STALE DIVERGENCE — case ${spec.id} (${spec.decision}) now AGREES with the normative pin. ` +
          `Remove expectDivergence and let it be an ordinary case.`)
      }
    } else {
      // A hand-supplied expectation with neither a golden nor a decision behind
      // it would be an unfalsifiable claim. Refuse it.
      fail(`case ${spec.id}: hand-written expect needs either "golden" or "decision"`)
    }
  } else {
    expect = observedExpect
    source = usingReference ? 'reference' : 'generated'
  }

  const rec = {
    id: spec.id,
    group: CUR.group,
    capability: spec.capability,
    title: spec.title,
    why: spec.why,
    input: { args },
    expect,
  }
  if (spec.appliesWhen) rec.appliesWhen = spec.appliesWhen
  if (spec.property) rec.property = spec.property
  rec.tags = spec.tags ?? []
  rec.pins = {
    daml: anchored ? `${anchored.vec.expr} === ${JSON.stringify(anchored.vec.literal.value.toString())}` : spec.daml ?? null,
    damlVector: anchored ? { key: anchored.vec.key, file: 'test-package/daml/Test/GameSdk/VectorsTest.daml', line: String(anchored.vec.line) } : null,
    sourceOfTruth: spec.sourceOfTruth ?? source,
  }
  rec.source = source
  if (spec.decision) rec.decision = spec.decision
  if (spec.note) rec.note = spec.note
  CUR.cases.push(rec)
  return rec
}

// ===========================================================================
// G01 - canon-scalars
// ===========================================================================

group('canon-scalars', 'core-digest',
  'The general encoding <tag>:<length>:<value>, where LENGTH IS IN UNICODE CODE POINTS. ' +
  'A client that counts UTF-16 units passes every ASCII case here and diverges on the first emoji.')

// Built from code points rather than written as literals so the generator
// source stays reviewable in ASCII and nothing depends on how an editor
// normalises the file.
const cp = (...codes) => String.fromCodePoint(...codes)

const CORPUS = [
  ['ascii', 'abc', 'plain ASCII, the case every implementation gets right'],
  ['empty', '', 'the empty string, which still carries its tag and a zero length'],
  ['colon', 'a:b', 'a colon inside the value, which the length prefix has to make harmless'],
  ['pipe', 'a|b', 'a pipe inside the value, which canonList uses as its element separator'],
  ['newline', 'a\nb', 'a newline inside the value'],
  ['nul', cp(97, 0, 98), 'a NUL code point inside the value'],
  ['semicolon-equals', 'a;b=c', 'the two characters canonFields uses to frame a field'],
  ['astral', cp(0x1F3AE), 'one astral code point, which is two UTF-16 units'],
  ['astral-mixed', cp(97, 0x1F3AE, 98), 'an astral code point between two ASCII ones'],
  ['combining', cp(101, 0x301), 'e plus a combining acute: two code points, one grapheme'],
  ['precomposed', cp(0xE9), 'the precomposed form of that same grapheme: one code point'],
  ['zwj-family', cp(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467, 0x200D, 0x1F466),
    'a ZWJ family cluster: seven code points, eleven UTF-16 units, one grapheme'],
  ['cjk', cp(0x65E5, 0x672C, 0x8A9E), 'three CJK code points, each three UTF-8 bytes'],
  ['latin1', cp(0xFC), 'a Latin-1 letter: one code point, two UTF-8 bytes'],
  ['musical', cp(0x1D11E), 'the G clef, an astral code point outside the emoji blocks'],
  ['replacement', cp(0xFFFD), 'the replacement character, which sorts above every astral code point in UTF-16 order'],
]

for (const [slug, s, blurb] of CORPUS) {
  C({
    id: `canon-text-${slug}`,
    capability: 'digest.canonText',
    title: `canonText over ${slug}`,
    why: `The length prefix is what makes the encoding injective, and it counts code points: ${blurb}. A client using a UTF-16 or byte length writes a different document for the same payload.`,
    args: [A.text(s)],
    tags: ['encoding', 'unicode'],
    daml: slug === 'ascii' ? 'canonText "abc" === "t:3:abc"' : null,
  })
  C({
    id: `code-point-length-${slug}`,
    capability: 'digest.codePointLength',
    title: `codePointLength over ${slug}`,
    why: `Every length in the scheme comes from here, so ${blurb} is exactly where a UTF-16 count silently produces a different canonical text and therefore a different commitment.`,
    args: [A.text(s)],
    tags: ['encoding', 'unicode'],
  })
}

C({
  id: 'canon-tag-and-length-shape',
  capability: 'digest.canon',
  title: 'canon composes tag, code-point length and value',
  why: 'The whole scheme is one function; pinning it directly separates a bug in the shape of the encoding from a bug in a particular scalar encoder.',
  args: [A.text('t'), A.text('abc')],
  tags: ['encoding'],
  daml: 'canon "t" "abc"',
})
C({
  id: 'canon-unknown-tag-is-still-encoded',
  capability: 'digest.canon',
  title: 'canon does not police the tag alphabet',
  why: 'The tag alphabet is a convention of the callers, not a check inside canon; pinning that keeps a future client from adding a rejection Daml does not have and refusing a document the ledger already accepted.',
  args: [A.text('z'), A.text('abc')],
  tags: ['encoding', 'boundary'],
})

const INTS = [
  ['zero', 0n], ['one', 1n], ['negative-one', -1n], ['forty-two', 42n],
  ['int64-max', INT64_MAX], ['int64-min', INT64_MIN],
  ['ten-digits', 1234567890n], ['micros-width', 1787437747372202n],
]
for (const [slug, v] of INTS) {
  C({
    id: `canon-int-${slug}`,
    capability: 'digest.canonInt',
    title: `canonInt ${slug}`,
    why: `Integers are rendered as a plain decimal with a leading minus and no grouping; ${slug} is where a locale-aware or float-backed renderer would insert a separator, an exponent or a lost digit.`,
    args: [A.int(v)],
    tags: ['encoding'],
    daml: slug === 'forty-two' ? 'canonInt 42 === "i:2:42"' : null,
  })
}
C({
  id: 'canon-int-wide-beyond-int64',
  capability: 'digest.canonInt',
  title: 'canonInt of a value wider than int64',
  why: 'JavaScript BigInt and Python int accept it while Daml Int and Java long cannot; pinning the encoding makes the difference visible here rather than when a document is written that the ledger can never reproduce.',
  args: [A.int(18446744073709551616n)],
  tags: ['encoding', 'boundary'],
  note: 'Outside the Daml Int band. The encoding is well defined; whether a document may carry such a value is the separate question the amount band answers.',
})
C({
  id: 'canon-int-boolean-rejected',
  capability: 'digest.canonInt',
  title: 'canonInt rejects a native boolean',
  why: "Python's str(True) yields i:4:True and JavaScript's BigInt(true) yields i:1:1, so the same accidental argument produces two different documents and neither client complains.",
  args: [A.bool(true)],
  expect: { reject: { class: 'bad-type' } },
  decision: 'D9',
  divergenceReason: 'JS coerces true to 1n and returns i:1:1 instead of rejecting.',
  tags: ['reject', 'normative'],
})

C({ id: 'canon-bool-true', capability: 'digest.canonBool', title: 'canonBool true',
  why: 'Booleans are spelled out in lowercase; a client rendering True, 1 or yes produces a different document for the same policy flag.',
  args: [A.bool(true)], tags: ['encoding'], daml: 'canonBool True === "b:4:true"' })
C({ id: 'canon-bool-false', capability: 'digest.canonBool', title: 'canonBool false',
  why: 'False is five characters and true is four, so the length prefix differs between the branches and a hardcoded length breaks on exactly one of them.',
  args: [A.bool(false)], tags: ['encoding'], daml: 'canonBool False === "b:5:false"' })

const TIMES = [
  ['epoch', 0n], ['one-second', 1000000n], ['negative', -500000n],
  ['pre-epoch-second', -1000000n], ['int64-max', INT64_MAX], ['int64-min', INT64_MIN],
  ['testnet-commit', 1787437747372202n],
]
for (const [slug, v] of TIMES) {
  C({
    id: `canon-time-micros-${slug}`,
    capability: 'digest.canonTimeMicros',
    title: `canonTimeMicros ${slug}`,
    why: `Time in a digest is always integer microseconds since the epoch, never ISO text; ${slug} is where a client routing through a millisecond Date type or an unsigned type loses the value.`,
    args: [A.micros(v)],
    tags: ['encoding', 'time'],
    daml: slug === 'one-second' ? 'canonTime (time (date 1970 Jan 1) 0 0 1) === "m:7:1000000"' : null,
  })
}

C({
  id: 'canon-party-full-fingerprint',
  capability: 'digest.canonParty',
  title: 'canonParty keeps the namespace fingerprint',
  why: 'partyToText returns the full party id including the ::1220 namespace fingerprint; a client that trims it to a readable hint produces a shorter document and a leaf no auditor can reproduce from the ledger.',
  args: [A.party('arccade-validator-1::1220ce19f2a2928e5775dbc18e14d37c1fa4d8e5579d6234c3def66438a182e963bf')],
  tags: ['encoding', 'party'],
})
C({
  id: 'canon-party-plain-text-party',
  capability: 'digest.canonParty',
  title: 'canonParty over a partyFromText party',
  why: 'The Daml golden audit row uses partyFromText so the constant does not depend on the runtime; this pins that a party with no fingerprint encodes exactly like any other text of that length.',
  args: [A.party('auditor-golden-party')],
  tags: ['encoding', 'party'],
})

// ===========================================================================
// G02 - canon-composite
// ===========================================================================

group('canon-composite', 'core-digest',
  'canonOptional, canonList and canonFields. Every document is a canonFields, so the ' +
  'field sort and the ASCII field-name restriction that makes it language-independent live here.')

C({ id: 'canon-optional-none', capability: 'digest.canonOptional', title: 'canonOptional of None',
  why: 'None encodes as an empty optional rather than being omitted, so a document with an absent field still differs from a document that never had the field at all.',
  args: [A.nul()], tags: ['encoding'], daml: 'canonOptional canonText None === "o:0:"' })
C({ id: 'canon-optional-some', capability: 'digest.canonOptional', title: 'canonOptional of Some',
  why: 'The inner value is canonicalised before it is wrapped, so the optional carries a length over an already-tagged string and not over the raw payload.',
  args: [A.text('x')], tags: ['encoding'], daml: 'canonOptional canonText (Some "x") === "o:5:t:1:x"' })
C({ id: 'canon-optional-some-empty-inner', capability: 'digest.canonOptional',
  title: 'canonOptional of Some with an empty inner value',
  why: 'This is the documented non-injectivity: Some "" and None both encode a zero-length payload under a different length, and pinning it now stops a future document from inheriting the ambiguity unnoticed.',
  args: [A.text('')], tags: ['encoding', 'boundary'],
  note: 'Not reachable from any shipped document. Pinned so that the first document to use canonOptional has to look at this case.' })

C({ id: 'canon-list-empty', capability: 'digest.canonList', title: 'canonList of an empty list',
  why: 'An empty list still encodes its element count and the trailing colon; a client that emits nothing at all collides with a list whose single element is empty.',
  args: [A.list([])], tags: ['encoding'], daml: 'canonList [] === "l:2:0:"' })
C({ id: 'canon-list-two-elements', capability: 'digest.canonList', title: 'canonList of two elements',
  why: 'The element separator is a pipe and the count is inside the encoded value, which is what stops two different lists from producing the same bytes.',
  args: [A.list([A.raw('a'), A.raw('b')])], tags: ['encoding'], daml: 'canonList ["a", "b"] === "l:5:2:a|b"' })
C({ id: 'canon-list-one-element', capability: 'digest.canonList', title: 'canonList of one element',
  why: 'A single-element list must still carry its count, otherwise it would be indistinguishable from the bare element in a nested position.',
  args: [A.list([A.raw('a')])], tags: ['encoding'] })
C({ id: 'canon-list-element-containing-pipe', capability: 'digest.canonList',
  title: 'canonList of one element that itself contains a pipe',
  why: 'Without the leading count this would encode identically to a two-element list, which is the exact ambiguity the count exists to prevent; this case and the next must produce different bytes.',
  args: [A.list([A.raw('a|b')])], tags: ['encoding', 'boundary'] })
C({ id: 'canon-list-two-elements-a-b', capability: 'digest.canonList',
  title: 'canonList of the two elements a and b',
  why: 'Paired with the previous case: same characters after the count, different count, therefore different bytes. A client that drops the count passes both cases individually and fails the pair.',
  args: [A.list([A.raw('a'), A.raw('b')])], tags: ['encoding', 'boundary'],
  note: 'Deliberately the same input as canon-list-two-elements; the pair is the assertion.' })
C({ id: 'canon-list-order-sensitive', capability: 'digest.canonList', title: 'canonList is order sensitive',
  why: 'Lists are positional and are never sorted, unlike record fields; a client that normalises list order changes the digest of every entry document that carries allocations or plays.',
  args: [A.list([A.raw('b'), A.raw('a')])], tags: ['encoding'] })
C({ id: 'canon-list-of-canonical-scalars', capability: 'digest.canonList',
  title: 'canonList over already-canonical elements',
  why: 'The caller canonicalises the elements, not canonList; passing raw payloads instead of canonical fragments produces shorter bytes that no other client would reproduce.',
  args: [A.list([A.raw(sdk.canonText('a')), A.raw(sdk.canonInt(1n))])], tags: ['encoding'] })
C({ id: 'canon-list-of-nested-records', capability: 'digest.canonList',
  title: 'canonList whose elements are bare canonFields values',
  why: 'Trade Wars allocations and Pixel Race plays nest records inside a list with no schema wrapper; a client that wraps each element in a document instead produces a different entry digest for the same play.',
  args: [A.list([
    A.raw(sdk.canonFields([['a', sdk.canonInt(1n)]])),
    A.raw(sdk.canonFields([['a', sdk.canonInt(2n)]])),
  ])], tags: ['encoding', 'games'] })

C({ id: 'canon-fields-empty', capability: 'digest.canonFields', title: 'canonFields of no fields',
  why: 'The empty record is the base of every empty document, including merkleEmpty, so an implementation that emits nothing here gets a different empty-period root.',
  args: [A.pairs([])], tags: ['encoding'] })
C({ id: 'canon-fields-sorted-by-name', capability: 'digest.canonFields',
  title: 'canonFields sorts by field name, not by insertion order',
  why: 'Source order must not reach the digest, otherwise adding a field in a later version of a builder would silently change a v1 document that the ledger already committed to.',
  args: [A.pairs([[A.text('b'), A.raw('2')], [A.text('a'), A.raw('1')]])],
  tags: ['encoding'], daml: 'canonFields [("b","2"),("a","1")] === canonFields [("a","1"),("b","2")]' })
C({ id: 'canon-fields-insertion-order-already-sorted', capability: 'digest.canonFields',
  title: 'canonFields of the same two fields already in order',
  why: 'Paired with the previous case: the two must produce identical bytes, which is the actual claim. Either case alone would pass an implementation that never sorts.',
  args: [A.pairs([[A.text('a'), A.raw('1')], [A.text('b'), A.raw('2')]])], tags: ['encoding'] })
C({ id: 'canon-fields-uppercase-sorts-before-lowercase', capability: 'digest.canonFields',
  title: 'canonFields sorts A before a',
  why: 'The sort is code-point order, so uppercase comes first; a case-folding or locale-aware comparator reverses this pair and changes the digest of any document mixing cases in its field names.',
  args: [A.pairs([[A.text('a'), A.raw('1')], [A.text('A'), A.raw('2')]])], tags: ['encoding', 'boundary'] })
C({ id: 'canon-fields-duplicate-name-kept-in-order', capability: 'digest.canonFields',
  title: 'Duplicate field names are kept in insertion order, not rejected',
  why: 'A caller building fields from a map merge can emit the same name twice; if one client rejects and another keeps both, the same payload yields a document in one language and an exception in the other, and the ledger has already accepted whichever was written first.',
  args: [A.pairs([[A.text('a'), A.raw('1')], [A.text('a'), A.raw('2')]])], tags: ['encoding', 'boundary'] })
C({ id: 'canon-fields-value-containing-semicolon', capability: 'digest.canonFields',
  title: 'A field value containing a semicolon',
  why: 'Semicolon terminates every field, so an unescaped value containing one would reshape the record if the values were not themselves length-prefixed canonical fragments.',
  args: [A.pairs([[A.text('a'), A.raw(sdk.canonText('x;y'))]])], tags: ['encoding', 'boundary'] })
C({ id: 'canon-fields-value-containing-equals', capability: 'digest.canonFields',
  title: 'A field value containing an equals sign',
  why: 'Equals separates a field name from its value, so this is the second half of the same ambiguity the length prefixes are there to close.',
  args: [A.pairs([[A.text('a'), A.raw(sdk.canonText('x=y'))]])], tags: ['encoding', 'boundary'] })
C({ id: 'canon-fields-trailing-semicolon-on-last-field', capability: 'digest.canonFields',
  title: 'Every field is terminated, including the last',
  why: 'A client that joins with a separator instead of terminating each field loses the final semicolon and produces a shorter record for every document in the scheme.',
  args: [A.pairs([[A.text('only'), A.raw(sdk.canonText('v'))]])], tags: ['encoding'] })
C({ id: 'canon-fields-name-length-in-code-points', capability: 'digest.canonFields',
  title: 'The field-name length prefix is a code-point count too',
  why: 'Field names are k-tagged with their own length; pinning a long ASCII name keeps a client from reusing the value length by mistake.',
  args: [A.pairs([[A.text('non-qualifying-tx-count'), A.raw(sdk.canonInt(1n))]])], tags: ['encoding'] })

const BAD_FIELD_NAMES = [
  ['non-ascii', cp(0xFC, 99, 114, 101, 116), 'a Turkish field name'],
  ['space', 'a b', 'a name with a space'],
  ['underscore', 'a_b', 'a name with an underscore'],
  ['empty', '', 'an empty name'],
  ['astral', cp(0x1F3AE), 'a name that is a single astral code point'],
  ['dot', 'a.b', 'a name with a dot'],
]
for (const [slug, name, blurb] of BAD_FIELD_NAMES) {
  C({
    id: `field-name-rejected-${slug}`,
    capability: 'digest.canonFields',
    title: `canonFields rejects ${blurb}`,
    why: `Field names are restricted to ASCII [a-zA-Z0-9-] precisely so that Daml sortOn, Python sorted and JavaScript Array.sort agree; ${blurb} is where code-unit order, code-point order and locale order stop coinciding and two clients sort the same record differently.`,
    args: [A.pairs([[A.text(name), A.raw('1')]])],
    tags: ['reject', 'encoding'],
  })
}
C({ id: 'field-name-accepts-digits-and-hyphen', capability: 'digest.canonFields',
  title: 'canonFields accepts a-b-9',
  why: 'The permitted alphabet has to be pinned from the accepting side too, otherwise a client could pass every rejection case by refusing everything.',
  args: [A.pairs([[A.text('a-b-9'), A.raw('1')]])], tags: ['encoding'] })

// ===========================================================================
// G03 - amount-units
// ===========================================================================

group('amount-units', 'core-digest',
  'Amounts are never hashed as formatted decimals. They become integer 1e-10 units, exactly or ' +
  'not at all, inside the Daml Int band, and a native binary float is refused. The conversion is ' +
  'lossless-or-reject in all four implementations, which is why no case here rounds: see D12.')

const AMOUNTS_OK = [
  ['one', '1.0', 'the Daml-pinned unit vector'],
  ['twelve-digits', '12.3456789012', 'the Daml-pinned full-precision vector'],
  ['zero', '0.0', 'zero'],
  ['smallest-unit', '0.0000000001', 'one unit, the smallest representable amount'],
  ['negative-one-and-a-half', '-1.5', 'a negative amount'],
  ['negative-zero', '-0.0', 'negative zero, which must collapse to zero rather than to a minus sign'],
  ['trailing-dot', '1.', 'a trailing dot with no fractional digits'],
  ['padded-zeros', '1.50000000000000', 'more than ten fractional digits, all of them zero past the tenth'],
  ['integer-no-dot', '100', 'an integer with no decimal point at all'],
  ['band-max', '922337203.6854775807', 'the largest representable amount'],
  ['band-min', '-922337203.6854775808', 'the smallest representable amount'],
  ['testnet-stake', '100.0000000000', 'the stake amount as the ledger actually spells it'],
  ['testnet-fee', '0.5000000000', 'the fee amount as the ledger actually spells it'],
  ['ten-fractional-nonzero', '0.1234567890', 'exactly ten fractional digits, all significant'],
  ['negative-smallest-unit', '-0.0000000001', 'minus one unit: the smallest representable amount on the negative side, '
    + 'where a parser that drops the sign before scaling, or scales with a float, lands on 0 or on -2'],
]
for (const [slug, s, blurb] of AMOUNTS_OK) {
  C({
    id: `amount-units-${slug}`,
    capability: 'digest.amountUnits',
    title: `amountUnits of ${s}`,
    why: `Ledger amounts arrive as decimal strings and must be parsed exactly into 1e-10 units; ${blurb} is where a parser that routes through a binary float, or one that rounds instead of truncating, produces a different integer and therefore a different document.`,
    args: [A.dec(s)],
    tags: ['amount'],
    daml: ['one', 'twelve-digits', 'zero', 'smallest-unit', 'negative-one-and-a-half'].includes(slug)
      ? `amountUnits ${s} (VectorsTest:amountConversion)` : null,
  })
}
// D12. This case used to be titled "A negative amount truncates toward zero"
// and carried a GENERATED expectation, which was a refusal — the title claimed
// a rounding direction while the recorded expectation was the precision guard
// firing. The direction is not merely unpinned, it is UNREACHABLE: every
// implementation is lossless-or-reject, so no input survives long enough to be
// rounded. Java is the clearest statement of it — `setScale(0, DOWN)` on one
// line, `back.compareTo(d) != 0 -> throw` on the next — and Daml cannot even
// express the input, because `Decimal` is `Numeric 10`. The pin therefore says
// what is actually normative: the refusal. See
// VectorsTest.daml:roundingDirectionIsUnreachable for the same argument stated
// where the Daml side is checked.
C({
  id: 'amount-negative-sub-unit-refused-not-rounded',
  capability: 'digest.amountUnits',
  title: 'A negative amount finer than 1e-10 is refused, not rounded in either direction',
  why: 'The negative side is where floor and truncate disagree, so it is the input a client that rounds would get wrong first; the contract is that no client rounds at all, and pinning the refusal here is what turns a port that quietly rounds into a red decision instead of a regenerated manifest.',
  args: [A.dec('-0.00000000019')],
  expect: { reject: { class: 'precision-loss' } },
  decision: 'D12',
  expectDivergence: false,
  divergenceReason: 'A client that rounds instead of refusing returns a unit count here, and the direction it rounds is then observable — which is exactly the state D12 says must not exist.',
  tags: ['amount', 'reject', 'boundary', 'normative'],
  note: 'The eleventh fractional digit is non-zero, which is the only kind of input that could distinguish one rounding direction from another; every implementation refuses it.',
})
C({
  id: 'canon-decimal-carries-units-not-digits',
  capability: 'digest.canonDecimal',
  title: 'canonDecimal encodes the unit count, not the printed decimal',
  why: 'The d tag wraps an integer; a client that canonicalises the formatted decimal instead produces d:3:1.5 where every other client produces the unit count, and the two never agree again.',
  args: [A.dec('1.5')],
  tags: ['amount'], daml: 'canonDecimal 1.5 === "d:11:15000000000"',
})
C({
  id: 'canon-decimal-zero',
  capability: 'digest.canonDecimal',
  title: 'canonDecimal of zero is a single digit',
  why: 'Zero must not carry the ten padding zeros of its unit representation; a client that pads gets d:11:00000000000 and diverges on every policy field that happens to be zero.',
  args: [A.dec('0.0')],
  tags: ['amount'], daml: 'canonDecimal 0.0 === "d:1:0"',
})

const AMOUNTS_BAD_FORMAT = [
  ['leading-plus', '+1', 'an explicit plus sign'],
  ['leading-dot', '.5', 'a leading dot with no integer part'],
  ['exponent-lower', '1e3', 'scientific notation'],
  ['exponent-upper', '1E+2', 'uppercase scientific notation'],
  ['not-a-number', 'abc', 'text that is not a number at all'],
  ['empty', '', 'the empty string'],
  ['double-dot', '1.2.3', 'two decimal points'],
  ['comma-decimal', '1,5', 'a comma as the decimal separator'],
]
for (const [slug, s, blurb] of AMOUNTS_BAD_FORMAT) {
  C({
    id: `amount-rejects-${slug}`,
    capability: 'digest.amountUnits',
    title: `amountUnits rejects ${blurb}`,
    why: `The grammar is a plain signed decimal and nothing else; ${blurb} is a form some language parses happily into a value the ledger would spell differently, so accepting it means writing a document no other client reproduces.`,
    args: [A.text(s)],
    tags: ['amount', 'reject'],
  })
}
C({
  id: 'amount-rejects-untrimmed-whitespace',
  capability: 'digest.amountUnits',
  title: 'amountUnits rejects an amount with leading whitespace',
  why: 'JavaScript trims the string before matching while Daml and a strict parser do not, so a padded field read out of a CSV is accepted by one client and refused by another, and the report and the ledger disagree about whether the row exists.',
  args: [A.text(' 1.5')],
  expect: { reject: { class: 'bad-format' } },
  decision: 'G03-whitespace',
  divergenceReason: 'JS calls String.trim() before matching the decimal grammar and accepts the value.',
  tags: ['amount', 'reject', 'normative'],
})
C({
  id: 'amount-sub-unit-precision-loss',
  capability: 'digest.amountUnits',
  title: 'An amount finer than 1e-10 is refused, not rounded',
  why: 'Silently dropping the eleventh digit would make two different payloads hash the same, so the round-trip guard refuses rather than losing precision; a client that rounds writes a commitment to an amount it did not receive.',
  args: [A.dec('0.00000000005')],
  tags: ['amount', 'reject'],
})
C({
  id: 'amount-eleven-fractional-nonzero',
  capability: 'digest.amountUnits',
  title: 'Eleven fractional digits with a non-zero tail are refused',
  why: 'This is the same guard reached from a plausible price feed rather than a contrived value, and it is the case that separates an implementation that checks the tail from one that only checks the digit count.',
  args: [A.dec('1.23456789012')],
  tags: ['amount', 'reject'],
})
C({
  id: 'amount-above-int64-band',
  capability: 'digest.amountUnits',
  title: 'An amount one unit above the band is refused',
  why: 'The band is exactly the Daml Int range in 1e-10 units; a reference that accepts what the ledger cannot hold cannot be used to reject it, and Python accepts Decimal("1e30") today.',
  args: [A.dec('922337203.6854775808')],
  tags: ['amount', 'reject', 'boundary'],
  daml: 'amountUnits band +/-922337203.6854775807',
})
C({
  id: 'amount-below-int64-band',
  capability: 'digest.amountUnits',
  title: 'An amount one unit below the band is refused',
  why: 'The negative edge is a separate branch in every implementation and a signed-overflow bug shows up on exactly one side, so both edges get a case.',
  args: [A.dec('-922337203.6854775809')],
  tags: ['amount', 'reject', 'boundary'],
})
C({
  id: 'amount-far-above-band',
  capability: 'digest.amountUnits',
  title: 'An amount far outside the band is refused',
  why: 'A client whose band check is a digit-count heuristic rather than an arithmetic comparison passes the adjacent-to-the-edge cases and fails here.',
  args: [A.dec('1000000000.0')],
  tags: ['amount', 'reject', 'boundary'],
})
C({
  id: 'amount-native-float-rejected',
  capability: 'digest.amountUnits',
  title: 'A native binary float is refused as an amount',
  why: 'canon_decimal(123456789.0123456789) returns d:19:1234567890123456700 in Python and a different value in JavaScript from the same intent, and both report success; refusing the type is the only thing that makes the difference visible.',
  args: [A.float64('123456789.0123456789')],
  appliesWhen: { hasNativeFloat: true },
  tags: ['amount', 'reject', 'normative'],
  sourceOfTruth: 'generated (JS already refuses a fractional Number)',
})
C({
  id: 'amount-native-float-half-rejected',
  capability: 'digest.canonDecimal',
  title: 'canonDecimal refuses a float even when the float is exact',
  why: '1.5 is exactly representable in binary, so a client that only refuses inexact floats accepts this one and its callers then believe floats are a supported input type; the refusal has to be about the type, not the value.',
  args: [A.float64('1.5')],
  appliesWhen: { hasNativeFloat: true },
  tags: ['amount', 'reject'],
})
C({
  id: 'amount-integer-number-accepted',
  capability: 'digest.amountUnits',
  title: 'An integral native number is accepted',
  why: 'The JavaScript client accepts an integral Number because it cannot lose precision; pinning that keeps the float rejection from being widened into a rejection of every numeric type, which would break existing callers without making anything safer.',
  args: [A.int(2n)],
  tags: ['amount', 'boundary'],
})

// ===========================================================================
// G04 - canon-document
// ===========================================================================

group('canon-document', 'core-digest',
  'The document envelope: scheme prefix, one literal pipe, schema, version, fields. ' +
  'The digest is the sha256 of that text as raw UTF-8, which is what makes plain sha256sum a check.')

C({
  id: 'canon-document-empty-fields',
  capability: 'digest.canonDocument',
  title: 'The smallest possible document',
  why: 'This pins the envelope with nothing inside it: one literal pipe after the prefix and no separator at all between schema, version and fields. A client that inserts a separator changes every document in the scheme at once.',
  args: [A.text('s'), A.int(1n), A.pairs([])],
  tags: ['document'],
})
C({
  id: 'canon-document-single-pipe-after-prefix',
  capability: 'digest.canonDocument',
  title: 'The only literal pipe is the one after the scheme prefix',
  why: 'Every other pipe in a document belongs to a canonList and is inside a length-prefixed value; a stray separator anywhere else would make the prefix ambiguous for a reader splitting on the first pipe.',
  args: [A.text('sch'), A.int(1n), A.pairs([[A.text('a'), A.raw(sdk.canonList([sdk.canonText('x'), sdk.canonText('y')]))]])],
  tags: ['document', 'boundary'],
})
C({
  id: 'canon-document-schema-is-inside-the-document',
  capability: 'digest.canonDocument',
  title: 'The schema name is part of the hashed text',
  why: 'Two payload types with the same fields must not collide; the schema is what separates a Merkle node from an audit row and makes claiming leaf-hood a sha256 collision problem rather than a formatting trick.',
  args: [A.text('arccade.merkle-empty'), A.int(1n), A.pairs([])],
  tags: ['document'],
})
C({
  id: 'canon-document-version-is-inside-the-document',
  capability: 'digest.canonDocument',
  title: 'The schema version is part of the hashed text',
  why: 'A v2 of a schema must not be able to produce a v1 digest; pinning version 2 of the same schema next to version 1 shows the two are distinguishable without reading the fields.',
  args: [A.text('s'), A.int(2n), A.pairs([])],
  tags: ['document'],
})
C({
  id: 'canon-document-fields-sorted-inside-envelope',
  capability: 'digest.canonDocument',
  title: 'Field order inside a document does not reach the digest',
  why: 'A builder that appends a field at the end rather than in sorted position would otherwise produce a document the ledger cannot reproduce; this is the composed form of the canonFields sort.',
  args: [A.text('s'), A.int(1n), A.pairs([
    [A.text('zeta'), A.raw(sdk.canonInt(2n))],
    [A.text('alpha'), A.raw(sdk.canonInt(1n))],
  ])],
  tags: ['document'],
})
C({
  id: 'text-digest-arccade',
  capability: 'digest.textDigest',
  title: 'textDigest of arccade matches plain sha256sum',
  why: "The value of the whole scheme is that a third party can run sha256sum over the published document and get the number on the ledger; if this one drifts, that claim is gone.",
  args: [A.text('arccade')],
  expect: { digest: '140f371fce01eea5068da54d3de6bb719d68dc325f494be284ce56a52da44079' },
  golden: 'VectorsTest:plainTextDigest',
  tags: ['digest'],
  daml: 'textDigest "arccade" === "140f371f...44079"',
  note: "Reproducible from a shell with: printf 'arccade' | sha256sum",
})
C({
  id: 'text-digest-utf8-bytes-not-code-units',
  capability: 'digest.textDigest',
  title: 'The digest is over UTF-8 bytes, not UTF-16 code units',
  why: 'An implementation hashing UTF-16 or Latin-1 bytes agrees with everyone on ASCII and diverges the moment a document carries a non-ASCII venue name or tier.',
  args: [A.text(cp(0x1F3AE, 0x65E5))],
  tags: ['digest', 'unicode'],
})
C({
  id: 'text-digest-empty-rejected',
  capability: 'digest.textDigest',
  title: 'textDigest of the empty string is refused',
  why: "Daml's toHex \"\" is a runtime error, so Daml cannot produce this digest at all; a client that returns e3b0c442... computes a value the ledger never can, and documentDigest can never reach the case because every document starts with the scheme prefix.",
  args: [A.text('')],
  expect: { reject: { class: 'bad-format' } },
  decision: 'D7',
  divergenceReason: 'JS returns the sha256 of the empty byte string instead of refusing.',
  tags: ['digest', 'reject', 'normative'],
})
C({
  id: 'document-digest-of-empty-document',
  capability: 'digest.canonDocument',
  title: 'The digest of the smallest document is pinned alongside its text',
  why: 'Pinning only the digest hides which byte moved; pinning only the text lets a hashing bug through. Every document-producing case in this suite pins both, and a runner must report which of the two failed.',
  args: [A.text('arccade.merkle-empty'), A.int(1n), A.pairs([])],
  tags: ['document', 'digest'],
})

// ===========================================================================
// G05 - merkle-structure
// ===========================================================================

group('merkle-structure', 'merkle',
  'Tree construction. A lone trailing node is PROMOTED unchanged, never paired with itself, ' +
  'which is what keeps [a,b,c] and [a,b,c,c] from sharing a root (CVE-2012-2459).')

// Pinned against Daml before anything is built from them: these hex strings go
// into the manifest as INPUT, so a broken textDigest would otherwise move the
// inputs and the expectations together and hide itself.
const LEAF = (n) => damlInputPin(`input.leaf-${n}`, sdk.textDigest(`leaf-${n}`))
const LEAVES9 = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(LEAF)

C({
  id: 'merkle-empty-golden',
  capability: 'merkle.merkleEmpty',
  title: 'The empty-period root',
  why: 'A day with zero cycles is still anchored, otherwise "nothing happened" and "we did not report" are indistinguishable; this constant is on the ledger in the live TestNet anchor for 2026-08-27.',
  args: [],
  expect: { digest: 'c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0' },
  golden: 'VectorsTest:merkleVectors merkleEmpty',
  tags: ['merkle'],
  daml: 'merkleEmpty === "c950347c...f61b0"',
})
C({
  id: 'merkle-node-golden',
  capability: 'merkle.merkleNode',
  title: 'An internal node over the first two golden leaves',
  why: 'Internal nodes hash under a different schema from leaves, and this is the constant that binds that separation across the four implementations.',
  args: [A.hex64(LEAF(1)), A.hex64(LEAF(2))],
  expect: { digest: 'aa3de7939ca80f5110e8b29ec442d9d770f525dfb63e86ff59e7624ff110e720' },
  golden: 'VectorsTest:merkleVectors merkleNode',
  tags: ['merkle'],
  daml: 'merkleNode (leaves !! 0) (leaves !! 1) === "aa3de793...0e720"',
})
C({
  id: 'merkle-root-three-leaves-golden',
  capability: 'merkle.merkleRoot',
  title: 'The three-leaf golden root',
  why: 'Three leaves is the smallest tree with a promotion in it, so this single constant covers both the pairing rule and the promotion rule that CVE-2012-2459 is about.',
  args: [A.list([1, 2, 3].map((n) => A.hex64(LEAF(n))))],
  expect: { digest: 'f31cc766e62a52c3c3156e05d53fde76f54fed6067d283dc9a3d8ada9d0ceedf' },
  golden: 'VectorsTest:merkleVectors merkleRoot',
  tags: ['merkle'],
  daml: 'merkleRoot leaves === "f31cc766...ceedf"',
})
C({
  id: 'merkle-node-domain-separation',
  capability: 'merkle.merkleNode',
  title: 'A node over two identical children is not the child',
  why: 'The leaf and node schemas differ, so no hashing of children can ever collide with a leaf value; a client that hashes the concatenation of children instead loses that separation and an internal node can be presented as a cycle.',
  args: [A.hex64(LEAF(1)), A.hex64(LEAF(1))],
  tags: ['merkle', 'boundary'],
})
C({
  id: 'merkle-node-is-order-sensitive',
  capability: 'merkle.merkleNode',
  title: 'Swapping the two children changes the node',
  why: 'Proof folding depends on knowing which side the sibling was on; a commutative node would let a forged proof place a sibling on either side and still verify.',
  args: [A.hex64(LEAF(2)), A.hex64(LEAF(1))],
  tags: ['merkle', 'boundary'],
})
C({
  id: 'merkle-root-of-no-leaves-is-merkle-empty',
  capability: 'merkle.merkleRoot',
  title: 'merkleRoot of no leaves is the empty root',
  why: 'A client that returns an all-zero hash or throws for an empty period cannot anchor a quiet day, and the anchor for a quiet day is exactly the one an auditor most needs.',
  args: [A.list([])],
  tags: ['merkle', 'boundary'],
})
C({
  id: 'merkle-root-of-one-leaf-is-the-leaf',
  capability: 'merkle.merkleRoot',
  title: 'A single leaf IS the root, unwrapped',
  why: 'A client that wraps a lone leaf in a node produces a root nobody else computes for a one-cycle day, which is the most common non-empty period a small venue has.',
  args: [A.list([A.hex64(LEAF(1))])],
  tags: ['merkle', 'boundary'],
})
for (let n = 1; n <= 9; n += 1) {
  C({
    id: `merkle-root-of-${n}-leaves`,
    capability: 'merkle.merkleRoot',
    title: `Root over ${n} leaves`,
    why: `Promotion happens at a different level for each leaf count, so the shape of the tree has to be pinned at every size up to nine; ${n} leaves is where an implementation that duplicates instead of promoting, or pairs from the wrong end, first differs.`,
    args: [A.list(LEAVES9.slice(0, n).map((h) => A.hex64(h)))],
    tags: ['merkle'],
  })
}
C({
  id: 'merkle-three-and-four-leaves-differ',
  capability: 'merkle.merkleRoot',
  title: 'Duplicating the last leaf changes the root',
  why: "Bitcoin's duplication convention lets [a,b,c] and [a,b,c,c] share a root, which is CVE-2012-2459; this root must differ from merkle-root-of-3-leaves or a period could be padded with a repeated cycle undetectably.",
  args: [A.list([LEAF(1), LEAF(2), LEAF(3), LEAF(3)].map((h) => A.hex64(h)))],
  tags: ['merkle', 'boundary'],
})
C({
  id: 'merkle-pair-up-promotes-lone-node',
  capability: 'merkle.merklePairUp',
  title: 'One level of pairing with an odd count',
  why: 'Pinning the intermediate level rather than only the root says where a duplicating implementation goes wrong, which a root alone cannot.',
  args: [A.list([LEAF(1), LEAF(2), LEAF(3)].map((h) => A.hex64(h)))],
  tags: ['merkle'],
})
C({
  id: 'merkle-pair-up-even-count',
  capability: 'merkle.merklePairUp',
  title: 'One level of pairing with an even count',
  why: 'The even case is the one every implementation gets right, and it is here so the odd case above is a comparison rather than an isolated assertion.',
  args: [A.list([LEAF(1), LEAF(2), LEAF(3), LEAF(4)].map((h) => A.hex64(h)))],
  tags: ['merkle'],
})
C({
  id: 'merkle-pair-up-single-element',
  capability: 'merkle.merklePairUp',
  title: 'Pairing a level that has one node returns it unchanged',
  why: 'This is the promotion rule in isolation; an implementation that pairs the node with itself produces a level that still has one element and a root that looks plausible.',
  args: [A.list([A.hex64(LEAF(1))])],
  tags: ['merkle', 'boundary'],
})

// ===========================================================================
// G06 - merkle-proof
// ===========================================================================

group('merkle-proof', 'merkle',
  'Inclusion proofs at every index of every tree size up to nine. Where a node was promoted, ' +
  'NO step is emitted, so a proof is not ceil(log2 n) steps long and a client that pads breaks.')

for (let n = 1; n <= 9; n += 1) {
  const leaves = LEAVES9.slice(0, n)
  for (let ix = 0; ix < n; ix += 1) {
    C({
      id: `merkle-proof-n${n}-index-${ix}`,
      capability: 'merkle.merkleProof',
      title: `Inclusion proof for leaf ${ix} of ${n}`,
      why: `A proof is only evidence if every client builds the same step list; index ${ix} of ${n} is one of the places a promoted node means no step is emitted at that level, and a client padding the proof to a fixed depth folds the wrong value.`,
      args: [A.int(BigInt(ix)), A.list(leaves.map((h) => A.hex64(h)))],
      tags: ['merkle', 'proof'],
    })
  }
}
for (const [n, ix] of [[3, 2], [5, 4], [9, 8]]) {
  const leaves = LEAVES9.slice(0, n)
  C({
    id: `merkle-verify-promoted-leaf-n${n}-index-${ix}`,
    capability: 'merkle.merkleVerify',
    title: `The promoted leaf ${ix} of ${n} verifies against the root`,
    why: `The step list for a promoted leaf is shorter than ceil(log2 ${n}); folding it still has to reach the root, which is what proves the promotion rule is consistent between the builder and the verifier.`,
    args: [
      A.hex64(leaves[ix]),
      A.steps(sdk.merkleProof(ix, leaves)),
      A.hex64(sdk.merkleRoot(leaves)),
    ],
    tags: ['merkle', 'proof'],
  })
}
C({
  id: 'merkle-proof-index-out-of-range',
  capability: 'merkle.merkleProof',
  title: 'An out-of-range index yields an empty proof, not an exception',
  why: 'All four implementations return an empty list rather than throwing, and callers rely on it; the danger is the next case, so this behaviour has to be pinned before it can be reasoned about.',
  args: [A.int(5n), A.list([LEAF(1), LEAF(2)].map((h) => A.hex64(h)))],
  tags: ['merkle', 'proof', 'boundary'],
})
C({
  id: 'merkle-verify-empty-proof-single-leaf-trap',
  capability: 'merkle.merkleVerify',
  title: 'An empty proof verifies anything against a single-leaf tree',
  why: 'merkleVerify with no steps reduces to leaf == root, so an out-of-range index against a one-leaf tree "verifies"; range-check before trusting an empty proof, and never expose bare merkleVerify as the auditor API.',
  args: [A.hex64(LEAF(1)), A.steps([]), A.hex64(sdk.merkleRoot([LEAF(1)]))],
  tags: ['merkle', 'proof', 'trap'],
})
C({
  id: 'merkle-verify-wrong-leaf-fails',
  capability: 'merkle.merkleVerify',
  title: 'A proof for one leaf does not verify a different leaf',
  why: 'Without this the whole group could be satisfied by an implementation that returns true unconditionally, and every proof case above would be worthless.',
  args: [
    A.hex64(LEAF(4)),
    A.steps(sdk.merkleProof(0, LEAVES9.slice(0, 3))),
    A.hex64(sdk.merkleRoot(LEAVES9.slice(0, 3))),
  ],
  tags: ['merkle', 'proof'],
})
C({
  id: 'merkle-verify-tampered-sibling-fails',
  capability: 'merkle.merkleVerify',
  title: 'Flipping a sibling in the proof breaks verification',
  why: 'The proof is the thing an auditor is handed, so the case where the proof rather than the leaf is wrong needs its own assertion.',
  args: [
    A.hex64(LEAF(0)),
    A.steps(sdk.merkleProof(0, LEAVES9.slice(0, 3)).map((s) => ({ siblingOnLeft: s.siblingOnLeft, sibling: LEAF(9) }))),
    A.hex64(sdk.merkleRoot(LEAVES9.slice(0, 3))),
  ],
  tags: ['merkle', 'proof'],
})
C({
  id: 'merkle-verify-flipped-side-fails',
  capability: 'merkle.merkleVerify',
  title: 'Flipping which side a sibling sits on breaks verification',
  why: 'siblingOnLeft is the only thing distinguishing two otherwise identical proofs, and a client that ignores it verifies a leaf that is not in the tree at the claimed position.',
  args: [
    A.hex64(LEAVES9[0]),
    A.steps(sdk.merkleProof(0, LEAVES9.slice(0, 3)).map((s) => ({ siblingOnLeft: !s.siblingOnLeft, sibling: s.sibling }))),
    A.hex64(sdk.merkleRoot(LEAVES9.slice(0, 3))),
  ],
  tags: ['merkle', 'proof'],
})
C({
  id: 'merkle-fold-is-separable-from-verify',
  capability: 'merkle.merkleFold',
  title: 'Folding a proof yields the root as a value, not a boolean',
  why: 'When a proof fails, the folded value is the only thing that says how far it got; a client that only exposes the boolean leaves an auditor with no way to tell a wrong leaf from a wrong sibling.',
  args: [A.hex64(LEAVES9[0]), A.steps(sdk.merkleProof(0, LEAVES9.slice(0, 3)))],
  tags: ['merkle', 'proof'],
})
C({
  id: 'merkle-fold-empty-proof-is-identity',
  capability: 'merkle.merkleFold',
  title: 'Folding an empty proof returns the leaf unchanged',
  why: 'This is the arithmetic behind the single-leaf trap above, stated as a value rather than a boolean so the reason the trap exists is visible.',
  args: [A.hex64(LEAVES9[0]), A.steps([])],
  tags: ['merkle', 'proof', 'boundary'],
})

// ===========================================================================
// G07 - period-leaf
// ===========================================================================

// Two more reject rules, added here because this is the group that reaches
// them: a leaf built from a decimal amount hits the integer parser, and a
// runner must classify that rather than swallow it.
for (const r of [
  { group: 'audit', match: 'Cannot convert', class: 'bad-format' },
]) { r.used = 0; REJECT_MAP.push(r) }

const ROWS_FIXTURE = JSON.parse(readFileSync(join(REPO, 'test-vectors', 'cycle-rows.json'), 'utf8'))
const bigFields = ['concurrencyIndex', 'committedUnits', 'feeUnits', 'returnedUnits',
  'forfeitedUnits', 'payoutUnits', 'committedAtMicros', 'settledAtMicros']
function fixtureRow(i, overrides = {}) {
  const raw = { ...ROWS_FIXTURE.rows[i] }
  for (const f of bigFields) raw[f] = BigInt(raw[f])
  return { ...raw, ...overrides }
}
const GOLDEN_ROW = {
  cycleId: 'cycle-golden',
  player: 'auditor-golden-party',
  gameCode: 'pixel-race-v1',
  concurrencyIndex: 0n,
  entryDigest: '0000000000000000000000000000000000000000000000000000000000000001',
  outcomeDigest: '0000000000000000000000000000000000000000000000000000000000000002',
  committedUnits: 300000000000n,
  feeUnits: 100000000n,
  returnedUnits: 300000000000n,
  forfeitedUnits: 0n,
  payoutUnits: 0n,
  disposition: 'returned-in-full',
  committedAtMicros: 1700000000000000n,
  settledAtMicros: 1700000003600000n,
  custodyTag: 'arccade-game-sdk:1:cycle-golden:x',
}

group('period-leaf', 'audit',
  'The fifteen fields of arccade.cycle-audit-row. Amounts go in as canonInt (integer 1e-10 units), ' +
  'NOT canonDecimal; the two timestamps go in as canonInt, NOT canonTimeMicros, even though they are times.')

C({
  id: 'period-leaf-golden-row',
  capability: 'audit.periodLeafDocument',
  title: 'The Daml golden audit row and its leaf',
  why: 'This is the constant that binds the Daml, JavaScript, Python and Java leaf builders to one another; an auditor verifies a proof in JavaScript or Python, never in Daml, so if this drifts the proof stops meaning anything.',
  args: [rowArg(GOLDEN_ROW)],
  expect: {
    document: {
      text: clientText('period-leaf-golden-row', () => sdk.periodLeafDocument(GOLDEN_ROW)),
      digest: '01e89a905ec52a23012354b602cdf583a7bc6dd92d9c36a19aa0346a1cf26237',
    },
  },
  golden: 'VectorsTest:auditRowVector',
  tags: ['audit', 'document'],
  daml: 'periodLeaf goldenAuditRow === "01e89a90...26237"',
})
for (let i = 0; i < ROWS_FIXTURE.rows.length; i += 1) {
  const r = fixtureRow(i)
  C({
    id: `period-leaf-fixture-row-${i}`,
    capability: 'audit.periodLeafDocument',
    title: `The leaf of TestNet row ${i} (${r.cycleId})`,
    why: `test-vectors/cycle-rows.json is already the cross-language contract for what the ledger emitted; lifting row ${i} in as a typed input means a client that cannot read transaction trees still has to prove it hashes the row identically.`,
    args: [rowArg(r)],
    expect: {
      document: { text: clientText(`period-leaf-fixture-row-${i}`, () => sdk.periodLeafDocument(r)), digest: ROWS_FIXTURE.leaves[i] },
    },
    golden: `test-vectors/cycle-rows.json leaves[${i}]`,
    tags: ['audit', 'document', 'testnet'],
  })
}
C({
  id: 'period-leaf-amounts-are-integers-not-decimals',
  capability: 'audit.periodLeafDocument',
  title: 'Amount fields carry the i tag, never the d tag',
  why: 'The row already holds integer 1e-10 units, so running them through canonDecimal would multiply by 1e10 a second time; the pinned text is where an implementer can see the tag and check it by eye.',
  args: [rowArg({ ...GOLDEN_ROW, cycleId: 'tag-check-amounts', committedUnits: 1n, feeUnits: 1n, returnedUnits: 1n, forfeitedUnits: 0n, payoutUnits: 0n })],
  tags: ['audit', 'document', 'trap'],
})
C({
  id: 'period-leaf-timestamps-are-integers-not-times',
  capability: 'audit.periodLeafDocument',
  title: 'Timestamp fields carry the i tag, never the m tag',
  why: 'Both timestamps are microsecond times but the row encodes them with canonInt; a client that reaches for canonTimeMicros because the field name ends in Micros produces a leaf that differs from the ledger in exactly two places.',
  args: [rowArg({ ...GOLDEN_ROW, cycleId: 'tag-check-times', committedAtMicros: 1n, settledAtMicros: 2n })],
  tags: ['audit', 'document', 'trap'],
})
for (const tag of ['returned-in-full', 'returned-with-forfeit', 'forfeited-in-full', 'aborted', 'expired-unsettled']) {
  const row = { ...GOLDEN_ROW, cycleId: `disp-${tag}`, disposition: tag }
  C({
    id: `period-leaf-disposition-${tag}`,
    capability: 'audit.periodLeafDocument',
    title: `A row carrying the ${tag} disposition tag`,
    why: `The ledger's choice argument carries the Daml constructor while the document carries the tag; ${tag} is one of the five, and a client that passes the constructor through produces silently different bytes whose failure only surfaces when an auditor's proof does not fold.`,
    args: [rowArg(row)],
    tags: ['audit', 'document'],
  })
}
for (const ctor of ['ReturnedInFull', 'ReturnedWithForfeit', 'ForfeitedInFull', 'Aborted', 'ExpiredUnsettled']) {
  C({
    id: `disposition-constructor-${ctor.toLowerCase()}`,
    capability: 'audit.periodLeafDocument',
    title: `A row carrying the ${ctor} constructor name is refused`,
    why: `Passing ${ctor} instead of its tag would produce a valid-looking document with different bytes, and the mistake would only be discovered when an auditor tried to verify a proof, which is the latest possible moment; all three clients validate rather than trust.`,
    args: [rowArg({ ...GOLDEN_ROW, disposition: ctor })],
    tags: ['audit', 'reject'],
  })
}
C({
  id: 'period-leaf-empty-outcome-digest-is-legal',
  capability: 'audit.periodLeafDocument',
  title: 'A row whose outcome never existed carries an empty outcomeDigest',
  why: 'Aborted and expired cycles have no outcome to digest, and the empty string is legal here because the field goes through canonText rather than textDigest; a client that substitutes a zero hash writes a claim about an outcome that never happened.',
  args: [rowArg({ ...GOLDEN_ROW, cycleId: 'no-outcome', disposition: 'aborted', outcomeDigest: '' })],
  tags: ['audit', 'document', 'boundary'],
})
C({
  id: 'period-leaf-ignores-reporting-only-fields',
  capability: 'audit.periodLeafDocument',
  title: 'Reporting-only fields on the row do not reach the leaf',
  why: 'rowsFromTransactions carries venueId and the two update ids so a report can cite its sources; if a client hashed them the leaf would depend on which transactions the report happened to quote rather than on the cycle.',
  args: [A.record('cycle-audit-row', {
    ...rowArg(GOLDEN_ROW).v.fields,
    venueId: A.text('tradewars/testnet-arena-v2'),
    commitUpdateId: A.text('1220e958bc1ee37993f52a255ad56d6ced4be9e91f6748891bc6025ae9552ef3e214'),
  })],
  tags: ['audit', 'document'],
  note: 'The expected document is identical to period-leaf-golden-row; that identity is the assertion.',
})
C({
  id: 'forged-row-amount-as-decimal',
  capability: 'audit.periodLeafDocument',
  title: 'A row whose amount is a decimal string is refused',
  why: 'A report generator that forgot to convert to units would put 100.0 where 1000000000000 belongs; accepted, it would produce a leaf that is off by a factor of 1e10 and still verify against a root computed the same wrong way.',
  args: [A.record('cycle-audit-row', { ...rowArg(GOLDEN_ROW).v.fields, committedUnits: A.text('100.0') })],
  tags: ['audit', 'reject', 'forgery'],
})

const FIXTURE_LEAVES = ROWS_FIXTURE.leaves
const FIXTURE_ROOT = ROWS_FIXTURE.merkleRoot
const NODE_01 = sdk.merkleNode(FIXTURE_LEAVES[0], FIXTURE_LEAVES[1])

C({
  id: 'merkle-verify-accepts-an-internal-node',
  capability: 'merkle.merkleVerify',
  title: 'Bare merkleVerify accepts an internal node as if it were a leaf',
  why: 'Folding cannot know what it started from, so this returns true for a node that is not a cycle at all; the case exists to state the hazard that makes periodRowVerify, not merkleVerify, the auditor API.',
  args: [
    A.hex64(NODE_01),
    A.steps([{ siblingOnLeft: false, sibling: FIXTURE_LEAVES[2] }]),
    A.hex64(FIXTURE_ROOT),
  ],
  tags: ['merkle', 'trap', 'forgery'],
})
C({
  id: 'forged-row-internal-node-as-leaf',
  capability: 'audit.periodRowVerify',
  title: 'No row can be presented as the internal node that verified above',
  why: 'periodRowVerify derives the leaf from the row, so passing off a node as a cycle would mean finding a sha256 collision across two schemas; a client that exposes bare merkleVerify as its auditor entry point returns true on the previous case and has no answer to this one.',
  args: [
    rowArg(fixtureRow(0)),
    A.steps([{ siblingOnLeft: false, sibling: FIXTURE_LEAVES[2] }]),
    A.hex64(FIXTURE_ROOT),
  ],
  tags: ['audit', 'forgery'],
})
C({
  id: 'period-row-verify-fixture-row-0',
  capability: 'audit.periodRowVerify',
  title: 'The first TestNet row verifies against the fixture root',
  why: 'The forgery cases below are only meaningful next to a proof that does verify; without this one an implementation returning false unconditionally would pass all of them.',
  args: [
    rowArg(fixtureRow(0)),
    A.steps(sdk.merkleProof(0, FIXTURE_LEAVES)),
    A.hex64(FIXTURE_ROOT),
  ],
  tags: ['audit', 'testnet'],
})
C({
  id: 'forged-row-tampered-payout',
  capability: 'audit.periodRowVerify',
  title: 'Raising the payout on a row breaks its proof',
  why: 'The payout is the number a venue has the most reason to overstate after the fact, and the proof is what makes restating it detectable rather than a matter of trusting the report.',
  args: [
    rowArg(fixtureRow(0, { payoutUnits: 10000000000n })),
    A.steps(sdk.merkleProof(0, FIXTURE_LEAVES)),
    A.hex64(FIXTURE_ROOT),
  ],
  tags: ['audit', 'forgery'],
})
C({
  id: 'forged-row-swapped-timestamps',
  capability: 'audit.periodRowVerify',
  title: 'Swapping the two timestamps on a row breaks its proof',
  why: 'A swapped pair keeps every amount intact and would move the cycle into a different period, which is how a venue could shift a bad day into a good one; both fields are inside the leaf so the proof catches it.',
  args: [
    rowArg(fixtureRow(0, {
      committedAtMicros: fixtureRow(0).settledAtMicros,
      settledAtMicros: fixtureRow(0).committedAtMicros,
    })),
    A.steps(sdk.merkleProof(0, FIXTURE_LEAVES)),
    A.hex64(FIXTURE_ROOT),
  ],
  tags: ['audit', 'forgery'],
})
C({
  id: 'forged-row-substituted-player',
  capability: 'audit.periodRowVerify',
  title: 'Substituting the player on a row breaks its proof',
  why: 'The party is the full ledger id inside the leaf, so a report cannot reassign a cycle to a different player without the proof failing.',
  args: [
    rowArg(fixtureRow(0, { player: 'someone-else::12200000000000000000000000000000000000000000000000000000000000000000' })),
    A.steps(sdk.merkleProof(0, FIXTURE_LEAVES)),
    A.hex64(FIXTURE_ROOT),
  ],
  tags: ['audit', 'forgery'],
})
C({
  id: 'merkle-root-over-fixture-leaves',
  capability: 'merkle.merkleRoot',
  title: 'The TestNet fixture root',
  why: 'This root is the published expectation for reconstructing test-vectors/cycle-trees.json; it is the one value that ties the reader, the leaf builder and the tree together on real ledger data.',
  args: [A.list(FIXTURE_LEAVES.map((h) => A.hex64(h)))],
  expect: { digest: FIXTURE_ROOT },
  golden: 'test-vectors/cycle-rows.json merkleRoot',
  tags: ['merkle', 'testnet'],
})

// ===========================================================================
// G08 - period-anchor
// ===========================================================================

group('period-anchor', 'audit',
  'arccade.period-anchor v1, fifteen fields. NO SHIPPED CLIENT IMPLEMENTS anchorDocument: ' +
  'Daml decides the anchor and the live TestNet anchor is on disk. The cases are here anyway, ' +
  'so a runner reports unsupported rather than the capability quietly disappearing.')

// The live anchor arCCade published for 2026-08-27. Inputs are the ones the
// venue anchored; the digest is the value on the ledger.
const LIVE_ANCHOR = {
  venueId: 'tradewars/testnet-arena-v2',
  periodId: '2026-08-27',
  periodStartMicros: 1787788800000000n,
  periodEndMicros: 1787875200000000n,
  cycleCount: 0n,
  committedUnits: 0n,
  feeUnits: 0n,
  returnedUnits: 0n,
  forfeitedUnits: 0n,
  payoutUnits: 0n,
  qualifyingTxCount: 0n,
  nonQualifyingTxCount: 1n,
  merkleRootHex: 'c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0',
  reportDigest: 'b4fda252f5064e39a0ed7a6e2914794545a3523b965e631eb94920f38be973fb',
  prevAnchorDigest: 'caa2d6f54dc9d0be9d165e505757cc760a421c13c75a21a6ac69e194e0470fc6',
}
const LIVE_ANCHOR_DIGEST = 'f3e0805b9c3b9b9147f8b7b866ddd34d157d5d1e1e60b5942e14335909a6bd2a'

// Cross-check against the anchor as published on Canton.
//
// VENDORED, not read from the host. It used to point at
// /opt/arccade/reports/game-sdk/... on the machine that publishes the reports,
// and the manifest recorded WHETHER THAT PATH EXISTED — so the file this
// generator produced differed between this box and anywhere else, and
// `--check` passed here and failed in CI. A reproducibility check that is
// itself host-dependent is worse than none: it goes green exactly where nobody
// is watching.
//
// The anchor is public — it is served at
// https://audit.arccade.io/testnet/ and the contract it describes is on the
// ledger — so vendoring it costs nothing and makes the cross-check run
// everywhere, including in CI, where it can now fail.
const LIVE_ANCHOR_FILE = new URL('../test-vectors/anchor-2026-08-27.json', import.meta.url).pathname
let liveAnchorCrossCheck = 'vendored anchor test-vectors/anchor-2026-08-27.json is missing'
if (existsSync(LIVE_ANCHOR_FILE)) {
  const live = JSON.parse(readFileSync(LIVE_ANCHOR_FILE, 'utf8'))
  const mismatches = []
  for (const [k, v] of Object.entries({
    venueId: LIVE_ANCHOR.venueId, periodId: LIVE_ANCHOR.periodId,
    merkleRootHex: LIVE_ANCHOR.merkleRootHex, reportDigest: LIVE_ANCHOR.reportDigest,
    prevAnchorDigest: LIVE_ANCHOR.prevAnchorDigest, anchorDigest: LIVE_ANCHOR_DIGEST,
  })) if (live[k] !== v) mismatches.push(`${k}: pinned ${v}, published ${live[k]}`)
  if (mismatches.length) problem(`live anchor cross-check failed:\n    ${mismatches.join('\n    ')}`)
  // The RESULT, not the path: an absolute path here is what made the manifest
  // differ between machines in the first place.
  liveAnchorCrossCheck = mismatches.length
    ? 'MISMATCH'
    : 'matches test-vectors/anchor-2026-08-27.json'
} else {
  problem(`vendored anchor missing: ${LIVE_ANCHOR_FILE}`)
}

const anchorArg = (a) => A.record('period-anchor', Object.fromEntries(
  ANCHOR_FIELDS.map((f) => [f, ANCHOR_TEXT_FIELDS.has(f) ? A.text(a[f]) : A.int(a[f])]),
))

C({
  id: 'anchor-testnet-2026-08-27',
  capability: 'audit.anchorDocument',
  title: 'The live TestNet anchor for 2026-08-27',
  why: 'This digest is on the ledger and in the published report, and no shipped client can reproduce it; the case is the evidence that the gap is real rather than a claim about it, and it goes green the moment any client implements anchorDocument.',
  args: [anchorArg(LIVE_ANCHOR)],
  expect: {
    document: {
      text: textPin(CAPS.get('audit.anchorDocument').reference([LIVE_ANCHOR]).text),
      digest: LIVE_ANCHOR_DIGEST,
    },
  },
  golden: 'live TestNet anchor f3e0805b',
  tags: ['audit', 'anchor', 'testnet', 'unimplemented'],
  note: 'The expected text is derived from canonDocument, canonText and canonInt only, so any client with the core-digest profile can compute it today even though none exposes anchorDocument.',
})
C({
  id: 'anchor-empty-period-root-is-merkle-empty',
  capability: 'audit.anchorDocument',
  title: 'An empty period still anchors, with the empty root',
  why: 'A day with no cycles must still produce an anchor, otherwise a venue that stops reporting is indistinguishable from a venue that had a quiet day; the live anchor above is exactly this case, which is why it is the one on the ledger.',
  args: [anchorArg({ ...LIVE_ANCHOR, periodId: '2026-08-28', prevAnchorDigest: LIVE_ANCHOR_DIGEST })],
  tags: ['audit', 'anchor', 'unimplemented'],
})
C({
  id: 'anchor-chain-start-empty-prev-digest',
  capability: 'audit.anchorDocument',
  title: 'The first anchor in a chain carries an empty prevAnchorDigest',
  why: 'The chain has to start somewhere, and an empty string is legal because the field goes through canonText; a client substituting a zero hash makes the first anchor look like it follows one that does not exist.',
  args: [anchorArg({ ...LIVE_ANCHOR, periodId: '2026-08-01', prevAnchorDigest: '' })],
  tags: ['audit', 'anchor', 'boundary', 'unimplemented'],
})
C({
  id: 'anchor-with-cycles-and-totals',
  capability: 'audit.anchorDocument',
  title: 'An anchor over the three TestNet rows',
  why: 'The empty anchor exercises none of the numeric fields; this one carries the real cycle count, the real root and the totals summed from the fixture rows, so a client that gets the field order or the tags wrong on non-zero values fails here.',
  args: [anchorArg({
    ...LIVE_ANCHOR,
    periodId: '2026-08-26',
    cycleCount: 3n,
    committedUnits: 1600000000000n,
    feeUnits: 5200000000n,
    returnedUnits: 1600000000000n,
    forfeitedUnits: 0n,
    payoutUnits: 0n,
    qualifyingTxCount: 6n,
    merkleRootHex: FIXTURE_ROOT,
  })],
  tags: ['audit', 'anchor', 'unimplemented'],
})
C({
  id: 'anchor-totals-derived-from-rows',
  capability: 'audit.anchorTotals',
  title: 'Totals are summed from the rows, never taken from the caller',
  why: 'A correct root says nothing about whether the summary fields are correct, so GameVenue_AnchorPeriod recomputes them; a venue that publishes a valid root and a flattering total is exactly what this catches.',
  args: [A.list([0, 1, 2].map((i) => rowArg(fixtureRow(i))))],
  tags: ['audit', 'anchor', 'unimplemented'],
})
C({
  id: 'anchor-totals-reject-duplicate-cycle-id',
  capability: 'audit.anchorTotals',
  title: 'Two rows with the same cycleId in one period are refused',
  why: 'cycleId has no contract key on the ledger, so nothing stops the same id appearing twice; a period that counts it twice inflates both the cycle count and the committed total while every individual proof still verifies.',
  args: [A.list([rowArg(fixtureRow(0)), rowArg(fixtureRow(0))])],
  tags: ['audit', 'anchor', 'reject', 'unimplemented'],
})
C({
  id: 'anchor-totals-of-an-empty-period',
  capability: 'audit.anchorTotals',
  title: 'The totals of a period with no rows are all zero',
  why: 'The empty period is the one the live anchor covers, and a client that returns no totals rather than zero totals cannot fill the anchor document at all.',
  args: [A.list([])],
  tags: ['audit', 'anchor', 'unimplemented'],
})

// ===========================================================================
// G09 - policy-document
// ===========================================================================

group('policy-document', 'audit',
  'arccade-venue-policy v1, twelve fields. The full text of the policy in force is committed at ' +
  'every stake, so "under which rules was this cycle opened" is answered by the cycle, not by us.')

const POLICY = {
  'min-stake-amount': '1.0',
  'max-stake-amount': '1000.0',
  'min-platform-fee': '0.5',
  'max-payout-amount': '5000.0',
  'min-lock-seconds': 7200n,
  'max-lock-seconds': 86400n,
  'min-cycle-seconds': 60n,
  'max-cycle-seconds': 3600n,
  'cooldown-seconds': 30n,
  'abort-cooldown-seconds': 300n,
  'concurrency-limit': 3n,
  'require-custody-proof': true,
}
const policyArg = (p) => A.record('venue-policy', Object.fromEntries(Object.entries(p).map(([k, v]) => [
  k,
  typeof v === 'boolean' ? A.bool(v) : (typeof v === 'bigint' ? A.int(v) : A.dec(v)),
])))

C({
  id: 'policy-document-representative',
  capability: 'policy.policyDocument',
  title: 'A representative venue policy and its digest',
  why: 'GameStake.policyHash commits to this text, so a venue cannot rewrite the rules after the fact and claim a cycle was opened under them; the document has to be reproducible outside Daml for that to be checkable.',
  args: [policyArg(POLICY)],
  tags: ['policy', 'document', 'unimplemented'],
})
C({
  id: 'policy-document-amounts-are-decimals',
  capability: 'policy.policyDocument',
  title: 'Policy amounts use canonDecimal while the audit row uses canonInt',
  why: 'The two schemas differ on purpose: a policy is authored in decimals and a row carries units already converted. A client that applies one convention to both produces a policy digest that no stake can match.',
  args: [policyArg({ ...POLICY, 'min-stake-amount': '0.0000000001', 'max-payout-amount': '0.0' })],
  tags: ['policy', 'document', 'trap', 'unimplemented'],
})
C({
  id: 'policy-document-require-custody-proof-false',
  capability: 'policy.policyDocument',
  title: 'The custody-proof flag goes through canonBool',
  why: 'true and false have different lengths, so the flag is one of the few places a fixed-width encoder would break, and it is the field that decides whether a stake needs to exhibit a real lock.',
  args: [policyArg({ ...POLICY, 'require-custody-proof': false })],
  tags: ['policy', 'document', 'unimplemented'],
})
C({
  id: 'valid-policy-accepts-a-consistent-policy',
  capability: 'policy.validPolicy',
  title: 'A consistent policy is valid',
  why: 'validPolicy sits in an ensure clause, so an inconsistent policy cannot create a venue at all; the accepting case has to be pinned or a client could satisfy every rejection by refusing everything.',
  args: [policyArg(POLICY)],
  tags: ['policy', 'unimplemented'],
})
C({
  id: 'valid-policy-rejects-lock-shorter-than-cycle',
  capability: 'policy.validPolicy',
  title: 'A lock shorter than the minimum cycle is not a lock',
  why: 'If the lock can expire mid-cycle the player can leave through OwnerExpireLockV2 before the minimum duration is up, which hollows out the minimum-ledger-lock commitment entirely.',
  args: [policyArg({ ...POLICY, 'min-lock-seconds': 30n, 'max-lock-seconds': 86400n, 'min-cycle-seconds': 60n })],
  tags: ['policy', 'unimplemented'],
})
C({
  id: 'valid-policy-rejects-zero-stake-floor',
  capability: 'policy.validPolicy',
  title: 'A zero minimum stake is refused',
  why: 'A venue with no stake floor can manufacture cycles at no cost, which turns the qualifying-activity count into something a caller sets rather than something it pays for.',
  args: [policyArg({ ...POLICY, 'min-stake-amount': '0.0' })],
  tags: ['policy', 'unimplemented'],
})
C({
  id: 'valid-policy-rejects-inverted-stake-band',
  capability: 'policy.validPolicy',
  title: 'A maximum stake below the minimum is refused',
  why: 'An inverted band accepts nothing at all, so a venue created with one would take stakes that can never be committed and the failure would show up as an unexplained rejection at play time.',
  args: [policyArg({ ...POLICY, 'max-stake-amount': '0.5' })],
  tags: ['policy', 'unimplemented'],
})
C({
  id: 'valid-policy-rejects-zero-concurrency-limit',
  capability: 'policy.validPolicy',
  title: 'A zero concurrency limit is refused',
  why: 'Zero slots means no player can ever commit, and a venue in that state looks healthy from outside while refusing every cycle.',
  args: [policyArg({ ...POLICY, 'concurrency-limit': 0n })],
  tags: ['policy', 'unimplemented'],
})

// ===========================================================================
// G10 - audit-tree
// ===========================================================================

group('audit-tree', 'audit',
  'Rebuilding report rows from the ledger transaction TREE. The join key is the STAKE CONTRACT ID, ' +
  'not the cycleId: a closing choice does not repeat the cycleId, it lives on the contract being exercised.')

const TREES = JSON.parse(readFileSync(join(REPO, 'test-vectors', 'cycle-trees.json'), 'utf8'))
const ALL_TX = TREES.cases.flatMap((c) => [c.commitTransaction, c.closingTransaction].filter(Boolean))
const txList = (txs) => A.list(txs.map((t) => A.json(t)))

C({
  id: 'audit-tree-reconstructs-published-rows',
  capability: 'audit.rowsFromTransactions',
  title: 'The three published rows, rebuilt from the real TestNet stream',
  why: 'If the rows behind an anchor come from our own database the anchor commits to our bookkeeping; it is evidence only when the rows derive from the same stream an auditor reads, which is what this case makes checkable in any language.',
  args: [txList(ALL_TX)],
  tags: ['audit', 'testnet'],
  note: 'The transactions are the ones in test-vectors/cycle-trees.json, embedded verbatim so the case needs nothing but this manifest.',
})
C({
  id: 'audit-tree-report-order-of-published-rows',
  capability: 'audit.reportOrder',
  title: 'The order the three published rows come out in',
  why: 'Report order decides the leaf order and therefore the root, so two honest implementations that sort differently publish different roots over the same set of cycles.',
  args: [txList(ALL_TX)],
  tags: ['audit', 'testnet', 'order'],
})
C({
  id: 'audit-tree-no-unmatched-halves-in-fixture',
  capability: 'audit.unmatchedHalves',
  title: 'The fixture leaves no open stake and no orphan closing',
  why: 'Unmatched halves are returned rather than dropped, because silently discarding a commit whose closing fell outside the window is exactly the omission an anchor exists to make provable; the fixture has none, which is what makes the synthetic cases below meaningful.',
  args: [txList(ALL_TX)],
  tags: ['audit', 'testnet'],
})

// -- synthetic trees, so the reader can be driven into states the live fixture
//    does not contain. Everything below is self-contained.

const PARTY = 'arccade-validator-1::1220ce19f2a2928e5775dbc18e14d37c1fa4d8e5579d6234c3def66438a182e963bf'
// These fixtures stand in for what a PARTICIPANT EMITTED, so both ids are
// real and package-id-qualified: a `#name` reference never appears in a
// transaction stream. The SDK id is the current vetted release, the amulet
// id is the splice-amulet the live AmuletRules is on — the same one the real
// transactions in test-vectors/cycle-trees.json carry.
const SDK_PKG = sdkPackageId(PACKAGE_IDS.current)
const AMULET_PKG = externalPackageId('splice-amulet')

function mkCommit(o) {
  return {
    updateId: o.updateId,
    commandId: `commit-${o.cycleId}`,
    workflowId: '',
    effectiveAt: o.committedAt,
    events: [
      { ExercisedEvent: {
        contractId: `ent-${o.cycleId}`,
        templateId: `${SDK_PKG}:ArCCade.GameSdk.Cycle:PlayerEntitlement`,
        choice: 'Entitlement_Commit',
        choiceArgument: { gameCode: o.gameCode, cycleId: o.cycleId },
        consuming: true,
        exerciseResult: o.stakeCid,
      } },
      { CreatedEvent: {
        contractId: o.stakeCid,
        templateId: `${SDK_PKG}:ArCCade.GameSdk.Cycle:GameStake`,
        createArgument: {
          venueId: o.venueId ?? 'tradewars/testnet-arena-v2',
          cycleId: o.cycleId,
          player: o.player ?? PARTY,
          gameCode: o.gameCode,
          concurrencyIndex: o.concurrencyIndex ?? '0',
          entryDigest: o.entryDigest,
          committedAt: o.committedAt,
          terms: {
            stakeAmount: o.stakeAmount,
            feeAmount: o.feeAmount,
            custodyTag: `arccade-game-sdk:1:${o.cycleId}:${o.entryDigest}`,
          },
        },
      } },
    ],
  }
}
function mkClosing(o) {
  const events = [
    { ExercisedEvent: {
      contractId: o.stakeCid,
      templateId: `${SDK_PKG}:ArCCade.GameSdk.Cycle:GameStake`,
      choice: o.choice,
      choiceArgument: o.choiceArgument ?? {},
      consuming: true,
      exerciseResult: null,
    } },
  ]
  if (o.unlockedAmount !== undefined) {
    events.push({ CreatedEvent: {
      contractId: `amulet-${o.stakeCid}`,
      templateId: `${AMULET_PKG}:Splice.Amulet:Amulet`,
      createArgument: { owner: o.player ?? PARTY, amount: { initialAmount: o.unlockedAmount } },
    } })
  }
  return { updateId: o.updateId, commandId: `close-${o.stakeCid}`, workflowId: '', effectiveAt: o.settledAt, events }
}

const DIGEST_A = '5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852'
const DIGEST_B = 'fd8d8db1d08ba84d3325137b8adf0c7dc7c894e3bd099b36c9464b618f190d4b'
const OUTCOME_A = '124de70ecc959cfe2d9f01362a414e9a493df2e10b521551ffd262c1f29d2f0a'

const settleTx = (over = {}) => {
  const cycleId = over.cycleId ?? 'syn-settle-1'
  const stakeCid = over.stakeCid ?? `stake-${cycleId}`
  return [
    mkCommit({ updateId: `u-commit-${cycleId}`, stakeCid, cycleId, gameCode: 'trade-wars-v4',
      entryDigest: DIGEST_A, committedAt: '2026-08-22T22:29:07.372202Z',
      stakeAmount: '100.0000000000', feeAmount: '0.5000000000', ...over.commit }),
    mkClosing({ updateId: `u-close-${cycleId}`, stakeCid, choice: 'GameStake_Settle',
      settledAt: '2026-08-22T22:29:35.189712Z',
      choiceArgument: {
        disposition: 'ReturnedInFull', returnedAmount: '100.0000000000',
        forfeitedAmount: '0.0000000000', payoutAmount: '0.0000000000', outcomeDigest: OUTCOME_A,
      }, ...over.closing }),
  ]
}

C({
  id: 'audit-tree-join-is-by-stake-contract-id',
  capability: 'audit.rowsFromTransactions',
  title: 'Commit and closing are joined by the stake contract id',
  why: 'The closing choice never repeats the cycleId, so a reader that tries to join on it finds nothing; the commit exercise result is the only link between the two halves in the stream.',
  args: [txList(settleTx())],
  tags: ['audit'],
})
// ---------------------------------------------------------------------------
// THE READER'S TAG, MEASURED WHERE IT IS HASHED.
//
// Every case above compares row-shaped VALUES, and this generator writes those
// expectations down itself. So renaming the reader's whole constructor-to-tag
// table is adopted rather than caught: the rows come back carrying
// `ReturnedInFull`, the generator records that as the new expectation, and all
// three runners then agree with it. That was a measured escape.
//
// The way to close it is to stop comparing the reader's output to something
// this file made up, and start FEEDING it to the leaf builder — which is where
// the tag actually becomes bytes a published root depends on. The row that goes
// in is the one the client produced; the input pin says what the row's tag has
// to be, and Daml says what the leaf has to be.
const readerSettleRow = sdk.toLeafRow(sdk.rowsFromTransactions(settleTx()).rows[0])
damlInputPin('input.reader-settle-row-disposition', readerSettleRow.disposition)

reopen('period-leaf')
C({
  id: 'period-leaf-of-a-reader-rebuilt-row',
  capability: 'audit.periodLeafDocument',
  title: 'The leaf of a row the reader rebuilt from a transaction stream, not from this file',
  why: "Every other row in this group is typed out here, so the leaf builder is only ever asked about rows the suite already agrees with; this one arrives from rowsFromTransactions, which means the constructor-to-tag mapping is inside the value being hashed and a rename of that table changes the leaf instead of changing the expectation.",
  args: [rowArg(readerSettleRow)],
  tags: ['audit', 'document'],
  note: 'The input is produced by the client and pinned against Daml as input.reader-settle-row-disposition, so a client that renames its tags fails on the way in as well as on the way out.',
})
reopen('audit-tree')

C({
  id: 'audit-tree-abort-derives-amounts',
  capability: 'audit.rowsFromTransactions',
  title: 'An aborted cycle derives its amounts rather than reading them',
  why: 'GameStake_Abort carries only a reason, so the amounts have to come from the mechanic: unlocking a TimeLockedHolding pays the owner in full and this mechanic cannot forfeit, which is why the stake comes back and nothing else moves.',
  args: [txList([
    mkCommit({ updateId: 'u1', stakeCid: 'stake-abort', cycleId: 'syn-abort', gameCode: 'pixel-race-v1',
      entryDigest: DIGEST_B, committedAt: '2026-08-24T11:23:09.534518Z',
      stakeAmount: '30.0000000000', feeAmount: '0.0100000000' }),
    mkClosing({ updateId: 'u2', stakeCid: 'stake-abort', choice: 'GameStake_Abort',
      settledAt: '2026-08-24T11:40:26.741193Z', choiceArgument: { reason: 'player disconnected' } }),
  ])],
  tags: ['audit'],
})
C({
  id: 'audit-tree-expiry-derives-amounts',
  capability: 'audit.rowsFromTransactions',
  title: 'An expired cycle derives its amounts from nothing at all',
  why: 'GameStake_ExpireUnsettled carries no argument whatsoever, so a reader that expects a disposition in the choice argument produces no row and the cycle vanishes from the period it belongs to.',
  args: [txList([
    mkCommit({ updateId: 'u3', stakeCid: 'stake-expire', cycleId: 'syn-expire', gameCode: 'pixel-race-v1',
      entryDigest: DIGEST_B, committedAt: '2026-08-24T11:39:21.158600Z',
      stakeAmount: '30.0000000000', feeAmount: '0.0100000000' }),
    mkClosing({ updateId: 'u4', stakeCid: 'stake-expire', choice: 'GameStake_ExpireUnsettled',
      settledAt: '2026-08-27T16:47:00.111993Z' }),
  ])],
  tags: ['audit'],
})
C({
  id: 'audit-tree-empty-outcome-digest-on-abort',
  capability: 'audit.reportOrder',
  title: 'An aborted cycle still produces a row',
  why: 'Its outcomeDigest is empty because no outcome ever existed, not because the reader failed to find one; a reader that skips rows with no outcome removes exactly the cycles a player would complain about.',
  args: [txList([
    mkCommit({ updateId: 'u5', stakeCid: 'stake-a2', cycleId: 'syn-abort-2', gameCode: 'pixel-race-v1',
      entryDigest: DIGEST_B, committedAt: '2026-08-24T11:23:09.534518Z',
      stakeAmount: '30.0000000000', feeAmount: '0.0100000000' }),
    mkClosing({ updateId: 'u6', stakeCid: 'stake-a2', choice: 'GameStake_Abort',
      settledAt: '2026-08-24T11:40:26.741193Z', choiceArgument: { reason: 'x' } }),
  ])],
  tags: ['audit'],
})
C({
  id: 'audit-tree-open-stake-is-surfaced',
  capability: 'audit.unmatchedHalves',
  title: 'A commit with no closing is reported, not dropped',
  why: 'An open cycle belongs to no period yet, but a reader that discards it silently cannot tell an open cycle from one whose closing it failed to parse, and those are very different facts about a venue.',
  args: [txList([
    mkCommit({ updateId: 'u7', stakeCid: 'stake-open', cycleId: 'syn-open', gameCode: 'trade-wars-v4',
      entryDigest: DIGEST_A, committedAt: '2026-08-22T22:29:07.372202Z',
      stakeAmount: '100.0000000000', feeAmount: '0.5000000000' }),
  ])],
  tags: ['audit', 'boundary'],
})
C({
  id: 'audit-tree-orphan-closing-is-surfaced',
  capability: 'audit.unmatchedHalves',
  title: 'A closing whose commit is outside the window is reported',
  why: 'A window boundary always cuts some cycle in half; surfacing the orphan is what lets a report say which period the missing commit belongs to instead of leaving a settled cycle unaccounted for.',
  args: [txList([
    mkClosing({ updateId: 'u8', stakeCid: 'stake-orphan', choice: 'GameStake_Settle',
      settledAt: '2026-08-22T22:29:35.189712Z',
      choiceArgument: { disposition: 'ReturnedInFull', returnedAmount: '1.0', forfeitedAmount: '0.0', payoutAmount: '0.0', outcomeDigest: OUTCOME_A } }),
  ])],
  tags: ['audit', 'boundary'],
})
C({
  id: 'audit-tree-unlock-cross-check-agrees',
  capability: 'audit.unlockWarnings',
  title: 'A settlement whose unlock rides along and agrees raises no warning',
  why: 'When the unlock is in the same transaction the created Amulet gives an independent reading of what was returned; the agreeing case has to be pinned or the disagreeing one below could be satisfied by a client that always warns.',
  args: [txList(settleTx({ cycleId: 'syn-unlock-ok', closing: {
    updateId: 'u-close-unlock-ok', stakeCid: 'stake-syn-unlock-ok', choice: 'GameStake_Settle',
    settledAt: '2026-08-22T22:29:35.189712Z', unlockedAmount: '100.0000000000',
    choiceArgument: { disposition: 'ReturnedInFull', returnedAmount: '100.0000000000', forfeitedAmount: '0.0000000000', payoutAmount: '0.0000000000', outcomeDigest: OUTCOME_A },
  } }))],
  tags: ['audit'],
})
C({
  id: 'audit-tree-unlock-cross-check-disagrees',
  capability: 'audit.unlockWarnings',
  title: 'A stated return that disagrees with the unlock is reported',
  why: 'The choice argument is what the venue says and the unlocked Amulet is what actually moved; reporting the disagreement rather than trusting the argument is the difference between a report and a press release.',
  args: [txList(settleTx({ cycleId: 'syn-unlock-bad', closing: {
    updateId: 'u-close-unlock-bad', stakeCid: 'stake-syn-unlock-bad', choice: 'GameStake_Settle',
    settledAt: '2026-08-22T22:29:35.189712Z', unlockedAmount: '99.0000000000',
    choiceArgument: { disposition: 'ReturnedInFull', returnedAmount: '100.0000000000', forfeitedAmount: '0.0000000000', payoutAmount: '0.0000000000', outcomeDigest: OUTCOME_A },
  } }))],
  tags: ['audit', 'forgery'],
  note: 'The live fixture contains no such case, which is why this one is synthetic; the warning path would otherwise be unexercised.',
})
C({
  id: 'audit-tree-unknown-disposition-rejected',
  capability: 'audit.rowsFromTransactions',
  title: 'A settle carrying an unknown disposition is refused',
  why: 'A future ledger version could add a disposition this reader does not know; guessing a tag for it would put a wrong value inside a leaf, so the reader stops instead of inventing one.',
  args: [txList(settleTx({ cycleId: 'syn-bad-disp', closing: {
    updateId: 'u-close-bad-disp', stakeCid: 'stake-syn-bad-disp', choice: 'GameStake_Settle',
    settledAt: '2026-08-22T22:29:35.189712Z',
    choiceArgument: { disposition: 'SomethingNew', returnedAmount: '1.0', forfeitedAmount: '0.0', payoutAmount: '0.0', outcomeDigest: OUTCOME_A },
  } }))],
  tags: ['audit', 'reject'],
})

const ISO_CASES = [
  ['microsecond-exact', '2026-08-22T22:29:07.372202Z', 'six fractional digits, which is what the ledger emits'],
  ['whole-second', '2026-08-22T22:29:07Z', 'no fractional part at all'],
  ['millisecond', '2026-08-22T22:29:07.372Z', 'three fractional digits, which must pad to microseconds not truncate'],
  ['epoch', '1970-01-01T00:00:00Z', 'the epoch itself'],
  ['nine-fractional-digits', '2026-08-22T22:29:07.372202999Z', 'nanosecond input, which must cut at six digits'],
]
for (const [slug, iso, blurb] of ISO_CASES) {
  C({
    id: `iso-to-micros-${slug}`,
    capability: 'audit.isoToMicros',
    title: `isoToMicros of ${blurb}`,
    why: `Ledger timestamps carry microsecond precision, so a client parsing through a millisecond Date type and multiplying by a thousand produces a different document; ${blurb} is where that shortcut shows.`,
    args: [A.text(iso)],
    tags: ['audit', 'time'],
  })
}
C({
  id: 'iso-to-micros-rejects-missing-z',
  capability: 'audit.isoToMicros',
  title: 'A timestamp without the trailing Z is refused',
  why: 'Without the Z the value is host-timezone dependent, and a two-hour shift in a committedAtMicros moves a cycle into a different period while every field still looks reasonable.',
  args: [A.text('2026-08-22T22:29:07.372202')],
  tags: ['audit', 'time', 'reject'],
})
C({
  id: 'iso-to-micros-rejects-offset-timezone',
  capability: 'audit.isoToMicros',
  title: 'A timestamp with a numeric offset is refused',
  why: 'An offset is not what the ledger emits, and accepting one means two clients reading the same report disagree about when the cycle committed by exactly the offset.',
  args: [A.text('2026-08-22T22:29:07.372202+02:00')],
  tags: ['audit', 'time', 'reject'],
})
C({
  id: 'iso-micros-preserved-in-document',
  capability: 'audit.periodLeafDocument',
  title: 'The microsecond part of a ledger timestamp survives into the leaf',
  why: 'A client whose document path routes through a millisecond conversion writes ...372000 where the ledger wrote ...372202, and the leaf differs in three digits nobody looks at until a proof fails.',
  args: [rowArg(fixtureRow(0))],
  tags: ['audit', 'time', 'document'],
  note: 'Same input as period-leaf-fixture-row-0; carried separately because this is the assertion D3 is about.',
})

// ===========================================================================
// G11 - report-order
// ===========================================================================

group('report-order', 'audit',
  'The tie-break. cycle-rows.json says "committedAtMicros, then cycleId" without naming a collation, ' +
  'so today neither localeCompare nor UTF-16 compareTo is wrong and two honest implementations ' +
  'produce two different Merkle roots over the same set of cycles. This group picks code-point order.')

// The normative comparator: Unicode code point ascending, which is exactly
// UTF-8 byte order and is trivial in all four languages.
function cmpCodePoint(a, b) {
  const xs = [...a], ys = [...b]
  const n = Math.min(xs.length, ys.length)
  for (let i = 0; i < n; i += 1) {
    const x = xs[i].codePointAt(0), y = ys[i].codePointAt(0)
    if (x !== y) return x < y ? -1 : 1
  }
  return xs.length === ys.length ? 0 : (xs.length < ys.length ? -1 : 1)
}

let orderSeq = 0
function tiePair(slug, idA, idB, blurb, sameTime = true) {
  orderSeq += 1
  const tA = '2026-08-22T22:29:07.372202Z'
  const tB = sameTime ? tA : '2026-08-22T22:29:08.372202Z'
  const txs = [
    ...(() => {
      const cid = `s${orderSeq}a`
      return [
        mkCommit({ updateId: `${cid}-c`, stakeCid: cid, cycleId: idA, gameCode: 'trade-wars-v4',
          entryDigest: DIGEST_A, committedAt: tA, stakeAmount: '1.0000000000', feeAmount: '0.5000000000' }),
        mkClosing({ updateId: `${cid}-z`, stakeCid: cid, choice: 'GameStake_Abort',
          settledAt: '2026-08-22T23:00:00.000000Z', choiceArgument: { reason: 'x' } }),
      ]
    })(),
    ...(() => {
      const cid = `s${orderSeq}b`
      return [
        mkCommit({ updateId: `${cid}-c`, stakeCid: cid, cycleId: idB, gameCode: 'trade-wars-v4',
          entryDigest: DIGEST_A, committedAt: tB, stakeAmount: '1.0000000000', feeAmount: '0.5000000000' }),
        mkClosing({ updateId: `${cid}-z`, stakeCid: cid, choice: 'GameStake_Abort',
          settledAt: '2026-08-22T23:00:00.000000Z', choiceArgument: { reason: 'x' } }),
      ]
    })(),
  ]
  const expected = sameTime
    ? [idA, idB].sort(cmpCodePoint)
    : [idA, idB]
  C({
    id: `report-order-${slug}`,
    capability: 'audit.reportOrder',
    title: `Tie-break between ${JSON.stringify(idA)} and ${JSON.stringify(idB)}`,
    why: `Leaf order decides the root, so a collation difference is a different published root over the same cycles; ${blurb} is a pair where locale collation, UTF-16 code-unit order and code-point order do not all agree.`,
    args: [txList(txs)],
    expect: { order: expected },
    decision: 'D1',
    expectDivergence: false,
    divergenceReason: 'rowsFromTransactions breaks ties with localeCompare, which is locale- and ICU-version-dependent.',
    tags: ['audit', 'order', 'normative'],
  })
}

tiePair('uppercase-b-vs-lowercase-a', 'B', 'a', 'an uppercase letter against a lowercase one')
tiePair('mixed-case-hyphenated', 'c-1', 'C-1', 'the same id differing only in case')
tiePair('underscore-vs-hyphen', 'x_1', 'x-1', 'underscore against hyphen, which locale collation often treats as equivalent')
tiePair('leading-underscore', '_z', 'az', 'a leading punctuation character, which many collations ignore entirely')
tiePair('astral-vs-replacement', cp(0x1F3AE), cp(0xFFFD), 'an astral code point against the replacement character, which UTF-16 compareTo orders backwards')
tiePair('digits-vs-letters', '1a', 'a1', 'a digit against a letter at the first position')
tiePair('prefix-shorter-first', 'ab', 'abc', 'one id that is a prefix of the other')

C({
  id: 'report-order-distinct-times-dominate',
  capability: 'audit.reportOrder',
  title: 'A later commit sorts after an earlier one whatever the ids say',
  why: 'The tie-break only applies when the timestamps are equal; a client that sorts by cycleId first reorders every period and the tie-break cases above would not catch it.',
  args: [txList([
    mkCommit({ updateId: 'tc1', stakeCid: 'st1', cycleId: 'zzz', gameCode: 'trade-wars-v4',
      entryDigest: DIGEST_A, committedAt: '2026-08-22T22:29:07.372202Z', stakeAmount: '1.0000000000', feeAmount: '0.5000000000' }),
    mkClosing({ updateId: 'tz1', stakeCid: 'st1', choice: 'GameStake_Abort', settledAt: '2026-08-22T23:00:00.000000Z', choiceArgument: { reason: 'x' } }),
    mkCommit({ updateId: 'tc2', stakeCid: 'st2', cycleId: 'aaa', gameCode: 'trade-wars-v4',
      entryDigest: DIGEST_A, committedAt: '2026-08-22T22:29:09.372202Z', stakeAmount: '1.0000000000', feeAmount: '0.5000000000' }),
    mkClosing({ updateId: 'tz2', stakeCid: 'st2', choice: 'GameStake_Abort', settledAt: '2026-08-22T23:00:00.000000Z', choiceArgument: { reason: 'x' } }),
  ])],
  tags: ['audit', 'order'],
})
C({
  id: 'report-order-microsecond-separates',
  capability: 'audit.reportOrder',
  title: 'One microsecond is enough to separate two commits',
  why: 'If a client truncates commit times to milliseconds these two collapse into a tie and fall through to the cycleId comparison, which reverses them; the tie-break and the timestamp precision are the same bug seen twice.',
  args: [txList([
    mkCommit({ updateId: 'mc1', stakeCid: 'sm1', cycleId: 'zzz', gameCode: 'trade-wars-v4',
      entryDigest: DIGEST_A, committedAt: '2026-08-22T22:29:07.372203Z', stakeAmount: '1.0000000000', feeAmount: '0.5000000000' }),
    mkClosing({ updateId: 'mz1', stakeCid: 'sm1', choice: 'GameStake_Abort', settledAt: '2026-08-22T23:00:00.000000Z', choiceArgument: { reason: 'x' } }),
    mkCommit({ updateId: 'mc2', stakeCid: 'sm2', cycleId: 'aaa', gameCode: 'trade-wars-v4',
      entryDigest: DIGEST_A, committedAt: '2026-08-22T22:29:07.372202Z', stakeAmount: '1.0000000000', feeAmount: '0.5000000000' }),
    mkClosing({ updateId: 'mz2', stakeCid: 'sm2', choice: 'GameStake_Abort', settledAt: '2026-08-22T23:00:00.000000Z', choiceArgument: { reason: 'x' } }),
  ])],
  tags: ['audit', 'order', 'time'],
})
C({
  id: 'report-order-constant-names-a-collation',
  capability: 'digest.constant',
  title: 'REPORT_ORDER names the collation, not just the fields',
  why: 'The current string says "committedAtMicros, then cycleId" and names no collation, which is the root of the divergence above; changing the string is how the decision becomes discoverable at the call site rather than buried in a spec.',
  args: [A.text('REPORT_ORDER')],
  expect: { value: A.text('committedAtMicros ascending, then cycleId ascending by Unicode code point') },
  decision: 'D11',
  divergenceReason: 'The shipped constant does not name a collation.',
  tags: ['constants', 'order', 'normative'],
})

// ===========================================================================
// G12 - identifiers
// ===========================================================================

group('identifiers', 'identity',
  'The validators. Only the JavaScript client has them, which is precisely why they need cases: ' +
  'a Java backend that accepts a cycleId the JavaScript client refuses writes a custody tag the ' +
  "auditor's tooling cannot parse.")

C({ id: 'cycleid-simple', capability: 'cycle.assertValidCycleId', title: 'A plain cycle id is accepted',
  why: 'Every rejection case below is only meaningful next to an acceptance; without this one a client that refuses everything would pass the whole group.',
  args: [A.text('tw-testnet-1787437747')], tags: ['identity'] })
C({ id: 'cycleid-64-ascii', capability: 'cycle.assertValidCycleId', title: 'An id of 64 ASCII characters is accepted',
  why: 'Sixty-four is the limit, and the accepting edge has to be pinned separately from the rejecting one or an off-by-one in either direction goes unnoticed.',
  args: [A.text('a'.repeat(64))], tags: ['identity', 'boundary'] })
C({ id: 'cycleid-65-codepoints', capability: 'cycle.assertValidCycleId', title: 'An id of 65 characters is refused',
  why: 'The limit exists because the id goes inside a custody tag the ledger stores; one character over is the case that says the check is a comparison and not a formality.',
  args: [A.text('a'.repeat(65))], tags: ['identity', 'boundary', 'reject'] })
C({ id: 'cycleid-empty', capability: 'cycle.assertValidCycleId', title: 'An empty id is refused',
  why: 'An empty cycleId produces a custody tag with two adjacent colons that parses back into a different pair of components, so the lock could no longer be matched to its cycle.',
  args: [A.text('')], tags: ['identity', 'reject'] })
C({ id: 'cycleid-contains-colon', capability: 'cycle.assertValidCycleId', title: 'An id containing a colon is refused',
  why: 'Colon separates the fields of the custody tag, so an id containing one makes the tag ambiguous and an auditor splitting it recovers a cycleId and an entryDigest that were never written.',
  args: [A.text('tw:1')], tags: ['identity', 'reject'] })
C({ id: 'cycleid-contains-pipe', capability: 'cycle.assertValidCycleId', title: 'An id containing a pipe is refused',
  why: 'Pipe is the canonList element separator, so an id carrying one can reshape any list a report puts it in even though the custody tag itself would survive.',
  args: [A.text('tw|1')], tags: ['identity', 'reject'] })
C({
  id: 'cycleid-64-astral-codepoints',
  capability: 'cycle.assertValidCycleId',
  title: 'An id of 64 astral code points is accepted',
  why: 'Daml T.length counts code points, so the ledger accepts this id; the JavaScript check counts UTF-16 units, sees 128 and refuses, which means the auditor path breaks on a cycle the ledger already committed.',
  args: [A.text(cp(0x1F3AE).repeat(64))],
  expect: { value: A.text(cp(0x1F3AE).repeat(64)) },
  decision: 'D2',
  divergenceReason: 'JS uses cycleId.length, a UTF-16 unit count, instead of a code-point count.',
  tags: ['identity', 'boundary', 'normative', 'unicode'],
})
C({
  id: 'cycleid-65-astral-codepoints-refused',
  capability: 'cycle.assertValidCycleId',
  title: 'An id of 65 astral code points is refused',
  why: 'The limit is in code points on both sides of the boundary; without this case D2 could be satisfied by removing the length check altogether.',
  args: [A.text(cp(0x1F3AE).repeat(65))],
  tags: ['identity', 'boundary', 'reject', 'unicode'],
})
C({ id: 'cycleid-uuid-shaped', capability: 'cycle.assertValidCycleId', title: 'A generated uuid-shaped id is accepted',
  why: 'newCycleId produces exactly this shape, so the validator and the generator have to agree or every id the SDK produces would be refused by its own check.',
  args: [A.text('c-3f2504e0-4f89-41d3-9a0c-0305e82c3301')], tags: ['identity'] })

const HEX_OK = 'fd8d8db1d08ba84d3325137b8adf0c7dc7c894e3bd099b36c9464b618f190d4b'
C({ id: 'hex64-valid', capability: 'cycle.assertHex64', title: 'A lowercase 64-character hash is accepted',
  why: 'Digests are the join between a document and the ledger, and this is the shape every one of them has; the rejections below only mean something with the acceptance pinned.',
  args: [A.text(HEX_OK)], tags: ['identity'] })
C({ id: 'hex64-uppercase', capability: 'cycle.assertHex64', title: 'An uppercase hash is refused',
  why: 'Case is not normalised anywhere in the scheme, so an uppercase digest inside a custody tag produces a different tag and the settlement check against it fails at the worst moment.',
  args: [A.text(HEX_OK.toUpperCase())], tags: ['identity', 'reject'] })
C({ id: 'hex64-63-chars', capability: 'cycle.assertHex64', title: 'A 63-character hash is refused',
  why: 'A truncated digest is what a copy-paste through a spreadsheet produces, and it would otherwise sit in a custody tag looking almost right.',
  args: [A.text(HEX_OK.slice(0, 63))], tags: ['identity', 'reject', 'boundary'] })
C({ id: 'hex64-65-chars', capability: 'cycle.assertHex64', title: 'A 65-character hash is refused',
  why: 'The other side of the length check, which a regex anchored only at the start would let through.',
  args: [A.text(HEX_OK + 'a')], tags: ['identity', 'reject', 'boundary'] })
C({ id: 'hex64-non-hex-char', capability: 'cycle.assertHex64', title: 'A hash with a non-hex character is refused',
  why: 'A digest with a stray character is not a digest, and accepting it would let a custody tag exist that no document can ever produce.',
  args: [A.text(HEX_OK.slice(0, 63) + 'z')], tags: ['identity', 'reject'] })
C({ id: 'hex64-empty', capability: 'cycle.assertHex64', title: 'An empty hash is refused',
  why: 'The empty string is what an unset field looks like, and it is the value most likely to reach the check by accident.',
  args: [A.text('')], tags: ['identity', 'reject'] })

C({ id: 'tradeid-simple', capability: 'trade.assertValidTradeId', title: 'A plain trade id is accepted',
  why: 'Trade ids follow the same rules as cycle ids because they go into the same kind of tag; pinning the acceptance keeps the two validators from drifting apart.',
  args: [A.text('t-3f2504e0-4f89-41d3-9a0c-0305e82c3301')], tags: ['identity'] })
C({ id: 'tradeid-contains-pipe', capability: 'trade.assertValidTradeId', title: 'A trade id containing a pipe is refused',
  why: 'The v1 trade document joins its components with pipes and has no length prefixes, so an id carrying one silently reshapes the document.',
  args: [A.text('t|1')], tags: ['identity', 'reject'] })
C({ id: 'tradeid-65-chars', capability: 'trade.assertValidTradeId', title: 'A 65-character trade id is refused',
  why: 'Same bound as the cycle id, and pinned separately because the two checks are separate code paths that have already drifted once.',
  args: [A.text('t'.repeat(65))], tags: ['identity', 'reject', 'boundary'] })

const LOCAL_IDS = [
  ['simple', 'gold', true, 'an ordinary item id'],
  ['dotted', 'sword.of.dawn', true, 'dots inside the id'],
  ['hyphenated', 'health-potion', true, 'hyphens inside the id'],
  ['two-chars', 'gg', true, 'the shortest accepted id'],
  ['ninety-six', 'a'.repeat(96), true, 'the longest accepted id'],
  ['one-char', 'g', false, 'a single character, which the grammar does not allow'],
  ['ninety-seven', 'a'.repeat(97), false, 'one character past the bound'],
  ['leading-dot', '.gold', false, 'a leading dot'],
  ['trailing-hyphen', 'gold-', false, 'a trailing hyphen'],
  ['uppercase', 'Gold', false, 'an uppercase letter'],
  ['slash', 'my/gold', false, 'a slash, which is the namespace separator'],
  ['colon', 'my:gold', false, 'a colon, which is the tag separator'],
  ['pipe', 'my|gold', false, 'a pipe, which is the list separator'],
]
for (const [slug, id, ok, blurb] of LOCAL_IDS) {
  C({
    id: `localid-${slug}`,
    capability: 'assets.assertValidLocalId',
    title: `A local id with ${blurb} is ${ok ? 'accepted' : 'refused'}`,
    why: `Local ids end up inside instrument ids that are compared as strings across tenants, so ${blurb} is where a permissive client mints an asset a strict one cannot name and the two disagree about who owns what.`,
    args: [A.text(id)],
    tags: ok ? ['identity'] : ['identity', 'reject'],
  })
}

const TENANT_IDS = [
  ['three-chars', 'abc', true, 'the shortest accepted tenant id'],
  ['thirty-two', 'a'.repeat(32), true, 'the longest accepted tenant id'],
  ['hyphenated', 'my-game', true, 'a single interior hyphen'],
  ['two-chars', 'ab', false, 'one character short'],
  ['thirty-three', 'a'.repeat(33), false, 'one character long'],
  ['double-hyphen', 'my--game', false, 'two consecutive hyphens'],
  ['leading-hyphen', '-mygame', false, 'a leading hyphen'],
  ['trailing-hyphen', 'mygame-', false, 'a trailing hyphen'],
  ['uppercase', 'MyGame', false, 'an uppercase letter'],
  ['slash', 'my/game', false, 'a slash'],
]
for (const [slug, id, ok, blurb] of TENANT_IDS) {
  C({
    id: `tenantid-${slug}`,
    capability: 'tenant.assertValidTenantId',
    title: `A tenant id with ${blurb} is ${ok ? 'accepted' : 'refused'}`,
    why: `Tenant ids are the namespace prefix that keeps one tenant from minting another tenant's item under the same registry party, so ${blurb} decides whether two tenants can collide.`,
    args: [A.text(id)],
    tags: ok ? ['identity'] : ['identity', 'reject'],
  })
}
C({
  id: 'namespaced-instrument-round-trip',
  capability: 'tenant.namespacedInstrumentId',
  title: 'A namespaced instrument id is tenant slash local',
  why: 'Slash was chosen because colon and pipe are both meaningful in the digest encoding; a client that picks a different separator produces ids that parse back into the wrong tenant.',
  args: [A.party('registry-party'), A.text('mygame'), A.text('sword-of-dawn')],
  tags: ['identity'],
})
C({
  id: 'parse-instrument-id-namespaced',
  capability: 'tenant.parseInstrumentId',
  title: 'Parsing a namespaced instrument id back into its parts',
  why: 'Isolation checks depend on this parse, so a client that splits on the last slash instead of the first attributes an item to the wrong tenant.',
  args: [instrIn('registry-party', 'mygame/sword-of-dawn')],
  tags: ['identity'],
})
C({
  id: 'parse-instrument-id-namespaceless',
  capability: 'tenant.parseInstrumentId',
  title: 'An instrument id with no namespace parses to a null tenant',
  why: 'Ecosystem-wide assets such as Amulet have no tenant prefix; a client that treats the whole id as a tenant name refuses every Canton Coin leg in the SDK.',
  args: [instrIn('dso-party', 'Amulet')],
  tags: ['identity', 'boundary'],
})
C({
  id: 'namespaced-instrument-rejects-slash-in-local-id',
  capability: 'tenant.namespacedInstrumentId',
  title: 'A local id containing a slash is refused',
  why: 'A second slash makes the parse ambiguous, and the ambiguity resolves in favour of the tenant prefix, so an item could be minted that reads back as belonging to someone else.',
  args: [A.party('registry-party'), A.text('mygame'), A.text('sub/sword')],
  tags: ['identity', 'reject'],
})
C({
  id: 'namespaced-instrument-rejects-colon-in-local-id',
  capability: 'tenant.namespacedInstrumentId',
  title: 'A local id containing a colon is refused',
  why: 'Colon is the tag separator in every custody, trade and transfer tag the SDK writes, so an id carrying one produces a tag that cannot be parsed back.',
  args: [A.party('registry-party'), A.text('mygame'), A.text('sw:ord')],
  tags: ['identity', 'reject'],
})
C({
  id: 'namespaced-instrument-rejects-97-char-local-id',
  capability: 'tenant.namespacedInstrumentId',
  title: 'A 97-character local id is refused here too',
  why: 'This bound is checked in a second place with a second message, and the two have to stay in step or an item name accepted by one entry point is refused by the other.',
  args: [A.party('registry-party'), A.text('mygame'), A.text('a'.repeat(97))],
  tags: ['identity', 'reject', 'boundary'],
})

// ===========================================================================
// G13 - custody-tag
// ===========================================================================

group('custody-tag', 'identity',
  'arccade-game-sdk:1:<cycleId>:<entryDigest>. The tag is what binds a real ledger lock to a ' +
  'particular cycle and its entry commitment; a generic string in optContext makes the stake unsettleable.')

C({
  id: 'custody-tag-shape',
  capability: 'cycle.custodyTagFor',
  title: 'The custody tag is prefix, cycle id, digest',
  why: 'Settlement re-derives this string and compares it to what is in the lock, so a client that assembles it differently produces a stake that can only ever be aborted.',
  args: [A.text('tw-testnet-1787437747'), A.text(DIGEST_A)],
  tags: ['identity', 'custody'],
})
for (let i = 0; i < ROWS_FIXTURE.rows.length; i += 1) {
  const r = ROWS_FIXTURE.rows[i]
  C({
    id: `custody-tag-fixture-row-${i}`,
    capability: 'cycle.custodyTagFor',
    title: `The custody tag of TestNet row ${i}`,
    why: `These three tags are on the ledger inside real locks, so reproducing them from the cycle id and entry digest is the check that the client's tag builder matches what was actually written.`,
    args: [A.text(r.cycleId), A.text(r.entryDigest)],
    expect: { text: textPin(r.custodyTag) },
    golden: `test-vectors/cycle-rows.json rows[${i}].custodyTag`,
    tags: ['identity', 'custody', 'testnet'],
  })
}
C({
  id: 'custody-tag-prefix-constant',
  capability: 'digest.constant',
  title: 'The custody tag prefix is a wire constant',
  why: 'Renaming it would orphan every lock already on the ledger, because settlement compares the stored optContext against a freshly built tag.',
  args: [A.text('CUSTODY_TAG_PREFIX')],
  tags: ['identity', 'custody', 'constants'],
})
C({
  id: 'custody-tag-rejects-colon-in-cycle-id',
  capability: 'cycle.custodyTagFor',
  title: 'A cycle id with a colon cannot become a tag',
  why: 'The tag has four colon-separated parts, so an id containing one produces a five-part string that an auditor splits into a cycle id and a digest neither of which was written.',
  args: [A.text('tw:1'), A.text(DIGEST_A)],
  tags: ['identity', 'custody', 'reject'],
})
C({
  id: 'custody-tag-rejects-non-hex-digest',
  capability: 'cycle.custodyTagFor',
  title: 'A non-hex entry digest cannot become a tag',
  why: 'The digest half of the tag is what binds the lock to the entry document; a value that is not a sha256 at all means there is no document it could ever be checked against.',
  args: [A.text('tw-1'), A.text('not-a-digest')],
  tags: ['identity', 'custody', 'reject'],
})
C({
  id: 'custody-tag-rejects-uppercase-digest',
  capability: 'cycle.custodyTagFor',
  title: 'An uppercase entry digest cannot become a tag',
  why: 'Case is never normalised, so an uppercase digest builds a tag that differs from the one settlement re-derives even though both spell the same hash.',
  args: [A.text('tw-1'), A.text(DIGEST_A.toUpperCase())],
  tags: ['identity', 'custody', 'reject'],
})
C({
  id: 'custody-tag-rejects-empty-cycle-id',
  capability: 'cycle.custodyTagFor',
  title: 'An empty cycle id cannot become a tag',
  why: 'It would produce two adjacent colons, and a parser splitting the tag would read the digest as the cycle id, which is the exact ambiguity the validator exists to prevent.',
  args: [A.text(''), A.text(DIGEST_A)],
  tags: ['identity', 'custody', 'reject'],
})
C({
  id: 'custody-tag-astral-cycle-id',
  capability: 'cycle.custodyTagFor',
  title: 'A tag over a 64-code-point astral cycle id',
  why: 'This is D2 seen from the tag side: the ledger would accept the lock, and a client counting UTF-16 units cannot even build the tag to check it.',
  args: [A.text(cp(0x1F3AE).repeat(64)), A.text(DIGEST_A)],
  expect: { text: textPin('arccade-game-sdk:1:' + cp(0x1F3AE).repeat(64) + ':' + DIGEST_A) },
  decision: 'D2',
  expectDivergence: false,
  divergenceReason: 'custodyTagFor calls assertValidCycleId, which counts UTF-16 units.',
  tags: ['identity', 'custody', 'normative', 'unicode'],
})

// ===========================================================================
// G14 - games-trade-wars
// ===========================================================================

group('games-trade-wars', 'games',
  'arccade-trade-wars-entry v1. The adapters live in js/examples/ and are NOT in the published ' +
  'package, so the cases are expressed as the composition a third party would write: canonFields for ' +
  'each nested record, canonList for the sequence, canonDocument for the envelope.')

const twPrice = (sym, price, micros) => sdk.canonFields([
  ['as-of', canonTimeMicrosBig(micros)],
  ['price', sdk.canonDecimal(price)],
  ['source', sdk.canonText('binance')],
  ['symbol', sdk.canonText(sym)],
])
const twAlloc = (sym, pct) => sdk.canonFields([
  ['allocation-percent', sdk.canonDecimal(pct)],
  ['symbol', sdk.canonText(sym)],
])
const TW_ENTRY_FIELDS = (allocs, prices, cycleId = 'tw-sample-1', tier = 'silver', bal = '10000.0') => A.pairs([
  [A.text('allocations'), A.raw(sdk.canonList(allocs))],
  [A.text('cycle-id'), A.raw(sdk.canonText(cycleId))],
  [A.text('entry-prices'), A.raw(sdk.canonList(prices))],
  [A.text('game-code'), A.raw(sdk.canonText('trade-wars-v4'))],
  [A.text('tier'), A.raw(sdk.canonText(tier))],
  [A.text('virtual-balance'), A.raw(sdk.canonDecimal(bal))],
])

C({
  id: 'trade-wars-price-point',
  capability: 'digest.canonFields',
  title: 'A Trade Wars price point as a bare nested record',
  why: 'Nested records inside a list carry no schema wrapper, so a client that wraps each price point in a document produces a different entry digest for the same market snapshot.',
  args: [A.pairs([
    [A.text('as-of'), A.raw(canonTimeMicrosBig(1000000n))],
    [A.text('price'), A.raw(sdk.canonDecimal('60000.0'))],
    [A.text('source'), A.raw(sdk.canonText('binance'))],
    [A.text('symbol'), A.raw(sdk.canonText('BTC'))],
  ])],
  tags: ['games', 'document'],
})
C({
  id: 'trade-wars-allocation',
  capability: 'digest.canonFields',
  title: 'A Trade Wars allocation as a bare nested record',
  why: 'The allocation percent is an amount and goes through canonDecimal, not canonText; a client that formats it as a string produces a document that looks right and hashes differently.',
  args: [A.pairs([
    [A.text('allocation-percent'), A.raw(sdk.canonDecimal('60.0'))],
    [A.text('symbol'), A.raw(sdk.canonText('BTC'))],
  ])],
  tags: ['games', 'document'],
})
C({
  id: 'trade-wars-entry-golden',
  capability: 'digest.canonDocument',
  title: 'The Trade Wars golden entry document',
  why: 'This digest is asserted in the Daml test suite and is the entry commitment of the first TestNet cycle; it is one of the two constants that bind the game adapters across all four implementations.',
  args: [A.text('arccade-trade-wars-entry'), A.int(1n),
    TW_ENTRY_FIELDS([twAlloc('BTC', '60.0'), twAlloc('ETH', '40.0')],
      [twPrice('BTC', '60000.0', 1000000n), twPrice('ETH', '3000.0', 1000000n)])],
  expect: {
    document: {
      text: textPin(sdk.canonDocument('arccade-trade-wars-entry', 1,
        decode(TW_ENTRY_FIELDS([twAlloc('BTC', '60.0'), twAlloc('ETH', '40.0')],
          [twPrice('BTC', '60000.0', 1000000n), twPrice('ETH', '3000.0', 1000000n)])))),
      digest: '5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852',
    },
  },
  golden: 'VectorsTest:goldenVectors TW.entryDigest',
  tags: ['games', 'document'],
  daml: 'TW.entryDigest sampleTwEntry === "5669632b...94852"',
})
C({
  id: 'trade-wars-allocation-order-matters',
  capability: 'digest.canonDocument',
  title: 'Swapping two allocations changes the entry digest',
  why: 'Allocations are a list, and lists are positional; a client that sorts them to be helpful produces a different commitment for the same portfolio and the cycle can never be settled against it.',
  args: [A.text('arccade-trade-wars-entry'), A.int(1n),
    TW_ENTRY_FIELDS([twAlloc('ETH', '40.0'), twAlloc('BTC', '60.0')],
      [twPrice('BTC', '60000.0', 1000000n), twPrice('ETH', '3000.0', 1000000n)])],
  tags: ['games', 'document', 'boundary'],
})
C({
  id: 'trade-wars-empty-allocations',
  capability: 'digest.canonDocument',
  title: 'An entry with no allocations at all',
  why: 'A player who commits without allocating anything is a legal cycle, and the empty list has to encode as a counted empty list rather than as nothing.',
  args: [A.text('arccade-trade-wars-entry'), A.int(1n), TW_ENTRY_FIELDS([], [])],
  tags: ['games', 'document', 'boundary'],
})
// The one instant in the suite that has a non-zero microsecond part on a
// document path. It is derived from isoToMicros, which IS microsecond-exact and
// IS shipped, so the pin below is not a number anybody typed.
const SUBMS_ISO = '2026-08-24T20:58:11.258920Z'
const SUBMS_MICROS = sdk.isoToMicros(SUBMS_ISO)

C({
  id: 'trade-wars-submillisecond-as-of',
  capability: 'digest.canonFields',
  title: 'A price point whose as-of has microsecond precision',
  why: 'The golden vector uses a whole second so nothing catches a millisecond conversion today; this price point differs in its last three digits, which is exactly the divergence D3 is about.',
  args: [A.pairs([
    [A.text('as-of'), A.raw(canonTimeMicrosBig(SUBMS_MICROS))],
    [A.text('price'), A.raw(sdk.canonDecimal('60000.0'))],
    [A.text('source'), A.raw(sdk.canonText('binance'))],
    [A.text('symbol'), A.raw(sdk.canonText('BTC'))],
  ])],
  tags: ['games', 'document', 'time'],
})
C({
  id: 'canon-time-truncates-to-milliseconds',
  capability: 'digest.canonTime',
  title: 'An ISO timestamp on a document path must keep its microseconds',
  why: 'A strict parser keeps the microseconds while the JavaScript canonTime routes through Date.parse and drops them to ...258000; the two write different Trade Wars entry documents for the same price snapshot, and the same client already parses the instant correctly through isoToMicros.',
  args: [A.text(SUBMS_ISO)],
  // Not a hand-typed number: canonTime must agree with canonTimeMicros over the
  // value the SHIPPED strict parser produces for the same instant.
  expect: { text: textPin(canonTimeMicrosBig(SUBMS_MICROS)) },
  decision: 'D3',
  divergenceReason: 'toMicros parses through Date.parse, which is millisecond precision.',
  tags: ['games', 'time', 'normative'],
})
C({
  id: 'trade-wars-outcome-document',
  capability: 'digest.canonDocument',
  title: 'A Trade Wars outcome document',
  why: 'The outcome is what settlement commits to, and every one of its amount fields goes through canonDecimal; a client that mixes an integer field in produces an outcome digest the stake will not accept.',
  args: [A.text('arccade-trade-wars-outcome'), A.int(1n), A.pairs([
    [A.text('cycle-id'), A.raw(sdk.canonText('tw-sample-1'))],
    [A.text('exit-prices'), A.raw(sdk.canonList([twPrice('BTC', '61000.0', 2000000n), twPrice('ETH', '2900.0', 2000000n)]))],
    [A.text('forfeited-amount'), A.raw(sdk.canonDecimal('0.0'))],
    [A.text('game-code'), A.raw(sdk.canonText('trade-wars-v4'))],
    [A.text('returned-amount'), A.raw(sdk.canonDecimal('100.0'))],
    [A.text('virtual-pnl'), A.raw(sdk.canonDecimal('466.6666666666'))],
    [A.text('virtual-pnl-percent'), A.raw(sdk.canonDecimal('4.6666666666'))],
    [A.text('xp-awarded'), A.raw(sdk.canonDecimal('12.0'))],
  ])],
  tags: ['games', 'document'],
})
C({
  id: 'trade-wars-outcome-negative-pnl',
  capability: 'digest.canonDocument',
  title: 'An outcome with a negative virtual PnL',
  why: 'Losses are the outcomes a player disputes, and a negative amount is where a client that truncates away from zero produces a different unit count than the ledger.',
  args: [A.text('arccade-trade-wars-outcome'), A.int(1n), A.pairs([
    [A.text('cycle-id'), A.raw(sdk.canonText('tw-sample-2'))],
    [A.text('exit-prices'), A.raw(sdk.canonList([twPrice('BTC', '59000.0', 2000000n)]))],
    [A.text('forfeited-amount'), A.raw(sdk.canonDecimal('0.0'))],
    [A.text('game-code'), A.raw(sdk.canonText('trade-wars-v4'))],
    [A.text('returned-amount'), A.raw(sdk.canonDecimal('100.0'))],
    [A.text('virtual-pnl'), A.raw(sdk.canonDecimal('-166.6666666667'))],
    [A.text('virtual-pnl-percent'), A.raw(sdk.canonDecimal('-1.6666666667'))],
    [A.text('xp-awarded'), A.raw(sdk.canonDecimal('0.0'))],
  ])],
  tags: ['games', 'document', 'boundary'],
})
C({
  id: 'trade-wars-entry-digest-matches-testnet-custody-tag',
  capability: 'digest.textDigest',
  title: 'The golden entry digest is the one inside the TestNet custody tag',
  why: 'The entry document, its digest, the custody tag and the audit row all have to agree or the chain from the published document to the ledger has a gap in it; this is the case that closes the loop.',
  args: [A.text(sdk.canonDocument('arccade-trade-wars-entry', 1,
    decode(TW_ENTRY_FIELDS([twAlloc('BTC', '60.0'), twAlloc('ETH', '40.0')],
      [twPrice('BTC', '60000.0', 1000000n), twPrice('ETH', '3000.0', 1000000n)]))))],
  expect: { digest: DIGEST_A },
  golden: 'entry digest inside test-vectors/cycle-rows.json rows[0].custodyTag',
  tags: ['games', 'testnet'],
})

// ===========================================================================
// G15 - games-pixel-race
// ===========================================================================

group('games-pixel-race', 'games',
  'arccade-pixel-race-entry v1 and its outcome. Same composition route as Trade Wars, and the ' +
  'seed commitment is a plain textDigest comparison rather than a separate primitive.')

const PR_ENTRY_FIELDS = (cycleId, tier, maxGames, seedCommit) => A.pairs([
  [A.text('cycle-id'), A.raw(sdk.canonText(cycleId))],
  [A.text('game-code'), A.raw(sdk.canonText('pixel-race-v1'))],
  [A.text('max-games-per-session'), A.raw(sdk.canonInt(maxGames))],
  [A.text('rng-seed-commit'), A.raw(sdk.canonText(seedCommit))],
  [A.text('tier'), A.raw(sdk.canonText(tier))],
])
const prPlay = (n, score, coins, level, secs) => sdk.canonFields([
  ['coins-collected', sdk.canonInt(coins)],
  ['game-number', sdk.canonInt(n)],
  ['max-level', sdk.canonInt(level)],
  ['score', sdk.canonInt(score)],
  ['survival-seconds', sdk.canonInt(secs)],
])

C({
  id: 'pixel-race-entry-golden',
  capability: 'digest.canonDocument',
  title: 'The Pixel Race golden entry document',
  why: 'The second of the two constants the Daml test suite asserts; together with the Trade Wars one it is what makes a claim of adapter parity checkable rather than asserted.',
  args: [A.text('arccade-pixel-race-entry'), A.int(1n),
    PR_ENTRY_FIELDS('pr-sample-1', 'bronze', 3n, '0'.repeat(64))],
  expect: {
    document: {
      text: textPin(sdk.canonDocument('arccade-pixel-race-entry', 1,
        decode(PR_ENTRY_FIELDS('pr-sample-1', 'bronze', 3n, '0'.repeat(64))))),
      digest: '0b2349e05633cf279ca0ee1d3f5efd8b2308f3e2ee947a32f5c3397e456d0204',
    },
  },
  golden: 'VectorsTest:goldenVectors PR.entryDigest',
  tags: ['games', 'document'],
  daml: 'PR.entryDigest samplePrEntry === "0b2349e0...d0204"',
})
C({
  id: 'pixel-race-game-play-record',
  capability: 'digest.canonFields',
  title: 'A Pixel Race play as a bare nested record',
  why: 'Every field of a play is an integer and goes through canonInt; a client that treats the score as an amount multiplies it by 1e10 and the outcome digest stops matching.',
  args: [A.pairs([
    [A.text('coins-collected'), A.raw(sdk.canonInt(17n))],
    [A.text('game-number'), A.raw(sdk.canonInt(1n))],
    [A.text('max-level'), A.raw(sdk.canonInt(4n))],
    [A.text('score'), A.raw(sdk.canonInt(9120n))],
    [A.text('survival-seconds'), A.raw(sdk.canonInt(83n))],
  ])],
  tags: ['games', 'document'],
})
C({
  id: 'pixel-race-outcome-document',
  capability: 'digest.canonDocument',
  title: 'A Pixel Race outcome with three plays',
  why: 'The plays are a positional list and the amounts are decimals, so this one document exercises both conventions at once in the order a real session produces them.',
  args: [A.text('arccade-pixel-race-outcome'), A.int(1n), A.pairs([
    [A.text('cycle-id'), A.raw(sdk.canonText('pr-sample-1'))],
    [A.text('forfeited-amount'), A.raw(sdk.canonDecimal('0.0'))],
    [A.text('game-code'), A.raw(sdk.canonText('pixel-race-v1'))],
    [A.text('plays'), A.raw(sdk.canonList([prPlay(1n, 9120n, 17n, 4n, 83n), prPlay(2n, 4400n, 8n, 2n, 41n), prPlay(3n, 15230n, 29n, 6n, 140n)]))],
    [A.text('returned-amount'), A.raw(sdk.canonDecimal('30.0'))],
    [A.text('rng-seed'), A.raw(sdk.canonText('seed-abc'))],
    [A.text('total-score'), A.raw(sdk.canonInt(28750n))],
    [A.text('xp-awarded'), A.raw(sdk.canonDecimal('28.75'))],
  ])],
  tags: ['games', 'document'],
})
C({
  id: 'pixel-race-outcome-empty-plays',
  capability: 'digest.canonDocument',
  title: 'An outcome with no plays at all',
  why: 'A session where the player never started is a legal outcome, and the empty list has to encode as a counted empty list or the document collides with one whose single play encoded to nothing.',
  args: [A.text('arccade-pixel-race-outcome'), A.int(1n), A.pairs([
    [A.text('cycle-id'), A.raw(sdk.canonText('pr-sample-2'))],
    [A.text('forfeited-amount'), A.raw(sdk.canonDecimal('0.0'))],
    [A.text('game-code'), A.raw(sdk.canonText('pixel-race-v1'))],
    [A.text('plays'), A.raw(sdk.canonList([]))],
    [A.text('returned-amount'), A.raw(sdk.canonDecimal('30.0'))],
    [A.text('rng-seed'), A.raw(sdk.canonText('seed-abc'))],
    [A.text('total-score'), A.raw(sdk.canonInt(0n))],
    [A.text('xp-awarded'), A.raw(sdk.canonDecimal('0.0'))],
  ])],
  tags: ['games', 'document', 'boundary'],
})
C({
  id: 'pixel-race-play-order-matters',
  capability: 'digest.canonList',
  title: 'Reordering plays changes the list encoding',
  why: 'A client that sorts plays by score to make a nicer report changes the outcome digest and the settlement it was committed to no longer matches.',
  args: [A.list([
    A.raw(prPlay(3n, 15230n, 29n, 6n, 140n)),
    A.raw(prPlay(1n, 9120n, 17n, 4n, 83n)),
  ])],
  tags: ['games', 'boundary'],
})
C({
  id: 'pixel-race-seed-matches-commit',
  capability: 'digest.textDigest',
  title: 'The revealed seed hashes to the commitment made at entry',
  why: 'The entry commits to a seed hash and the outcome reveals the seed; if the two do not line up the game could pick its randomness after seeing the play, which is the whole thing this commitment prevents.',
  args: [A.text('pixel-race-seed-2026-08-24')],
  tags: ['games', 'commitment'],
  note: 'seedMatchesCommit is textDigest(seed) === commit; it needs no capability of its own.',
})
C({
  id: 'pixel-race-entry-with-revealed-seed-commit',
  capability: 'digest.canonDocument',
  title: 'An entry whose seed commitment is a real digest',
  why: 'The golden entry uses an all-zero commitment, which would also be produced by a client that forgot to hash anything; a real digest is what distinguishes the two.',
  args: [A.text('arccade-pixel-race-entry'), A.int(1n),
    PR_ENTRY_FIELDS('pr-sample-3', 'gold', 5n, sdk.textDigest('pixel-race-seed-2026-08-24'))],
  tags: ['games', 'document'],
})
C({
  id: 'pixel-race-testnet-entry-digest',
  capability: 'digest.textDigest',
  title: 'The Pixel Race entry digest that is in the TestNet fixture',
  why: 'Two of the three published rows carry this digest inside their custody tags; being able to name the document that produced it is the difference between a hash and a commitment.',
  args: [A.text(sdk.canonDocument('arccade-pixel-race-entry', 1,
    decode(PR_ENTRY_FIELDS('pr-livetest-20260824', 'bronze', 3n, '0'.repeat(64)))))],
  tags: ['games', 'testnet'],
  note: 'The fixture digest fd8d8db1... comes from the entry the venue actually published; this case pins the composition route, not that particular preimage.',
})
C({
  id: 'pixel-race-entry-max-games-is-an-integer',
  capability: 'digest.canonDocument',
  title: 'The session cap is an integer field, not an amount',
  why: 'max-games-per-session is a count; a client that runs it through canonDecimal writes i-versus-d in the document and every entry digest in the game changes.',
  args: [A.text('arccade-pixel-race-entry'), A.int(1n),
    PR_ENTRY_FIELDS('pr-sample-4', 'bronze', 1n, '0'.repeat(64))],
  tags: ['games', 'document', 'trap'],
})
C({
  id: 'pixel-race-entry-tier-with-astral-character',
  capability: 'digest.canonDocument',
  title: 'A tier name containing an emoji',
  why: 'Tier names are player-facing and get emoji; this is the shortest path from a product decision to a UTF-16 length bug in a commitment.',
  args: [A.text('arccade-pixel-race-entry'), A.int(1n),
    PR_ENTRY_FIELDS('pr-sample-5', 'gold ' + cp(0x1F3AE), 3n, '0'.repeat(64))],
  tags: ['games', 'document', 'unicode'],
})

// ===========================================================================
// G16 - assets
// ===========================================================================

group('assets', 'identity',
  'Fungible and unique instruments, the attribute document that binds a stat sheet to a digest, ' +
  'and the amount rule that keeps "three of this particular sword" from existing.')

C({ id: 'fungible-instrument-id', capability: 'assets.fungibleInstrument', title: 'A fungible instrument id',
  why: 'Type-level assets are named tenant slash local with no instance part; a client that appends an empty instance separator produces an id that parses back as unique with an empty instance.',
  args: [A.party('registry-party'), A.text('mygame'), A.text('gold')], tags: ['assets'] })
C({ id: 'unique-instrument-id', capability: 'assets.uniqueInstrument', title: 'A unique instrument id',
  why: 'Each instance is its own instrument, which is what lets a particular sword carry its own attributes; the separator is what tells the two classes apart at parse time.',
  args: [A.party('registry-party'), A.text('mygame'), A.text('sword-of-dawn'), A.text('4a91c8f2')], tags: ['assets'] })
C({ id: 'unique-instrument-rejects-short-instance-id', capability: 'assets.uniqueInstrument',
  title: 'A three-character instance id is refused',
  why: 'Instance ids are derived from attribute digests and truncating one too far makes collisions between different instances likely, which would merge two players items.',
  args: [A.party('registry-party'), A.text('mygame'), A.text('sword'), A.text('abc')], tags: ['assets', 'reject'] })
C({ id: 'unique-instrument-rejects-uppercase-instance-id', capability: 'assets.uniqueInstrument',
  title: 'An uppercase instance id is refused',
  why: 'Instrument ids are compared as exact strings on the ledger, so allowing two spellings of the same instance would let the same item exist twice.',
  args: [A.party('registry-party'), A.text('mygame'), A.text('sword'), A.text('4A91C8F2')], tags: ['assets', 'reject'] })
C({ id: 'parse-asset-fungible', capability: 'assets.parseAsset', title: 'Parsing a fungible instrument id',
  why: 'The parse decides which isolation and amount rules apply, so getting the class wrong means a unique item can be transferred in quantity.',
  args: [instrIn('registry-party', 'mygame/gold')], tags: ['assets'] })
C({ id: 'parse-asset-unique', capability: 'assets.parseAsset', title: 'Parsing a unique instrument id',
  why: 'The instance part is everything after the first separator, so a client splitting on the last one mangles any instance id that happens to contain the separator character.',
  args: [instrIn('registry-party', 'mygame/sword-of-dawn#4a91c8f2')], tags: ['assets'] })
C({ id: 'parse-asset-namespaceless', capability: 'assets.parseAsset', title: 'Parsing an instrument id with no namespace',
  why: 'Canton Coin has no tenant prefix, and a client that refuses it cannot price a single marketplace trade in the ecosystem currency.',
  args: [instrIn('dso-party', 'Amulet')], tags: ['assets', 'boundary'] })
C({ id: 'is-unique-true', capability: 'assets.isUnique', title: 'A unique instrument is recognised as unique',
  why: 'This predicate gates the amount rule below, so it needs its own case rather than being inferred from the rejection it causes.',
  args: [instrIn('registry-party', 'mygame/sword#4a91c8f2')], tags: ['assets'] })
C({ id: 'is-unique-false', capability: 'assets.isUnique', title: 'A fungible instrument is not unique',
  why: 'The negative case is what stops an implementation from marking everything unique and refusing every quantity above one.',
  args: [instrIn('registry-party', 'mygame/gold')], tags: ['assets'] })
C({ id: 'unique-amount-must-be-one', capability: 'assets.assertAmountValidForAsset',
  title: 'Three of one particular sword is refused',
  why: 'Quantity on an instance-level asset is meaningless and, if it passed, would show up downstream as something that looks like a double spend.',
  args: [instrIn('registry-party', 'mygame/sword#4a91c8f2'), A.dec('3')], tags: ['assets', 'reject'] })
C({ id: 'unique-amount-one-accepted', capability: 'assets.assertAmountValidForAsset',
  title: 'Exactly one of a unique asset is accepted',
  why: 'Without the accepting case the rule could be satisfied by refusing every unique asset outright, which would make instance-level items unusable.',
  args: [instrIn('registry-party', 'mygame/sword#4a91c8f2'), A.dec('1')], tags: ['assets'] })
C({ id: 'fungible-amount-non-positive-refused', capability: 'assets.assertAmountValidForAsset',
  title: 'A zero amount is refused for a fungible asset',
  why: 'A zero-amount leg moves nothing while still consuming a write and counting as activity, which is the cheapest way to manufacture volume.',
  args: [instrIn('registry-party', 'mygame/gold'), A.dec('0')], tags: ['assets', 'reject'] })
C({ id: 'fungible-amount-negative-refused', capability: 'assets.assertAmountValidForAsset',
  title: 'A negative amount is refused for a fungible asset',
  why: 'A negative leg would reverse the direction of a transfer while the document still reads as a payment to the receiver.',
  args: [instrIn('registry-party', 'mygame/gold'), A.dec('-5')], tags: ['assets', 'reject'] })
C({ id: 'asset-attribute-document', capability: 'assets.assetAttributeDocument',
  title: 'An attribute document with an integer and a text attribute',
  why: 'Binding the attribute digest to the instrument is what lets a buyer check that a sword really is plus nine and stops the application quietly nerfing it after the sale.',
  args: [instrIn('registry-party', 'mygame/sword-of-dawn#4a91c8f2'),
    A.pairs([[A.text('attack'), A.int(9n)], [A.text('name'), A.text('Sword of Dawn')]])],
  tags: ['assets', 'document'] })
C({ id: 'asset-attribute-document-decimal-as-text', capability: 'assets.assetAttributeDocument',
  title: 'A fractional attribute has to be given as text',
  why: 'There is no decimal attribute type, so a weight of 1.5 goes in as a string; a client that accepts a float here writes an attribute document whose value depends on the language it was written in.',
  args: [instrIn('registry-party', 'mygame/sword#4a91c8f2'),
    A.pairs([[A.text('weight'), A.text('1.5')]])],
  tags: ['assets', 'document'] })
C({ id: 'asset-attribute-document-rejects-float', capability: 'assets.assetAttributeDocument',
  title: 'A native float attribute is refused',
  why: 'Accepting one would make the same stat sheet hash differently in two languages, and the attribute digest is the only thing a marketplace has to check the item against.',
  args: [instrIn('registry-party', 'mygame/sword#4a91c8f2'),
    A.pairs([[A.text('weight'), A.float64('1.5')]])],
  appliesWhen: { hasNativeFloat: true },
  tags: ['assets', 'reject'] })
C({ id: 'derive-instance-id-deterministic', capability: 'assets.deriveInstanceId',
  title: 'The same attributes derive the same instance id',
  why: 'Determinism is the point: two mints of the same item get the same id, so an accidental double mint is visible instead of producing two items that look distinct.',
  args: [A.text('mygame'), A.text('sword-of-dawn'), A.pairs([[A.text('attack'), A.int(9n)]]), A.text('')],
  tags: ['assets'] })
C({ id: 'derive-instance-id-salt-sensitive', capability: 'assets.deriveInstanceId',
  title: 'A salt changes the derived instance id',
  why: 'Deliberate reprints need to be distinguishable from accidental ones, and the salt is the only thing separating them; if it did not reach the digest the feature would be a no-op.',
  args: [A.text('mygame'), A.text('sword-of-dawn'), A.pairs([[A.text('attack'), A.int(9n)]]), A.text('reprint-2')],
  tags: ['assets'] })
C({ id: 'derive-instance-id-attribute-sensitive', capability: 'assets.deriveInstanceId',
  title: 'A different attribute value derives a different instance id',
  why: 'If the attributes did not reach the id, a plus-three and a plus-nine sword would share an instance and the marketplace could not tell them apart.',
  args: [A.text('mygame'), A.text('sword-of-dawn'), A.pairs([[A.text('attack'), A.int(3n)]]), A.text('')],
  tags: ['assets'] })

// ===========================================================================
// G17 - tenant
// ===========================================================================

group('tenant', 'identity',
  'Isolation, namespacing and keys. Tenants share one participant and one registry party, so ' +
  'isolation is this layer\'s responsibility rather than the ledger\'s.')

C({ id: 'hash-tenant-key', capability: 'tenant.hashTenantKey', title: 'A tenant key hashes to a plain sha256',
  why: 'Only the hash is stored server-side, so an implementation that salts or encodes differently cannot verify a key issued by another.',
  args: [A.text('ags_mygame_Zm9vYmFyYmF6cXV4')], tags: ['tenant'] })
C({ id: 'tenant-id-from-key', capability: 'tenant.tenantIdFromKey', title: 'The tenant id is readable from the key',
  why: 'Routing needs the tenant before verification, and reading it from the key is what lets the lookup happen without a database round trip; it is not a substitute for verifying.',
  args: [A.text('ags_mygame_Zm9vYmFyYmF6cXV4')], tags: ['tenant'] })
C({ id: 'tenant-id-from-key-wrong-prefix', capability: 'tenant.tenantIdFromKey',
  title: 'A key without the ags_ prefix yields no tenant',
  why: 'An unrecognised credential must resolve to nothing rather than to a plausible-looking tenant id that would then be used for a namespace check.',
  args: [A.text('sk_live_mygame_abc')], tags: ['tenant', 'boundary'] })
C({ id: 'tenant-id-from-key-no-separator', capability: 'tenant.tenantIdFromKey',
  title: 'A key with no separator yields no tenant',
  why: 'A truncated key would otherwise read as a tenant id made of the whole remainder, which could accidentally match a real tenant.',
  args: [A.text('ags_mygame')], tags: ['tenant', 'boundary'] })
C({ id: 'tenant-id-from-key-invalid-id', capability: 'tenant.tenantIdFromKey',
  title: 'A key carrying an invalid tenant id yields no tenant',
  why: 'The id inside a key is attacker-controlled text, so it goes through the same validator as any other tenant id rather than being trusted because it arrived in a key.',
  args: [A.text('ags_My--Game_abc')], tags: ['tenant', 'boundary'] })
C({ id: 'verify-tenant-key-correct', capability: 'tenant.verifyTenantKey',
  title: 'A key verifies against its own hash',
  why: 'The value behaviour is in scope even though the constant-time property is not; without the accepting case the rejections could be satisfied by always returning false.',
  args: [A.text('ags_mygame_Zm9vYmFyYmF6cXV4'), A.text(sdk.hashTenantKey('ags_mygame_Zm9vYmFyYmF6cXV4'))],
  tags: ['tenant'] })
C({ id: 'verify-tenant-key-wrong', capability: 'tenant.verifyTenantKey',
  title: 'A different key does not verify',
  why: 'One character difference has to fail, and this is the case that says the comparison is over the hash rather than over the prefix.',
  args: [A.text('ags_mygame_Zm9vYmFyYmF6cXV5'), A.text(sdk.hashTenantKey('ags_mygame_Zm9vYmFyYmF6cXV4'))],
  tags: ['tenant'] })
C({ id: 'verify-tenant-key-length-mismatch', capability: 'tenant.verifyTenantKey',
  title: 'A hash of the wrong length does not verify',
  why: 'A truncated expected hash must be refused rather than compared byte by byte until it runs out, which is both wrong and the shape of a timing leak.',
  args: [A.text('ags_mygame_Zm9vYmFyYmF6cXV4'), A.text('deadbeef')],
  tags: ['tenant', 'boundary'] })
C({ id: 'tenant-owns-own-instrument', capability: 'tenant.assertTenantOwnsInstrument',
  title: 'A tenant may touch an asset in its own namespace',
  why: 'The isolation check runs on every tenant call, so the accepting path is on the hot path and has to be pinned as tightly as the rejection.',
  args: [A.text('mygame'), instrIn('registry-party', 'mygame/gold')], tags: ['tenant'] })
C({ id: 'tenant-cannot-touch-other-namespace', capability: 'tenant.assertTenantOwnsInstrument',
  title: 'A tenant may not touch another tenant asset',
  why: 'Every tenant item sits under the same registry party, so without this check tenant A could mint or move tenant B item by naming it; the ledger cannot tell them apart.',
  args: [A.text('mygame'), instrIn('registry-party', 'othergame/gold')], tags: ['tenant', 'reject'] })
C({ id: 'tenant-may-touch-namespaceless-asset', capability: 'tenant.assertTenantOwnsInstrument',
  title: 'A tenant may touch an asset with no namespace',
  why: 'Canton Coin belongs to no tenant, and a client that refuses it cannot take a stake or pay out at all, which would make isolation and usability mutually exclusive.',
  args: [A.text('mygame'), instrIn('dso-party', 'Amulet')], tags: ['tenant', 'boundary'] })
C({ id: 'tenant-legs-checked-across-a-trade', capability: 'tenant.assertTenantLegs',
  title: 'Every leg of a trade is checked, not only the first',
  why: 'A two-leg trade where only the offer is in the tenant namespace is exactly how isolation would be bypassed if the check stopped at the first leg.',
  args: [A.text('mygame'), A.pairs([
    [A.text('offer'), A.record('trade-leg', { sender: A.party('M'), receiver: A.party('T'), instrumentId: instrIn('registry-party', 'mygame/sword#4a91c8f2'), amount: A.text('1') })],
    [A.text('ask'), A.record('trade-leg', { sender: A.party('T'), receiver: A.party('M'), instrumentId: instrIn('othergame/registry', 'othergame/gold'), amount: A.text('10.0') })],
  ])],
  tags: ['tenant', 'reject'] })

// ===========================================================================
// G18 - value-documents
// ===========================================================================

group('value-documents', 'value-documents',
  'tradeDocument and transferDocument. These are the one place in the SDK where a document is ' +
  'joined with pipes and carries NO length prefixes, which is why the pipe has to be refused inside a component.')

const tradeArg = (o) => A.record('trade', {
  tradeId: A.text(o.tradeId),
  maker: A.party(o.maker),
  taker: o.taker === null ? A.nul() : A.party(o.taker),
  expiresAt: A.text(o.expiresAt),
  legs: A.pairs(o.legs.map(([k, l]) => [A.text(k), A.record('trade-leg', {
    sender: A.party(l.sender), receiver: A.party(l.receiver),
    instrumentId: instrIn(l.admin, l.id), amount: A.text(l.amount),
  })])),
  meta: A.pairs((o.meta ?? []).map(([k, v]) => [A.text(k), A.text(v)])),
})
const TRADE_LEGS = [
  ['offer', { sender: 'maker-party', receiver: 'taker-party', admin: 'registry-party', id: 'mygame/sword-of-dawn#4a91c8f2', amount: '1' }],
  ['ask', { sender: 'taker-party', receiver: 'maker-party', admin: 'dso-party', id: 'Amulet', amount: '25.0' }],
]

C({
  id: 'trade-document-two-legs',
  capability: 'trade.tradeDocument',
  title: 'A marketplace sale as a trade document',
  why: 'Only the digest reaches the ledger, so the document has to be reproducible from the published record or a buyer cannot check that the trade they saw is the trade that settled.',
  args: [tradeArg({ tradeId: 't-1', maker: 'maker-party', taker: 'taker-party', expiresAt: '2026-08-30T00:00:00Z', legs: TRADE_LEGS, meta: [['listing', 'lst-9']] })],
  tags: ['trade', 'document'],
})
C({
  id: 'trade-document-leg-order-is-by-key',
  capability: 'trade.tradeDocument',
  title: 'Legs are ordered by their key, not by insertion',
  why: 'The two legs arrive from a map whose iteration order is not fixed across languages, so without the sort the same trade hashes differently depending on who built it.',
  args: [tradeArg({ tradeId: 't-1', maker: 'maker-party', taker: 'taker-party', expiresAt: '2026-08-30T00:00:00Z', legs: [TRADE_LEGS[1], TRADE_LEGS[0]], meta: [['listing', 'lst-9']] })],
  tags: ['trade', 'document'],
  note: 'Same expected text as trade-document-two-legs; the identity is the assertion.',
})
C({
  id: 'trade-document-meta-order-is-by-key',
  capability: 'trade.tradeDocument',
  title: 'Meta entries are ordered by their key',
  why: 'Meta is caller-supplied and arrives as a map, so it needs the same sort as the legs or two clients building the same trade produce two digests.',
  args: [tradeArg({ tradeId: 't-2', maker: 'maker-party', taker: 'taker-party', expiresAt: '2026-08-30T00:00:00Z', legs: TRADE_LEGS, meta: [['z', '1'], ['a', '2']] })],
  tags: ['trade', 'document'],
})
C({
  id: 'trade-document-open-offer-empty-taker',
  capability: 'trade.tradeDocument',
  title: 'An open offer writes an empty taker rather than omitting the field',
  why: 'Omitting the field would make an open offer and a trade to a party named nothing produce the same bytes, and the document has no length prefixes to tell them apart.',
  args: [tradeArg({ tradeId: 't-3', maker: 'maker-party', taker: null, expiresAt: '2026-08-30T00:00:00Z', legs: TRADE_LEGS })],
  tags: ['trade', 'document', 'boundary'],
})
C({
  id: 'trade-document-rejects-pipe-in-meta-value',
  capability: 'trade.tradeDocument',
  title: 'A pipe inside a meta value is refused',
  why: 'The v1 format joins components with pipes and has no length prefixes, so a pipe inside a value silently reshapes the document into one with an extra component; assertValidTradeId already forbids the character in the id, so the guard is half built.',
  args: [tradeArg({ tradeId: 't-4', maker: 'maker-party', taker: 'taker-party', expiresAt: '2026-08-30T00:00:00Z', legs: TRADE_LEGS, meta: [['note', 'a|b']] })],
  expect: { reject: { class: 'not-injective' } },
  decision: 'D8',
  divergenceReason: 'tradeDocument joins the value straight in, producing a document that reads as having one more component.',
  tags: ['trade', 'document', 'reject', 'normative'],
})
C({
  id: 'trade-document-rejects-pipe-in-party',
  capability: 'trade.tradeDocument',
  title: 'A pipe inside a party name is refused',
  why: 'Party ids are ledger-controlled today but the document builder does not know that, and the same ambiguity applies to any component, not only to meta.',
  args: [tradeArg({ tradeId: 't-5', maker: 'maker|party', taker: 'taker-party', expiresAt: '2026-08-30T00:00:00Z', legs: TRADE_LEGS })],
  expect: { reject: { class: 'not-injective' } },
  decision: 'D8',
  expectDivergence: false,
  divergenceReason: 'tradeDocument does not screen its components for the separator.',
  tags: ['trade', 'document', 'reject', 'normative'],
})
C({
  id: 'trade-leg-rejects-self-trade',
  capability: 'trade.leg',
  title: 'A leg from a party to itself is refused',
  why: 'A self leg moves nothing while still counting as a settled trade, which is the cheapest way to manufacture marketplace volume.',
  args: [A.record('trade-leg', { sender: A.party('p'), receiver: A.party('p'), instrumentId: instrIn('dso-party', 'Amulet'), amount: A.text('1.0') })],
  tags: ['trade', 'reject'],
})
C({
  id: 'trade-leg-rejects-zero-amount',
  capability: 'trade.leg',
  title: 'A leg of zero is refused',
  why: 'A zero leg makes a trade that settles without moving value, which would let a marketplace report activity it never had.',
  args: [A.record('trade-leg', { sender: A.party('a'), receiver: A.party('b'), instrumentId: instrIn('dso-party', 'Amulet'), amount: A.text('0') })],
  tags: ['trade', 'reject'],
})
C({
  id: 'trade-leg-accepted',
  capability: 'trade.leg',
  title: 'A well formed leg is accepted and normalised',
  why: 'The amount is normalised to text on the way through, which is what keeps a float from reaching the document; the accepting case is where that normalisation is visible.',
  args: [A.record('trade-leg', { sender: A.party('a'), receiver: A.party('b'), instrumentId: instrIn('dso-party', 'Amulet'), amount: A.text('25.0') })],
  tags: ['trade'],
})

const transferArg = (o) => A.record('transfer', {
  transferId: A.text(o.transferId),
  sender: A.party(o.sender),
  reason: A.text(o.reason),
  recipients: A.list(o.recipients.map((r) => A.record('transfer-recipient', {
    receiver: A.party(r.receiver), amount: A.text(r.amount), instrumentId: instrIn(r.admin, r.id),
  }))),
  meta: A.pairs((o.meta ?? []).map(([k, v]) => [A.text(k), A.text(v)])),
})

C({
  id: 'transfer-document-single-recipient',
  capability: 'transfer.transferDocument',
  title: 'A single-recipient transfer document',
  why: 'The reason classifies the movement in reporting and is inside the hashed text, so a client that leaves it out cannot reproduce the digest that reached the ledger.',
  args: [transferArg({ transferId: 'x-1', sender: 'venue-party', reason: 'reward', recipients: [{ receiver: 'player-party', amount: '5.0', admin: 'dso-party', id: 'Amulet' }] })],
  tags: ['transfer', 'document'],
})
C({
  id: 'transfer-document-batch-order-preserved',
  capability: 'transfer.transferDocument',
  title: 'Recipients keep the order they were given in',
  why: 'Recipients are a list, not a map, and are deliberately not sorted; a client that sorts them changes the digest of every batch payout.',
  args: [transferArg({ transferId: 'x-2', sender: 'venue-party', reason: 'payout', recipients: [
    { receiver: 'p2', amount: '2.0', admin: 'dso-party', id: 'Amulet' },
    { receiver: 'p1', amount: '1.0', admin: 'dso-party', id: 'Amulet' },
  ] })],
  tags: ['transfer', 'document'],
})
C({
  id: 'transfer-document-meta-sorted',
  capability: 'transfer.transferDocument',
  title: 'Transfer meta is sorted while recipients are not',
  why: 'The two halves of the same document follow opposite rules on purpose, and a client applying one rule to both gets a different digest for every transfer that carries meta.',
  args: [transferArg({ transferId: 'x-3', sender: 'venue-party', reason: 'refund', recipients: [{ receiver: 'p1', amount: '1.0', admin: 'dso-party', id: 'Amulet' }], meta: [['z', '1'], ['a', '2']] })],
  tags: ['transfer', 'document'],
})
C({
  id: 'transfer-document-rejects-pipe-in-meta',
  capability: 'transfer.transferDocument',
  title: 'A pipe inside transfer meta is refused',
  why: 'Same ambiguity as the trade document and the same fix; a memo field is the most likely place for a caller to put arbitrary text.',
  args: [transferArg({ transferId: 'x-4', sender: 'venue-party', reason: 'p2p', recipients: [{ receiver: 'p1', amount: '1.0', admin: 'dso-party', id: 'Amulet' }], meta: [['memo', 'for the|sword']] })],
  expect: { reject: { class: 'not-injective' } },
  decision: 'D8',
  expectDivergence: false,
  divergenceReason: 'transferDocument joins the value straight in.',
  tags: ['transfer', 'document', 'reject', 'normative'],
})

// ===========================================================================
// G19 - time-arithmetic
// ===========================================================================

group('time-arithmetic', 'time',
  'Daml Int division truncates TOWARD ZERO and secondsBetween truncates EACH endpoint independently ' +
  'before subtracting. Every policy duration check runs through it, so a client computing (b-a)/1e6 ' +
  'disagrees by up to a second exactly where acceptance flips.')

C({
  id: 'int-divide-negative-truncates-toward-zero',
  capability: 'time.intDivide',
  title: 'Minus seven over two is minus three',
  why: 'Floor division would give minus four, and every duration comparison in Policy.daml and Cycle.daml is built on this operator; the sign is where a client that reached for a floor helper diverges.',
  args: [A.int(-7n), A.int(2n)],
  expect: { value: A.int(-3n) },
  golden: 'Daml (-7) / 2 === -3, verified against the 1.5.0 DAR',
  tags: ['time', 'unimplemented'],
})
C({
  id: 'epoch-seconds-negative-truncates-to-zero',
  capability: 'time.epochSeconds',
  title: 'Half a second before the epoch is second zero',
  why: 'A floor-based conversion gives minus one, which puts a pre-epoch timestamp in the wrong second; the case is contrived on TestNet and not contrived at all for a client whose clock is wrong.',
  args: [A.micros(-500000n)],
  expect: { value: A.int(0n) },
  golden: 'Daml epochSeconds (-500000 us) === 0, verified against the 1.5.0 DAR',
  tags: ['time', 'unimplemented'],
})
C({
  id: 'seconds-between-truncates-each-endpoint',
  capability: 'time.secondsBetween',
  title: 'From 0.9s to 60.0s is sixty seconds, not fifty-nine',
  why: 'Each endpoint is truncated to whole seconds independently and only then subtracted, so the answer is one more than elapsed time; this is the single most dangerous behaviour in the package because it decides whether a lock or a cycle is long enough.',
  args: [A.micros(900000n), A.micros(60000000n)],
  expect: { value: A.int(60n) },
  golden: 'Daml secondsBetween 0.9s 60.0s === 60, verified against the 1.5.0 DAR',
  tags: ['time', 'unimplemented'],
})
C({
  id: 'seconds-between-naive-elapsed-would-differ',
  capability: 'time.secondsBetween',
  title: 'The boundary where policy acceptance flips',
  why: 'Elapsed time here is 59.1 seconds and the Daml answer is 60, so a policy with a sixty-second minimum accepts on the ledger and is refused by a client that computes (b-a)/1e6; that is a cycle the game believes it cannot open.',
  args: [A.micros(900000n), A.micros(60000000n)],
  tags: ['time', 'unimplemented'],
  note: 'Same inputs as the case above, stated from the caller\'s side. The point is the comparison a client makes, not the arithmetic.',
})
C({
  id: 'seconds-between-same-second',
  capability: 'time.secondsBetween',
  title: 'Two instants inside one second are zero seconds apart',
  why: 'A minimum cycle duration of one second is satisfied by nothing that happens inside the same second, which is what stops a commit and settle in the same instant from counting.',
  args: [A.micros(1000001n), A.micros(1999999n)],
  tags: ['time', 'unimplemented'],
})
C({
  id: 'seconds-between-across-a-second-boundary',
  capability: 'time.secondsBetween',
  title: 'One microsecond across a second boundary is one second',
  why: 'The mirror of the previous case: almost no elapsed time counts as a full second because both endpoints are truncated first, and a client that rounds instead of truncating gets zero.',
  args: [A.micros(1999999n), A.micros(2000000n)],
  tags: ['time', 'unimplemented'],
})
C({
  id: 'seconds-between-negative-interval',
  capability: 'time.secondsBetween',
  title: 'A backwards interval is negative, not an error',
  why: 'Clock skew between a client and the ledger produces exactly this, and a client that takes an absolute value would accept a lock that expires before it starts.',
  args: [A.micros(60000000n), A.micros(900000n)],
  tags: ['time', 'unimplemented', 'boundary'],
})
C({
  id: 'epoch-seconds-exact-second',
  capability: 'time.epochSeconds',
  title: 'A whole second converts exactly',
  why: 'The unremarkable case has to be pinned so the negative and fractional ones are a comparison rather than isolated assertions.',
  args: [A.micros(1787437747000000n)],
  tags: ['time', 'unimplemented'],
})
C({
  id: 'epoch-seconds-drops-fraction',
  capability: 'time.epochSeconds',
  title: 'A fractional second is dropped, not rounded',
  why: 'The real TestNet commit timestamp has 372202 microseconds on it, and rounding up would put the cycle in the next second and, at a period boundary, in the next day.',
  args: [A.micros(1787437747372202n)],
  tags: ['time', 'unimplemented'],
})
C({
  id: 'add-seconds-cooldown',
  capability: 'time.addSeconds',
  title: 'A cooldown is added in whole seconds',
  why: 'nextEligibleAt is computed this way at settlement, and the commit choice refuses while now is before it; an off-by-a-thousand in the unit makes the cooldown either instant or seventeen minutes.',
  args: [A.micros(1787437775189712n), A.int(30n)],
  tags: ['time', 'unimplemented'],
})
C({
  id: 'add-seconds-zero',
  capability: 'time.addSeconds',
  title: 'A zero cooldown leaves the instant unchanged',
  why: 'A venue may set no cooldown, and a client that treats zero as unset and substitutes a default silently locks players out of a mechanic the venue chose to allow.',
  args: [A.micros(1787437775189712n), A.int(0n)],
  tags: ['time', 'unimplemented', 'boundary'],
})
C({
  id: 'add-seconds-negative',
  capability: 'time.addSeconds',
  title: 'A negative offset moves the instant backwards',
  why: 'Abort uses a different cooldown from settlement and a client could pass the difference; the arithmetic has to be plain rather than clamped at zero, or the two paths stop agreeing.',
  args: [A.micros(1787437775189712n), A.int(-30n)],
  tags: ['time', 'unimplemented', 'boundary'],
})

// ===========================================================================
// G20 - settlement-invariants
// ===========================================================================

group('settlement-invariants', 'audit',
  'The arithmetic Cycle.daml enforces at settlement. No client re-checks it, so a report can state ' +
  'amounts the ledger would have refused and every individual proof still verifies.')

const settleArg = (o) => A.record('settlement', {
  disposition: A.text(o.disposition),
  stakeUnits: A.int(o.stakeUnits),
  returnedUnits: A.int(o.returnedUnits),
  forfeitedUnits: A.int(o.forfeitedUnits),
  payoutUnits: A.int(o.payoutUnits),
  maxPayoutUnits: A.int(o.maxPayoutUnits ?? 50000000000000n),
})
const S = { disposition: 'returned-in-full', stakeUnits: 1000000000000n, returnedUnits: 1000000000000n, forfeitedUnits: 0n, payoutUnits: 0n }

C({ id: 'settlement-returned-in-full-valid', capability: 'settlement.assertSettlementValid',
  title: 'A full return is valid',
  why: 'This is the disposition on the first published TestNet row, so the accepting case is the one an auditor meets first and it has to be pinned before the rejections mean anything.',
  args: [settleArg(S)], tags: ['settlement', 'unimplemented'] })
C({ id: 'settlement-conservation-violated', capability: 'settlement.assertSettlementValid',
  title: 'Returned plus forfeited must equal the stake',
  why: 'Any other split either creates value out of nothing or loses some, and the row would still hash and verify perfectly; conservation is the one property a Merkle proof cannot express.',
  args: [settleArg({ ...S, returnedUnits: 900000000000n, forfeitedUnits: 0n })],
  tags: ['settlement', 'reject', 'unimplemented'] })
C({ id: 'settlement-returned-in-full-with-forfeit', capability: 'settlement.assertSettlementValid',
  title: 'A full return cannot forfeit anything',
  why: 'The disposition tag is what a player and an auditor read, so a returned-in-full row that also forfeits is a document that contradicts itself while remaining arithmetically balanced.',
  args: [settleArg({ ...S, returnedUnits: 900000000000n, forfeitedUnits: 100000000000n })],
  tags: ['settlement', 'reject', 'unimplemented'] })
C({ id: 'settlement-forfeited-in-full-valid', capability: 'settlement.assertSettlementValid',
  title: 'A full forfeit is valid',
  why: 'The opposite extreme of the same rule, pinned so the check is a comparison of both sides rather than a one-way test.',
  args: [settleArg({ ...S, disposition: 'forfeited-in-full', returnedUnits: 0n, forfeitedUnits: 1000000000000n })],
  tags: ['settlement', 'unimplemented'] })
C({ id: 'settlement-forfeited-in-full-with-return', capability: 'settlement.assertSettlementValid',
  title: 'A full forfeit cannot return anything',
  why: 'A row that forfeits in full while returning most of the stake would let a venue report a loss it did not impose, and the amounts would still sum correctly.',
  args: [settleArg({ ...S, disposition: 'forfeited-in-full', returnedUnits: 900000000000n, forfeitedUnits: 100000000000n })],
  tags: ['settlement', 'reject', 'unimplemented'] })
C({ id: 'settlement-partial-forfeit-valid', capability: 'settlement.assertSettlementValid',
  title: 'A partial forfeit needs both sides non-zero',
  why: 'returned-with-forfeit is the disposition a player is most likely to dispute, so the tag has to mean what it says rather than being a catch-all for any split.',
  args: [settleArg({ ...S, disposition: 'returned-with-forfeit', returnedUnits: 700000000000n, forfeitedUnits: 300000000000n })],
  tags: ['settlement', 'unimplemented'] })
C({ id: 'settlement-partial-forfeit-with-zero-forfeit', capability: 'settlement.assertSettlementValid',
  title: 'A partial forfeit that forfeits nothing is refused',
  why: 'It would be a full return wearing a different label, which matters because the two tags carry different meanings in a dispute and in the reported totals.',
  args: [settleArg({ ...S, disposition: 'returned-with-forfeit', returnedUnits: 1000000000000n, forfeitedUnits: 0n })],
  tags: ['settlement', 'reject', 'unimplemented'] })
C({ id: 'settlement-negative-return-refused', capability: 'settlement.assertSettlementValid',
  title: 'A negative returned amount is refused',
  why: 'A negative leg reverses the direction of the settlement while the row still reads as a payment to the player.',
  args: [settleArg({ ...S, returnedUnits: -1000000000000n, forfeitedUnits: 2000000000000n })],
  tags: ['settlement', 'reject', 'unimplemented'] })
C({ id: 'settlement-payout-above-cap-refused', capability: 'settlement.assertSettlementValid',
  title: 'A payout above the policy cap is refused',
  why: 'The cap is the venue commitment about maximum exposure, and it is enforced on the ledger; a report that states a payout above it describes a settlement that could not have happened.',
  args: [settleArg({ ...S, payoutUnits: 60000000000000n, maxPayoutUnits: 50000000000000n })],
  tags: ['settlement', 'reject', 'unimplemented'] })
C({ id: 'settlement-payout-at-cap-accepted', capability: 'settlement.assertSettlementValid',
  title: 'A payout exactly at the cap is accepted',
  why: 'The bound is inclusive, and pinning the edge from the accepting side stops the check from drifting into a strict inequality that would refuse the venue own maximum.',
  args: [settleArg({ ...S, payoutUnits: 50000000000000n, maxPayoutUnits: 50000000000000n })],
  tags: ['settlement', 'unimplemented', 'boundary'] })
C({ id: 'settlement-abort-returns-in-full', capability: 'settlement.assertSettlementValid',
  title: 'An aborted cycle returns the stake in full',
  why: 'Unlocking a TimeLockedHolding always pays the owner in full and this mechanic cannot forfeit, so an abort row that returns less than the stake describes value that went nowhere.',
  args: [settleArg({ ...S, disposition: 'aborted' })],
  tags: ['settlement', 'unimplemented'] })
C({ id: 'settlement-abort-with-partial-return-refused', capability: 'settlement.assertSettlementValid',
  title: 'An aborted cycle that returns less than the stake is refused',
  why: 'This is how a venue would take a fee out of an abort without saying so, and the row would balance because the difference could be booked as a forfeit.',
  args: [settleArg({ ...S, disposition: 'aborted', returnedUnits: 900000000000n, forfeitedUnits: 100000000000n })],
  tags: ['settlement', 'reject', 'unimplemented'] })
C({ id: 'settlement-expiry-returns-in-full', capability: 'settlement.assertSettlementValid',
  title: 'An expired cycle returns the stake in full',
  why: 'Expiry is the player unconditional exit and needs neither arCCade nor the DSO, so anything less than a full return would make that exit conditional after all.',
  args: [settleArg({ ...S, disposition: 'expired-unsettled' })],
  tags: ['settlement', 'unimplemented'] })
C({
  id: 'builder-settle-refuses-forfeit-on-returned-in-full',
  capability: 'builder.buildSettleCommands',
  title: 'The settle builder refuses a forfeit on a full return',
  why: 'This is the one settlement invariant a shipped client does check, and pinning it says which part of the arithmetic is already guarded and which part is not.',
  args: [A.json({
    sdkPackageId: SDK_PACKAGE_REF, amuletPackageId: AMULET_PKG, venue: 'V', operator: 'O', player: 'P',
    stakeCid: 'stake-0000000000000', disposition: 'ReturnedInFull',
    returnedAmount: '99.0', forfeitedAmount: '1.0', payoutAmount: '0.0',
    outcomeDigest: OUTCOME_A, commandId: 'settle-1',
  })],
  tags: ['settlement', 'builder', 'reject'],
})
C({
  id: 'builder-settle-refuses-return-on-forfeited-in-full',
  capability: 'builder.buildSettleCommands',
  title: 'The settle builder refuses a return on a full forfeit',
  why: 'The mirror guard, and the pair is what shows the check is on both dispositions rather than on whichever one was written first.',
  args: [A.json({
    sdkPackageId: SDK_PACKAGE_REF, amuletPackageId: AMULET_PKG, venue: 'V', operator: 'O', player: 'P',
    stakeCid: 'stake-0000000000000', disposition: 'ForfeitedInFull',
    returnedAmount: '1.0', forfeitedAmount: '99.0', payoutAmount: '0.0',
    outcomeDigest: OUTCOME_A, commandId: 'settle-2',
  })],
  tags: ['settlement', 'builder', 'reject'],
})

// ===========================================================================
// G21 - constants
// ===========================================================================

group('constants', 'core-digest',
  'Wire constants. A rename invalidates every commitment already on the ledger, so each one gets a ' +
  'case; a change arrives as a v2 scheme alongside v1, never as an edit.')

for (const [name, blurb] of [
  ['SCHEME_PREFIX', 'the first component of every canonical document'],
  ['DIGEST_ALG_ID', 'the value written into GameStake.digestAlg at commit'],
  ['CUSTODY_TAG_PREFIX', 'the first component of every custody tag on the ledger'],
  ['TRADE_TAG_PREFIX', 'the first component of every trade document'],
  ['TRANSFER_TAG_PREFIX', 'the first component of every transfer document'],
  ['INSTANCE_SEPARATOR', 'the character that separates a unique instance from its type'],
  ['DRY_RUN_VENUE_PREFIX', 'the prefix a venue id must carry to run in dry-run mode'],
]) {
  C({
    id: `constant-${name.toLowerCase().replace(/_/g, '-')}`,
    capability: 'digest.constant',
    title: `The ${name} wire constant`,
    why: `${blurb.charAt(0).toUpperCase()}${blurb.slice(1)}; renaming it would orphan every value already written under the old spelling, and the rename would look like a harmless refactor in review.`,
    args: [A.text(name)],
    tags: ['constants'],
  })
}
C({
  id: 'constant-dispositions-order-and-membership',
  capability: 'digest.constant',
  title: 'The five disposition tags, in order',
  why: 'The list is both a membership check and an ordering that a client might index into; adding a sixth tag in the middle would renumber the others for anyone who did.',
  args: [A.text('DISPOSITIONS')],
  tags: ['constants', 'audit'],
})
C({
  id: 'constant-leg-keys',
  capability: 'digest.constant',
  title: 'The offer leg key',
  why: 'Leg keys are sorted into the trade document, so renaming one reorders the document and changes the digest of every trade that has ever been proposed.',
  args: [A.text('LEG_OFFER')],
  tags: ['constants', 'trade'],
})
C({
  id: 'constant-transfer-reason-reward',
  capability: 'digest.constant',
  title: 'The reward transfer reason',
  why: 'The reason string is inside the hashed transfer document, so it is a wire value and not a display label, which is easy to forget when adding a reason.',
  args: [A.text('REASON_REWARD')],
  tags: ['constants', 'transfer'],
})

// ===========================================================================
// G22 - quota
// ===========================================================================

group('quota', 'quota',
  'Per-tenant write quota as a state-machine trace with an INJECTED clock. Deterministic, which is ' +
  'why it is an optional profile rather than an exclusion.')

const quotaCfg = (windowSeconds, maxWrites) => A.record('quota-config', {
  windowSeconds: A.int(windowSeconds), maxWrites: A.int(maxWrites),
})
const step = (nowMs, cost = 1n, tenantId = 'mygame') => A.record('quota-step', {
  tenantId: A.text(tenantId), nowMs: A.int(nowMs), cost: A.int(cost),
})

C({ id: 'quota-consumes-within-window', capability: 'quota.consume',
  title: 'Three writes inside the window are allowed and counted down',
  why: 'Economic cost is the first defence against spam and the quota is the administrative second; the remaining count is what a caller shows a tenant, so it is part of the contract, not a debug field.',
  args: [quotaCfg(60n, 3n), A.list([step(0n), step(1000n), step(2000n)])],
  tags: ['quota'] })
C({ id: 'quota-refuses-at-the-cap', capability: 'quota.consume',
  title: 'The fourth write in a window is refused',
  why: 'A client that allows the cap-plus-one write makes the quota advisory, and a well funded tenant can then produce operationally harmful volume that is economically legitimate.',
  args: [quotaCfg(60n, 3n), A.list([step(0n), step(0n), step(0n), step(0n)])],
  tags: ['quota', 'boundary'] })
C({ id: 'quota-window-rolls-at-exactly-the-boundary', capability: 'quota.consume',
  title: 'The window rolls at exactly windowSeconds, not one millisecond later',
  why: 'The comparison is greater-or-equal, so the write at exactly the boundary starts a fresh window; an implementation using a strict comparison holds a tenant out for one extra millisecond every window forever.',
  args: [quotaCfg(60n, 1n), A.list([step(0n), step(59999n), step(60000n)])],
  tags: ['quota', 'boundary'] })
C({ id: 'quota-cost-greater-than-one', capability: 'quota.consume',
  title: 'A single call may cost more than one write',
  why: 'The two-write cycle costs two, so a client that always charges one lets a tenant open twice as many cycles as its quota allows.',
  args: [quotaCfg(60n, 4n), A.list([step(0n, 2n), step(0n, 2n), step(0n, 1n)])],
  tags: ['quota'] })
C({ id: 'quota-cost-larger-than-cap-never-allowed', capability: 'quota.consume',
  title: 'A cost above the cap can never be allowed',
  why: 'Otherwise a caller could get an oversized batch through by waiting for a fresh window, which would make the cap a rate rather than a bound.',
  args: [quotaCfg(60n, 3n), A.list([step(0n, 5n), step(60000n, 5n)])],
  tags: ['quota', 'boundary'] })
C({ id: 'quota-reset-at-is-window-start-plus-window', capability: 'quota.consume',
  title: 'resetAt is the start of the window plus its length',
  why: 'Callers surface resetAt to tenants as a retry-after, so a client computing it from the current instant instead of the window start tells every tenant to retry too late.',
  args: [quotaCfg(30n, 2n), A.list([step(5000n), step(20000n)])],
  tags: ['quota'] })
C({ id: 'quota-separate-tenants-separate-buckets', capability: 'quota.consume',
  title: 'One tenant cannot spend another tenant quota',
  why: 'A shared bucket would let a noisy tenant deny service to a quiet one on the same participant, which is the isolation failure this layer exists to prevent.',
  args: [quotaCfg(60n, 1n), A.list([step(0n, 1n, 'mygame'), step(0n, 1n, 'othergame'), step(0n, 1n, 'mygame')])],
  tags: ['quota'] })
C({ id: 'quota-refused-call-does-not-consume', capability: 'quota.consume',
  title: 'A refused write does not eat quota',
  why: 'If refusals consumed the budget a tenant that retries would never recover inside the window, turning a rate limit into a lockout.',
  args: [quotaCfg(60n, 2n), A.list([step(0n), step(0n), step(0n), step(0n), step(60000n), step(60000n)])],
  tags: ['quota', 'boundary'] })
C({ id: 'quota-rejects-invalid-tenant-id', capability: 'quota.consume',
  title: 'The quota check validates the tenant id',
  why: 'The tenant id arrives from a key that is attacker-controlled text, and an unvalidated one would create an unbounded number of buckets, each with a full allowance.',
  args: [quotaCfg(60n, 3n), A.list([step(0n, 1n, 'My--Game')])],
  tags: ['quota', 'reject'] })
C({ id: 'quota-second-window-full-allowance', capability: 'quota.consume',
  title: 'A fresh window restores the full allowance',
  why: 'A client that decays the counter instead of resetting it gives a tenant less than its stated quota, and the difference only shows under sustained load.',
  args: [quotaCfg(10n, 2n), A.list([step(0n), step(0n), step(10000n), step(10000n), step(10000n)])],
  tags: ['quota'] })

// ===========================================================================
// G23 - builder
// ===========================================================================

group('builder', 'builder',
  'Ledger command payloads. Only the JavaScript client builds them, and excluding them because of ' +
  'that would be exactly the quiet stop this suite exists to prevent: the output is deterministic ' +
  'JSON, so it is checkable.')

const COMMIT_BASE = {
  // SUBMISSION side: our templates go in by package NAME, which is what
  // docs/INTEGRATION.md 2.3 tells integrators to pass and what survives an
  // upgrade. The case then pins that the builder puts the reference into the
  // templateId prefix unmodified, rather than pinning one release's id.
  sdkPackageId: SDK_PACKAGE_REF,
  // The amulet id is the caller's PARAMETER, read off the AmuletRules
  // templateId at runtime (gameCustody.js fetchAmuletRules). The value is a
  // dated witness, not a constant — see package-ids.json external.packages —
  // so what this case fixes is the shape, with the id passing through.
  amuletPackageId: AMULET_PKG,
  venue: 'venue-party', operator: 'operator-party', player: 'player-party',
  entitlementCid: 'ent-0001', gameCode: 'trade-wars-v4',
  cycleId: 'tw-testnet-1787437747', entryDigest: DIGEST_A,
  stakeAmount: '100.0', feeAmount: '0.5',
  instrumentId: { admin: 'dso-party', id: 'Amulet' },
  lockExpiresAt: '2026-08-23T00:29:07Z',
  amuletRulesCid: 'rules-0001', openMiningRoundCid: 'round-0001',
  inputAmuletCids: ['amulet-0001'], dsoParty: 'dso-party',
  commandId: 'commit-tw-testnet-1787437747',
}

C({
  id: 'builder-commit-is-two-commands-in-one-submission',
  capability: 'builder.buildCommitCommands',
  title: 'Write one is exactly two commands in a single submission',
  why: 'Sent apart, a GameStake can exist unfunded or a lock can exist with no cycle behind it; the atomicity is the entire reason the commit builder exists rather than two calls.',
  args: [A.json(COMMIT_BASE)],
  tags: ['builder'],
})
C({
  id: 'builder-commit-custody-tag-reaches-opt-context',
  capability: 'builder.buildCommitCommands',
  title: 'The custody tag is written into the lock optContext',
  why: 'The two commands cannot see each other, so the tag in optContext is the only thing binding the lock to the cycle; a generic string there makes the stake unsettleable and abortable only.',
  args: [A.json({ ...COMMIT_BASE, cycleId: 'tw-tag-check', commandId: 'commit-tag-check' })],
  tags: ['builder', 'custody'],
})
C({
  id: 'builder-commit-no-fee-output-when-fee-is-zero',
  capability: 'builder.buildCommitCommands',
  title: 'A zero fee produces no fee output',
  why: 'An output of zero would be a transfer leg that moves nothing and still costs a ledger write, and dry-run mode requires the fee to be zero, so this path is on the learning ramp.',
  args: [A.json({ ...COMMIT_BASE, feeAmount: '0.0', cycleId: 'tw-zero-fee', commandId: 'commit-zero-fee' })],
  tags: ['builder', 'boundary'],
})
C({
  id: 'builder-commit-rejects-missing-fee-amount',
  capability: 'builder.buildCommitCommands',
  title: 'An omitted fee amount is refused, not serialised',
  why: 'Bare String() serialisation sends the literal text undefined to the ledger as the fee, which was verified against a live submission; the ledger then rejects it with a parse error that says nothing about the missing field.',
  args: [A.json({ ...COMMIT_BASE, feeAmount: undefined, cycleId: 'tw-no-fee', commandId: 'commit-no-fee' })],
  expect: { reject: { class: 'bad-type' } },
  decision: 'D10',
  divergenceReason: 'buildCommitCommands writes feeAmount: "undefined" into the terms.',
  tags: ['builder', 'reject', 'normative'],
})
C({
  id: 'builder-commit-rejects-empty-input-amulets',
  capability: 'builder.buildCommitCommands',
  title: 'A commit with no Amulet inputs is refused',
  why: 'There would be nothing to lock, and the transfer command would be built anyway; the failure would surface as a ledger rejection with no indication of which field was empty.',
  args: [A.json({ ...COMMIT_BASE, inputAmuletCids: [], cycleId: 'tw-no-input', commandId: 'commit-no-input' })],
  tags: ['builder', 'reject'],
})
C({
  id: 'builder-commit-rejects-invalid-cycle-id',
  capability: 'builder.buildCommitCommands',
  title: 'A commit with a colon in the cycle id is refused',
  why: 'The builder is where the identifier rules are actually enforced for most callers, so a validator that is never reached from a builder protects nothing.',
  args: [A.json({ ...COMMIT_BASE, cycleId: 'tw:bad', commandId: 'commit-bad-id' })],
  tags: ['builder', 'reject'],
})
C({
  id: 'builder-commit-rejects-non-hex-entry-digest',
  capability: 'builder.buildCommitCommands',
  title: 'A commit with a malformed entry digest is refused',
  why: 'The entry digest goes straight into the custody tag, so a malformed one produces a tag that settlement can never re-derive and a stake that can only be aborted.',
  args: [A.json({ ...COMMIT_BASE, entryDigest: 'not-a-digest', commandId: 'commit-bad-digest' })],
  tags: ['builder', 'reject'],
})
C({
  id: 'builder-dry-run-commit-is-one-command',
  capability: 'builder.buildDryRunCommitCommands',
  title: 'A dry-run commit is a single command with no lock',
  why: 'The learning ramp has to run without Canton Coin or disclosed contracts from Scan; if dry run needed the transfer half, the first hour would be spent on Splice transfer mechanics rather than on the SDK.',
  args: [A.json({
    sdkPackageId: COMMIT_BASE.sdkPackageId, venue: 'dryrun-venue', operator: 'operator-party',
    player: 'player-party', entitlementCid: 'ent-0001', gameCode: 'trade-wars-v4',
    cycleId: 'tw-dry-1', entryDigest: DIGEST_A, stakeAmount: '100.0',
    instrumentId: { admin: 'dso-party', id: 'Amulet' }, lockExpiresAt: '2026-08-23T00:29:07Z',
    commandId: 'dryrun-commit-tw-dry-1',
  })],
  tags: ['builder'],
})
C({
  id: 'builder-dry-run-fee-is-zero-in-the-payload',
  capability: 'builder.buildDryRunCommitCommands',
  title: 'A dry-run commit writes a zero fee explicitly',
  why: 'Mode discipline enforces a zero fee on the ledger, and writing it explicitly means a caller who expected to charge one finds out here rather than in a rejection from the venue contract.',
  args: [A.json({
    sdkPackageId: COMMIT_BASE.sdkPackageId, venue: 'dryrun-venue', operator: 'operator-party',
    player: 'player-party', entitlementCid: 'ent-0001', gameCode: 'pixel-race-v1',
    cycleId: 'pr-dry-1', entryDigest: DIGEST_B, stakeAmount: '30.0',
    instrumentId: { admin: 'dso-party', id: 'Amulet' }, lockExpiresAt: '2026-08-23T00:29:07Z',
    commandId: 'dryrun-commit-pr-dry-1',
  })],
  tags: ['builder'],
})

const SETTLE_BASE = {
  sdkPackageId: COMMIT_BASE.sdkPackageId, amuletPackageId: COMMIT_BASE.amuletPackageId,
  venue: 'venue-party', operator: 'operator-party', player: 'player-party',
  stakeCid: 'stake-000000000000001', lockedAmuletCid: 'locked-0001',
  disposition: 'ReturnedInFull', returnedAmount: '100.0', forfeitedAmount: '0.0',
  payoutAmount: '0.0', outcomeDigest: OUTCOME_A, commandId: 'settle-tw-1',
}
C({
  id: 'builder-settle-order-settle-before-unlock',
  capability: 'builder.buildSettleCommands',
  title: 'Settle comes before the unlock, never after',
  why: 'GameStake_Settle reads the lock through the Holding interface, so the unlock that archives it has to come second; reversed, settlement is refused for having no custody proof.',
  args: [A.json(SETTLE_BASE)],
  tags: ['builder'],
})
C({
  id: 'builder-settle-without-lock-is-one-command',
  capability: 'builder.buildSettleCommands',
  title: 'A settlement with no lock is a single command',
  why: 'Dry-run cycles and cycles whose unlock rides in another transaction have no locked Amulet to archive, and a builder that always emits two commands makes those submissions fail.',
  args: [A.json({ ...SETTLE_BASE, lockedAmuletCid: null, commandId: 'settle-nolock' })],
  tags: ['builder', 'boundary'],
})
C({
  id: 'builder-settle-derives-digest-from-document',
  capability: 'builder.buildSettleCommands',
  title: 'An outcome document is hashed into the outcome digest',
  why: 'Callers pass the document and expect the digest to be derived from it; a client that requires both invites them to drift apart, and the digest is what the ledger stores.',
  args: [A.json({ ...SETTLE_BASE, outcomeDigest: undefined, outcomeDocument: 'arccade-sdk-digest-v1|t:3:foo', commandId: 'settle-fromdoc' })],
  tags: ['builder'],
})
C({
  id: 'builder-settle-rejects-missing-outcome',
  capability: 'builder.buildSettleCommands',
  title: 'A settlement with neither a document nor a digest is refused',
  why: 'The outcome commitment is the whole point of settlement; without it the row would carry an empty outcome that reads exactly like a legitimate abort.',
  args: [A.json({ ...SETTLE_BASE, outcomeDigest: undefined, commandId: 'settle-nodigest' })],
  tags: ['builder', 'reject'],
})
C({
  id: 'builder-abort-carries-optional-custody-ref',
  capability: 'builder.buildAbortCommands',
  title: 'An abort takes its custody reference optionally',
  why: 'The reason abort exists is that the lock may never have been created, so requiring the reference would make the escape hatch unusable in exactly the case it was built for.',
  args: [A.json({
    sdkPackageId: COMMIT_BASE.sdkPackageId, venue: 'venue-party', operator: 'operator-party',
    player: 'player-party', stakeCid: 'stake-000000000000001', reason: 'player disconnected',
    lockedAmuletCid: null, commandId: 'abort-1',
  })],
  tags: ['builder'],
})
C({
  id: 'builder-expire-acts-as-player-alone',
  capability: 'builder.buildExpireCommands',
  title: 'Expiry is submitted by the player alone',
  why: 'It is the unconditional exit: after the lock expires the player recovers both the funds and the slot without arCCade or the DSO, and any extra actAs party would reintroduce the dependency.',
  args: [A.json({
    sdkPackageId: COMMIT_BASE.sdkPackageId, amuletPackageId: COMMIT_BASE.amuletPackageId,
    player: 'player-party', stakeCid: 'stake-000000000000001',
    lockedAmuletCid: 'locked-0001', commandId: 'expire-1',
  })],
  tags: ['builder'],
})

const TRADE_BUILD = {
  sdkPackageId: COMMIT_BASE.sdkPackageId, venue: 'venue-party', maker: 'maker-party',
  taker: 'taker-party', tradeId: 't-0001',
  legs: {
    offer: { sender: 'maker-party', receiver: 'taker-party', instrumentId: { admin: 'registry-party', id: 'mygame/sword-of-dawn#4a91c8f2' }, amount: '1' },
    ask: { sender: 'taker-party', receiver: 'maker-party', instrumentId: { admin: 'dso-party', id: 'Amulet' }, amount: '25.0' },
  },
  expiresAt: '2026-08-30T00:00:00Z', settleBefore: '2026-08-31T00:00:00Z',
  commandId: 'trade-propose-t-0001', meta: { listing: 'lst-9' },
}
C({
  id: 'builder-trade-proposal-embeds-the-digest',
  capability: 'builder.buildTradeProposalCommands',
  title: 'A trade proposal carries the digest of its own document',
  why: 'Only the digest reaches the ledger, so a proposal whose digest was computed from different inputs than the published document cannot be checked by the buyer at all.',
  args: [A.json(TRADE_BUILD)],
  tags: ['builder', 'trade'],
})
C({
  id: 'builder-trade-proposal-rejects-single-leg',
  capability: 'builder.buildTradeProposalCommands',
  title: 'A trade with only an offer is refused',
  why: 'A one-sided trade is a transfer wearing a trade label, and it would settle atomically while moving value in only one direction.',
  args: [A.json({ ...TRADE_BUILD, legs: { offer: TRADE_BUILD.legs.offer }, commandId: 'trade-propose-oneleg' })],
  tags: ['builder', 'trade', 'reject'],
})
C({
  id: 'builder-trade-settle-rejects-empty-allocations',
  capability: 'builder.buildTradeSettleCommands',
  title: 'Settling a trade with no allocations is refused',
  why: 'Every leg needs its allocation contract id for the settlement to be atomic; an empty map would submit a settle that can only fail on the ledger.',
  args: [A.json({
    sdkPackageId: COMMIT_BASE.sdkPackageId, venue: 'venue-party', maker: 'maker-party',
    taker: 'taker-party', tradeCid: 'trade-000000000000001', allocations: {}, commandId: 'trade-settle-1',
  })],
  tags: ['builder', 'trade', 'reject'],
})
C({
  id: 'builder-trade-cancel',
  capability: 'builder.buildTradeCancelCommands',
  title: 'Cancelling a trade is one command from the venue',
  why: 'Allocation withdrawal is what makes a trade cancellable without escrow, and the cancel path has to stay a single venue-signed command or the counterparty could block it.',
  args: [A.json({
    sdkPackageId: COMMIT_BASE.sdkPackageId, venue: 'venue-party',
    tradeCid: 'trade-000000000000001', reason: 'listing withdrawn', commandId: 'trade-cancel-1',
  })],
  tags: ['builder', 'trade'],
})

const TRANSFER_BUILD = {
  amuletPackageId: COMMIT_BASE.amuletPackageId, sender: 'venue-party', provider: 'venue-party',
  recipients: [
    { receiver: 'player-1', amount: '5.0', instrumentId: { admin: 'dso-party', id: 'Amulet' } },
    { receiver: 'player-2', amount: '3.0', instrumentId: { admin: 'dso-party', id: 'Amulet' } },
  ],
  inputAmuletCids: ['amulet-0001'], amuletRulesCid: 'rules-0001',
  openMiningRoundCid: 'round-0001', dsoParty: 'dso-party', transferId: 'x-0001',
  reason: 'reward', commandId: 'transfer-x-0001', meta: {},
}
C({
  id: 'builder-transfer-batch-is-one-transaction',
  capability: 'builder.buildTransferCommands',
  title: 'A batch payout is one command, not one per recipient',
  why: 'Splitting a payout into N transactions would inflate the qualifying-activity count for the same economic event, and the builder deliberately does not make that easy.',
  args: [A.json(TRANSFER_BUILD)],
  tags: ['builder', 'transfer'],
})
C({
  id: 'builder-transfer-rejects-unknown-reason',
  capability: 'builder.buildTransferCommands',
  title: 'An unknown transfer reason is refused',
  why: 'The reason is inside the hashed document, so an unrecognised one produces a digest no other client reproduces and a report category nothing else understands.',
  args: [A.json({ ...TRANSFER_BUILD, reason: 'airdrop', commandId: 'transfer-bad-reason' })],
  tags: ['builder', 'transfer', 'reject'],
})
C({
  id: 'builder-transfer-rejects-self-transfer',
  capability: 'builder.buildTransferCommands',
  title: 'A transfer to the sender is refused',
  why: 'It is the cheapest way to manufacture volume that looks like real activity, and it is closed at the source rather than left to a reporting filter.',
  args: [A.json({ ...TRANSFER_BUILD, recipients: [{ receiver: 'venue-party', amount: '5.0', instrumentId: { admin: 'dso-party', id: 'Amulet' } }], commandId: 'transfer-self' })],
  tags: ['builder', 'transfer', 'reject'],
})
C({
  id: 'builder-transfer-rejects-repeated-recipient',
  capability: 'builder.buildTransferCommands',
  title: 'The same recipient twice in one batch is refused',
  why: 'Paying one party twice in a single transaction is one payment split in two, which inflates the recipient count in a report without moving any more value.',
  args: [A.json({ ...TRANSFER_BUILD, recipients: [{ receiver: 'player-1', amount: '5.0', instrumentId: { admin: 'dso-party', id: 'Amulet' } }, { receiver: 'player-1', amount: '3.0', instrumentId: { admin: 'dso-party', id: 'Amulet' } }], commandId: 'transfer-dup' })],
  tags: ['builder', 'transfer', 'reject'],
})
C({
  id: 'builder-transfer-rejects-empty-recipients',
  capability: 'builder.buildTransferCommands',
  title: 'A transfer with no recipients is refused',
  why: 'It would submit a transfer command with no outputs, burning a write and a fee to move nothing.',
  args: [A.json({ ...TRANSFER_BUILD, recipients: [], commandId: 'transfer-empty' })],
  tags: ['builder', 'transfer', 'reject'],
})
C({
  id: 'builder-transfer-rejects-zero-amount',
  capability: 'builder.buildTransferCommands',
  title: 'A zero-amount recipient is refused',
  why: 'A zero leg is a payment that moves nothing while still counting as one, and the batch would otherwise succeed with it silently included.',
  args: [A.json({ ...TRANSFER_BUILD, recipients: [{ receiver: 'player-1', amount: '0', instrumentId: { admin: 'dso-party', id: 'Amulet' } }], commandId: 'transfer-zero' })],
  tags: ['builder', 'transfer', 'reject'],
})

// -- stragglers: cases whose only job is to reach a reject-map rule that would
//    otherwise be dead code. A rule nobody exercises is a rule nobody checked.

reopen('builder')
C({
  id: 'builder-commit-rejects-over-long-cycle-id',
  capability: 'builder.buildCommitCommands',
  title: 'A commit with a 65-character cycle id is refused',
  why: 'The length bound and the forbidden-character rule are separate checks with separate messages, and a builder that reaches only one of them lets the other kind of bad id through to the ledger.',
  args: [A.json({ ...COMMIT_BASE, cycleId: 'a'.repeat(65), commandId: 'commit-long-id' })],
  tags: ['builder', 'reject', 'boundary'],
})

reopen('amount-units')
C({
  id: 'amount-rejects-unsupported-type',
  capability: 'digest.amountUnits',
  title: 'A null amount is refused as an unsupported type',
  why: 'An unset field reaching the amount parser has to be refused by type rather than coerced; a client that turns it into zero writes a commitment to a stake of nothing.',
  args: [A.nul()],
  tags: ['amount', 'reject'],
})

reopen('value-documents')
C({
  id: 'trade-leg-rejects-missing-receiver',
  capability: 'trade.leg',
  title: 'A leg with no receiver is refused',
  why: 'A leg without both parties cannot be allocated, and the failure would otherwise arrive from the ledger as a missing-field error long after the proposal was published.',
  args: [A.record('trade-leg', { sender: A.party('a'), receiver: A.text(''), instrumentId: instrIn('dso-party', 'Amulet'), amount: A.text('1.0') })],
  tags: ['trade', 'reject'],
})
C({
  id: 'trade-leg-rejects-malformed-instrument',
  capability: 'trade.leg',
  title: 'A leg whose instrument has no admin is refused',
  why: 'The admin is the registry that governs the asset, and a leg without one names an asset no registry will settle.',
  args: [A.record('trade-leg', { sender: A.party('a'), receiver: A.party('b'), instrumentId: A.record('instrument-id', { admin: A.text(''), id: A.text('Amulet') }), amount: A.text('1.0') })],
  tags: ['trade', 'reject'],
})

// ===========================================================================
// Assembly and the checks that make the manifest falsifiable
// ===========================================================================

const PROFILES = {
    'core-digest': 'canonical encoding, amounts, documents, scheme constants',
    merkle: 'tree construction, proofs, domain separation',
    audit: 'leaf, anchor, policy, tree reconstruction, report order, settlement invariants',
    identity: 'cycle/trade/asset/tenant identifiers, custody tag, namespacing',
    'value-documents': 'trade and transfer documents',
    time: 'epoch and second truncation arithmetic',
    quota: 'optional; tenant rate limiting with an injected clock',
    builder: 'separate tier; ledger command payloads',
    games: 'GROUPING ONLY, not a capability profile. The game adapters live in js/examples/ and are not in the published package, so a consumer cannot call them; the entry and outcome documents are covered as compositions of core-digest capabilities instead. See README.md.',
  }

const ALL_CASES = GROUPS.flatMap((g) => g.cases)

// The profile a case is SELECTED BY is the profile of its group. It cannot be
// the profile of its capability: `games` is declared here, twenty cases sit in
// two groups that declare it, and no capability carries it — so bucketing by
// capability scatters those twenty into core-digest and merkle and leaves the
// declared profile looking empty. This map is the one definition of "which
// cases are in profile P", and the runners read the same two fields out of the
// manifest to reach the same answer.
const DECLARED_PROFILES = Object.keys(PROFILES)
const CASES_PER_PROFILE = new Map(DECLARED_PROFILES.map((p) => [p, 0]))
for (const g of GROUPS) {
  if (CASES_PER_PROFILE.has(g.profile)) {
    CASES_PER_PROFILE.set(g.profile, CASES_PER_PROFILE.get(g.profile) + g.cases.length)
  }
}

// 1. No JSON number may appear under input or expect. `1787437747372202`
//    survives JSON.parse in JavaScript today but 9223372036854775807 does not,
//    Python would hand a float to a Decimal path, and Jackson picks Integer,
//    Long or Double by value. One rule removes the whole class of problem.
//    The single exception is a `json` value, which is a ledger payload passed
//    through verbatim and never decoded into a typed value.
function assertNoNumbers(node, path) {
  if (node === null || node === undefined) return
  if (typeof node === 'number') { problem(`JSON number at ${path}`); return }
  if (Array.isArray(node)) { node.forEach((x, i) => assertNoNumbers(x, `${path}[${i}]`)); return }
  if (typeof node === 'object') {
    if (node.t === 'json') return
    for (const [k, v] of Object.entries(node)) assertNoNumbers(v, `${path}.${k}`)
  }
}
for (const c of ALL_CASES) {
  assertNoNumbers(c.input, `${c.id}.input`)
  assertNoNumbers(c.expect, `${c.id}.expect`)
}

// 2. A capability with zero cases is a hole, not a pass.
for (const g of GROUPS) {
  if (!Object.prototype.hasOwnProperty.call(PROFILES, g.profile)) {
    problem(`group ${g.group} declares profile ${g.profile}, which is not in the profile list`)
  }
}
for (const c of CAPS.values()) {
  if (c.cases === 0) problem(`capability ${c.id} has no case; a capability with zero cases is a hole, not a pass`)
  if (!Object.prototype.hasOwnProperty.call(PROFILES, c.profile)) {
    problem(`capability ${c.id} declares profile ${c.profile}, which is not in the profile list`)
  }
}

// 2b. A declared profile with no case is a profile a runner can name and get
//     nothing back from. `games` was the reverse of that and just as bad — 20
//     cases, declared, and unreachable by name in all three runners because
//     every runner derived its selectable set from the capability catalog,
//     which has no games capability. Both halves are the same rule: the
//     declared profile set and the reachable profile set are one set.
for (const p of DECLARED_PROFILES) {
  if (CASES_PER_PROFILE.get(p) === 0) {
    problem(`profile ${p} is declared in \`profiles\` and no group puts a case in it; ` +
      'a profile a runner can name and get nothing back from is a claim nothing can check. ' +
      'Give it a group or drop the declaration.')
  }
}

// 2c. The buckets must account for every case exactly once. summary.byProfile
//     used to be built from a hardcoded 8-key literal, so the 20 games cases
//     were redistributed into core-digest and merkle and the totals still
//     summed to 469 — a wrong answer that adds up is the hard kind to see.
{
  const bucketed = [...CASES_PER_PROFILE.values()].reduce((a, b) => a + b, 0)
  if (bucketed !== ALL_CASES.length) {
    problem(`summary.byProfile would account for ${bucketed} of ${ALL_CASES.length} cases; ` +
      'every case must land in exactly one declared profile')
  }
}

// 3. A reject-map rule nobody exercises is a rule nobody checked.
for (const r of REJECT_MAP) {
  if (r.used === 0) problem(`reject rule [${r.group}] /${r.match}/ is never exercised by any case`)
}

// 3b. Every Daml vector must anchor something. A key that names no case is a
//     literal nobody is measured against — it reads like coverage and is not.
for (const v of VECTORS.values()) {
  if (v.used === 0) {
    problem(`Daml vector "${v.key}" (VectorsTest.daml:${v.line}) anchors no conformance case. ` +
      'Either name the case it belongs to, add that case, or delete the vector.')
  }
}

// 3b-bis. A per-case decode override that names no case would be a decode rule
//         nobody runs, sitting in the table looking reviewed.
for (const [capId, anchor] of Object.entries(DAML_ANCHORS)) {
  for (const caseId of Object.keys(anchor.decodeFor ?? {})) {
    if (!IDS.has(caseId)) {
      problem(`DAML_ANCHORS[${capId}].decodeFor names "${caseId}", which is not a case id. ` +
        'Point it at the case whose vector needs the override, or drop it.')
    }
  }
}

// 3c. The honest residue: which capabilities have no case anchored to Daml.
//     This is reported, not waived — the README carries the reason for each.
const DAML_ANCHORED = ALL_CASES.filter((c) => c.source === 'daml-vector' || c.source === 'daml-vector-golden')
const damlAnchoredIds = new Set(DAML_ANCHORED.map((c) => c.id))
const UNANCHORED_CAPS = [...CAPS.values()]
  .filter((c) => !ALL_CASES.some((x) => x.capability === c.id && damlAnchoredIds.has(x.id)))
  .map((c) => c.id)

// 4. Provenance. A golden is only a golden if the value it claims to come from
//    is still spelled that way in the file it came from. Grepping for the
//    literal is crude and that is the point: it cannot be satisfied by the
//    implementation agreeing with itself.
//
//    This check used to FAIL OPEN. If a golden's label happened to contain none
//    of the known substrings, it fell through to the sentence "verified by
//    running the Daml test package against the 1.5.0 DAR" — prose nothing
//    reads, stamped into the manifest as if it were a result. Three shipped
//    goldens (the three time operators) took that branch. It now fails CLOSED:
//    a golden must resolve to at least one provenance this generator actually
//    verified, and a golden that resolves to none stops the run.
const PROVENANCE_FILES = {
  VectorsTest: join(REPO, 'test-package', 'daml', 'Test', 'GameSdk', 'VectorsTest.daml'),
  'cycle-rows.json': join(REPO, 'test-vectors', 'cycle-rows.json'),
  'custody tag': join(REPO, 'test-vectors', 'cycle-rows.json'),
}
const VECTORS_REL = VECTORS_PATH.slice(REPO.length + 1)
for (const g of GOLDEN_CHECKS) {
  const needle = g.pinned.digest
    ?? g.pinned.document?.digest
    ?? g.pinned.text?.v
    ?? (g.pinned.value ? g.pinned.value.v : null)
  const verified = []

  // (a) The value appears verbatim in a file this repository ships.
  const key = Object.keys(PROVENANCE_FILES).find((k) => g.golden.includes(k))
  if (key) {
    const file = PROVENANCE_FILES[key]
    if (needle === null) {
      problem(`golden ${g.caseId} names ${key} but pins no scalar value to look for, ` +
        'so "appears verbatim in" cannot be checked. Pin a digest, text or value.')
    } else if (!existsSync(file)) {
      problem(`golden ${g.caseId}: provenance file missing: ${file}`)
    } else if (!readFileSync(file, 'utf8').includes(needle)) {
      problem(`GOLDEN PROVENANCE — case ${g.caseId} claims to come from ${key}, but ${needle} does not appear in ${file}`)
    } else {
      verified.push(`appears verbatim in ${file.slice(REPO.length + 1)}`)
    }
  }

  // (b) A Daml vector for this exact case. Stronger than a grep: the literal
  //     was parsed out of the source, the client was measured against it, and a
  //     disagreement in either direction already stopped the run above.
  if (g.vector) {
    verified.push(`Daml vector "${g.vector.key}" at ${VECTORS_REL}:${g.vector.line}`)
  }

  // (c) The published TestNet anchor report, when this environment has it.
  //     Best-effort by design — an auditor without the report directory can
  //     still regenerate — which is exactly why it may not be the ONLY
  //     provenance a golden has.
  if (g.golden.includes('anchor') && liveAnchorCrossCheck.startsWith('matches ')) {
    verified.push(liveAnchorCrossCheck)
  }

  if (verified.length === 0) {
    problem(`GOLDEN PROVENANCE — case ${g.caseId}: "${g.golden}" resolves to nothing this generator ` +
      'can verify. A golden with no checkable provenance is a claim, not a golden: name a file in ' +
      'PROVENANCE_FILES that carries the literal, or anchor the case to a Daml vector.')
  }
  g.provenance = verified.length ? verified.join('; ') : null
}

// 4. Normative decisions.
//
//    `goesRed` is a CLAIM about which clients violate the pin, and it used to
//    be hand-maintained prose that nothing could refute. It is now measured
//    from two directions:
//
//      - javascript, HERE. This generator runs the JavaScript client, so it
//        knows exactly whether that client diverges. `goesRed` including or
//        excluding 'javascript' against the evidence is a failure either way:
//        a decision the client has quietly started to obey is a description,
//        and a decision listed green that is actually red is a missing waiver.
//      - python and java, in `conformance/run-all.sh`. This generator cannot
//        import either client, so it does not guess. The parity script reads
//        all three .verdicts files and fails when a language's observed red on
//        a decision's cases does not equal what `goesRed` says.
//
//    `governs` names the cases a decision is about when NO client diverges any
//    more, so a settled decision still has cases attached and goes red again
//    the moment somebody regresses. A decision with no case at all is refused:
//    that is the shape D4, D5 and D6 had while claiming Python went red on
//    them, which no case could contradict because there were none.
const DECISIONS = [
  { id: 'D1', title: 'Report order breaks ties by Unicode code point', goesRed: ['javascript'],
    rationale: 'localeCompare is locale- and ICU-version-dependent and String::compareTo is UTF-16 code-unit order, so two honest implementations publish different Merkle roots over the same cycles.' },
  { id: 'D2', title: 'The cycleId length limit is 64 CODE POINTS', goesRed: ['javascript'],
    rationale: 'Daml T.length counts code points, so the ledger accepts an id the JavaScript check refuses, and the auditor path breaks on a cycle already on the ledger.' },
  { id: 'D3', title: 'An ISO to micros conversion on a document path is microsecond-exact', goesRed: ['javascript'],
    rationale: 'Java Instant keeps micros while JavaScript canonTime routes through Date.parse; the Trade Wars golden uses a whole second so nothing catches it today.' },
  { id: 'D4', title: 'A native binary float is refused as an amount', goesRed: [],
    governs: ['amount-native-float-rejected', 'amount-native-float-half-rejected'],
    rationale: 'canon_decimal of a float returns a value that differs between languages while both report success.' },
  { id: 'D5', title: 'Every client enforces the Daml Int band', goesRed: [],
    governs: ['amount-above-int64-band', 'amount-below-int64-band', 'amount-far-above-band'],
    rationale: 'A reference that accepts what the ledger cannot hold cannot be used to reject it.' },
  { id: 'D6', title: 'Every client enforces the ASCII field-name rule', goesRed: [],
    governs: ['field-name-rejected-non-ascii', 'field-name-rejected-astral'],
    rationale: 'The ASCII restriction is what makes the field sort identical across Daml sortOn, Python sorted and JavaScript Array.sort.' },
  { id: 'D7', title: 'textDigest of the empty string is refused', goesRed: ['javascript'],
    rationale: "Daml's toHex of an empty string is a runtime error, so a client returning e3b0c442 computes a value the ledger never can." },
  { id: 'D8', title: 'v1 trade and transfer documents refuse a pipe in any component', goesRed: ['javascript'],
    rationale: 'The format has no length prefixes, so a pipe inside a value silently reshapes the document.' },
  { id: 'D9', title: 'canonInt of a native boolean is refused', goesRed: ['javascript'],
    rationale: "Python's str(True) yields i:4:True and JavaScript's BigInt(true) yields i:1:1." },
  { id: 'D10', title: 'Cycle builders refuse a missing fee amount', goesRed: ['javascript'],
    rationale: 'Bare String() serialisation sends the literal text undefined to the ledger.' },
  { id: 'D11', title: 'REPORT_ORDER names its collation', goesRed: ['javascript'],
    rationale: 'The current string names no collation, which is the root of D1.' },
  { id: 'D12', title: 'amountUnits is lossless-or-reject, so it has no rounding direction', goesRed: [],
    governs: ['amount-sub-unit-precision-loss', 'amount-eleven-fractional-nonzero'],
    rationale: 'A rounding direction is only observable on an input finer than 1e-10, and all four implementations refuse ' +
      'that input before rounding it: Daml Decimal is Numeric 10 and cannot hold one, Java rounds DOWN and then rejects ' +
      'unless the value divides back exactly, and JavaScript and Python check the digits past the tenth before scaling. ' +
      'Stating the direction would be pinning dead code; what is normative is the refusal, so that is what is pinned. A ' +
      'port that rounds rather than refuses makes the direction observable and turns this decision red.' },
  { id: 'G03-whitespace', title: 'An amount with surrounding whitespace is refused', goesRed: ['javascript'],
    rationale: 'JavaScript trims before matching while Daml does not, so a padded field is accepted by one client and refused by another.' },
]
const ALL_CASE_IDS = new Set(ALL_CASES.map((c) => c.id))
const DECISION_LANGUAGES = ['javascript', 'python', 'java']
for (const d of DECISIONS) {
  for (const lang of d.goesRed) {
    if (!DECISION_LANGUAGES.includes(lang)) fail(`decision ${d.id}: unknown language ${lang} in goesRed`)
  }
  const pinned = ALL_CASES.filter((c) => c.decision === d.id).map((c) => c.id)
  const governs = d.governs ?? []
  for (const cid of governs) {
    if (!ALL_CASE_IDS.has(cid)) problem(`decision ${d.id}: governs "${cid}", which is not a case id`)
    if (pinned.includes(cid)) problem(`decision ${d.id}: case ${cid} is both pinned and listed under governs; say it once`)
  }
  d.cases = [...pinned, ...governs]
  d.divergentCases = DIVERGENCES.filter((x) => x.decision === d.id).map((x) => x.caseId)

  // A decision with no case is a claim nothing can contradict.
  if (d.cases.length === 0) {
    problem(`decision ${d.id} names no case. Pin the case that carries it, or list the ` +
      'cases it governs under "governs" — a decision no case is attached to cannot be checked.')
  }

  // The javascript half of goesRed, measured rather than declared. Both
  // directions fail, so neither a stale divergence nor a silent one survives.
  const jsRed = d.divergentCases.length > 0
  if (d.goesRed.includes('javascript') && !jsRed) {
    problem(`STALE DECISION ${d.id}: goesRed lists javascript, but every case now agrees with the pin. ` +
      'Drop javascript from goesRed (and list the cases under "governs" if none is pinned any more).')
  }
  if (!d.goesRed.includes('javascript') && jsRed) {
    problem(`UNDECLARED DIVERGENCE ${d.id}: the JavaScript client diverges on ` +
      `${d.divergentCases.join(', ')}, but goesRed does not list javascript.`)
  }
  d.settled = d.goesRed.length === 0
}
// Python and java are not observable from here: this generator imports the
// JavaScript package entry point and nothing else. Rather than let that gap
// read as "no other client diverges", every decision carries the scope of the
// claim, and run-all.sh is the thing that closes it.
for (const d of DECISIONS) {
  d.observedBy = {
    javascript: 'this generator, by running the client',
    python: 'conformance/run-all.sh, from runners/results/python.jsonl.verdicts',
    java: 'conformance/run-all.sh, from runners/results/java.jsonl.verdicts',
  }
  if (d.settled) {
    d.note = 'Settled: no client diverges from this pin today. The cases stay, so a regression in ' +
      'any of the three clients turns this decision red again instead of passing unnoticed.'
  }
}

// 5. README drift. The README quotes counts; a quoted count that has stopped
//    being true is a documentation bug that reads exactly like a fact.
const README_PATH = join(HERE, 'README.md')
const manifestRejectCases = ALL_CASES.filter((c) => 'reject' in c.expect).length
if (existsSync(README_PATH)) {
  const readme = readFileSync(README_PATH, 'utf8')
  // Claims are matched against a whitespace-collapsed copy: a claim is a
  // sentence, not a line. Reflowing a paragraph used to break the check that
  // the paragraph was still true, which made an honest edit look like a
  // failure and a reflow look like a fix. The per-group coverage rows below
  // are matched against the raw text, because a table row IS a line.
  const readmeFlat = readme.replace(/\s+/g, ' ')
  const claims = [
    [`${ALL_CASES.length} cases`, 'total case count'],
    [`${GROUPS.length} groups`, 'group count'],
    [`${CAPS.size} capabilities`, 'capability count'],
    [`${GOLDEN_CHECKS.length} already-published constants`, 'golden count'],
    [`${manifestRejectCases} of the ${ALL_CASES.length} cases expect a refusal`, 'refusal case count'],
    [`${DECISIONS.length} normative decisions`, 'decision count'],
    [`${DIVERGENCES.length} cases currently disagree`, 'divergence count'],
    [`${ALL_CASES.filter((c) => !CAPS.get(c.capability).impl.js).length} cases sit on capabilities the JavaScript client does not implement`,
      'unimplemented-capability case count'],
    [`${[...CAPS.values()].filter((c) => !c.impl.js && !c.impl.python && !c.impl.java).length} capabilities are implemented by no client`, 'nobody-implements-it capability count'],
    [`${[...CAPS.values()].filter((c) => !c.impl.js).length} capabilities the JavaScript client does not implement`, 'js-unimplemented capability count'],
    [`${DECISIONS.filter((d) => d.settled).length} settled decisions`, 'settled-decision count'],
  ]
  for (const [needle, what] of claims) {
    if (!readmeFlat.includes(needle)) problem(`README drift: it does not state the current ${what} ("${needle}")`)
  }
  for (const g of GROUPS) {
    const line = readme.split('\n').find((l) => l.includes(`\`${g.group}\``) && l.startsWith('|'))
    if (!line) { problem(`README drift: no coverage row for group ${g.group}`); continue }
    if (!line.includes(`| ${g.cases.length} |`)) {
      problem(`README drift: the coverage row for ${g.group} does not say ${g.cases.length}`)
    }
  }
}

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ---------------------------------------------------------------------------
// Reject classification: where it is normative, and where it cannot be.
//
// The finding this answers: each runner compared its own message->class map
// against the manifest's single `rejectMap`, found drift, PRINTED it, and
// exited 0. A drift report nobody's exit code depends on is a comment.
//
// The reason the drift existed at all is that the manifest's `rejectMap` was
// the JAVASCRIPT client's map, published under a name that reads as though it
// were every client's. It cannot be every client's: Python and JavaScript match
// on a substring of their own error message, Java matches on exception type
// plus message, and the three clients do not speak the same sentences. Python
// legitimately carries eight rules JavaScript has no use for, because Python
// refuses three things JavaScript does not (D7, D8, D9).
//
// So the normativity is split, and both halves are enforced:
//
//   NORMATIVE, cross-client:  the reject CLASS vocabulary, and the class each
//   case expects. Every runner is already measured against `expect.reject.class`
//   case by case, and a wrong class is a failed case in any language.
//
//   PER CLIENT, and now published as such: the message->class map. The manifest
//   carries one map per language, harvested from that runner's own source, so
//   there is exactly one place each rule is written down. Each runner compares
//   its table against its OWN entry and exits 2 on any difference — the drift
//   that used to be a printed note is now a refusal to produce a result.
//
// Harvesting from source (rather than restating the rules here) is deliberate:
// a copy would be a second place to edit, and a second place to forget.
const RUNNER_SOURCES = {
  javascript: join(HERE, 'runners', 'run.mjs'),
  python: join(HERE, 'runners', 'run.py'),
  java: join(HERE, 'runners', 'java', 'Runner.java'),
}
function harvestRejectRules(lang) {
  const file = RUNNER_SOURCES[lang]
  if (!existsSync(file)) { fail(`runner source missing for ${lang}: ${file}`); return [] }
  const src = readFileSync(file, 'utf8')
  const rules = []
  if (lang === 'java') {
    const body = src.slice(src.indexOf('static final List<RejectRule> REJECT_MAP'))
    const re = /new RejectRule\(\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)",\s*\n?\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\s*\)/g
    for (const m of body.matchAll(re)) {
      rules.push({ group: m[1], type: m[2], contains: m[3], class: m[4] })
    }
  } else {
    const marker = lang === 'python' ? '\nREJECT_MAP = [' : '\nconst REJECT_MAP = ['
    const from = src.indexOf(marker)
    if (from < 0) { fail(`${lang} runner has no REJECT_MAP literal`); return [] }
    const body = src.slice(from, src.indexOf('\n]', from))
    const re = /["']?group["']?:\s*"((?:[^"\\]|\\.)*)"\s*,\s*["']?match["']?:\s*"((?:[^"\\]|\\.)*)"\s*,\s*["']?class["']?:\s*"((?:[^"\\]|\\.)*)"/g
    for (const m of body.matchAll(re)) rules.push({ group: m[1], match: m[2], class: m[3] })
  }
  // An empty or near-empty harvest means the regex stopped matching a source
  // that has since been reformatted. That must stop the run: a silently empty
  // map would make every runner's drift check trivially pass.
  if (rules.length < 20) {
    fail(`reject-map harvest for ${lang} found only ${rules.length} rules in ${file}. ` +
      'The literal moved or was reformatted; fix harvestRejectRules rather than shipping an empty map.')
  }
  for (const r of rules) {
    if (!REJECT_CLASSES.includes(r.class)) {
      problem(`${lang} reject rule [${r.group}] classes as "${r.class}", which is not in rejectClasses`)
    }
  }
  return rules
}
const REJECT_MAPS = {
  javascript: { matchOn: 'error message substring', rules: harvestRejectRules('javascript') },
  python: { matchOn: 'error message substring', rules: harvestRejectRules('python') },
  java: { matchOn: 'exception type, then message substring', rules: harvestRejectRules('java') },
}
for (const [lang, m] of Object.entries(REJECT_MAPS)) {
  m.source = relative(REPO, RUNNER_SOURCES[lang])
  m.normative = false
  const seen = new Set()
  for (const r of m.rules) {
    const k = JSON.stringify(r)
    if (seen.has(k)) problem(`${lang} reject map has a duplicate rule: ${k}`)
    seen.add(k)
  }
}
// The JavaScript map is the one this generator itself classifies with, so it
// must be the same table the JavaScript runner uses. If those two drift, every
// generated `reject.class` in this file was produced by a rule set no runner
// has.
{
  const key = (r) => `${r.group} | ${r.match} | ${r.class}`
  const mine = REJECT_MAP.map(key).sort()
  const theirs = REJECT_MAPS.javascript.rules.map(key).sort()
  const only = (a, b) => a.filter((k) => !b.includes(k))
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
    problem('REJECT MAP DRIFT — generate.mjs and runners/run.mjs classify JavaScript refusals differently.\n' +
      only(mine, theirs).map((k) => `    only in generate.mjs: ${k}`).join('\n') +
      (only(mine, theirs).length && only(theirs, mine).length ? '\n' : '') +
      only(theirs, mine).map((k) => `    only in run.mjs:      ${k}`).join('\n'))
  }
}

const manifest = {
  manifestVersion: MANIFEST_VERSION,
  spec: SPEC_VERSION,
  // Every number in the premise is COMPUTED. It used to be prose, and the prose
  // said the JavaScript client "does not implement nine capabilities" for a
  // release after that stopped being true, and counted twelve decisions when
  // there were thirteen. A premise that cannot go stale is worth more than one
  // that reads well.
  premise: (() => {
    const unsettled = DECISIONS.filter((d) => !d.settled)
    const jsRed = unsettled.filter((d) => (d.goesRed ?? []).includes('javascript'))
    const settled = DECISIONS.filter((d) => d.settled)
    const jsUnimplemented = [...CAPS.values()].filter((c) => !c.impl.js)
    return [
      'A client conforms at profile P if, driven exactly as a third-party consumer would drive it, it',
      'passes every case in P with no unsupported result and no error. This suite is expected to ship RED,',
      `and it does: the JavaScript client violates ${jsRed.length} of the ${DECISIONS.length} normative decisions below`,
      `(${jsRed.map((d) => d.id).join(', ')}) over ${DIVERGENCES.length} cases, and does not implement`,
      `${jsUnimplemented.length} of the ${CAPS.size} capabilities${jsUnimplemented.length ? ` (${jsUnimplemented.map((c) => c.id).join(', ')})` : ''}.`,
      'A suite that goes green on day one has been written to match the code instead of to match the ledger.',
      `The other ${settled.length} decisions are SETTLED - every client obeys them now - and they keep their`,
      'cases so a regression turns them red again rather than passing unnoticed.',
    ].join(' ')
  })(),
  generator: {
    script: 'conformance/generate.mjs',
    rule: 'Expectations are GENERATED by running the client through its package entry point. The published goldens are ASSERTED and the generator fails on drift. The normative pins are hand-written and the generator records where the client disagrees.',
    liveAnchorCrossCheck,
  },
  sdk: {
    package: pkg.name,
    version: pkg.version,
    // Per client, because they are not the same number. Published so a reader
    // of the manifest sees the skew instead of inferring one version from the
    // JavaScript package's.
    clientVersions: CLIENT_VERSIONS,
    entry: entryRel,
    resolvedThrough: 'js/package.json exports["."].import',
  },
  profiles: PROFILES,
  rejectClasses: REJECT_CLASSES,
  rejectClassification: {
    normative: 'the reject class, per case, in `expect.reject.class`',
    perLanguage: 'the message-to-class map, in `rejectMaps`; the three clients do not share error text',
    enforcedBy: 'each runner compares its own table against rejectMaps.<its language> at startup and exits 2 on any difference',
    note: '`rejectMap` below is `rejectMaps.javascript.rules` with exercise counts, kept under its old name for readers of the previous manifest. It is the JavaScript client\'s map and nothing else.',
  },
  rejectMaps: REJECT_MAPS,
  rejectMap: REJECT_MAP.map((r) => ({ group: r.group, match: r.match, class: r.class, language: 'javascript', exercisedBy: String(r.used) })),
  capabilities: [...CAPS.values()].map((c) => ({
    id: c.id,
    profile: c.profile,
    returns: c.returns,
    rejectGroup: c.rejectGroup,
    argTypes: c.argTypes ?? [],
    schema: c.schema ?? null,
    impl: c.impl,
    implementedByAnyClient: Boolean(c.impl.js || c.impl.python || c.impl.java),
    implementedBy: ['js', 'python', 'java'].filter((l) => c.impl[l]),
    cases: String(c.cases),
    ...(c.note ? { note: c.note } : {}),
    ...(c.run ? {} : { expectationSource: 'reference built from shipped primitives only; see generate.mjs' }),
  })),
  damlVectors: {
    file: 'test-package/daml/Test/GameSdk/VectorsTest.daml',
    rule: 'Where this file carries a literal for a case, THAT literal is the expectation and the JavaScript client is measured against it. On disagreement generate.mjs exits non-zero and writes nothing. Daml is normative because the ledger recomputes these values in GameStake_Settle and rejects a mismatch.',
    literals: String(VECTORS.size),
    anchoredCases: String(DAML_ANCHORED.length),
    inputPins: [...VECTORS.keys()].filter((k) => k.startsWith('input.')),
    capabilitiesWithNoAnchoredCase: UNANCHORED_CAPS,
  },
  goldens: GOLDEN_CHECKS.map((g) => ({ caseId: g.caseId, golden: g.golden, agrees: g.agrees, provenance: g.provenance ?? null })),
  decisions: DECISIONS,
  divergenceCoverage: {
    observedLanguages: ['javascript'],
    reason: 'this generator imports the JavaScript package entry point and runs that client. It cannot import the Python or the Java client, so every entry in `divergences` is a JavaScript observation and the array is silent about the other two — not evidence that they agree.',
    otherLanguagesAdjudicatedBy: 'conformance/run-all.sh, which runs all three runners and judges the per-case verdict triple against a frozen baseline, and which fails when a decision\'s goesRed does not match the red observed in python or java',
    scopeCheckedBy: 'generate.mjs asserts, for javascript only, that goesRed and the recorded divergences agree in both directions',
  },
  divergences: DIVERGENCES,
  fixtures: [
    { path: 'test-vectors/cycle-rows.json', sha256: sha256File(join(REPO, 'test-vectors', 'cycle-rows.json')),
      use: 'three rows, their leaves and their root are lifted into the manifest verbatim; the file itself is not needed to run the suite' },
    { path: 'test-vectors/cycle-trees.json', sha256: sha256File(join(REPO, 'test-vectors', 'cycle-trees.json')),
      use: 'the six real TestNet transactions are embedded verbatim in the audit-tree group; the file itself is not needed to run the suite' },
  ],
  exclusions: [
    { excluded: 'Ledger submission and gRPC', reason: 'no deterministic input; the wire format is the Ledger API contract, not the SDK one', mitigation: 'the builder group pins the JSON payload, which is the part the SDK decides' },
    { excluded: 'Entropy: newCycleId, newTradeId, generateTenantKey', reason: 'nondeterministic by design, no pinnable output', mitigation: 'none in this manifest; the shapes they produce are pinned as ordinary cases (cycleid-uuid-shaped, tenant-id-from-key)' },
    { excluded: 'verifyTenantKey constant-time behaviour', reason: 'a timing property; a value-equality harness cannot observe it and a synthetic timing assertion would be flaky and defeatable', mitigation: 'none. Its value behaviour is covered by the three verify-tenant-key cases; only the timing guarantee is unchecked.' },
    { excluded: 'Exception types and message text', reason: 'three languages, two with Turkish messages; forcing agreement is translation work with no auditor value', mitigation: 'reject classes are normative and the raw error text must be recorded by a runner on every case' },
    { excluded: 'JS toMicros over Date and epoch-millis numbers', reason: 'host-timezone dependent and millisecond-precision by construction', mitigation: 'isoToMicros is in scope and strict, and iso-micros-preserved-in-document pins a microsecond timestamp through to document bytes' },
    { excluded: 'Language-idiomatic input types (Decimal vs string vs BigDecimal)', reason: 'insisting on one type across three languages would be a port, not a conformance suite', mitigation: 'types are excluded, values are not: every number is an exact string and the float cases assert refusal' },
    { excluded: 'Package and DAR reproducibility', reason: 'a fact about one build artifact, not a behaviour three clients share; it would make every runner depend on a Daml SDK', mitigation: 'tools/check_package_id.py stays as its own CI job' },
    { excluded: 'Performance, memory, thread-safety', reason: 'not part of the byte-for-byte contract; timing assertions would make the suite flaky', mitigation: 'none needed; no case records a timing' },
    { excluded: 'reportUri fetching', reason: 'network I/O', mitigation: 'reportDigest is inside the anchor document and is covered by the period-anchor group' },
  ],
  retiredIds: [],
  summary: {
    totalCases: String(ALL_CASES.length),
    byGroup: Object.fromEntries(GROUPS.map((g) => [g.group, String(g.cases.length)])),
    // Keyed by the DECLARED profile list and counted by GROUP profile — the
    // same rule the runners select by, so `--profiles p` returns exactly the
    // number printed here. Checked by 2b/2c above, and again by every runner
    // against this published table at startup.
    byProfile: Object.fromEntries(DECLARED_PROFILES.map((p) => [p, String(CASES_PER_PROFILE.get(p))])),
    bySource: Object.fromEntries([...new Set(ALL_CASES.map((c) => c.source))].sort()
      .map((s) => [s, String(ALL_CASES.filter((c) => c.source === s).length)])),
    rejectCases: String(ALL_CASES.filter((c) => 'reject' in c.expect).length),
    // Cases on a capability the JAVASCRIPT client does not implement. This
    // used to be reported as "no client implements", which was never what it
    // counted and is now flatly false: every capability has an implementation
    // in Python and in Java.
    casesWithNoJavaScriptImpl: String(ALL_CASES.filter((c) => !CAPS.get(c.capability).run).length),
    casesImplementedByNoClient: String(ALL_CASES.filter((c) => {
      const im = CAPS.get(c.capability).impl
      return !im.js && !im.python && !im.java
    }).length),
    divergentCases: String(DIVERGENCES.length),
  },
  groups: GROUPS.map((g) => ({ group: g.group, profile: g.profile, note: g.note, cases: g.cases })),
}

// ---------------------------------------------------------------------------
// THE PACKAGE-REFERENCE CHECK.
//
// Walk the finished manifest and collect every string that sits in package-id
// position — a `templateId` shaped `<ref>:<Module>:<Entity>`, or the value of
// any `*packageId` key. Each one must be either the package-NAME reference or
// an id recorded in test-vectors/package-ids.json.
//
// This is the check that would have caught what it replaces. A fabricated id
// (`c6e1b2c9…`, on no participant) and a stale one (`344ce4ef…`, five releases
// behind the shipped client) both let a client go green on the builder profile
// while emitting a payload the ledger answers with NOT_FOUND. Membership in a
// file that CI already checks against a rebuilt DAR (tools/check_package_id.py)
// is a claim that can fail; a literal typed here is not.
// ---------------------------------------------------------------------------

// A templateId is `<packageRef>:<Module.Path>:<Entity>`. Module and entity
// segments are Daml identifiers and so begin with a capital, which is what
// keeps ISO timestamps and canonical-encoding strings (`t:3:abc`) out; the
// package ref itself is left wide open on purpose, so that a placeholder like
// `sdkpkg` is caught rather than quietly skipped for not looking like an id.
const TEMPLATE_ID_RE = /^([#A-Za-z0-9._-]+):([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*):([A-Z][A-Za-z0-9_]*)$/
const PACKAGE_ID_KEY_RE = /^(?:packageId|[A-Za-z0-9]*PackageId)$/

const packageRefSites = []
;(function collectPackageRefs(node, path) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectPackageRefs(v, `${path}[${i}]`))
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && PACKAGE_ID_KEY_RE.test(k)) {
        packageRefSites.push({ path: `${path}.${k}`, ref: v, how: `${k} = ${JSON.stringify(v)}` })
      }
      collectPackageRefs(v, `${path}.${k}`)
    }
  } else if (typeof node === 'string') {
    const m = TEMPLATE_ID_RE.exec(node)
    if (m) packageRefSites.push({ path, ref: m[1], how: `templateId ${node}` })
  }
})(manifest, '$')

const packageRefCounts = new Map()
for (const site of packageRefSites) {
  packageRefCounts.set(site.ref, (packageRefCounts.get(site.ref) ?? 0) + 1)
}
const unknownPackageRefs = [...packageRefCounts.keys()]
  .filter((ref) => ref !== SDK_PACKAGE_REF && !KNOWN_PACKAGE_IDS.has(ref))
  .sort()

if (unknownPackageRefs.length) {
  const lines = unknownPackageRefs.map((ref) => {
    const site = packageRefSites.find((x) => x.ref === ref)
    const why = HEX64.test(ref)
      ? 'not in test-vectors/package-ids.json — a package id no participant is known to hold'
      : `not the package-name reference ${SDK_PACKAGE_REF}`
    return `${ref}  (${packageRefCounts.get(ref)}x, e.g. ${site.path} — ${site.how})\n        ${why}`
  })
  problem('UNPINNED PACKAGE REFERENCE — the manifest names package(s) this repository cannot vouch for.\n' +
    `    ${lines.join('\n    ')}\n` +
    '    Every package id in the manifest must be either the package-NAME reference\n' +
    `    ${SDK_PACKAGE_REF} (which the ledger resolves to the highest vetted version) or an id\n` +
    '    recorded in test-vectors/package-ids.json with its provenance. A case that pins a\n' +
    '    package the ledger would reject with NOT_FOUND is green here and broken there.')
}

// Optional, and stronger when it runs: ask a participant whether the ids we
// pinned are actually vetted on it. Absent, the membership check above still
// stands on its own; present and disagreeing, the run stops. Read-only.
const PARTICIPANT_URL = process.env.CONFORMANCE_PARTICIPANT_URL ?? ''
let participantCrossCheck = PARTICIPANT_URL
  ? 'not reached'
  : 'not attempted (set CONFORMANCE_PARTICIPANT_URL to a JSON Ledger API base URL)'
if (PARTICIPANT_URL) {
  const pinned = [...packageRefCounts.keys()].filter((r) => HEX64.test(r))
  try {
    const res = await fetch(`${PARTICIPANT_URL.replace(/\/$/, '')}/v2/packages`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const onParticipant = new Set((await res.json()).packageIds ?? [])
    const missing = pinned.filter((id) => !onParticipant.has(id))
    if (missing.length) {
      problem('PARTICIPANT CROSS-CHECK FAILED — the manifest names package(s) this participant does not hold:\n' +
        missing.map((id) => `      ${id}  (${KNOWN_PACKAGE_IDS.get(id) ?? 'unrecorded'})`).join('\n') +
        `\n    Queried ${PARTICIPANT_URL}/v2/packages, ${onParticipant.size} packages vetted.`)
      participantCrossCheck = 'MISMATCH'
    } else {
      participantCrossCheck = `all ${pinned.length} pinned ids vetted on ${PARTICIPANT_URL} (${onParticipant.size} packages)`
    }
  } catch (e) {
    // Not reaching a participant is not evidence of anything, so it is not a
    // failure; claiming it was checked when it was not would be.
    participantCrossCheck = `not reached (${e.message})`
  }
}

manifest.packageReferences = {
  note: 'Every package id the manifest names, and what it is. A case whose templateId names a ' +
    'package the ledger does not hold is green in this suite and NOT_FOUND on submission, so the ' +
    'generator refuses to write a manifest containing a reference it cannot account for.',
  packageNameReference: SDK_PACKAGE_REF,
  packageNameReferenceResolvesTo: 'the highest vetted version of arccade-game-sdk, chosen by the ledger at submission time',
  source: 'test-vectors/package-ids.json',
  sourceSha256: sha256File(PACKAGE_IDS_PATH),
  // The participant cross-check result is deliberately NOT recorded here. CI
  // runs `generate.mjs --check`, which compares manifest bytes, so anything in
  // this file that varies with the machine turns that check into a false alarm.
  // The cross-check is reported on stdout and fails the run when it disagrees.
  participantCrossCheckedBy: 'generate.mjs, when CONFORMANCE_PARTICIPANT_URL is set: every id below must be in GET /v2/packages',
  referenced: [...packageRefCounts.entries()].sort((a, b) => b[1] - a[1]).map(([ref, count]) => ({
    ref,
    is: ref === SDK_PACKAGE_REF ? 'package-name reference' : (KNOWN_PACKAGE_IDS.get(ref) ?? 'UNKNOWN'),
    sites: String(count),
  })),
}

if (errors.length) {
  console.error('generate.mjs refused to write manifest.json:\n')
  for (const e of errors) console.error(`  - ${e}`)
  console.error(`\n${errors.length} problem(s). Nothing was written.`)
  process.exit(2)
}

const out = JSON.stringify(manifest, null, 2) + '\n'
const checkOnly = process.argv.includes('--check')
if (checkOnly) {
  if (!existsSync(MANIFEST_PATH)) fail('--check: manifest.json does not exist')
  const have = readFileSync(MANIFEST_PATH, 'utf8')
  if (have !== out) {
    console.error('--check: manifest.json is not what generate.mjs produces from the current client.')
    console.error(`  on disk: ${have.length} bytes, sha256 ${createHash('sha256').update(have).digest('hex')}`)
    console.error(`  fresh:   ${out.length} bytes, sha256 ${createHash('sha256').update(out).digest('hex')}`)
    process.exit(1)
  }
  console.log(`manifest.json is up to date (${ALL_CASES.length} cases).`)
  process.exit(0)
}
writeFileSync(MANIFEST_PATH, out)

console.log(`wrote ${MANIFEST_PATH}`)
console.log(`  ${ALL_CASES.length} cases in ${GROUPS.length} groups over ${CAPS.size} capabilities`)
console.log(`  ${manifest.summary.rejectCases} reject cases, ${manifest.summary.casesWithNoJavaScriptImpl} on capabilities the JavaScript client does not implement, ${manifest.summary.casesImplementedByNoClient} on capabilities no client implements`)
console.log(`  ${DAML_ANCHORED.length} cases anchored to a Daml literal harvested from VectorsTest.daml (${VECTORS.size} literals)`)
console.log(`  ${GOLDEN_CHECKS.length} published goldens re-derived and asserted, all agreeing`)
console.log(`  ${DIVERGENCES.length} recorded divergences between the JavaScript client and the normative pins`)
console.log(`  live anchor cross-check: ${liveAnchorCrossCheck}`)
console.log(`  package references: ${manifest.packageReferences.referenced.length} distinct over ${packageRefSites.length} sites; participant cross-check: ${participantCrossCheck}`)
console.log('\ncases per group:')
for (const g of GROUPS) console.log(`  ${g.group.padEnd(24)} ${String(g.cases.length).padStart(4)}  (${g.profile})`)
console.log('\ncases per profile (the set `--profiles <p>` selects in every runner):')
for (const p of DECLARED_PROFILES) console.log(`  ${p.padEnd(24)} ${String(CASES_PER_PROFILE.get(p)).padStart(4)}`)
console.log('\nexpectation sources:')
for (const [k, n] of Object.entries(manifest.summary.bySource)) console.log(`  ${k.padEnd(32)} ${String(n).padStart(4)}`)
console.log(`\ncapabilities with no Daml-anchored case (${UNANCHORED_CAPS.length}):`)
for (const id of UNANCHORED_CAPS) console.log(`  ${id}`)
console.log('\ndivergences:')
for (const d of DIVERGENCES) console.log(`  ${d.decision.padEnd(16)} ${d.caseId}`)
