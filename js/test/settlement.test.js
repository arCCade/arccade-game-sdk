/**
 * Settlement invariants.
 *
 * Conservation is the one property a Merkle proof cannot express: the tree
 * says "this row is in the report", never "this row is arithmetically
 * possible". Without these checks a published report can state amounts the
 * ledger would have refused while every individual proof still verifies.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { assertSettlementValid, settlementIsValid } from '../src/index.js'

const STAKE = 1000000000000n
const CAP = 50000000000000n

const settlement = (over) => ({
  disposition: 'returned-in-full',
  stakeUnits: STAKE,
  returnedUnits: STAKE,
  forfeitedUnits: 0n,
  payoutUnits: 0n,
  maxPayoutUnits: CAP,
  ...over,
})

test('a full return is valid', () => {
  assert.equal(assertSettlementValid(settlement({})), true)
})

test('returned + forfeited must equal the stake', () => {
  assert.throws(
    () => assertSettlementValid(settlement({ returnedUnits: 900000000000n })),
    /must equal the stake/,
  )
})

test('returned-in-full cannot forfeit', () => {
  assert.throws(
    () => assertSettlementValid(settlement({
      returnedUnits: 900000000000n, forfeitedUnits: 100000000000n,
    })),
    /returned-in-full cannot forfeit/,
  )
})

test('forfeited-in-full cannot return', () => {
  assert.equal(assertSettlementValid(settlement({
    disposition: 'forfeited-in-full', returnedUnits: 0n, forfeitedUnits: STAKE,
  })), true)
  assert.throws(
    () => assertSettlementValid(settlement({
      disposition: 'forfeited-in-full',
      returnedUnits: 900000000000n,
      forfeitedUnits: 100000000000n,
    })),
    /forfeited-in-full cannot return/,
  )
})

test('a partial forfeit needs both sides non-zero', () => {
  assert.equal(assertSettlementValid(settlement({
    disposition: 'returned-with-forfeit',
    returnedUnits: 700000000000n,
    forfeitedUnits: 300000000000n,
  })), true)
  assert.throws(
    () => assertSettlementValid(settlement({ disposition: 'returned-with-forfeit' })),
    /needs both sides non-zero/,
  )
})

test('a negative leg is refused BEFORE conservation is checked', () => {
  // -1000 + 2000 == 1000 balances, so conservation alone lets this through
  // while the row reverses the direction of the settlement.
  const bad = settlement({ returnedUnits: -STAKE, forfeitedUnits: 2n * STAKE })
  assert.equal(bad.returnedUnits + bad.forfeitedUnits, bad.stakeUnits)
  assert.throws(() => assertSettlementValid(bad), /negative settlement amount: returnedUnits=/)
})

test('a payout at the cap is accepted and one above it is not', () => {
  assert.equal(assertSettlementValid(settlement({ payoutUnits: CAP })), true)
  assert.throws(
    () => assertSettlementValid(settlement({ payoutUnits: 60000000000000n })),
    /payout above the policy cap/,
  )
})

test('an abort or an expiry returns the stake in full', () => {
  for (const d of ['aborted', 'expired-unsettled']) {
    assert.equal(assertSettlementValid(settlement({ disposition: d })), true)
    assert.throws(
      () => assertSettlementValid(settlement({
        disposition: d, returnedUnits: 900000000000n, forfeitedUnits: 100000000000n,
      })),
      /must return the stake in full/,
    )
  }
})

test('the disposition is a TAG, not a constructor name', () => {
  assert.throws(
    () => assertSettlementValid(settlement({ disposition: 'ReturnedInFull' })),
    /gecersiz disposition/,
  )
})

test('the predicate form agrees with the assertion form, and throws nothing', () => {
  assert.equal(settlementIsValid(settlement({})), true)
  assert.equal(settlementIsValid(settlement({ returnedUnits: 900000000000n })), false)
  assert.equal(settlementIsValid({}), false)
  assert.equal(settlementIsValid(null), false)
})

test('every golden row from the real TestNet ledger settles legally', () => {
  // The rows the shipped audit reader produces are the rows this check has to
  // accept, or the two halves of the client disagree about the same period.
  const golden = JSON.parse(readFileSync(new URL('../../test-vectors/cycle-rows.json', import.meta.url)))
  for (const r of golden.rows) {
    assert.equal(assertSettlementValid({
      disposition: r.disposition,
      stakeUnits: r.committedUnits,
      returnedUnits: r.returnedUnits,
      forfeitedUnits: r.forfeitedUnits,
      payoutUnits: r.payoutUnits,
      maxPayoutUnits: CAP,
    }), true, r.cycleId)
  }
})
