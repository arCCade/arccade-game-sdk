/**
 * @arccade/game-sdk — tip bildirimleri.
 *
 * Kaynak ESM JavaScript'tir (repo konvansiyonu, derleme adimi yok); bu dosya
 * TypeScript tuketicilerine tam tip destegi verir.
 */

// ----------------------------------------------------------------- digest

export const SCHEME_PREFIX: string
export const DIGEST_ALG_ID: string

/** Ondalik tutar: hassasiyet icin METIN tercih edin. */
export type Amount = string | bigint | number
/** ISO 8601 metni, Date, epoch ms (number) veya epoch mikrosaniye (bigint). */
export type TimeLike = string | Date | number | bigint

export function codePointLength(s: string): number
export function canon(tag: string, value: string): string
export function canonText(s: string): string
export function canonInt(i: number | bigint): string
export function canonBool(b: boolean): string
export function canonDecimal(d: Amount): string
export function canonTimeMicros(micros: number | bigint): string
export function canonTime(t: TimeLike): string
export function canonParty(p: string): string
export function canonOptional<T>(f: (x: T) => string, x: T | null | undefined): string
export function canonList(items: Iterable<string>): string
export function canonFields(kvs: Iterable<readonly [string, string]>): string
export function canonDocument(
  schema: string,
  version: number,
  kvs: Iterable<readonly [string, string]>,
): string

/** Kanonik metnin ham baytlarinin sha256'si (duz `sha256sum` ile ayni). */
export function textDigest(t: string): string
export function documentDigest(
  schema: string,
  version: number,
  kvs: Iterable<readonly [string, string]>,
): string

/** Tamsayi 1e-10 birimi; hassasiyet kaybinda hata firlatir. */
export function amountUnits(d: Amount): bigint
export function toMicros(t: TimeLike): bigint

// ------------------------------------------------------------------ cycle

export const CUSTODY_TAG_PREFIX: string
export const DRY_RUN_VENUE_PREFIX: string

export function custodyTagFor(cycleId: string, entryDigest: string): string
/** Her zaman bunu kullanin: cycleId tekilligini ledger zorlayamaz. */
export function newCycleId(prefix?: string): string
export function assertValidCycleId(cycleId: string): void
export function assertHex64(h: string): void

export interface InstrumentId {
  admin: string
  id: string
}

export type Disposition =
  | 'ReturnedInFull'
  | 'ReturnedWithForfeit'
  | 'ForfeitedInFull'
  | 'Aborted'
  | 'ExpiredUnsettled'

/** JSON Ledger API v2 komutu (opak). */
export type LedgerCommand = Record<string, unknown>

export interface Submission {
  commands: {
    commands: LedgerCommand[]
    commandId: string
    actAs: string[]
    readAs?: string[]
  }
}

export interface CommitOptions {
  sdkPackageId: string
  amuletPackageId: string
  venue: string
  operator: string
  player: string
  entitlementCid: string
  gameCode: string
  cycleId: string
  entryDigest: string
  stakeAmount: Amount
  feeAmount: Amount
  instrumentId: InstrumentId
  lockExpiresAt: string | Date
  amuletRulesCid: string
  openMiningRoundCid: string
  inputAmuletCids: string[]
  dsoParty: string
  commandId?: string
  stakeMeta?: Record<string, string>
}

export interface CommitResult {
  custodyTag: string
  cycleId: string
  commands: LedgerCommand[]
  actAs: string[]
  readAs: string[]
  submission: Submission
}

/** YAZMA 1: iki komut, tek gonderim, tek updateId. */
export function buildCommitCommands(opts: CommitOptions): CommitResult

export interface SettleOptions {
  sdkPackageId: string
  amuletPackageId: string
  venue: string
  operator: string
  player: string
  stakeCid: string
  lockedAmuletCid?: string | null
  disposition?: Disposition
  returnedAmount: Amount
  forfeitedAmount?: Amount
  payoutAmount?: Amount
  outcomeDocument?: string
  outcomeDigest?: string
  revealOutcome?: boolean
  revealedEntry?: string | null
  commandId?: string
  settlementMeta?: Record<string, string>
}

