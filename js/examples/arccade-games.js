/**
 * Oyun adaptorleri — `daml/ArCCade/GameSdk/Games/*.daml` ile bayt-birebir.
 *
 * Bunlar SDK'nin urettigi ilk iki ornek adaptordur. Yeni bir oyun kendi
 * adaptorunu yazar: tek gereksinim, giris ve sonuc belgelerinin kanonik
 * kodlamayla uretilmesi ve alan adlarinin ASCII olmasidir. SDK belgenin
 * ICERIGINI yorumlamaz — yalnizca digest'ini tasir.
 */

import {
  canonDecimal,
  canonFields,
  canonInt,
  canonList,
  canonText,
  canonTime,
  canonDocument,
  textDigest,
} from '../src/digest.js'

// ------------------------------------------------------------- Trade Wars

export const TRADE_WARS_GAME_CODE = 'trade-wars-v4'

const twPricePoint = (p) =>
  canonFields([
    ['as-of', canonTime(p.asOf)],
    ['price', canonDecimal(p.price)],
    ['source', canonText(p.source)],
    ['symbol', canonText(p.symbol)],
  ])

const twAllocation = (a) =>
  canonFields([
    ['allocation-percent', canonDecimal(a.allocationPercent)],
    ['symbol', canonText(a.symbol)],
  ])

export function tradeWarsEntryDocument(e) {
  return canonDocument('arccade-trade-wars-entry', 1, [
    ['allocations', canonList(e.allocations.map(twAllocation))],
    ['cycle-id', canonText(e.cycleId)],
    ['entry-prices', canonList(e.entryPrices.map(twPricePoint))],
    ['game-code', canonText(TRADE_WARS_GAME_CODE)],
    ['tier', canonText(e.tier)],
    ['virtual-balance', canonDecimal(e.virtualBalance)],
  ])
}

export const tradeWarsEntryDigest = (e) => textDigest(tradeWarsEntryDocument(e))

export function tradeWarsOutcomeDocument(o) {
  return canonDocument('arccade-trade-wars-outcome', 1, [
    ['cycle-id', canonText(o.cycleId)],
    ['exit-prices', canonList(o.exitPrices.map(twPricePoint))],
    ['forfeited-amount', canonDecimal(o.forfeitedAmount)],
    ['game-code', canonText(TRADE_WARS_GAME_CODE)],
    ['returned-amount', canonDecimal(o.returnedAmount)],
    ['virtual-pnl', canonDecimal(o.virtualPnl)],
    ['virtual-pnl-percent', canonDecimal(o.virtualPnlPercent)],
    ['xp-awarded', canonDecimal(o.xpAwarded)],
  ])
}

export const tradeWarsOutcomeDigest = (o) => textDigest(tradeWarsOutcomeDocument(o))

// ------------------------------------------------------------- Pixel Race

export const PIXEL_RACE_GAME_CODE = 'pixel-race-v1'

const prGamePlay = (g) =>
  canonFields([
    ['coins-collected', canonInt(g.coinsCollected)],
    ['game-number', canonInt(g.gameNumber)],
    ['max-level', canonInt(g.maxLevel)],
    ['score', canonInt(g.score)],
    ['survival-seconds', canonInt(g.survivalSeconds)],
  ])

export function pixelRaceEntryDocument(e) {
  return canonDocument('arccade-pixel-race-entry', 1, [
    ['cycle-id', canonText(e.cycleId)],
    ['game-code', canonText(PIXEL_RACE_GAME_CODE)],
    ['max-games-per-session', canonInt(e.maxGamesPerSession)],
    ['rng-seed-commit', canonText(e.rngSeedCommit)],
    ['tier', canonText(e.tier)],
  ])
}

export const pixelRaceEntryDigest = (e) => textDigest(pixelRaceEntryDocument(e))

export function pixelRaceOutcomeDocument(o) {
  return canonDocument('arccade-pixel-race-outcome', 1, [
    ['cycle-id', canonText(o.cycleId)],
    ['forfeited-amount', canonDecimal(o.forfeitedAmount)],
    ['game-code', canonText(PIXEL_RACE_GAME_CODE)],
    ['plays', canonList(o.plays.map(prGamePlay))],
    ['returned-amount', canonDecimal(o.returnedAmount)],
    ['rng-seed', canonText(o.rngSeed)],
    ['total-score', canonInt(o.totalScore)],
    ['xp-awarded', canonDecimal(o.xpAwarded)],
  ])
}

export const pixelRaceOutcomeDigest = (o) => textDigest(pixelRaceOutcomeDocument(o))

/** Acilan tohumun giristeki taahhutle tutarli olup olmadigi. */
export const seedMatchesCommit = (seed, commitment) => textDigest(seed) === commitment
