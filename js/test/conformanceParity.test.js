/**
 * The nine capabilities this client was once missing, driven from the
 * conformance manifest itself.
 *
 * WHY THIS FILE EXISTS. It was written while `conformance/runners/run.mjs` had
 * no DISPATCH entry for these nine, so the runner reported all 40 of their
 * cases `unsupported` no matter what `js/src/index.js` exported, and the
 * catalog agreed with it: `impl.js` was null for each. The runner could not
 * then be the evidence that the gap was closed, and this was.
 *
 * BOTH OF THOSE FACTS HAVE SINCE CHANGED. `run.mjs` dispatches all nine, the
 * catalog names the export for each, and all 40 cases pass in the runner. This
 * file was arranged so that the runner's arrival would make it redundant
 * rather than wrong, and that is what happened — so it stays, as a second
 * measurement taken through a different path: `npm test` alone, with no
 * conformance runner involved, still drives the 40 cases against the published
 * entry point and the manifest's expected bytes.
 *
 * Arguments are decoded the way run.mjs decodes them, and rejections are
 * classified with the manifest's OWN published rules for this language rather
 * than a table copied here, so a rule that changes there changes the verdict
 * here. The `impl.js` claim itself is asserted below, so a catalog that
 * reverts to null turns this file red instead of quietly agreeing with it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as sdk from '../src/index.js'

const MANIFEST = JSON.parse(
  readFileSync(new URL('../../conformance/manifest.json', import.meta.url)),
)

/** The capabilities Python and Java carried and this client did not. */
const CAPABILITIES = [
  'audit.anchorDocument', 'audit.anchorTotals',
  'policy.policyDocument', 'policy.validPolicy',
  'settlement.assertSettlementValid',
  'time.epochSeconds', 'time.secondsBetween', 'time.addSeconds', 'time.intDivide',
]

const EXPECTED_CASE_COUNT = 40

// --------------------------------------------------------------------------
// Argument decoding — the same tagged-value domain run.mjs reads.
// --------------------------------------------------------------------------

function decode(a) {
  if (a === null || typeof a !== 'object' || typeof a.t !== 'string') {
    throw new Error(`argument is not a tagged value: ${JSON.stringify(a)}`)
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
    default: throw new Error(`unknown ArgValue tag "${a.t}"`)
  }
}

// --------------------------------------------------------------------------
// Dispatch: capability id -> the published API call.
// --------------------------------------------------------------------------

const asDoc = (text) => ({ text, digest: sdk.textDigest(text) })

const DISPATCH = {
  'audit.anchorDocument': ([a]) => asDoc(sdk.anchorDocument(a)),
  'audit.anchorTotals': ([rows]) => Object.entries(sdk.anchorTotals(rows)),
  'policy.policyDocument': ([p]) => asDoc(sdk.policyDocument(p)),
  'policy.validPolicy': ([p]) => sdk.validPolicy(p),
  'settlement.assertSettlementValid': ([s]) => sdk.assertSettlementValid(s),
  'time.epochSeconds': ([m]) => sdk.epochSeconds(m),
  'time.secondsBetween': ([a, b]) => sdk.secondsBetween(a, b),
  'time.addSeconds': ([m, s]) => sdk.addSeconds(m, s),
  'time.intDivide': ([a, b]) => sdk.intDivide(a, b),
}

// --------------------------------------------------------------------------
// Rejection classes, read from the manifest's published JavaScript rules.
// --------------------------------------------------------------------------

const REJECT_RULES = MANIFEST.rejectMaps?.javascript?.rules

function classify(group, message) {
  for (const r of REJECT_RULES) {
    if (r.group === group && String(message).includes(r.match)) return r.class
  }
  return null
}

// --------------------------------------------------------------------------

const CAPS = new Map(MANIFEST.capabilities.map((c) => [c.id, c]))
const CASES = MANIFEST.groups
  .flatMap((g) => g.cases)
  .filter((c) => CAPABILITIES.includes(c.capability))

test('the manifest still states the gap this file closes', () => {
  assert.ok(Array.isArray(REJECT_RULES) && REJECT_RULES.length > 0,
    'manifest has no rejectMaps.javascript.rules to classify against')
  assert.equal(CASES.length, EXPECTED_CASE_COUNT,
    'the case count moved; this file is measuring a different gap than the one it claims')
  for (const id of CAPABILITIES) {
    assert.ok(CAPS.has(id), `capability ${id} is not in the catalog`)
    assert.ok(DISPATCH[id], `no dispatch for ${id}`)
  }
})