export interface SettleResult {
  commands: LedgerCommand[]
  actAs: string[]
  readAs: string[]
  outcomeDigest: string
  submission: Submission
}

/** YAZMA 2: Settle ONCE (kilidi ceker), Unlock SONRA. */
export function buildSettleCommands(opts: SettleOptions): SettleResult

export function buildAbortCommands(opts: {
  sdkPackageId: string
  venue: string
  operator: string
  player: string
  stakeCid: string
  reason: string
  lockedAmuletCid?: string | null
  commandId?: string
}): { commands: LedgerCommand[]; actAs: string[]; submission: Submission }

/** Oyuncunun kosulsuz cikis yolu; yalnizca oyuncunun imzasi gerekir. */
export function buildExpireCommands(opts: {
  sdkPackageId: string
  amuletPackageId: string
  player: string
  stakeCid: string
  lockedAmuletCid?: string | null
  commandId?: string
}): { commands: LedgerCommand[]; actAs: string[]; submission: Submission }

// ------------------------------------------------------------------ games

export namespace games {
  const TRADE_WARS_GAME_CODE: string
  const PIXEL_RACE_GAME_CODE: string

  interface PricePoint {
    symbol: string
    price: Amount
    source: string
    asOf: TimeLike
  }
  interface AssetAllocation {
    symbol: string
    allocationPercent: Amount
  }
  interface TradeWarsEntry {
    cycleId: string
    tier: string
    virtualBalance: Amount
    allocations: AssetAllocation[]
    entryPrices: PricePoint[]
  }
  interface TradeWarsOutcome {
    cycleId: string
    exitPrices: PricePoint[]
    virtualPnl: Amount
    virtualPnlPercent: Amount
    xpAwarded: Amount
    returnedAmount: Amount
    forfeitedAmount: Amount
  }
  interface GamePlay {
    gameNumber: number
    score: number
    survivalSeconds: number
    maxLevel: number
    coinsCollected: number
  }
  interface PixelRaceEntry {
    cycleId: string
    tier: string
    maxGamesPerSession: number
    rngSeedCommit: string
  }
  interface PixelRaceOutcome {
    cycleId: string
    rngSeed: string
    plays: GamePlay[]
    totalScore: number
    xpAwarded: Amount
    returnedAmount: Amount
    forfeitedAmount: Amount
  }

  function tradeWarsEntryDocument(e: TradeWarsEntry): string
  function tradeWarsEntryDigest(e: TradeWarsEntry): string
  function tradeWarsOutcomeDocument(o: TradeWarsOutcome): string
  function tradeWarsOutcomeDigest(o: TradeWarsOutcome): string
  function pixelRaceEntryDocument(e: PixelRaceEntry): string
  function pixelRaceEntryDigest(e: PixelRaceEntry): string
  function pixelRaceOutcomeDocument(o: PixelRaceOutcome): string
  function pixelRaceOutcomeDigest(o: PixelRaceOutcome): string
  function seedMatchesCommit(seed: string, commitment: string): boolean
}

// --------------------------------------------------------- period anchor

/** Integer 1e-10 unit or microsecond count. Prefer bigint past 2^53. */
export type Int64Like = bigint | number | string

export const ANCHOR_SCHEMA: string
export const ANCHOR_SCHEMA_VERSION: number
export const ANCHOR_FIELDS: readonly string[]
export const ANCHOR_TOTAL_FIELDS: readonly string[]

