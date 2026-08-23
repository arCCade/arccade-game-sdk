/**
 * Komut kurucu testleri — dongu disiplininin kodda zorlandigini dogrular.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAbortCommands,
  buildCommitCommands,
  buildExpireCommands,
  buildSettleCommands,
  custodyTagFor,
  newCycleId,
} from '../src/cycle.js'
import { textDigest } from '../src/digest.js'

const SDK_PKG = 'a'.repeat(64)
const AMULET_PKG = 'b'.repeat(64)
const VENUE = 'venue::1220aa'
const OPERATOR = 'operator::1220bb'
const PLAYER = 'player::1220cc'
const DIGEST = textDigest('giris-belgesi')

const baseCommit = {
  sdkPackageId: SDK_PKG,
  amuletPackageId: AMULET_PKG,
  venue: VENUE,
  operator: OPERATOR,
  player: PLAYER,
  entitlementCid: '00ent',
  gameCode: 'trade-wars-v4',
  cycleId: 'tw-1',
  entryDigest: DIGEST,
  stakeAmount: '100.0',
  feeAmount: '0.5',
  instrumentId: { admin: 'dso::1220dd', id: 'Amulet' },
  lockExpiresAt: '2026-12-31T00:00:00Z',
  amuletRulesCid: '00rules',
  openMiningRoundCid: '00round',
  inputAmuletCids: ['00am1'],
  dsoParty: 'dso::1220dd',
}

test('YAZMA 1 tam olarak iki komut uretir, tek gonderimde', () => {
  const r = buildCommitCommands(baseCommit)
  assert.equal(r.commands.length, 2)
  assert.equal(r.submission.commands.commands.length, 2)
  assert.equal(r.commands[0].ExerciseCommand.choice, 'AmuletRules_Transfer')
  assert.equal(r.commands[1].ExerciseCommand.choice, 'Entitlement_Commit')
})

test('kilit baglami custody etiketini tasir, jenerik metin degil', () => {
  const r = buildCommitCommands(baseCommit)
  const transfer = r.commands[0].ExerciseCommand.choiceArgument.transfer
  const stakeOutput = transfer.outputs.find((o) => o.lock)
  assert.equal(stakeOutput.lock.optContext, custodyTagFor('tw-1', DIGEST))
  assert.deepEqual(stakeOutput.lock.holders, [VENUE])
  assert.equal(stakeOutput.receiver, PLAYER)
})

test('ucret ayri bir cikti olarak ayni transfere binir', () => {
  const r = buildCommitCommands(baseCommit)
  const outputs = r.commands[0].ExerciseCommand.choiceArgument.transfer.outputs
  assert.equal(outputs.length, 2)
  const fee = outputs.find((o) => !o.lock)
  assert.equal(fee.receiver, VENUE)
  assert.equal(fee.amount, '0.5')
})

test('ucret sifirsa fee ciktisi eklenmez', () => {
  const r = buildCommitCommands({ ...baseCommit, feeAmount: '0.0' })
  const outputs = r.commands[0].ExerciseCommand.choiceArgument.transfer.outputs
  assert.equal(outputs.length, 1)
  assert.ok(outputs[0].lock)
})

test('commit ve stake ayni etiketi kullanir', () => {
  const r = buildCommitCommands(baseCommit)
  const terms = r.commands[1].ExerciseCommand.choiceArgument.terms
  const lock = r.commands[0].ExerciseCommand.choiceArgument.transfer.outputs.find((o) => o.lock)
  assert.equal(terms.custodyTag, lock.lock.optContext)
  assert.equal(terms.lockExpiresAt, lock.lock.expiresAt)
})

test('girdi Amulet yoksa reddedilir', () => {
  assert.throws(() => buildCommitCommands({ ...baseCommit, inputAmuletCids: [] }), /girdi/)
})

test('gecersiz cycleId reddedilir', () => {
  assert.throws(() => buildCommitCommands({ ...baseCommit, cycleId: 'a:b' }), /iceremez/)
  assert.throws(() => buildCommitCommands({ ...baseCommit, cycleId: '' }), /gecersiz cycleId/)
  assert.throws(() => buildCommitCommands({ ...baseCommit, cycleId: 'x'.repeat(65) }), /gecersiz cycleId/)
})

test('newCycleId benzersiz ve gecerli uretir', () => {
  const a = newCycleId('tw')
  const b = newCycleId('tw')
  assert.notEqual(a, b)
  assert.ok(a.length <= 64)
  assert.ok(!a.includes(':'))
})

test('YAZMA 2 sirasi: Settle once, Unlock sonra', () => {
  const r = buildSettleCommands({
    sdkPackageId: SDK_PKG,
    amuletPackageId: AMULET_PKG,
    venue: VENUE,
    operator: OPERATOR,
    player: PLAYER,
    stakeCid: '00stake0000000000',
    lockedAmuletCid: '00locked',
    returnedAmount: '100.0',
    outcomeDocument: 'sonuc-belgesi',
  })
  assert.equal(r.commands.length, 2)
  assert.equal(r.commands[0].ExerciseCommand.choice, 'GameStake_Settle')
  assert.equal(r.commands[1].ExerciseCommand.choice, 'LockedAmulet_UnlockV2')
})

test('settlement disposition ile tutarlari celismeye birakmaz', () => {
  const base = {
    sdkPackageId: SDK_PKG, amuletPackageId: AMULET_PKG,
    venue: VENUE, operator: OPERATOR, player: PLAYER,
    stakeCid: '00stake0000000000', lockedAmuletCid: '00locked',
    outcomeDocument: 'x',
  }
  assert.throws(
    () => buildSettleCommands({ ...base, returnedAmount: '60.0', forfeitedAmount: '40.0' }),
    /ReturnedInFull/,
  )
  assert.throws(
    () => buildSettleCommands({ ...base, disposition: 'ForfeitedInFull', returnedAmount: '100.0' }),
    /ForfeitedInFull/,
  )
})

test('sonuc belgesi verilince digest kendiliginden hesaplanir', () => {
  const doc = 'sonuc-belgesi-v1'
  const r = buildSettleCommands({
    sdkPackageId: SDK_PKG, amuletPackageId: AMULET_PKG,
    venue: VENUE, operator: OPERATOR, player: PLAYER,
    stakeCid: '00stake0000000000', lockedAmuletCid: '00locked',
    returnedAmount: '100.0', outcomeDocument: doc,
  })
  assert.equal(r.outcomeDigest, textDigest(doc))
  assert.equal(r.commands[0].ExerciseCommand.choiceArgument.revealedOutcome, doc)
})

test('abort kaniti istege bagli, actAs operator+player', () => {
  const r = buildAbortCommands({
    sdkPackageId: SDK_PKG, venue: VENUE, operator: OPERATOR, player: PLAYER,
    stakeCid: '00stake0000000000', reason: 'transfer gerceklesmedi',
  })
  assert.equal(r.commands.length, 1)
  assert.equal(r.commands[0].ExerciseCommand.choiceArgument.custodyRef, null)
  assert.deepEqual(r.actAs, [OPERATOR, PLAYER])
})

test('cikis yolu yalnizca oyuncunun imzasini gerektirir', () => {
  const r = buildExpireCommands({
    sdkPackageId: SDK_PKG, amuletPackageId: AMULET_PKG,
    player: PLAYER, stakeCid: '00stake0000000000', lockedAmuletCid: '00locked',
  })
  assert.deepEqual(r.actAs, [PLAYER])
  assert.equal(r.commands[0].ExerciseCommand.choice, 'GameStake_ExpireUnsettled')
  assert.equal(r.commands[1].ExerciseCommand.choice, 'LockedAmulet_OwnerExpireLockV2')
})
