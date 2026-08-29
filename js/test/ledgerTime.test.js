/**
 * Ledger time arithmetic.
 *
 * The point of these tests is the SIGN. Daml's Int division truncates toward
 * zero; JavaScript's `Math.floor` rounds toward negative infinity. The two
 * agree on every positive operand, so a wrong implementation passes every
 * cheerful test and diverges only on a pre-epoch or clock-skewed timestamp —
 * which is why the divergence itself is asserted below rather than described
 * in a comment.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { addSeconds, epochSeconds, intDivide, secondsBetween } from '../src/index.js'

test('intDivide truncates toward zero, the way Daml does', () => {
  assert.equal(intDivide(-7n, 2n), -3n)
  assert.equal(intDivide(7n, 2n), 3n)
  assert.equal(intDivide(-7n, -2n), 3n)
  assert.equal(intDivide(7n, -2n), -3n)
})

test('the floor answer is a DIFFERENT answer, and it is the wrong one', () => {
  // If this ever stops being true, the trap has gone away and the guard above
  // is decoration. While it is true, a client that reached for Math.floor is
  // demonstrably off by one.
  assert.equal(Math.floor(-7 / 2), -4)
  assert.notEqual(BigInt(Math.floor(-7 / 2)), intDivide(-7n, 2n))
})

test('intDivide refuses a zero divisor rather than returning Infinity', () => {
  // `(-7) / 0` is -Infinity in float JavaScript and `Math.floor` of it is
  // -Infinity too, so a float implementation returns a "number" here.
  assert.throws(() => intDivide(-7n, 0n), /division by zero/)
})

test('epochSeconds drops the fraction and never rounds', () => {
  assert.equal(epochSeconds(1787437747000000n), 1787437747n)
  assert.equal(epochSeconds(1787437747372202n), 1787437747n)
  assert.equal(epochSeconds(1787437747999999n), 1787437747n)
})

test('half a second before the epoch is second zero, not minus one', () => {
  assert.equal(epochSeconds(-500000n), 0n)
  // The floor conversion a careless port would write:
  assert.equal(Math.floor(-500000 / 1e6), -1)
})

test('secondsBetween truncates EACH endpoint before subtracting', () => {
  // 0.9s to 60.0s is sixty seconds, not fifty-nine. This is what decides
  // whether a lock or a cycle is long enough.
  assert.equal(secondsBetween(900000n, 60000000n), 60n)
  const naive = Math.floor((60000000 - 900000) / 1e6)
  assert.equal(naive, 59)
  assert.notEqual(BigInt(naive), secondsBetween(900000n, 60000000n))
})

test('secondsBetween inside one second is zero, across a boundary is one', () => {
  assert.equal(secondsBetween(1000001n, 1999999n), 0n)
  assert.equal(secondsBetween(1999999n, 2000000n), 1n)
})

test('secondsBetween keeps its sign; a backwards interval is negative', () => {
  // An absolute value here would accept a lock that expires before it starts.
  assert.equal(secondsBetween(60000000n, 900000n), -60n)
})

test('addSeconds moves whole seconds in both directions', () => {
  assert.equal(addSeconds(1787437775189712n, 30n), 1787437805189712n)
  assert.equal(addSeconds(1787437775189712n, 0n), 1787437775189712n)
  assert.equal(addSeconds(1787437775189712n, -30n), 1787437745189712n)
})

test('addSeconds refuses to wrap out of the band Daml Int can hold', () => {
  assert.throws(() => addSeconds(9223372036854775807n, 1n), /int64 range/)
})

test('a fractional or unsafe Number is refused, not rounded', () => {
  assert.throws(() => epochSeconds(1.5), /Cannot convert/)
  assert.throws(() => addSeconds(2 ** 53 + 2, 0), /Cannot convert/)
  // Plain integers within the safe range still work, so the guard costs the
  // ordinary caller nothing.
  assert.equal(epochSeconds(1787437747372202), 1787437747n)
})