const NEW_SURFACE = [
  'ANCHOR_SCHEMA', 'ANCHOR_SCHEMA_VERSION', 'ANCHOR_FIELDS', 'ANCHOR_TOTAL_FIELDS',
  'anchorDocument', 'anchorDigest', 'anchorTotals',
  'POLICY_SCHEMA', 'POLICY_SCHEMA_VERSION', 'POLICY_FIELDS',
  'policyDocument', 'policyDigest', 'validPolicy',
  'SETTLEMENT_FIELDS', 'assertSettlementValid', 'settlementIsValid',
  'intDivide', 'epochSeconds', 'secondsBetween', 'addSeconds',
]

test('index.d.ts declares the surface these modules added', () => {
  // There is no TypeScript compiler in this repo, so the declarations cannot
  // be typechecked here; what CAN be checked is that none of the new exports
  // is missing from them, which is the drift that actually bites a consumer.
  const dts = readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  for (const name of NEW_SURFACE) {
    assert.match(dts, new RegExp(`export (function|const) ${name}\\b`), name)
  }
})

test('the catalog names a JavaScript implementation for all nine', () => {
  // The claim this file was written to contradict, now asserted in the other
  // direction. `impl.js: null` on any of the nine would mean the manifest has
  // gone back to describing a client that does not exist.
  for (const id of CAPABILITIES) {
    const cap = CAPS.get(id)
    assert.ok(cap, `capability ${id} is not in the catalog`)
    assert.equal(typeof cap.impl?.js, 'string',
      `catalog says impl.js is ${JSON.stringify(cap.impl?.js)} for ${id}, but this package exports it`)
    assert.equal(typeof sdk[cap.impl.js], 'function',
      `catalog names impl.js "${cap.impl.js}" for ${id}, which the entry point does not export`)
  }
})

test('every one of the nine capabilities is reachable from the published entry point', () => {
  // Reached through `../src/index.js`, the file package.json `exports["."]`
  // resolves to. A capability only reachable from a module the package does
  // not export is a capability a consumer does not have.
  for (const name of ['anchorDocument', 'anchorTotals', 'policyDocument', 'validPolicy',
    'assertSettlementValid', 'epochSeconds', 'secondsBetween', 'addSeconds', 'intDivide']) {
    assert.equal(typeof sdk[name], 'function', name)
  }
})

for (const c of CASES) {
  test(`conformance ${c.id}`, () => {
    const cap = CAPS.get(c.capability)
    const args = (c.input?.args ?? []).map(decode)

    if (Object.prototype.hasOwnProperty.call(c.expect, 'reject')) {
      let threw = null
      try {
        DISPATCH[c.capability](args)
      } catch (e) {
        threw = e
      }
      assert.ok(threw, `expected a rejection of class ${c.expect.reject.class}, got a value`)
      const cls = classify(cap.rejectGroup, threw.message)
      assert.ok(cls !== null,
        `unclassifiable throw in reject group "${cap.rejectGroup}": ${threw.message}`)
      assert.equal(cls, c.expect.reject.class, threw.message)
      return
    }

    const value = DISPATCH[c.capability](args)
    switch (cap.returns) {
      case 'document':
        assert.equal(value.text, c.expect.document.text.v)
        assert.equal(value.digest, c.expect.document.digest)
        // The byte pin: the document is what a third party runs sha256sum on,
        // so the manifest states its UTF-8 bytes as well as its characters.
        assert.equal(Buffer.from(value.text, 'utf8').toString('hex'), c.expect.document.text.vHex)
        break
      case 'bool':
        assert.equal(value, c.expect.bool)
        break
      case 'int':
        assert.equal(value, BigInt(c.expect.value.v))
        break
      case 'value':
        assert.equal(c.expect.value.t, 'pairs')
        assert.deepEqual(
          value.map(([k, v]) => [k, String(v)]),
          c.expect.value.v.map(([k, v]) => [k.v, v.v]),
        )
        break
      default:
        assert.fail(`unhandled "returns" kind ${cap.returns} for ${c.capability}`)
    }
  })
}
