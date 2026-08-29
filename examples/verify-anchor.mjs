#!/usr/bin/env node
/**
 * Verify a published period report against its on-ledger anchor.
 *
 * The point of the anchor is not that arCCade can show you a report. It is
 * that a third party can prove a cycle was OMITTED from one. So this script
 * takes arCCade's published bytes as a SUSPECT rather than a source: it
 * recomputes every leaf from the rows, rebuilds the root, folds an inclusion
 * proof for each row, reassembles the anchor document field by field, and
 * re-derives the period totals — then compares each of those against what the
 * ledger was made to commit to. The report's own `leaves` and `merkleRoot`
 * are checked, never trusted.
 *
 * It also does the thing an example usually skips: it tampers with a row and
 * shows the same call refusing it. A verifier that only ever runs on good
 * input has not been tested, and neither has the reader's understanding of it.
 *
 *   node examples/verify-anchor.mjs              # the live TestNet report
 *   node examples/verify-anchor.mjs --offline    # the copy in fixtures/, no network
 *   node examples/verify-anchor.mjs --ledger     # anchors from your own participant
 *
 * Options:
 *   --source <url|dir>   where index.json and the reports live
 *                        (default https://audit.arccade.io/testnet)
 *   --anchors <file>     full anchor records  (default ./fixtures/anchors.json)
 *   --ledger             read VenuePeriodAnchor from LEDGER_URL/PARTY instead
 *   --offline            --source ./fixtures, and never touch the network
 *   --period <id>        check one period only, e.g. 2026-08-26
 *
 * Environment (only for --ledger):
 *   LEDGER_URL   JSON Ledger API base   (default http://localhost:7575)
 *   PARTY        a party that can see the anchor (the venue, operator or auditor)
 *   USER_ID      ledger API user        (default participant_admin)
 *   AUTH_TOKEN   bearer token, if your participant requires one
 *
 * Exit codes:
 *   0  everything reproduced
 *   1  a verification failed — a leaf, a root, a proof, an anchor or the chain
 *   2  everything reproduced EXCEPT the served bytes, which are not the bytes
 *      the anchor commits to. Separated because it is a different kind of
 *      finding: the rows are intact and the publisher's serialisation drifted.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  canonInt,
  canonText,
  documentDigest,
  merkleEmpty,
  merkleProof,
  merkleRoot,
  periodLeaf,
  periodRowVerify,
} from '@arccade/game-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const LIVE = 'https://audit.arccade.io/testnet'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const OFFLINE = flag('--offline')
const SOURCE = value('--source', OFFLINE ? FIXTURES : LIVE)
const ANCHORS = value('--anchors', join(FIXTURES, 'anchors.json'))
const FROM_LEDGER = flag('--ledger')
const ONLY = value('--period', null)

const LEDGER = (process.env.LEDGER_URL ?? 'http://localhost:7575').replace(/\/+$/, '')
const PARTY = process.env.PARTY
const USER_ID = process.env.USER_ID ?? 'participant_admin'
const TOKEN = process.env.AUTH_TOKEN ?? ''

const failures = []
const byteFindings = []
const fail = (what) => { failures.push(what); return false }

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isUrl = (s) => /^https?:\/\//.test(s)
const step = (n, what) => console.log(`\n${n}. ${what}`)
const mark = (ok) => (ok ? 'ok  ' : 'FAIL')

/**
 * Reads one artifact and returns its EXACT BYTES.
 *
 * Not its parsed form and not a re-serialisation of it: `reportDigest` is a
 * hash of the file as served, so a verifier that parses first and hashes
 * second is checking a different object than the anchor committed to (T4).
 */
