/**
 * The venue policy document and its consistency check.
 *
 * The FULL TEXT of the policy in force is committed as a digest at every stake
 * (`GameStake.policyHash`). "Under which rules was this cycle opened" is then
 * answered by the cycle's own record rather than by whatever arCCade says
 * later — which only holds if the document is reproducible outside Daml.
 *
 * Note the deliberate difference from an audit row: a policy is authored in
 * DECIMALS (`canonDecimal`) while a row carries units already converted
 * (`canonInt`). Applying one convention to both produces a policy digest no
 * stake can match, and nothing else would go wrong until an auditor tried to
 * check one.
 *
 * Byte-for-byte identical to `daml/ArCCade/GameSdk/Policy.daml`,
 * `python/arccade_game_sdk/policy.py` and `PolicyDocuments.java`.
 */

import {
  amountUnits, canonBool, canonDecimal, canonDocument, canonInt, textDigest,
} from './digest.js'
import { toInt64 } from './int64.js'

export const POLICY_SCHEMA = 'arccade-venue-policy'
export const POLICY_SCHEMA_VERSION = 1

/** The document's field names. Amount fields are decimals; the rest are ints. */
export const POLICY_FIELDS = Object.freeze([
  'min-stake-amount', 'max-stake-amount', 'min-platform-fee', 'max-payout-amount',
  'min-lock-seconds', 'max-lock-seconds', 'min-cycle-seconds', 'max-cycle-seconds',
  'cooldown-seconds', 'abort-cooldown-seconds', 'concurrency-limit',
  'require-custody-proof',
])

const camel = (name) => {
  const [head, ...tail] = name.split('-')
  return head + tail.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('')
}

/**
 * Reads a policy field under any of its three spellings.
 *
 * A policy arrives either keyed by document field names (which is how the
 * conformance manifest states it), or in the camelCase a JavaScript caller
 * writes, or in the snake_case a caller porting from the Python client writes.
 * Accepting all three keeps the document definition in one place instead of
 * growing a second, subtly different, spelling of the same schema.
 */
function get(policy, field) {
  if (policy === null || typeof policy !== 'object') {
    throw new Error(`arccade-game-sdk: policy must be an object, got ${typeof policy}`)
  }
  for (const key of [field, field.replaceAll('-', '_'), camel(field)]) {
    const v = policy[key]
    if (v !== undefined && v !== null) return v
  }
  throw new Error(
    `arccade-game-sdk: policy field is missing: ${field} ` +
    `(tried ${field}, ${field.replaceAll('-', '_')}, ${camel(field)})`,
  )
}

/**
 * The policy's canonical document.
 *
 * Field order here does not matter — `canonFields` sorts by name — so a field
 * added later does not change the v1 digest unless the schema version moves
 * with it.
 */
export function policyDocument(policy) {
  return canonDocument(POLICY_SCHEMA, POLICY_SCHEMA_VERSION, [
    ['min-stake-amount', canonDecimal(get(policy, 'min-stake-amount'))],
    ['max-stake-amount', canonDecimal(get(policy, 'max-stake-amount'))],
    ['min-platform-fee', canonDecimal(get(policy, 'min-platform-fee'))],
    ['max-payout-amount', canonDecimal(get(policy, 'max-payout-amount'))],
    ['min-lock-seconds', canonInt(toInt64(get(policy, 'min-lock-seconds'), 'min-lock-seconds'))],
    ['max-lock-seconds', canonInt(toInt64(get(policy, 'max-lock-seconds'), 'max-lock-seconds'))],
    ['min-cycle-seconds', canonInt(toInt64(get(policy, 'min-cycle-seconds'), 'min-cycle-seconds'))],
    ['max-cycle-seconds', canonInt(toInt64(get(policy, 'max-cycle-seconds'), 'max-cycle-seconds'))],
    ['cooldown-seconds', canonInt(toInt64(get(policy, 'cooldown-seconds'), 'cooldown-seconds'))],
    ['abort-cooldown-seconds',
      canonInt(toInt64(get(policy, 'abort-cooldown-seconds'), 'abort-cooldown-seconds'))],
    ['concurrency-limit', canonInt(toInt64(get(policy, 'concurrency-limit'), 'concurrency-limit'))],
    ['require-custody-proof', canonBool(assertBool(get(policy, 'require-custody-proof')))],
  ])
}

function assertBool(v) {
  if (typeof v !== 'boolean') {
    // Truthiness would encode `"false"` as `b:4:true` and produce a policy
    // digest that no stake can match, with nothing to see until an auditor
    // tried to reproduce it.
    throw new Error(
      `arccade-game-sdk: require-custody-proof must be a boolean, got ${typeof v}: ${JSON.stringify(v)}`,
    )
  }
  return v
}

export const policyDigest = (policy) => textDigest(policyDocument(policy))

/**
 * A consistent policy. Used in Daml's `ensure`, so an inconsistent policy
 * cannot create a venue at all.
 *
 * THE CRITICAL RULE is `minLockSeconds >= minCycleSeconds`. A lock that can
 * expire mid-cycle is not a lock: the player could leave through
 * `OwnerExpireLockV2` before the minimum duration was up, which would hollow
 * out the minimum-ledger-lock commitment.
 *
 * Amounts are compared in integer 1e-10 units rather than as floats, so
 * `0.0000000001 > 0` is decided by the same arithmetic the ledger uses.
 */
export function validPolicy(policy) {
  const units = (f) => amountUnits(get(policy, f))
  const ints = (f) => toInt64(get(policy, f), f)

  const minStake = units('min-stake-amount')
  const maxStake = units('max-stake-amount')
  const minFee = units('min-platform-fee')
  const maxPayout = units('max-payout-amount')
  const minLock = ints('min-lock-seconds')
  const maxLock = ints('max-lock-seconds')
  const minCycle = ints('min-cycle-seconds')
  const maxCycle = ints('max-cycle-seconds')
  const cooldown = ints('cooldown-seconds')
  const abortCooldown = ints('abort-cooldown-seconds')
  const concurrency = ints('concurrency-limit')

  return (
    minStake > 0n
    && maxStake >= minStake
    && minFee >= 0n
    && maxPayout >= 0n
    && minLock > 0n
    && maxLock >= minLock
    && minCycle > 0n
    && maxCycle >= minCycle
    && minLock >= minCycle
    && cooldown >= 0n
    && abortCooldown >= 0n
    && concurrency > 0n
  )
}
