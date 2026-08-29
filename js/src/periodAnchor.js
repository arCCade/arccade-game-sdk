/**
 * The period anchor — the package's only mechanism that proves OMISSION.
 *
 * WHY IT EXISTS. The price of two writes per cycle is that the outcome travels
 * in the settlement's exercise node and is invisible in the flat stream. If an
 * auditor sees a lock on Scan and cannot find that cycle in arCCade's report,
 * the only thing that settles the argument is a commitment over the WHOLE
 * report: one write per period, a Merkle root over 100% of that period's
 * cycles, and a digest chained to the previous period.
 *
 * WHAT IS PROVEN AND WHAT IS DECLARED — the distinction matters and is not
 * hidden:
 *
 *   PROVEN (Daml recomputes it; the venue cannot lie)
 *     merkleRootHex, anchorDigest, cycleCount, committedUnits, feeUnits,
 *     returnedUnits, forfeitedUnits, payoutUnits
 *
 *   DECLARED (arrives as an argument; the contract cannot check it)
 *     reportUri, reportDigest, prevAnchorDigest, qualifyingTxCount,
 *     nonQualifyingTxCount
 *
 * Until now no PUBLISHED JavaScript client could reproduce `anchorDocument`:
 * Daml decided the anchor and the live TestNet anchor sat on disk with nothing
 * able to re-derive it outside the ledger. The Python and Java clients closed
 * this; this module closes it for the client on npm.
 *
 * Byte-for-byte identical to `daml/ArCCade/GameSdk/Audit.daml`,
 * `python/arccade_game_sdk/audit.py` and `PeriodAnchorDocuments.java`.
 */

import { canonDocument, canonInt, canonText, textDigest } from './digest.js'
import { assertInt64, toInt64 } from './int64.js'

export const ANCHOR_SCHEMA = 'arccade.period-anchor'
export const ANCHOR_SCHEMA_VERSION = 1

/** The fields an anchor document commits, in the order Daml lists them. */
export const ANCHOR_FIELDS = Object.freeze([
  'venueId', 'periodId', 'periodStartMicros', 'periodEndMicros', 'cycleCount',
  'committedUnits', 'feeUnits', 'returnedUnits', 'forfeitedUnits',
  'payoutUnits', 'qualifyingTxCount', 'nonQualifyingTxCount', 'merkleRootHex',
  'reportDigest', 'prevAnchorDigest',
])

/** The six totals an anchor states, in the order `anchorTotals` returns them. */
export const ANCHOR_TOTAL_FIELDS = Object.freeze([
  'cycleCount', 'committedUnits', 'feeUnits', 'returnedUnits',
  'forfeitedUnits', 'payoutUnits',
])

const UNIT_FIELDS = ANCHOR_TOTAL_FIELDS.slice(1)

/**
 * Reads a required field.
 *
 * `prevAnchorDigest` is EMPTY TEXT at the start of a chain, and `cycleCount`
 * is 0 for an empty period, so presence is tested rather than truthiness: an
 * anchor with no predecessor and an anchor whose predecessor was forgotten
 * must not hash to the same document, and neither may be waved through as
 * "missing".
 */
function req(anchor, field) {
  if (anchor === null || typeof anchor !== 'object') {
    throw new Error(`arccade-game-sdk: anchor must be an object, got ${typeof anchor}`)
  }
  const v = anchor[field]
  if (v === undefined || v === null) {
    throw new Error(`arccade-game-sdk: anchor field is missing: ${field}`)
  }
  return v
}

const reqText = (a, f) => {
  const v = req(a, f)
  if (typeof v !== 'string') {
    throw new Error(`arccade-game-sdk: anchor field ${f} must be text, got ${typeof v}`)
  }
  return v
}

const reqInt = (a, f) => toInt64(req(a, f), `anchor field ${f}`)

/**
 * The anchor's canonical text. `anchorDigest` is its sha256, and the next link
 * in the chain carries that value as `prevAnchorDigest`.
 */
export function anchorDocument(anchor) {
  return canonDocument(ANCHOR_SCHEMA, ANCHOR_SCHEMA_VERSION, [
    ['venueId', canonText(reqText(anchor, 'venueId'))],
    ['periodId', canonText(reqText(anchor, 'periodId'))],
    ['periodStartMicros', canonInt(reqInt(anchor, 'periodStartMicros'))],
    ['periodEndMicros', canonInt(reqInt(anchor, 'periodEndMicros'))],
    ['cycleCount', canonInt(reqInt(anchor, 'cycleCount'))],
    ['committedUnits', canonInt(reqInt(anchor, 'committedUnits'))],
    ['feeUnits', canonInt(reqInt(anchor, 'feeUnits'))],
    ['returnedUnits', canonInt(reqInt(anchor, 'returnedUnits'))],
    ['forfeitedUnits', canonInt(reqInt(anchor, 'forfeitedUnits'))],
    ['payoutUnits', canonInt(reqInt(anchor, 'payoutUnits'))],
    ['qualifyingTxCount', canonInt(reqInt(anchor, 'qualifyingTxCount'))],
    ['nonQualifyingTxCount', canonInt(reqInt(anchor, 'nonQualifyingTxCount'))],
    ['merkleRootHex', canonText(reqText(anchor, 'merkleRootHex'))],
    ['reportDigest', canonText(reqText(anchor, 'reportDigest'))],
    ['prevAnchorDigest', canonText(reqText(anchor, 'prevAnchorDigest'))],
  ])
}

export const anchorDigest = (anchor) => textDigest(anchorDocument(anchor))

/**
 * Period totals DERIVED FROM THE ROWS, never taken from the caller.
 *
 * Otherwise a venue could publish a correct root and lie in the summary
 * fields: the root says nothing about whether the summary agrees with the
 * leaves it was built from.
 *
 * A repeated `cycleId` inside one period is refused. `cycleId` has no contract
 * key on the ledger, so nothing stops the same id appearing twice; a duplicate
 * would be counted twice in the totals while the Merkle proof for each copy
 * still verified, which is precisely the shape of mistake this anchor exists
 * to make visible.
 *
 * Returns BigInt totals keyed by `ANCHOR_TOTAL_FIELDS`, in that order.
 */
export function anchorTotals(rows) {
  const totals = {
    cycleCount: 0n,
    committedUnits: 0n,
    feeUnits: 0n,
    returnedUnits: 0n,
    forfeitedUnits: 0n,
    payoutUnits: 0n,
  }
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      throw new Error(`arccade-game-sdk: audit row must be an object, got ${typeof row}`)
    }
    const cycleId = row.cycleId
    if (typeof cycleId !== 'string' || cycleId.length === 0) {
      throw new Error(`arccade-game-sdk: audit row has no cycleId: ${JSON.stringify(cycleId ?? null)}`)
    }
    if (seen.has(cycleId)) {
      throw new Error(`arccade-game-sdk: duplicate cycleId in a period: ${JSON.stringify(cycleId)}`)
    }
    seen.add(cycleId)
    totals.cycleCount += 1n
    for (const f of UNIT_FIELDS) {
      // Range-checked on every step rather than at the end: a period whose
      // totals leave the int64 band is a period the ledger could not have
      // anchored, and a total that wrapped would be a smaller, plausible-
      // looking lie.
      totals[f] = assertInt64(totals[f] + toInt64(row[f], `row ${cycleId}.${f}`), `total ${f}`)
    }
  }
  return totals
}
