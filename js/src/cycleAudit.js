/**
 * Rebuilds period-report rows from the ledger's TRANSACTION TREE stream.
 *
 * WHY THIS EXISTS AND WHY IT IS IN THE SDK. If the rows behind a period anchor
 * come from the game's own database, the anchor commits to arCCade's record of
 * what happened — a signature on our own bookkeeping. It is evidence only if
 * the rows derive from the same stream an auditor reads. And that derivation
 * has to be something anyone can run, in whatever language they already have,
 * or "verifiable" means "verifiable by arCCade".
 *
 * `test-vectors/cycle-trees.json` holds real transactions captured from
 * TestNet, and `test-vectors/cycle-rows.json` the rows they must produce.
 * Every implementation is pinned to the same pair.
 *
 * ## The shape of a cycle in the tree
 *
 * Two transactions. The commit carries the whole entry half in the `GameStake`
 * create argument; the closing carries the exit half in its choice argument.
 *
 * THE JOIN KEY IS THE STAKE CONTRACT ID, NOT THE CYCLE ID. A closing choice
 * does not repeat `cycleId` — it lives on the contract being exercised. The
 * commit's `exerciseResult` is that contract id, which is the only thing
 * linking the two halves in the stream.
 *
 * ## Where each field comes from, and what is derived rather than read
 *
 * `GameStake_Settle` states the amounts and the outcome digest. `_Abort`
 * carries only a reason; `_ExpireUnsettled` carries nothing at all. For those
 * two the amounts are DERIVED from the mechanic rather than read: unlocking a
 * TimeLockedHolding always pays the owner in full, and settlement refuses a
 * non-zero forfeit on this mechanic, so an aborted or expired cycle returns
 * the stake and moves nothing else. `outcomeDigest` is empty because no
 * outcome ever existed — not because we failed to find one.
 *
 * When the unlock happens in the SAME transaction, the created `Amulet` gives
 * an independent reading of the returned amount, and {@link rowsFromTransactions}
 * reports a mismatch instead of trusting the argument. It is not always there:
 * a settlement with no `custodyRef`, and every expiry, leave the unlock to a
 * separate transaction.
 */

import { amountUnits, canonInt } from './digest.js'

const SDK_MODULE = 'ArCCade.GameSdk.Cycle'

const CLOSING_CHOICES = Object.freeze({
  GameStake_Settle: null, // stated in the argument
  GameStake_Abort: 'aborted',
  GameStake_ExpireUnsettled: 'expired-unsettled',
})

/** Daml constructor -> the tag that goes into the canonical document. */
const DISPOSITION_TAGS = Object.freeze({
  ReturnedInFull: 'returned-in-full',
  ReturnedWithForfeit: 'returned-with-forfeit',
  ForfeitedInFull: 'forfeited-in-full',
  Aborted: 'aborted',
  ExpiredUnsettled: 'expired-unsettled',
})

/** ISO 8601 -> integer microseconds since the epoch. */
export function isoToMicros(iso) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(iso)
  if (!m) throw new Error(`arccade-game-sdk: unparsable ledger timestamp: ${iso}`)
  const seconds = Math.floor(Date.parse(`${m[1]}Z`) / 1000)
  // Ledger timestamps are microsecond-precision; JS Date would truncate to
  // milliseconds and the canonical document would differ from Daml's.
  const fraction = ((m[2] ?? '') + '000000').slice(0, 6)
  return BigInt(seconds) * 1000000n + BigInt(fraction)
}

function eventsOf(transaction) {
  return transaction?.events ?? []
}

function exercisedNodes(transaction) {
  return eventsOf(transaction)
    .map((e) => e.ExercisedEvent)
    .filter(Boolean)
}

function createdNodes(transaction) {
  return eventsOf(transaction)
    .map((e) => e.CreatedEvent)
    .filter(Boolean)
}

const isSdk = (node, entity) =>
  (node?.templateId ?? '').includes(`${SDK_MODULE}:${entity}`)

/**
 * The commit half: the created GameStake, keyed by its contract id.
 * Returns null when this transaction is not a commit.
 */
export function commitFacts(transaction) {
  const commit = exercisedNodes(transaction)
    .find((x) => x.choice === 'Entitlement_Commit' && isSdk(x, 'PlayerEntitlement'))
  if (!commit) return null
  const stake = createdNodes(transaction).find((c) => isSdk(c, 'GameStake'))
  if (!stake) return null
  const a = stake.createArgument
  return {
    stakeContractId: stake.contractId,
    updateId: transaction.updateId,
    venueId: a.venueId,
    cycleId: a.cycleId,
    player: a.player,
    gameCode: a.gameCode,
    concurrencyIndex: BigInt(a.concurrencyIndex),
    entryDigest: a.entryDigest,
    committedAtMicros: isoToMicros(a.committedAt),
    committedUnits: amountUnits(a.terms.stakeAmount),
    feeUnits: amountUnits(a.terms.feeAmount),
    custodyTag: a.terms.custodyTag,
  }
}

/**
 * The closing half. Returns null when this transaction closes nothing.
 *
 * `unlockedUnits` is present only when the unlock rode in this transaction;
 * it is a cross-check, not the source of truth.
 */
