#!/usr/bin/env node
/**
 * The ways a cycle ends when it does not settle cleanly.
 *
 * `GameStake` is created by exactly one choice and consumed by exactly one of
 * three: `GameStake_Settle`, `GameStake_Abort`, `GameStake_ExpireUnsettled`.
 * There is no fourth state and no administrative override. first-cycle.mjs
 * covers the first. This covers the other two, and — because a claim about
 * custody is only worth what its refusals are worth — it also exercises the
 * things that LOOK like exits and are refused by the ledger.
 *
 * The centrepiece is expiry. `GameStake_ExpireUnsettled` has one controller,
 * `player`, and its Splice counterpart `LockedAmulet_OwnerExpireLockV2` has
 * one controller, `amulet.owner`. After `terms.lockExpiresAt` the player
 * recovers both their slot and their money without arCCade, without the
 * operator and without the DSO. That is the SDK's strongest custody claim and
 * it is a claim about two controller sets, so this script closes a cycle with
 * `actAs: [player]` AND NOTHING ELSE, and first shows the venue being refused
 * when it tries to do the same thing.
 *
 *   node examples/recovery.mjs
 *
 * DRY-RUN, like first-cycle.mjs: no Canton Coin, no disclosed contracts, no
 * `LockedAmulet`. What live mode adds to these paths is the unlock command
 * that rides alongside each closing choice — see live-custody.md, and
 * `buildAbortCommands` / `buildExpireCommands`, which emit both.
 *
 * USE TWO PARTIES. With one party acting as venue, operator and player at
 * once, every submission below carries every authority, and the refusals that
 * carry the whole argument cannot fail. The script detects that and says so
 * rather than printing a check it did not really run.
 *
 * Environment:
 *   LEDGER_URL     JSON Ledger API base       (default http://localhost:7575)
 *   PARTY          venue + operator           (required)
 *   PLAYER_PARTY   the player                 (default PARTY — see above)
 *   USER_ID        ledger API user            (default participant_admin)
 *   AUTH_TOKEN     bearer token, if your participant requires one
 *   LOCK_SECONDS   how long the lock runs     (default 25)
 *   KEEP           set to 1 to skip the cleanup at the end
 */

import {
  buildAbortCommands,
  buildDryRunCommitCommands,
  buildExpireCommands,
  buildSettleCommands,
  canonDocument,
  canonInt,
  canonText,
  newCycleId,
  textDigest,
} from '@arccade/game-sdk'

const LEDGER = (process.env.LEDGER_URL ?? 'http://localhost:7575').replace(/\/+$/, '')
const PARTY = process.env.PARTY
const PLAYER = process.env.PLAYER_PARTY ?? PARTY
const USER_ID = process.env.USER_ID ?? 'participant_admin'
const TOKEN = process.env.AUTH_TOKEN ?? ''
const LOCK_SECONDS = Number(process.env.LOCK_SECONDS ?? 25)
const KEEP = process.env.KEEP === '1'

if (!PARTY) {
  console.error('PARTY is required — the party id you can act as on your participant.')
  process.exit(1)
}

// T7: player and venue as the same party produces a lock with `holders: []`,
// which no settlement can ever verify. It cannot bite in dry-run — nothing is
// locked — but the same configuration is fatal in live mode, so the script
// refuses to model a shape you must not ship.
const SEPARATE_PARTIES = PLAYER !== PARTY

const T = (entity) => `#arccade-game-sdk:ArCCade.GameSdk.Cycle:${entity}`

