/**
 * The venue policy document.
 *
 * The digests below are the ones `GameStake.policyHash` carries on TestNet. A
 * policy document that does not reproduce them answers "under which rules was
 * this cycle opened" with a different set of rules.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { POLICY_FIELDS, policyDigest, policyDocument, validPolicy } from '../src/index.js'

/** The representative policy, keyed the way the document names its fields. */
const POLICY = {
  'min-stake-amount': '1.0',
  'max-stake-amount': '1000.0',
  'min-platform-fee': '0.5',
  'max-payout-amount': '5000.0',
  'min-lock-seconds': 7200n,
  'max-lock-seconds': 86400n,
  'min-cycle-seconds': 60n,
  'max-cycle-seconds': 3600n,
  'cooldown-seconds': 30n,
  'abort-cooldown-seconds': 300n,
  'concurrency-limit': 3n,
  'require-custody-proof': true,
}

test('the representative policy reproduces the pinned document and digest', () => {
  assert.equal(
    policyDocument(POLICY),
    'arccade-sdk-digest-v1|t:20:arccade-venue-policyi:1:1r:417:'
    + 'k:22:abort-cooldown-seconds=i:3:300;k:17:concurrency-limit=i:1:3;'
    + 'k:16:cooldown-seconds=i:2:30;k:17:max-cycle-seconds=i:4:3600;'
    + 'k:16:max-lock-seconds=i:5:86400;k:17:max-payout-amount=d:14:50000000000000;'
    + 'k:16:max-stake-amount=d:14:10000000000000;k:17:min-cycle-seconds=i:2:60;'
    + 'k:16:min-lock-seconds=i:4:7200;k:16:min-platform-fee=d:10:5000000000;'
    + 'k:16:min-stake-amount=d:11:10000000000;k:21:require-custody-proof=b:4:true;',
  )
  assert.equal(policyDigest(POLICY), '4ec4e8bc990d8b0f75e992202bcbdf6524ffe190f5367e874cd64ad5c4b8ed2e')
})

test('amounts are DECIMALS here and units in an audit row', () => {
  // A policy is authored in decimals; a row carries units already converted.
  // Applying one convention to both produces a policy digest no stake can
  // match — `1.0` is `d:11:10000000000`, not `d:1:1`.
  assert.ok(policyDocument(POLICY).includes('min-stake-amount=d:11:10000000000;'))
  const finest = { ...POLICY, 'min-stake-amount': '0.0000000001', 'max-payout-amount': '0.0' }
  assert.ok(policyDocument(finest).includes('min-stake-amount=d:1:1;'))
  assert.equal(policyDigest(finest), '7d3838db6df6baeb28b3a49de2f6f0a50244be055fecb41204b43874a25113cc')
})

test('the boolean is encoded, not made truthy', () => {
  assert.equal(
    policyDigest({ ...POLICY, 'require-custody-proof': false }),
    'd71b7a2ce4df0636482ed8a563a5b84417929a1c5847292e806d4201f3765942',
  )
  // "false" is a non-empty string and would encode as true under truthiness.
  assert.throws(() => policyDocument({ ...POLICY, 'require-custody-proof': 'false' }), /must be a boolean/)
})

test('all three spellings of a field name name the same policy', () => {
  const camel = {
    minStakeAmount: '1.0', maxStakeAmount: '1000.0', minPlatformFee: '0.5',
    maxPayoutAmount: '5000.0', minLockSeconds: 7200n, maxLockSeconds: 86400n,
    minCycleSeconds: 60n, maxCycleSeconds: 3600n, cooldownSeconds: 30n,
    abortCooldownSeconds: 300n, concurrencyLimit: 3n, requireCustodyProof: true,
  }
  const snake = Object.fromEntries(
    POLICY_FIELDS.map((f) => [f.replaceAll('-', '_'), POLICY[f]]),
  )
  assert.equal(policyDigest(camel), policyDigest(POLICY))
  assert.equal(policyDigest(snake), policyDigest(POLICY))
})

test('a missing field is refused rather than encoded as absent', () => {
  const { 'cooldown-seconds': _, ...missing } = POLICY
  assert.throws(() => policyDocument(missing), /policy field is missing: cooldown-seconds/)
})

test('the representative policy is consistent', () => {
  assert.equal(validPolicy(POLICY), true)
})

test('a lock that can expire mid-cycle is not a lock', () => {
  // THE critical rule: with minLock < minCycle the player could leave through
  // OwnerExpireLockV2 before the minimum duration was up.
  assert.equal(validPolicy({ ...POLICY, 'min-lock-seconds': 30n }), false)
})

test('the remaining consistency rules each refuse on their own', () => {
  assert.equal(validPolicy({ ...POLICY, 'min-stake-amount': '0.0' }), false)
  assert.equal(validPolicy({ ...POLICY, 'max-stake-amount': '0.5' }), false)
  assert.equal(validPolicy({ ...POLICY, 'concurrency-limit': 0n }), false)
  assert.equal(validPolicy({ ...POLICY, 'max-lock-seconds': 60n }), false)
  assert.equal(validPolicy({ ...POLICY, 'min-cycle-seconds': 0n }), false)
  assert.equal(validPolicy({ ...POLICY, 'max-cycle-seconds': 30n }), false)
  assert.equal(validPolicy({ ...POLICY, 'min-platform-fee': '-0.1' }), false)
  assert.equal(validPolicy({ ...POLICY, 'max-payout-amount': '-1.0' }), false)
  assert.equal(validPolicy({ ...POLICY, 'cooldown-seconds': -1n }), false)
  assert.equal(validPolicy({ ...POLICY, 'abort-cooldown-seconds': -1n }), false)
})

test('the finest representable stake floor is above zero', () => {
  // Decided in integer 1e-10 units, the same arithmetic the ledger uses; a
  // float comparison of 1e-10 > 0 happens to agree, and happening to agree is
  // not the property wanted here.
  assert.equal(validPolicy({ ...POLICY, 'min-stake-amount': '0.0000000001' }), true)
})