export function closingFacts(transaction) {
  const closing = exercisedNodes(transaction)
    .find((x) => isSdk(x, 'GameStake') && x.choice in CLOSING_CHOICES)
  if (!closing) return null
  const arg = closing.choiceArgument ?? {}
  const unlocked = createdNodes(transaction).find((c) => (c.templateId ?? '').endsWith(':Amulet'))
  return {
    stakeContractId: closing.contractId,
    updateId: transaction.updateId,
    choice: closing.choice,
    settledAtMicros: isoToMicros(transaction.effectiveAt),
    argument: arg,
    unlockedUnits: unlocked ? amountUnits(unlocked.createArgument.amount.initialAmount) : null,
  }
}

function exitAmounts(commit, closing) {
  if (closing.choice === 'GameStake_Settle') {
    const tag = DISPOSITION_TAGS[closing.argument.disposition]
    if (!tag) {
      throw new Error(
        `arccade-game-sdk: unknown disposition ${JSON.stringify(closing.argument.disposition)}`,
      )
    }
    return {
      disposition: tag,
      outcomeDigest: closing.argument.outcomeDigest ?? '',
      returnedUnits: amountUnits(closing.argument.returnedAmount),
      forfeitedUnits: amountUnits(closing.argument.forfeitedAmount),
      payoutUnits: amountUnits(closing.argument.payoutAmount),
    }
  }
  // Abort and expiry state no amounts. Unlocking pays the owner in full and
  // this mechanic cannot forfeit, so the stake comes back and nothing else
  // moves. There is no outcome to digest.
  return {
    disposition: CLOSING_CHOICES[closing.choice],
    outcomeDigest: '',
    returnedUnits: commit.committedUnits,
    forfeitedUnits: 0n,
    payoutUnits: 0n,
  }
}

/**
 * Joins commit and closing halves into report rows.
 *
 * Only CLOSED cycles produce rows: an open cycle has no exit half and belongs
 * to no period yet. Unmatched halves are returned separately rather than
 * dropped — silently discarding a commit whose closing fell outside the window
 * is exactly the omission the anchor exists to make provable.
 */
export function rowsFromTransactions(transactions) {
  const commits = new Map()
  const closings = new Map()
  for (const t of transactions) {
    const c = commitFacts(t)
    if (c) commits.set(c.stakeContractId, c)
    const z = closingFacts(t)
    if (z) closings.set(z.stakeContractId, z)
  }

  const rows = []
  const warnings = []
  for (const [stakeCid, commit] of commits) {
    const closing = closings.get(stakeCid)
    if (!closing) continue
    const exit = exitAmounts(commit, closing)
    if (closing.unlockedUnits !== null && closing.unlockedUnits !== exit.returnedUnits) {
      warnings.push({
        cycleId: commit.cycleId,
        kind: 'returned-amount-disagrees-with-unlock',
        stated: exit.returnedUnits.toString(),
        unlocked: closing.unlockedUnits.toString(),
      })
    }
    rows.push({
      cycleId: commit.cycleId,
      player: commit.player,
      gameCode: commit.gameCode,
      concurrencyIndex: commit.concurrencyIndex,
      entryDigest: commit.entryDigest,
      outcomeDigest: exit.outcomeDigest,
      committedUnits: commit.committedUnits,
      feeUnits: commit.feeUnits,
      returnedUnits: exit.returnedUnits,
      forfeitedUnits: exit.forfeitedUnits,
      payoutUnits: exit.payoutUnits,
      disposition: exit.disposition,
      committedAtMicros: commit.committedAtMicros,
      settledAtMicros: closing.settledAtMicros,
      custodyTag: commit.custodyTag,
      // Not part of the leaf. Carried so a report can cite the two
      // transactions a row was built from.
      venueId: commit.venueId,
      commitUpdateId: commit.updateId,
      closingUpdateId: closing.updateId,
    })
  }

  const openStakes = [...commits.keys()].filter((k) => !closings.has(k))
  const orphanClosings = [...closings.keys()].filter((k) => !commits.has(k))

  // Report order must be deterministic or two honest implementations would
  // compute different Merkle roots over the same set.
  rows.sort((a, b) =>
    a.committedAtMicros === b.committedAtMicros
      ? a.cycleId.localeCompare(b.cycleId)
      : (a.committedAtMicros < b.committedAtMicros ? -1 : 1))

  return { rows, warnings, openStakes, orphanClosings }
}

/** The canonical ordering a period report and its Merkle root must use. */
export const REPORT_ORDER = 'committedAtMicros, then cycleId'

/** Strips the reporting-only fields, leaving exactly what the leaf hashes. */
export function toLeafRow(row) {
  return {
    cycleId: row.cycleId,
    player: row.player,
    gameCode: row.gameCode,
    concurrencyIndex: row.concurrencyIndex,
    entryDigest: row.entryDigest,
    outcomeDigest: row.outcomeDigest,
    committedUnits: row.committedUnits,
    feeUnits: row.feeUnits,
    returnedUnits: row.returnedUnits,
    forfeitedUnits: row.forfeitedUnits,
    payoutUnits: row.payoutUnits,
    disposition: row.disposition,
    committedAtMicros: row.committedAtMicros,
    settledAtMicros: row.settledAtMicros,
    custodyTag: row.custodyTag,
  }
}

// Kept so `canonInt` is unambiguously part of this module's contract with the
// digest layer; the leaf builder lives in digest.js.
export const _canonInt = canonInt
