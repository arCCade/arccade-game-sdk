/**
 * Int64 coercion — internal, not part of the published surface.
 *
 * Daml's `Int` is a signed 64-bit integer and every quantity this SDK commits
 * to the ledger lives in that band: microseconds since the epoch, whole
 * seconds, and amounts already converted to 1e-10 units. JavaScript has two
 * integer types and only one of them can hold the band, so the boundary where
 * a caller's `number` becomes a `BigInt` is the place a silent rounding gets
 * in. It is written down once, here, rather than repeated per module.
 *
 * Three things are refused rather than absorbed:
 *
 *   1. a fractional `number` — 1.5 microseconds is not a ledger timestamp;
 *   2. a `number` beyond 2^53 — the double already lost digits before this
 *      function ever saw it, so `BigInt(x)` would faithfully preserve a value
 *      that is already wrong;
 *   3. anything outside the int64 band — a value Daml could not have held,
 *      and therefore a value no ledger fact can be about.
 *
 * `boolean` is refused too. `BigInt(true)` is 1n, which would let a row carry
 * `committedUnits: true` into a total that still looked plausible.
 */

export const INT64_MAX = 9223372036854775807n
export const INT64_MIN = -9223372036854775808n

/** Throws unless `v` fits the band Daml's `Int` can hold. */
export function assertInt64(v, what) {
  if (v > INT64_MAX || v < INT64_MIN) {
    throw new Error(
      `arccade-game-sdk: ${what} is outside the int64 range Daml's Int can hold: ${v}`,
    )
  }
  return v
}

/**
 * Coerces to a BigInt in the int64 band, or throws saying which field failed.
 *
 * The message deliberately begins "Cannot convert ... to an integer": the
 * conformance reject map classes that wording as `bad-format` for the audit
 * group, and the Python client raises the same sentence.
 */
export function toInt64(value, what) {
  if (typeof value === 'bigint') return assertInt64(value, what)
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`arccade-game-sdk: Cannot convert ${value} to an integer (${what}): it is fractional`)
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `arccade-game-sdk: Cannot convert ${value} to an integer (${what}): ` +
        'beyond 2^53 a Number has already lost digits, pass a BigInt',
      )
    }
    return assertInt64(BigInt(value), what)
  }
  if (typeof value === 'string') {
    if (!/^[+-]?\d+$/.test(value.trim())) {
      throw new Error(`arccade-game-sdk: Cannot convert ${JSON.stringify(value)} to an integer (${what})`)
    }
    return assertInt64(BigInt(value.trim()), what)
  }
  throw new Error(
    `arccade-game-sdk: Cannot convert ${JSON.stringify(String(value))} to an integer (${what}): ` +
    `unsupported type ${typeof value}`,
  )
}