async function api(path, body) {
  const res = await fetch(LEDGER + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} -> ${res.status}\n${text.slice(0, 800)}`)
  return text ? JSON.parse(text) : {}
}

const submit = (commands, commandId, actAs = [PARTY], readAs = actAs) =>
  api('/v2/commands/submit-and-wait-for-transaction', {
    commands: { commands, commandId, actAs, readAs, userId: USER_ID },
  }).then((r) => r.transaction ?? r)

const created = (tx, entity) => {
  const hit = (tx.events ?? [])
    .map((e) => e.CreatedEvent)
    .filter(Boolean)
    .find((c) => (c.templateId ?? '').endsWith(`:${entity}`))
  if (!hit) throw new Error(`no ${entity} created in ${tx.updateId}`)
  return hit
}

/**
 * Runs a submission that MUST be rejected, and fails the script if it is not.
 *
 * A recovery example that only shows the happy paths would be a statement,
 * not a check: "the venue cannot close the player's cycle" is worth exactly as
 * much as a submission that tries it and is refused. So the failure case here
 * is a SUCCESSFUL submission.
 */
async function mustBeRefused(what, expect, run) {
  let tx
  try {
    tx = await run()
  } catch (e) {
    const message = String(e.message)
    const matched = expect.test(message)
    console.log(`   refused: ${what}`)
    console.log(`     ${firstUsefulLine(message)}`)
    if (!matched) {
      console.error(`\n   The ledger refused it, but not for the expected reason.`)
      console.error(`   Expected the message to match ${expect}`)
      failures.push(`${what}: refused for an unexpected reason`)
    }
    return
  }
  console.error(`\n   ACCEPTED, and it should not have been: ${what}`)
  console.error(`   updateId ${tx.updateId}`)
  failures.push(`${what}: the ledger accepted a submission that must be refused`)
}

/** Daml's own assertion text is the useful part of a ledger error. */
function firstUsefulLine(message) {
  const m = /UNHANDLED_EXCEPTION[^"]*|Interpretation error:[^"]*|[A-Z_]+\(\d+,[^)]*\): [^"\\]*/.exec(message)
  const line = (m ? m[0] : message.split('\n').find((l) => l.trim()) ?? message).trim()
  return line.length > 220 ? `${line.slice(0, 220)}…` : line
}

const failures = []
const step = (n, what) => console.log(`\n${n}. ${what}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------

const stamp = Date.now()
const venueId = `dryrun-example-recovery-${stamp}`
const created_ = []   // everything this run wrote, for the cleanup at the end

console.log(`venue    ${venueId}`)
console.log(`operator ${PARTY}`)
console.log(`player   ${PLAYER}`)
if (!SEPARATE_PARTIES) {
  console.log(`
   ONE PARTY IS ACTING AS BOTH. Every submission below therefore carries both
   the operator's and the player's authority, so the authority refusals in
   steps 4 and 10 cannot fail and are SKIPPED rather than reported as passing.
   Set PLAYER_PARTY to a second party you can act as to run them.`)
}

step(1, 'A venue whose bands make both recovery paths reachable')
// minLockSeconds is the smallest lock a commit may ask for; it must be at
// least minCycleSeconds. Both are set low here ONLY so the expiry path
// finishes while you watch it. In production maxLockSeconds is the number
// that matters: it bounds how long a venue can refuse to co-sign an unlock
// (INTEGRATION 4.3), so set it to the smallest your game can live with.
const policy = {
  minStakeAmount: '10.0000000000',
  maxStakeAmount: '1000.0000000000',
  minPlatformFee: '0.0000000000',
  maxPayoutAmount: '0.0000000000',
  minLockSeconds: '5',
  maxLockSeconds: '172800',
  minCycleSeconds: '1',
  maxCycleSeconds: '7200',
  cooldownSeconds: '0',
  // Deliberately long, and the point of step 5: an aborted cycle is not
  // counted AND its slot stays out of use, so an unfunded commit buys a
  // farmer no throughput.
  abortCooldownSeconds: '120',
  concurrencyLimit: '2',
  requireCustodyProof: false,
}
const venueArgs = {
  venue: PARTY,
  operator: PARTY,
  venueId,
  sdkVersion: '1.5.0',
  mode: 'ModeDryRun',
  gameCodes: ['recovery-v1'],
  policy,
  custody: 'TimeLockedHolding',
  instrumentId: { admin: PARTY, id: 'Amulet' },
  auditor: null,
  roster: null,
  meta: { values: {} },
}
let venueCid = created(
  await submit([{ CreateCommand: { templateId: T('GameVenue'), createArguments: venueArgs } }],
    `venue-${stamp}`),
  'GameVenue').contractId
venueCid = created(
  await submit([{ ExerciseCommand: {
    templateId: T('GameVenue'), contractId: venueCid,
    choice: 'GameVenue_InitRoster', choiceArgument: { shardCapacity: '64' },
  } }], `roster-${stamp}`),
  'GameVenue').contractId
console.log(`   ${venueCid.slice(0, 24)}…  concurrencyLimit 2, abortCooldownSeconds 120`)

step(2, 'Issue the player their two slots')
// Exactly `concurrencyLimit` of them, indices 0..limit-1, one issuance per
// player ever. Two slots means the abort path and the expiry path can each
// hold an open cycle without waiting for the other.
const issueTx = await submit([{ ExerciseCommand: {
  templateId: T('GameVenue'), contractId: venueCid,
  choice: 'GameVenue_IssueEntitlements',
  choiceArgument: { grants: [{ player: PLAYER, concurrencyIndex: '0', tier: 'default' }] },
} }], `issue-${stamp}`)
venueCid = created(issueTx, 'GameVenue').contractId
created_.push({ template: 'GameVenue', cid: venueCid })
for (const e of issueTx.events ?? []) {
  const c = e.CreatedEvent
  if (c && (c.templateId ?? '').endsWith(':PlayerRoster')) {
    created_.push({ template: 'PlayerRoster', cid: c.contractId })
  }
}
const slots = (issueTx.events ?? [])
  .map((e) => e.CreatedEvent)
  .filter((c) => c && (c.templateId ?? '').endsWith(':PlayerEntitlement'))
  .sort((a, b) => Number(a.createArgument.concurrencyIndex) - Number(b.createArgument.concurrencyIndex))
console.log(`   ${slots.length} slots: ${slots.map((s) => s.createArgument.concurrencyIndex).join(', ')}`)

/** Opens a cycle on `entitlementCid` and returns the stake's contract id. */
async function commit(entitlementCid, label) {
  const cycleId = newCycleId(label)
  const entryDocument = canonDocument('recovery-entry', 1, [
    ['cycleId', canonText(cycleId)],
    ['path', canonText(label)],
  ])
  const built = buildDryRunCommitCommands({
    sdkPackageId: '#arccade-game-sdk',
    venue: PARTY, operator: PARTY, player: PLAYER,
    entitlementCid,
    gameCode: 'recovery-v1',
    cycleId,
    entryDigest: textDigest(entryDocument),
    stakeAmount: '30.0',
    instrumentId: venueArgs.instrumentId,
    // T10: ledger time decides, not this clock. Never ask for exactly
    // policy.minLockSeconds — LOCK_SECONDS is five times it by default.
    lockExpiresAt: new Date(Date.now() + LOCK_SECONDS * 1000),
  })
  const tx = await submit(
    built.commands, built.submission.commands.commandId,
    [PLAYER, PARTY], [PLAYER, PARTY])
  const stake = created(tx, 'GameStake')
  return {
    cycleId,
    entryDocument,
    stakeCid: stake.contractId,
    lockExpiresAt: stake.createArgument.terms.lockExpiresAt,
  }
}

/** The recycled slot, and what the closing choice wrote on it. */
function recycled(tx) {
  const e = created(tx, 'PlayerEntitlement')
  return {
    cid: e.contractId,
    index: e.createArgument.concurrencyIndex,
    cyclesCompleted: e.createArgument.cyclesCompleted,
    lifetimeStaked: e.createArgument.lifetimeStaked,
    nextEligibleAt: e.createArgument.nextEligibleAt,
  }
}

// --------------------------------------------------------------- abort ----

step(3, 'Abort — the exit for a cycle that should not have started')
const aborting = await commit(slots[0].contractId, 'abort')
console.log(`   open on slot 0: ${aborting.cycleId}`)
console.log(`   stake ${aborting.stakeCid.slice(0, 24)}…`)

step(4, 'The operator cannot abort alone')
// `GameStake_Abort` is controlled by `operator, player`. A venue that could
// cancel a player's cycle by itself would be making a unilateral decision
// about the player's encumbered funds, which is the whole thing the SDK is
// arguing it does not do.
if (SEPARATE_PARTIES) {
  const solo = buildAbortCommands({
    sdkPackageId: '#arccade-game-sdk',
    venue: PARTY, operator: PARTY, player: PLAYER,
    stakeCid: aborting.stakeCid,
    reason: 'operator acting alone',
  })
  await mustBeRefused(
    'GameStake_Abort submitted as the operator only',
    /authoriz|NOT_AUTHORIZED|requires authorizers|DAML_AUTHORIZATION/i,
    () => submit(solo.commands, `abort-solo-${stamp}`, [PARTY], [PARTY, PLAYER]))
} else {
  console.log('   SKIPPED — one party carries both authorities (set PLAYER_PARTY)')
}

step(5, 'Abort, properly — and the cooldown it writes')
const abort = buildAbortCommands({
  sdkPackageId: '#arccade-game-sdk',
  venue: PARTY, operator: PARTY, player: PLAYER,
  stakeCid: aborting.stakeCid,
  reason: 'funding transfer never landed',
  // In live mode pass the LockedAmulet here if one exists; the proof is
  // optional on purpose, because the premise of an abort is that the
  // encumbrance may never have been created.
  lockedAmuletCid: null,
})
const abortedSlot = recycled(
  await submit(abort.commands, `abort-${stamp}`, [PARTY, PLAYER], [PARTY, PLAYER]))
console.log(`   slot ${abortedSlot.index} back as ${abortedSlot.cid.slice(0, 24)}…`)
console.log(`   cyclesCompleted ${abortedSlot.cyclesCompleted}  (an abort is NOT a cycle)`)
console.log(`   lifetimeStaked  ${abortedSlot.lifetimeStaked}`)
console.log(`   nextEligibleAt  ${abortedSlot.nextEligibleAt}  (+abortCooldownSeconds)`)
if (abortedSlot.cyclesCompleted !== '0' || Number(abortedSlot.lifetimeStaked) !== 0) {
  failures.push('abort incremented the cycle counters')
}

step(6, 'The cooldown is the ledger\'s, not the operator\'s')
// Not a scheduler and not a service: the returned slot carries nextEligibleAt
// and `Entitlement_Commit` asserts against it from getTime.
await mustBeRefused(
  'a second commit on the slot the abort returned',
  /cooldown/i,
  () => commit(abortedSlot.cid, 'too-soon'))

// -------------------------------------------------------------- expiry ----

step(7, 'Expiry — the path the player walks alone')
const expiring = await commit(slots[1].contractId, 'expire')
console.log(`   open on slot 1: ${expiring.cycleId}`)
console.log(`   stake ${expiring.stakeCid.slice(0, 24)}…`)
console.log(`   lockExpiresAt ${expiring.lockExpiresAt}`)

const expire = buildExpireCommands({
  sdkPackageId: '#arccade-game-sdk',
  amuletPackageId: '#splice-amulet',
  player: PLAYER,
  stakeCid: expiring.stakeCid,
  // Live mode: pass the LockedAmulet and the builder appends
  // LockedAmulet_OwnerExpireLockV2 — also controlled by the owner alone.
  lockedAmuletCid: null,
})
console.log(`   buildExpireCommands actAs: [${expire.actAs.join(', ')}]`)
if (expire.actAs.length !== 1 || expire.actAs[0] !== PLAYER) {
  failures.push('buildExpireCommands emitted an actAs that is not the player alone')
}

step(8, 'Before the lock expires, nobody can take this exit — the player included')
// The expiry is not a cancel button. It opens at a time the ledger reads from
// getTime, not at a time either side declares.
await mustBeRefused(
  'GameStake_ExpireUnsettled before terms.lockExpiresAt',
  /kilit suresi henuz dolmadi|lock has not/i,
  () => submit(expire.commands, `expire-early-${stamp}`, [PLAYER], [PLAYER]))

step(9, `Wait out the lock  (${LOCK_SECONDS}s from commit, plus margin)`)
// T11: secondsBetween truncates each endpoint independently, so a submission
// aimed at the exact boundary is a coin flip. Wait past it.
const waitMs = Math.max(0, Date.parse(expiring.lockExpiresAt) - Date.now()) + 3000
console.log(`   sleeping ${Math.round(waitMs / 1000)}s`)
await sleep(waitMs)

step(10, 'Now the choice is open — and the venue still cannot take it')
// This is the assertion the custody claim rests on, stated as a submission
// rather than as a sentence, and made at the moment it matters: the time
// condition is satisfied, the exact same commands go up, and the only thing
// missing is the player. `controller player` — not `operator, player`, not
// `venue`. The venue is a signatory of the stake and can read every field of
// it, and still cannot exercise this choice.
if (SEPARATE_PARTIES) {
  await mustBeRefused(
    'GameStake_ExpireUnsettled submitted as venue + operator, without the player',
    /authoriz|NOT_AUTHORIZED|requires authorizers|DAML_AUTHORIZATION/i,
    () => submit(expire.commands, `expire-venue-${stamp}`, [PARTY], [PARTY, PLAYER]))
} else {
  console.log('   SKIPPED — one party carries both authorities (set PLAYER_PARTY)')
}

step(11, 'The player closes it, with nobody else\'s signature')
const expiredSlot = recycled(
  await submit(expire.commands, `expire-${stamp}`, [PLAYER], [PLAYER]))
console.log(`   submitted actAs: [${PLAYER}]`)
console.log(`   slot ${expiredSlot.index} back as ${expiredSlot.cid.slice(0, 24)}…`)
console.log(`   cyclesCompleted ${expiredSlot.cyclesCompleted}  (an expiry is NOT a cycle)`)
console.log(`   nextEligibleAt  ${expiredSlot.nextEligibleAt}  (now — expiry writes no cooldown)`)
if (expiredSlot.cyclesCompleted !== '0') failures.push('expiry incremented the cycle counter')
console.log(`
   That submission carried one authority. No operator, no venue, no DSO, and
   in live mode the money comes back the same way: LockedAmulet_OwnerExpireLockV2
   is controlled by the amulet's owner alone, in Splice's package, with nothing
   of arCCade's in the controller set. There is no state in which the venue can
   strand a player's funds or their slot.`)

step(12, 'The expired slot is usable immediately')
// Which is also how you can tell the two paths apart from outside: abort
// writes abortCooldownSeconds, expiry writes `now`. A venue cannot dress an
// abort up as an expiry, because it cannot exercise the expiry at all.
const reused = await commit(expiredSlot.cid, 'after-expiry')
console.log(`   ${reused.cycleId} open on slot ${expiredSlot.index}`)

// ------------------------------------------------- the exit that is not ----

step(13, 'The exit that does not exist: forfeiting a time-locked stake')
// Not policy — mechanics. LockedAmulet_UnlockV2 always pays the full amount
// to the owner and a locked amulet is not a valid transfer input, so routing
// part of the stake to the venue would need a third write. The contract
// refuses rather than letting that write appear quietly.
const forfeit = buildSettleCommands({
  sdkPackageId: '#arccade-game-sdk',
  venue: PARTY, operator: PARTY, player: PLAYER,
  stakeCid: reused.stakeCid,
  lockedAmuletCid: null,
  disposition: 'ForfeitedInFull',
  returnedAmount: '0.0',
  forfeitedAmount: '30.0',
  outcomeDocument: canonDocument('recovery-outcome', 1, [
    ['cycleId', canonText(reused.cycleId)],
    ['score', canonInt(0)],
  ]),
  revealedEntry: reused.entryDocument,
})
await mustBeRefused(
  'GameStake_Settle with forfeitedAmount > 0 on TimeLockedHolding',
  /musadere|forfeit/i,
  () => submit(forfeit.commands, `forfeit-${stamp}`, [PARTY], [PARTY, PLAYER]))
console.log(`   take the at-risk amount as terms.feeAmount AT COMMIT instead: a fee
     spent before the outcome exists cannot be dodged by refusing to settle.`)

step(14, 'Close the last cycle the ordinary way')
const outcomeDocument = canonDocument('recovery-outcome', 1, [
  ['cycleId', canonText(reused.cycleId)],
  ['score', canonInt(7)],
])
const settle = buildSettleCommands({
  sdkPackageId: '#arccade-game-sdk',
  venue: PARTY, operator: PARTY, player: PLAYER,
  stakeCid: reused.stakeCid,
  lockedAmuletCid: null,
  disposition: 'ReturnedInFull',
  returnedAmount: '30.0',
  outcomeDocument,
  revealedEntry: reused.entryDocument,
})
const settledSlot = recycled(
  await submit(settle.commands, `settle-${stamp}`, [PARTY], [PARTY, PLAYER]))
console.log(`   cyclesCompleted ${settledSlot.cyclesCompleted}  (this one counted)`)
console.log(`   lifetimeStaked  ${settledSlot.lifetimeStaked}`)
if (settledSlot.cyclesCompleted !== '1') {
  failures.push('a clean settlement did not increment the cycle counter')
}

// ------------------------------------------------------------- cleanup ----

if (KEEP) {
  console.log('\nKEEP=1 — leaving the venue, roster and slot on the ledger.')
} else {
  step(15, 'Archive everything this run created')
  // T15: dev-loop leftovers are how an ACS grows into 413s on list queries.
  // Every template here is signed by the operator alone, so one actAs closes
  // all of them.
  const toArchive = [
    ...created_,
    { template: 'PlayerEntitlement', cid: settledSlot.cid },
    { template: 'PlayerEntitlement', cid: abortedSlot.cid },
  ]
  for (const { template, cid } of toArchive) {
    await submit([{ ExerciseCommand: {
      templateId: T(template), contractId: cid, choice: 'Archive', choiceArgument: {},
    } }], `archive-${template}-${cid.slice(0, 12)}`, [PARTY], [PARTY])
  }
  console.log(`   archived ${toArchive.length}: ${toArchive.map((c) => c.template).join(', ')}`)
  // Ask the ledger rather than believing the loop above.
  const { offset } = await api('/v2/state/ledger-end')
  const acs = await api('/v2/state/active-contracts', {
    filter: { filtersByParty: { [PARTY]: { cumulative: [
      { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
    ] } } },
    verbose: false,
    activeAtOffset: offset,
  })
  const left = acs
    .map((e) => e?.contractEntry?.JsActiveContract?.createdEvent)
    .filter((c) => c && JSON.stringify(c.createArgument ?? {}).includes(venueId))
  console.log(`   contracts still active for ${venueId}: ${left.length}`)
  if (left.length > 0) {
    for (const c of left) console.log(`     ${c.templateId} ${c.contractId.slice(0, 24)}…`)
    failures.push('cleanup left contracts behind')
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`
Done. Three exits, and only three: settled, aborted, expired. The one that
matters is the one the player takes without asking.
`)
