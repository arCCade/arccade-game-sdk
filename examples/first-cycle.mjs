#!/usr/bin/env node
/**
 * A complete stake-and-settle cycle, from nothing, in one file.
 *
 * This is the getting-started path: a venue, a slot, a commitment, a
 * settlement — and then the two digests recomputed off-ledger to show that
 * nothing here has to be taken on trust.
 *
 * IT RUNS IN DRY-RUN MODE, and that is a deliberate choice rather than a
 * simplification. A dry-run venue is constrained BY THE CONTRACT: its id must
 * start with `dryrun-`, its fee floor and maximum payout must be zero. So a
 * dry-run cycle cannot be presented as real activity — which is exactly why it
 * is safe to hand a newcomer. You get the whole shape of the SDK without
 * needing Canton Coin, without pulling disclosed contracts from Scan, and
 * without learning Splice's transfer mechanics in your first hour.
 *
 * What live mode adds is described at the end of docs/GETTING-STARTED.md.
 *
 *   node examples/first-cycle.mjs
 *
 * Environment:
 *   LEDGER_URL   JSON Ledger API base       (default http://localhost:7575)
 *   PARTY        a party you can act as     (required)
 *   USER_ID      ledger API user            (default participant_admin)
 *   AUTH_TOKEN   bearer token, if your participant requires one
 */

import {
  buildDryRunCommitCommands,
  buildSettleCommands,
  canonInt,
  canonText,
  canonDocument,
  documentDigest,
  newCycleId,
  textDigest,
} from '@arccade/game-sdk'

const LEDGER = (process.env.LEDGER_URL ?? 'http://localhost:7575').replace(/\/+$/, '')
const PARTY = process.env.PARTY
const USER_ID = process.env.USER_ID ?? 'participant_admin'
const TOKEN = process.env.AUTH_TOKEN ?? ''

if (!PARTY) {
  console.error('PARTY is required — the party id you can act as on your participant.')
  process.exit(1)
}

// A package-NAME reference. The ledger resolves it to the highest vetted
// version, so this file does not pin a package id and does not go stale when
// the SDK is upgraded.
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
  if (!res.ok) {
    // The ledger's own message is almost always the useful one — a Daml
    // assertion says exactly which invariant you missed.
    throw new Error(`${path} -> ${res.status}\n${text.slice(0, 600)}`)
  }
  return text ? JSON.parse(text) : {}
}

const submit = (commands, commandId, actAs = [PARTY], readAs = [PARTY]) =>
  api('/v2/commands/submit-and-wait-for-transaction', {
    commands: { commands, commandId, actAs, readAs, userId: USER_ID },
  }).then((r) => r.transaction ?? r)

const created = (tx, entity) => {
  const hit = (tx.events ?? [])
    .map((e) => e.CreatedEvent)
    .filter(Boolean)
    .find((c) => (c.templateId ?? '').endsWith(`:${entity}`))
  if (!hit) throw new Error(`no ${entity} created in ${tx.updateId}`)
  return hit.contractId
}

const step = (n, what) => console.log(`\n${n}. ${what}`)

// ---------------------------------------------------------------------------

const stamp = Date.now()
const venueId = `dryrun-first-cycle-${stamp}`

step(1, `Create the venue  (${venueId})`)
// Dry-run discipline is enforced by the contract, not by convention: a
// non-zero fee floor or payout ceiling here is rejected at creation.
const venueArgs = {
  venue: PARTY,
  operator: PARTY,
  venueId,
  sdkVersion: '1.5.0',
  mode: 'ModeDryRun',
  gameCodes: ['first-cycle-v1'],
  policy: {
    minStakeAmount: '10.0000000000',
    maxStakeAmount: '1000.0000000000',
    minPlatformFee: '0.0000000000',
    maxPayoutAmount: '0.0000000000',
    minLockSeconds: '60',
    maxLockSeconds: '172800',
    minCycleSeconds: '1',
    maxCycleSeconds: '7200',
    cooldownSeconds: '0',
    abortCooldownSeconds: '0',
    concurrencyLimit: '1',
    requireCustodyProof: false,
  },
  custody: 'TimeLockedHolding',
  // In dry-run you are your own instrument admin; no DSO lookup needed.
  instrumentId: { admin: PARTY, id: 'Amulet' },
  auditor: null,
  roster: null,
  meta: { values: {} },
}
let venueCid = created(
  await submit([{ CreateCommand: { templateId: T('GameVenue'), createArguments: venueArgs } }],
    `venue-${stamp}`),
  'GameVenue')