async function readBytes(base, name) {
  if (isUrl(base)) {
    if (OFFLINE) throw new Error(`--offline, but the source is a URL: ${base}`)
    const res = await fetch(`${base}/${name}`)
    if (!res.ok) throw new Error(`${base}/${name} -> ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  return readFile(join(base, name))
}

/**
 * The anchor document, assembled from primitives.
 *
 * NO SHIPPED JAVASCRIPT CLIENT EXPORTS THIS. Daml computes it inside
 * `GameVenue_AnchorPeriod`; the Python client exports `anchor_document`; the
 * JavaScript and Java ones do not. So a verifier writes the fifteen fields
 * out, in this order, in schema `arccade.period-anchor` version 1 — which is
 * also the honest test of whether the scheme is really reimplementable from
 * the published description. Values arrive from JSON as strings; `canonInt`
 * takes them through BigInt, so no decimal ever appears in the bytes.
 */
function anchorDigestOf(a) {
  return documentDigest('arccade.period-anchor', 1, [
    ['venueId', canonText(a.venueId)],
    ['periodId', canonText(a.periodId)],
    ['periodStartMicros', canonInt(a.periodStartMicros)],
    ['periodEndMicros', canonInt(a.periodEndMicros)],
    ['cycleCount', canonInt(a.cycleCount)],
    ['committedUnits', canonInt(a.committedUnits)],
    ['feeUnits', canonInt(a.feeUnits)],
    ['returnedUnits', canonInt(a.returnedUnits)],
    ['forfeitedUnits', canonInt(a.forfeitedUnits)],
    ['payoutUnits', canonInt(a.payoutUnits)],
    ['qualifyingTxCount', canonInt(a.qualifyingTxCount)],
    ['nonQualifyingTxCount', canonInt(a.nonQualifyingTxCount)],
    ['merkleRootHex', canonText(a.merkleRootHex)],
    ['reportDigest', canonText(a.reportDigest)],
    // Empty on the first period of a chain, and that emptiness is signed.
    ['prevAnchorDigest', canonText(a.prevAnchorDigest)],
  ])
}

/**
 * Period totals DERIVED FROM THE ROWS.
 *
 * A correct Merkle root says nothing whatever about the summary fields — the
 * root commits to the rows, not to the arithmetic over them. Recomputing the
 * totals is what stops a venue from publishing a verifiable root beside a
 * fabricated headline number.
 */
function totalsOf(rows) {
  const sum = (f) => rows.reduce((acc, r) => acc + BigInt(r[f]), 0n)
  return {
    cycleCount: BigInt(rows.length),
    committedUnits: sum('committedUnits'),
    feeUnits: sum('feeUnits'),
    returnedUnits: sum('returnedUnits'),
    forfeitedUnits: sum('forfeitedUnits'),
    payoutUnits: sum('payoutUnits'),
  }
}

/** Anchors from a participant's ACS — the strongest source there is. */
async function anchorsFromLedger() {
  if (!PARTY) throw new Error('--ledger needs PARTY: a party that can see the anchor.')
  const call = async (path, body) => {
    const res = await fetch(LEDGER + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path} -> ${res.status}\n${text.slice(0, 400)}`)
    return JSON.parse(text)
  }
  const { offset } = await call('/v2/state/ledger-end')
  const acs = await call('/v2/state/active-contracts', {
    filter: { filtersByParty: { [PARTY]: { cumulative: [
      { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
    ] } } },
    verbose: false,
    activeAtOffset: offset,
    userId: USER_ID,
  })
  return acs
    .map((e) => e?.contractEntry?.JsActiveContract?.createdEvent)
    .filter((c) => c && (c.templateId ?? '').includes('ArCCade.GameSdk.Audit:VenuePeriodAnchor'))
    .map((c) => ({ contractId: c.contractId, createArgument: c.createArgument }))
}

// ---------------------------------------------------------------------------

console.log(`source  ${SOURCE}${OFFLINE ? '   (offline)' : ''}`)

step(1, 'The index, and where the anchors are coming from')
const index = JSON.parse((await readBytes(SOURCE, 'index.json')).toString('utf8'))
console.log(`   ${index.count} period(s) published`)

let anchors = []
let anchorSource = 'none'
if (FROM_LEDGER) {
  anchors = await anchorsFromLedger()
  anchorSource = `${LEDGER} (ACS)`
} else if (existsSync(ANCHORS)) {
  anchors = JSON.parse(await readFile(ANCHORS, 'utf8')).anchors ?? []
  anchorSource = ANCHORS
}
console.log(`   anchors from ${anchorSource}: ${anchors.length}`)
if (anchors.length === 0) {
  // index.json carries the anchored root and digest, so the leaf, root and
  // proof checks still run — but the anchor DOCUMENT cannot be reassembled
  // from a summary, so step 6 will be skipped rather than quietly passed.
  console.log('   the anchor document check needs the contract itself; use --ledger')
}
const anchorFor = (periodId) =>
  anchors.map((a) => a.createArgument).find((a) => a.periodId === periodId) ?? null

const reports = index.reports.filter((r) => !ONLY || r.periodId === ONLY)
if (reports.length === 0) throw new Error(`no published period matches --period ${ONLY}`)

let previousAnchorDigest = null

for (const meta of reports) {
  // The step counter restarts under each period heading: every period is
  // checked the same way, and a reader comparing two of them should be
  // comparing step 4 with step 4.
  let n = 0
  console.log(`\n${'─'.repeat(72)}`)
  console.log(`${meta.venueId}  period ${meta.periodId}  (${meta.cycleCount} cycles)`)
  const anchor = anchorFor(meta.periodId)

  step(++n, 'The report, hashed as bytes')
  const bytes = await readBytes(SOURCE, meta.name)
  const served = sha256(bytes)
  const report = JSON.parse(bytes.toString('utf8'))
  console.log(`   ${meta.name}`)
  console.log(`   sha256 ${served}`)
  // Reproducible with no library at all — which is the claim being made:
  //   sha256sum tradewars_testnet-arena-v2_2026-08-27.json
  console.log(`   ${mark(served === meta.servedDigest)}  matches index.servedDigest`)
  if (served !== meta.servedDigest) fail(`${meta.periodId}: served bytes differ from index.servedDigest`)

  step(++n, 'Every leaf, recomputed from its row')
  // periodLeaf renders the row as `arccade.cycle-audit-row` v1 and hashes it.
  // Amounts are integer 1e-10 units and times are integer microseconds — the
  // report gives both as strings precisely so no JSON number ever rounds one.
  const leaves = report.rows.map(periodLeaf)
  let leavesOk = leaves.length === (report.leaves ?? []).length
  leaves.forEach((leaf, i) => { if (leaf !== report.leaves?.[i]) leavesOk = false })
  for (const [i, leaf] of leaves.entries()) {
    const same = leaf === report.leaves?.[i]
    console.log(`   ${mark(same)}  [${i}] ${report.rows[i].cycleId}  ${leaf.slice(0, 16)}…`)
  }
  if (leaves.length === 0) console.log('   (no rows — an empty period is still anchored)')
  if (!leavesOk) fail(`${meta.periodId}: recomputed leaves differ from the published ones`)

  step(++n, 'The root, rebuilt from the leaves')
  // A lone trailing node is PROMOTED unchanged rather than duplicated: the
  // Bitcoin convention (CVE-2012-2459) lets [a,b,c] and [a,b,c,c] produce one
  // root, and this tree refuses that by construction.
  const root = merkleRoot(leaves)
  console.log(`   ${root}${leaves.length === 0 ? '   (= merkleEmpty)' : ''}`)
  if (leaves.length === 0 && root !== merkleEmpty()) fail(`${meta.periodId}: empty root is wrong`)
  console.log(`   ${mark(root === report.merkleRoot)}  matches the report's merkleRoot`)
  console.log(`   ${mark(root === meta.anchoredRoot)}  matches the ANCHORED root`)
  if (root !== report.merkleRoot) fail(`${meta.periodId}: rebuilt root differs from the report`)
  if (root !== meta.anchoredRoot) fail(`${meta.periodId}: rebuilt root differs from the anchor`)

  step(++n, 'An inclusion proof for every row')
  if (leaves.length === 0) {
    // merkleProof returns [] for any index into an empty period, and folding
    // [] returns the leaf unchanged. An empty proof must never be read as
    // proof of anything, so there is nothing to run here and saying so is the
    // honest output.
    console.log('   nothing to prove: no rows. An empty proof proves nothing.')
  } else {
    for (const [i, row] of report.rows.entries()) {
      const proof = merkleProof(i, leaves)
      // periodRowVerify, not merkleVerify: folding a bare hash returns true
      // for an internal node too, because the fold cannot know what it
      // started from. Deriving the leaf FROM THE ROW is what binds the claim
      // "this is a cycle" to the row schema.
      const ok = periodRowVerify(row, proof, root)
      console.log(`   ${mark(ok)}  [${i}] ${row.cycleId}  ${proof.length} step(s)`)
      if (!ok) fail(`${meta.periodId}: inclusion proof failed for ${row.cycleId}`)
    }

    // The check that matters, and the one an example usually leaves out.
    const tampered = { ...report.rows[0], returnedUnits: String(BigInt(report.rows[0].returnedUnits) - 1n) }
    const refused = periodRowVerify(tampered, merkleProof(0, leaves), root) === false
    console.log(`   ${mark(refused)}  the same proof REFUSES the row with returnedUnits-1`)
    console.log(`         ${report.rows[0].returnedUnits} -> ${tampered.returnedUnits}`)
    if (!refused) fail(`${meta.periodId}: a tampered row verified against the root`)
  }

  step(++n, 'Totals, re-derived from the rows')
  const totals = totalsOf(report.rows)
  if (anchor) {
    for (const [field, got] of Object.entries(totals)) {
      const same = got === BigInt(anchor[field])
      console.log(`   ${mark(same)}  ${field.padEnd(16)} ${got}`)
      if (!same) fail(`${meta.periodId}: ${field} disagrees with the anchor (${anchor[field]})`)
    }
  } else {
    console.log(`   cycleCount ${totals.cycleCount} vs index ${meta.cycleCount}`)
    if (totals.cycleCount !== BigInt(meta.cycleCount)) {
      fail(`${meta.periodId}: row count disagrees with the index`)
    }
    console.log('   the rest need the anchor contract; use --ledger or fixtures/anchors.json')
  }

  step(++n, 'The anchor document, reassembled field by field')
  if (!anchor) {
    console.log('   SKIPPED — no anchor contract available for this period')
  } else {
    const digest = anchorDigestOf(anchor)
    console.log(`   ${digest}`)
    console.log(`   ${mark(digest === anchor.anchorDigest)}  matches anchorDigest on the contract`)
    console.log(`   ${mark(anchor.merkleRootHex === root)}  the anchor commits to the root we rebuilt`)
    if (digest !== anchor.anchorDigest) fail(`${meta.periodId}: anchor document does not reproduce`)
    if (anchor.merkleRootHex !== root) fail(`${meta.periodId}: anchor root differs from the rebuilt root`)
    // reportUri is a field of the CONTRACT, not of the document: the place a
    // report is served from is not part of the commitment, its bytes are.
    console.log(`   reportUri (not covered by the digest): ${anchor.reportUri}`)

    step(++n, 'The chain')
    if (previousAnchorDigest === null) {
      const first = anchor.prevAnchorDigest === ''
      console.log(`   prevAnchorDigest ${anchor.prevAnchorDigest === '' ? '""  (start of the chain)' : anchor.prevAnchorDigest}`)
      if (!first) console.log('   this is not the first period — run without --period to walk it')
    } else {
      const linked = anchor.prevAnchorDigest === previousAnchorDigest
      console.log(`   ${mark(linked)}  prevAnchorDigest is the previous period's anchorDigest`)
      console.log(`         ${anchor.prevAnchorDigest}`)
      // A missing period is a broken link, not an absence you have to notice.
      if (!linked) fail(`${meta.periodId}: chain link broken — a period is missing or reordered`)
    }
    previousAnchorDigest = anchor.anchorDigest
  }

  step(++n, 'The bytes the anchor actually commits to')
  const anchoredDigest = anchor?.reportDigest ?? meta.anchoredDigest
  const bytesMatch = served === anchoredDigest
  console.log(`   served   ${served}`)
  console.log(`   anchored ${anchoredDigest}`)
  console.log(`   ${mark(bytesMatch)}  the file served is the file anchored`)
  if (!bytesMatch) {
    byteFindings.push(meta.periodId)
    console.log(`
   T4. The rows are intact — every leaf and the root reproduced above — but
   these bytes are not the bytes the ledger was made to commit to. Publish a
   report's bytes once and serve them byte-stable forever; re-serialising to
   pretty-print it is a breaking change. index.json records both digests, so
   this was noticed rather than hidden.`)
  }
}

// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(72)}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} verification(s) failed:`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
if (byteFindings.length > 0) {
  console.log(`
Rows, roots, proofs, anchors and the chain all reproduce.

The served bytes do not match the anchored bytes for: ${byteFindings.join(', ')}.
Exit 2 — see T4 in docs/INTEGRATION.md. This is a finding about how the report
was published, not about what happened on the ledger.
`)
  process.exit(2)
}
console.log(`
Everything reproduced, from the bytes up, with nothing taken from arCCade but
the report itself. That is the whole claim: an omitted cycle cannot survive
this check, because the root the ledger holds would no longer be the root the
rows produce.
`)
