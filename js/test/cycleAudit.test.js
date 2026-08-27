/**
 * Rebuilding report rows from real ledger trees.
 *
 * The fixture is real: transactions captured from the arCCade TestNet
 * validator with TRANSACTION_SHAPE_LEDGER_EFFECTS, covering all three ways a
 * cycle can close. `cycle-rows.json` is the expected output, and it is the
 * SAME file the Python and Java implementations assert against — that is what
 * makes "any language can verify this" a fact rather than a claim.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { merkleRoot, periodLeaf } from '../src/digest.js'
import { isoToMicros, rowsFromTransactions, toLeafRow } from '../src/cycleAudit.js'

const trees = JSON.parse(readFileSync(new URL('../../test-vectors/cycle-trees.json', import.meta.url)))
const expected = JSON.parse(readFileSync(new URL('../../test-vectors/cycle-rows.json', import.meta.url)))
const transactions = trees.cases.flatMap((c) => [c.commitTransaction, c.closingTransaction])

const asStrings = (row) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))

test('the fixture covers every way a cycle can close', () => {
  // A path with no fixture is a path an implementation can get wrong and
  // still pass.
  assert.deepEqual(
    trees.cases.map((c) => c.closingChoice).sort(),
    ['GameStake_Abort', 'GameStake_ExpireUnsettled', 'GameStake_Settle'],
  )
})

test('rows rebuilt from the trees match the golden vector', () => {
  const { rows } = rowsFromTransactions(transactions)
  assert.deepEqual(rows.map((r) => asStrings(toLeafRow(r))), expected.rows)
})

test('leaves and the period root match the golden vector', () => {
  const { rows } = rowsFromTransactions(transactions)
  const leaves = rows.map((r) => periodLeaf(toLeafRow(r)))
  assert.deepEqual(leaves, expected.leaves)
  assert.equal(merkleRoot(leaves), expected.merkleRoot)
})

test('an abort returns the stake in full and has no outcome', () => {
  const { rows } = rowsFromTransactions(transactions)
  const aborted = rows.find((r) => r.disposition === 'aborted')
  assert.ok(aborted)
  // Abort states no amounts; unlocking pays the owner in full and this
  // mechanic cannot forfeit, so the stake comes back and nothing else moves.
  assert.equal(aborted.returnedUnits, aborted.committedUnits)
  assert.equal(aborted.forfeitedUnits, 0n)
  assert.equal(aborted.payoutUnits, 0n)
  assert.equal(aborted.outcomeDigest, '')
})

test('the unlock in the same transaction is cross-checked, not trusted', () => {
  // The aborted case carries LockedAmulet_UnlockV2 and the resulting Amulet,
  // so the returned amount has an independent second reading.
  const { warnings } = rowsFromTransactions(transactions)
  assert.deepEqual(warnings, [])
})

test('a commit with no closing is reported, not dropped', () => {
  // Silently discarding a commit whose settlement fell outside the window is
  // precisely the omission the anchor exists to make provable.
  const commitsOnly = trees.cases.map((c) => c.commitTransaction)
  const { rows, openStakes } = rowsFromTransactions(commitsOnly)
  assert.equal(rows.length, 0)
  assert.equal(openStakes.length, 3)
})

test('ledger timestamps keep microsecond precision', () => {
  // Date.parse would truncate to milliseconds and the canonical document
  // would stop matching Daml's.
  assert.equal(isoToMicros('2026-08-26T16:58:11.258920Z'), 1787763491258920n)
  assert.equal(isoToMicros('2026-08-27T17:27:00Z'), 1787851620000000n)
})