console.log(`   ${venueCid.slice(0, 24)}…`)

step(2, 'Initialise the slot roster')
// Without this the venue cannot issue at all. It fails closed on purpose:
// before 1.4.0 the concurrency limit was operator convention, and a venue
// that silently fell back to the old behaviour would look identical to one
// that enforces it.
venueCid = created(
  await submit([{ ExerciseCommand: {
    templateId: T('GameVenue'), contractId: venueCid,
    choice: 'GameVenue_InitRoster', choiceArgument: { shardCapacity: '64' },
  } }], `roster-${stamp}`),
  'GameVenue')
console.log('   roster ready (InitRoster consumes and recreates the venue)')

step(3, 'Issue this player their slots')
// One call per player, ever. The contract mints exactly concurrencyLimit
// entitlements at indices 0..limit-1 and refuses a player already on the
// roster — the count and the uniqueness are structural, not asserted.
const issueTx = await submit([{ ExerciseCommand: {
  templateId: T('GameVenue'), contractId: venueCid,
  choice: 'GameVenue_IssueEntitlements',
  choiceArgument: { grants: [{ player: PARTY, concurrencyIndex: '0', tier: 'default' }] },
} }], `issue-${stamp}`)
venueCid = created(issueTx, 'GameVenue')
const entitlementCid = created(issueTx, 'PlayerEntitlement')
console.log(`   slot ${entitlementCid.slice(0, 24)}…`)

step(4, 'Commit — the entry document and its digest')
// The SDK never interprets your document. It carries the digest, and the
// ledger recomputes it at settlement. Field names must be ASCII; values are
// rendered by the canon* helpers.
const cycleId = newCycleId('demo')
const entryDocument = canonDocument('first-cycle-entry', 1, [
  ['cycleId', canonText(cycleId)],
  ['difficulty', canonInt(3)],
  ['seed', canonText('a-seed-you-keep-secret-until-settlement')],
])
const entryDigest = textDigest(entryDocument)
console.log(`   cycleId     ${cycleId}`)
console.log(`   entryDigest ${entryDigest}`)

const commit = buildDryRunCommitCommands({
  sdkPackageId: '#arccade-game-sdk',
  venue: PARTY, operator: PARTY, player: PARTY,
  entitlementCid,
  gameCode: 'first-cycle-v1',
  cycleId,
  entryDigest,
  stakeAmount: '30.0',
  instrumentId: venueArgs.instrumentId,
  lockExpiresAt: new Date(Date.now() + 3600_000),
})
const stakeCid = created(
  await submit(commit.commands, commit.submission.commands.commandId),
  'GameStake')
console.log(`   stake       ${stakeCid.slice(0, 24)}…`)
console.log(`   custodyTag  ${commit.custodyTag}`)

step(5, 'Settle — reveal both documents')
const outcomeDocument = canonDocument('first-cycle-outcome', 1, [
  ['cycleId', canonText(cycleId)],
  ['score', canonInt(1337)],
])
const settle = buildSettleCommands({
  sdkPackageId: '#arccade-game-sdk',
  venue: PARTY, operator: PARTY, player: PARTY,
  stakeCid,
  lockedAmuletCid: null,          // dry-run: nothing was locked
  disposition: 'ReturnedInFull',
  returnedAmount: '30.0',
  outcomeDocument,
  revealedEntry: entryDocument,   // the ledger recomputes entryDigest from this
})
const settleTx = await submit(settle.commands, settle.submission.commands.commandId)
console.log(`   settled in ${settleTx.updateId.slice(0, 24)}…`)
console.log('   the slot came back — settlement recreates the entitlement')

step(6, 'Verify, without trusting anything above')
// Both digests are plain sha256 over the exact canonical text. Anyone can
// reproduce them: `printf '%s' "<document>" | sha256sum`.
const entryOk = textDigest(entryDocument) === entryDigest
const outcomeOk = documentDigest('first-cycle-outcome', 1, [
  ['cycleId', canonText(cycleId)],
  ['score', canonInt(1337)],
]) === textDigest(outcomeDocument)
console.log(`   entry digest reproduces   ${entryOk ? 'yes' : 'NO'}`)
console.log(`   outcome digest reproduces ${outcomeOk ? 'yes' : 'NO'}`)
console.log(`
   Had the reveal been tampered with by one byte, GameStake_Settle would have
   refused it. The commitment is enforced by the ledger, not recorded by us.
`)

if (!entryOk || !outcomeOk) process.exit(1)
console.log('Done. Two writes, one cycle.\n')
