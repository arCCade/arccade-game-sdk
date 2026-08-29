/**
 * Ledger time arithmetic — the same truncation Daml does, in JavaScript.
 *
 * Every duration check in `Policy.daml` and `Cycle.daml` runs through this
 * arithmetic, so a client that computes a duration differently refuses cycles
 * the ledger accepts, or offers cycles it will refuse. Times are integer
 * MICROSECONDS since the epoch throughout, never ISO text and never a float.
 *
 * # The three traps, all of them JavaScript's
 *
 *   1. `/` IS FLOAT DIVISION. `(-7) / 2` is -3.5, and reaching for
 *      `Math.floor` to make it whole rounds TOWARD NEGATIVE INFINITY: -4.
 *      Daml's `/` on `Int` truncates TOWARD ZERO: -3. The two agree on every
 *      positive operand and disagree on every negative one, which is exactly
 *      where a pre-epoch or clock-skewed timestamp lands. `Math.trunc` on a
 *      float would agree in sign and lose digits above 2^53 instead, so
 *      neither float route is taken: the arithmetic is BigInt, whose `/`
 *      already truncates toward zero.
 *
 *   2. `secondsBetween` TRUNCATES EACH ENDPOINT BEFORE SUBTRACTING. 0.9s to
 *      60.0s is SIXTY seconds, not fifty-nine. This is the most dangerous
 *      behaviour in the package: it decides whether a lock or a cycle is long
 *      enough, and a client computing `(b - a) / 1e6` refuses cycles the
 *      ledger accepts.
 *
 *   3. A `number` past 2^53 has already lost digits. Microsecond timestamps
 *      are safe until the year 2255, but a duration in microseconds is not,
 *      so the coercion refuses rather than rounds — see `int64.js`.
 *
 * There is no `Date` overload on purpose. A `Date` carries milliseconds and a
 * time zone the ledger does not have; the conversion belongs at the boundary
 * where the caller can see it — `toMicros` in `digest.js`.
 */

import { assertInt64, toInt64 } from './int64.js'

const MICROS_PER_SECOND = 1000000n

/**
 * Integer division truncating TOWARD ZERO, as Daml's `/` on `Int` does.
 *
 * `intDivide(-7n, 2n) === -3n`; flooring gives -4n. Named rather than inlined
 * so the choice is a function with tests on it instead of an assumption
 * scattered across call sites.
 */
export function intDivide(a, b) {
  const x = toInt64(a, 'a')
  const y = toInt64(b, 'b')
  if (y === 0n) throw new Error('arccade-game-sdk: division by zero in intDivide')
  // BigInt `/` truncates toward zero. The only quotient that can leave the
  // band is INT64_MIN / -1, and assertInt64 catches it rather than wrapping.
  return assertInt64(x / y, 'intDivide result')
}

/** Epoch microseconds -> epoch seconds, truncated toward zero. */
export function epochSeconds(micros) {
  return intDivide(toInt64(micros, 'micros'), MICROS_PER_SECOND)
}

/**
 * `epochSeconds(b) - epochSeconds(a)`.
 *
 * Negative when b precedes a. The caller checks the sign; taking an absolute
 * value here would accept a lock that expires before it starts.
 */
export function secondsBetween(aMicros, bMicros) {
  const a = epochSeconds(aMicros)
  const b = epochSeconds(bMicros)
  return assertInt64(b - a, 'secondsBetween result')
}

/** Adds whole seconds to an instant. Used for cooldowns and deadlines. */
export function addSeconds(micros, seconds) {
  const m = toInt64(micros, 'micros')
  const s = toInt64(seconds, 'seconds')
  // Range-checked in two steps: a seconds count that alone overflows the band
  // and a sum that overflows it are different mistakes, and the message says
  // which one happened.
  const shift = assertInt64(s * MICROS_PER_SECOND, 'seconds in microseconds')
  return assertInt64(m + shift, 'addSeconds result')
}
