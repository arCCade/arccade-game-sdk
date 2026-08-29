/**
 * The settlement arithmetic Cycle.daml enforces, restated so a client can
 * check it.
 *
 * No published JavaScript client re-checked this, which meant a report could
 * state amounts the ledger would have refused while every individual Merkle
 * proof still verified. Conservation is the one property a proof cannot
 * express: the tree says "this row is in the report", never "this row is
 * arithmetically possible".
 *
 * Amounts are integer 1e-10 units, matching an audit row rather than a policy.
 * The field names are the audit row's: `disposition`, `stakeUnits`,
 * `returnedUnits`, `forfeitedUnits`, `payoutUnits`, `maxPayoutUnits`.
 *
 * Messages are English rather than Turkish because they name conditions from
 * Cycle.daml's assertions and the conformance reject map keys off them; the
 * Python and Java clients raise the same sentences.
 */

import { assertDisposition } from './digest.js'
import { assertInt64, toInt64 } from './int64.js'

export const SETTLEMENT_FIELDS = Object.freeze([
  'disposition', 'stakeUnits', 'returnedUnits', 'forfeitedUnits',
  'payoutUnits', 'maxPayoutUnits',
])

/**
 * Checks one settlement's amounts. Returns true, or throws saying which rule
 * failed — "which rule" is the useful half when a report is being argued
 * about.
 *
 * `maxPayoutUnits` is the venue policy's cap, carried alongside the settlement
 * because the cap is what makes a payout checkable at all: without it, any
 * payout is as plausible as any other.
 */
export function assertSettlementValid(settlement) {
  if (settlement === null || typeof settlement !== 'object') {
    throw new Error(`arccade-game-sdk: settlement must be an object, got ${typeof settlement}`)
  }
  const disposition = assertDisposition(settlement.disposition)
  const stake = toInt64(settlement.stakeUnits, 'stakeUnits')
  const returned = toInt64(settlement.returnedUnits, 'returnedUnits')
  const forfeited = toInt64(settlement.forfeitedUnits, 'forfeitedUnits')
  const payout = toInt64(settlement.payoutUnits, 'payoutUnits')
  const maxPayout = toInt64(settlement.maxPayoutUnits, 'maxPayoutUnits')

  // Sign first: a negative leg reverses the direction of the settlement while
  // the row still reads as a payment to the player, and it can make the
  // conservation sum come out right for two amounts that are both wrong.
  for (const [name, value] of [['returnedUnits', returned],
    ['forfeitedUnits', forfeited], ['payoutUnits', payout]]) {
    if (value < 0n) {
      throw new Error(`arccade-game-sdk: negative settlement amount: ${name}=${value}`)
    }
  }

  if (assertInt64(returned + forfeited, 'returned + forfeited') !== stake) {
    throw new Error(
      'arccade-game-sdk: returned + forfeited must equal the stake: '
      + `${returned} + ${forfeited} != ${stake}`,
    )
  }

  switch (disposition) {
    case 'returned-in-full':
      if (forfeited !== 0n) {
        throw new Error(`arccade-game-sdk: returned-in-full cannot forfeit: forfeitedUnits=${forfeited}`)
      }
      break
    case 'forfeited-in-full':
      if (returned !== 0n) {
        throw new Error(`arccade-game-sdk: forfeited-in-full cannot return: returnedUnits=${returned}`)
      }
      break
    case 'returned-with-forfeit':
      if (!(returned > 0n && forfeited > 0n)) {
        throw new Error(
          'arccade-game-sdk: returned-with-forfeit needs both sides non-zero: '
          + `returnedUnits=${returned}, forfeitedUnits=${forfeited}`,
        )
      }
      break
    case 'aborted':
    case 'expired-unsettled':
      // Unlocking a TimeLockedHolding always pays the owner in full and
      // neither mechanic can forfeit, so anything less than the whole stake
      // describes value that went nowhere.
      if (returned !== stake) {
        throw new Error(
          `arccade-game-sdk: ${disposition} must return the stake in full: `
          + `returnedUnits=${returned}, stakeUnits=${stake}`,
        )
      }
      break
    default:
      // Unreachable while assertDisposition and DISPOSITIONS agree; kept so
      // that adding a tag to one and not the other fails loudly here instead
      // of passing every settlement carrying the new tag.
      throw new Error(`arccade-game-sdk: unknown disposition: ${JSON.stringify(disposition)}`)
  }

  if (payout > maxPayout) {
    throw new Error(
      `arccade-game-sdk: payout above the policy cap: payoutUnits=${payout}, `
      + `maxPayoutUnits=${maxPayout}`,
    )
  }
  return true
}

/**
 * The predicate form. Prefer `assertSettlementValid` when reporting: which
 * rule failed is the half a reader needs, and this form throws it away.
 */
export function settlementIsValid(settlement) {
  try {
    return assertSettlementValid(settlement)
  } catch {
    return false
  }
}
