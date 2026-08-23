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