export interface PeriodAnchor {
  venueId: string
  periodId: string
  periodStartMicros: Int64Like
  periodEndMicros: Int64Like
  /** PROVEN by Daml: recomputed from the rows, so the venue cannot lie. */
  cycleCount: Int64Like
  committedUnits: Int64Like
  feeUnits: Int64Like
  returnedUnits: Int64Like
  forfeitedUnits: Int64Like
  payoutUnits: Int64Like
  /** DECLARED: arrives as an argument; the contract cannot check it. */
  qualifyingTxCount: Int64Like
  nonQualifyingTxCount: Int64Like
  merkleRootHex: string
  reportDigest: string
  /** Empty text at the start of a chain — never absent. */
  prevAnchorDigest: string
}

export interface AnchorTotals {
  cycleCount: bigint
  committedUnits: bigint
  feeUnits: bigint
  returnedUnits: bigint
  forfeitedUnits: bigint
  payoutUnits: bigint
}

export interface CycleAuditRow {
  cycleId: string
  player: string
  gameCode: string
  concurrencyIndex: Int64Like
  entryDigest: string
  outcomeDigest: string
  committedUnits: Int64Like
  feeUnits: Int64Like
  returnedUnits: Int64Like
  forfeitedUnits: Int64Like
  payoutUnits: Int64Like
  disposition: string
  committedAtMicros: Int64Like
  settledAtMicros: Int64Like
  custodyTag: string
}

export function anchorDocument(anchor: PeriodAnchor): string
export function anchorDigest(anchor: PeriodAnchor): string
/** Totals summed from the rows; a repeated cycleId throws. */
export function anchorTotals(rows: Iterable<CycleAuditRow>): AnchorTotals

// ----------------------------------------------------------------- policy

export const POLICY_SCHEMA: string
export const POLICY_SCHEMA_VERSION: number
export const POLICY_FIELDS: readonly string[]

/**
 * A venue policy. Amounts are DECIMALS (`"1.0"`), unlike an audit row's
 * already-converted units. Fields may be spelled `min-stake-amount`,
 * `min_stake_amount` or `minStakeAmount`.
 */
export interface VenuePolicy {
  minStakeAmount: Amount
  maxStakeAmount: Amount
  minPlatformFee: Amount
  maxPayoutAmount: Amount
  minLockSeconds: Int64Like
  maxLockSeconds: Int64Like
  minCycleSeconds: Int64Like
  maxCycleSeconds: Int64Like
  cooldownSeconds: Int64Like
  abortCooldownSeconds: Int64Like
  concurrencyLimit: Int64Like
  requireCustodyProof: boolean
}

export type VenuePolicyLike = VenuePolicy | Record<string, unknown>

export function policyDocument(policy: VenuePolicyLike): string
export function policyDigest(policy: VenuePolicyLike): string
/** Daml's `ensure`: an inconsistent policy cannot create a venue at all. */
export function validPolicy(policy: VenuePolicyLike): boolean

// ------------------------------------------------------------- settlement

export const SETTLEMENT_FIELDS: readonly string[]

/** Amounts in integer 1e-10 units, as in an audit row. */
export interface Settlement {
  disposition: string
  stakeUnits: Int64Like
  returnedUnits: Int64Like
  forfeitedUnits: Int64Like
  payoutUnits: Int64Like
  /** The venue policy's cap; without it no payout is checkable. */
  maxPayoutUnits: Int64Like
}

/** Returns true, or throws naming the Cycle.daml rule that failed. */
export function assertSettlementValid(settlement: Settlement): boolean
export function settlementIsValid(settlement: Settlement): boolean

// ------------------------------------------------------------ ledger time

/**
 * Truncates TOWARD ZERO, as Daml's `/` on `Int` does: `intDivide(-7n, 2n)` is
 * `-3n`. `Math.floor` would give -4n.
 */
export function intDivide(a: Int64Like, b: Int64Like): bigint
export function epochSeconds(micros: Int64Like): bigint
/** Each endpoint is truncated to whole seconds BEFORE subtracting. */
export function secondsBetween(aMicros: Int64Like, bMicros: Int64Like): bigint
export function addSeconds(micros: Int64Like, seconds: Int64Like): bigint
