/**
 * The period anchor.
 *
 * The fixture is the one the Python and Java clients assert against —
 * `test-vectors/cycle-rows.json`, rebuilt from real arCCade TestNet
 * transactions. Driving the anchor from that file rather than from numbers
 * typed here is what makes "any language reproduces the same anchor" a fact
 * instead of a claim: if this client's totals or document ever drift, they
 * drift away from the same bytes the other two are pinned to.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ANCHOR_FIELDS, ANCHOR_TOTAL_FIELDS, anchorDigest, anchorDocument, anchorTotals,
  merkleEmpty, merkleRoot, periodLeaf, textDigest,
} from '../src/index.js'

const golden = JSON.parse(readFileSync(new URL('../../test-vectors/cycle-rows.json', import.meta.url)))

// The live TestNet period. Its declared fields are what the venue published;
// the proven ones are recomputed below from the rows.
const REPORT_DIGEST = 'b4fda252f5064e39a0ed7a6e2914794545a3523b965e631eb94920f38be973fb'
const PREV = 'caa2d6f54dc9d0be9d165e505757cc760a421c13c75a21a6ac69e194e0470fc6'

const emptyPeriodAnchor = {
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
  merkleRootHex: merkleEmpty(),
  reportDigest: REPORT_DIGEST,
  prevAnchorDigest: PREV,
}

test('the empty period anchor reproduces the pinned document and digest', () => {
  assert.equal(
    anchorDocument(emptyPeriodAnchor),
    'arccade-sdk-digest-v1|t:21:arccade.period-anchori:1:1r:632:'
    + 'k:14:committedUnits=i:1:0;k:10:cycleCount=i:1:0;k:8:feeUnits=i:1:0;'
    + 'k:14:forfeitedUnits=i:1:0;'
    + 'k:13:merkleRootHex=t:64:c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0;'
    + 'k:20:nonQualifyingTxCount=i:1:1;k:11:payoutUnits=i:1:0;'
    + 'k:15:periodEndMicros=i:16:1787875200000000;k:8:periodId=t:10:2026-08-27;'
    + 'k:17:periodStartMicros=i:16:1787788800000000;'
    + 'k:16:prevAnchorDigest=t:64:caa2d6f54dc9d0be9d165e505757cc760a421c13c75a21a6ac69e194e0470fc6;'
    + 'k:17:qualifyingTxCount=i:1:0;'
    + 'k:12:reportDigest=t:64:b4fda252f5064e39a0ed7a6e2914794545a3523b965e631eb94920f38be973fb;'
    + 'k:13:returnedUnits=i:1:0;k:7:venueId=t:26:tradewars/testnet-arena-v2;',
  )
  assert.equal(
    anchorDigest(emptyPeriodAnchor),
    'f3e0805b9c3b9b9147f8b7b866ddd34d157d5d1e1e60b5942e14335909a6bd2a',
  )
})

test('the digest is the plain sha256 of the document a third party downloads', () => {
  // The whole claim rests on this: `sha256sum` over the published text, no
  // library involved.
  assert.equal(anchorDigest(emptyPeriodAnchor), textDigest(anchorDocument(emptyPeriodAnchor)))
})

test('an empty period anchors the merkle-empty root, not an absent one', () => {
  assert.equal(merkleEmpty(), 'c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0')
  assert.equal(merkleRoot([]), merkleEmpty())
})

test('the next link carries the previous digest, and changes the bytes', () => {
  const next = { ...emptyPeriodAnchor, periodId: '2026-08-28', prevAnchorDigest: anchorDigest(emptyPeriodAnchor) }
  assert.equal(anchorDigest(next), '866678007b520f83714954776ffe5725bc9ebb6fd36ea99e4b704b70decdf0e5')
  assert.notEqual(anchorDigest(next), anchorDigest(emptyPeriodAnchor))
})

test('the start of a chain is empty text, not an absent field', () => {
  // An anchor with no predecessor and an anchor whose predecessor was
  // forgotten must not hash to the same document.
  const first = { ...emptyPeriodAnchor, periodId: '2026-08-01', prevAnchorDigest: '' }
  assert.equal(anchorDigest(first), 'f15bcb0678a266dbd359f9254f71732b3296f282cae0ef93fe787681681c382a')
  assert.throws(() => anchorDigest({ ...first, prevAnchorDigest: undefined }), /field is missing/)
})

test('totals are summed from the golden rows, and match the anchor Daml wrote', () => {
  const totals = anchorTotals(golden.rows)
  assert.deepEqual(totals, {
    cycleCount: 3n,
    committedUnits: 1600000000000n,
    feeUnits: 5200000000n,
    returnedUnits: 1600000000000n,
    forfeitedUnits: 0n,
    payoutUnits: 0n,
  })
  assert.deepEqual(Object.keys(totals), [...ANCHOR_TOTAL_FIELDS])

  const anchor = {
    ...emptyPeriodAnchor,
    periodId: '2026-08-26',
    ...totals,
    qualifyingTxCount: 6n,
    nonQualifyingTxCount: 1n,
    merkleRootHex: merkleRoot(golden.rows.map(periodLeaf)),
  }
  assert.equal(anchor.merkleRootHex, golden.merkleRoot)
  assert.equal(anchorDigest(anchor), '10cccbfce134a319e4cdcfd51000e5b6502a7e077ddc89d1501d4be1b7e4b436')
})

test('an empty period has zero totals rather than no totals', () => {
  // A client that returns nothing here cannot fill the anchor document at all,
  // and the empty period is the one the live anchor covers.
  assert.deepEqual(anchorTotals([]), {
    cycleCount: 0n,
    committedUnits: 0n,
    feeUnits: 0n,
    returnedUnits: 0n,
    forfeitedUnits: 0n,
    payoutUnits: 0n,
  })
})

test('a repeated cycleId in one period is refused', () => {
  // cycleId has no contract key on the ledger, so nothing stops the same id
  // appearing twice; counted twice it inflates the totals while every
  // individual Merkle proof still verifies.
  const dup = [golden.rows[0], golden.rows[0]]
  assert.throws(() => anchorTotals(dup), /duplicate cycleId in a period/)
})

test('a non-integer unit is refused rather than coerced', () => {
  const bad = [{ ...golden.rows[0], committedUnits: true }]
  assert.throws(() => anchorTotals(bad), /Cannot convert/)
})

test('the anchor commits exactly the fields Daml commits', () => {
  // Field-set drift is the failure that produces a document which hashes
  // cleanly and matches nothing on the ledger.
  const doc = anchorDocument(emptyPeriodAnchor)
  for (const f of ANCHOR_FIELDS) assert.ok(doc.includes(`k:${f.length}:${f}=`), f)
  assert.equal((doc.match(/k:\d+:[a-zA-Z-]+=/g) ?? []).length, ANCHOR_FIELDS.length)
})
