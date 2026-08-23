/**
 * Marketplace / takas primitifi testleri.
 *
 * Vurgu: ayni primitifin item<->CC, item<->item ve ucuncu taraf varliklari
 * icin calistigi, ve deger tasimayan hicbir seyin zincire yazilmadigi.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LEG_ASK,
  LEG_OFFER,
  assertValidTradeId,
  buildTradeCancelCommands,
  buildTradeProposalCommands,
  buildTradeSettleCommands,
  leg,
  newTradeId,
  tradeDigest,
  tradeDocument,
} from '../src/trade.js'

const SDK_PKG = 'a'.repeat(64)
const VENUE = 'venue::1220aa'
const MAKER = 'maker::1220bb'
const TAKER = 'taker::1220cc'
const DSO = 'dso::1220dd'
const GAME_REGISTRY = 'mygame::1220ee'

const CC = { admin: DSO, id: 'Amulet' }
const SWORD = { admin: GAME_REGISTRY, id: 'sword-of-dawn' }
const SHIELD = { admin: GAME_REGISTRY, id: 'shield-of-dusk' }

const base = (legs) => ({
  sdkPackageId: SDK_PKG,
  venue: VENUE,
  maker: MAKER,
  taker: TAKER,
  tradeId: 'tr-1',
  legs,
  expiresAt: '2026-12-01T00:00:00Z',
  settleBefore: '2026-12-02T00:00:00Z',
})

test('item <-> CC: marketplace satisi', () => {
  const legs = {
    [LEG_OFFER]: leg({ sender: MAKER, receiver: TAKER, instrumentId: SWORD, amount: '1' }),
    [LEG_ASK]: leg({ sender: TAKER, receiver: MAKER, instrumentId: CC, amount: '25.0' }),
  }
  const r = buildTradeProposalCommands(base(legs))
  const args = r.commands[0].CreateCommand.createArguments
  assert.equal(args.legs.values[LEG_OFFER].instrumentId.id, 'sword-of-dawn')
  assert.equal(args.legs.values[LEG_ASK].instrumentId.id, 'Amulet')
})

test('item <-> item: takas, ayni primitif', () => {
  const legs = {
    [LEG_OFFER]: leg({ sender: MAKER, receiver: TAKER, instrumentId: SWORD, amount: '1' }),
    [LEG_ASK]: leg({ sender: TAKER, receiver: MAKER, instrumentId: SHIELD, amount: '1' }),
  }
  const r = buildTradeProposalCommands(base(legs))
  assert.equal(r.commands.length, 1)
  // Iki bacak da ayni registry'den — SDK varligi yorumlamaz.
  const v = r.commands[0].CreateCommand.createArguments.legs.values
  assert.equal(v[LEG_OFFER].instrumentId.admin, GAME_REGISTRY)
  assert.equal(v[LEG_ASK].instrumentId.admin, GAME_REGISTRY)
})

test('bacak dogrulamasi: sifir/negatif tutar ve kendine gonderim reddedilir', () => {
  assert.throws(() => leg({ sender: MAKER, receiver: TAKER, instrumentId: CC, amount: '0' }), /pozitif/)
  assert.throws(() => leg({ sender: MAKER, receiver: MAKER, instrumentId: CC, amount: '1' }), /ayni olamaz/)
  assert.throws(() => leg({ sender: MAKER, receiver: TAKER, instrumentId: { id: 'x' }, amount: '1' }), /instrumentId/)
})

test('iki bacak zorunlu: tek tarafli "hediye" bu primitifle yazilamaz', () => {
  const onlyOffer = {
    [LEG_OFFER]: leg({ sender: MAKER, receiver: TAKER, instrumentId: SWORD, amount: '1' }),
  }
  assert.throws(() => buildTradeProposalCommands(base(onlyOffer)), /iki bacak/)
})

test('takas belgesi item metaverisini ZINCIRE tasimaz, yalnizca digest', () => {
  const legs = {
    [LEG_OFFER]: leg({ sender: MAKER, receiver: TAKER, instrumentId: SWORD, amount: '1' }),
    [LEG_ASK]: leg({ sender: TAKER, receiver: MAKER, instrumentId: CC, amount: '25.0' }),
  }
  const r = buildTradeProposalCommands({
    ...base(legs),
    // Uygulama istedigi metaveriyi belgeye koyar; zincire digest'i gider.
    meta: { 'item-name': 'Sword of Dawn', rarity: 'legendary' },
  })
  const args = r.commands[0].CreateCommand.createArguments
  assert.match(args.tradeDigest, /^[0-9a-f]{64}$/)
  // Item adi zincire giden alanlarda GECMEMELI.
  assert.ok(!JSON.stringify(args.legs).includes('Sword of Dawn'))
})

test('belge deterministik: alan sirasi digest i degistirmez', () => {
  const legs = {
    [LEG_ASK]: leg({ sender: TAKER, receiver: MAKER, instrumentId: CC, amount: '25.0' }),
    [LEG_OFFER]: leg({ sender: MAKER, receiver: TAKER, instrumentId: SWORD, amount: '1' }),
  }
  const a = tradeDigest({ tradeId: 'tr-1', maker: MAKER, taker: TAKER, legs, expiresAt: '2026-12-01T00:00:00Z' })
  const legsReordered = { [LEG_OFFER]: legs[LEG_OFFER], [LEG_ASK]: legs[LEG_ASK] }
  const b = tradeDigest({ tradeId: 'tr-1', maker: MAKER, taker: TAKER, legs: legsReordered, expiresAt: '2026-12-01T00:00:00Z' })
  assert.equal(a, b)
})

test('settle her bacak icin allocation ister', () => {
  assert.throws(
    () => buildTradeSettleCommands({ sdkPackageId: SDK_PKG, venue: VENUE, maker: MAKER, taker: TAKER, tradeCid: '00t', allocations: {} }),
    /allocation/,
  )
  const r = buildTradeSettleCommands({
    sdkPackageId: SDK_PKG, venue: VENUE, maker: MAKER, taker: TAKER, tradeCid: '00trade000000000',
    allocations: { [LEG_OFFER]: ['00a1', {}], [LEG_ASK]: ['00a2', {}] },
  })
  assert.equal(r.commands[0].ExerciseCommand.choice, 'Trade_Settle')
  assert.deepEqual(r.actAs, [VENUE])
})

test('iptal venue tarafindan', () => {
  const r = buildTradeCancelCommands({ sdkPackageId: SDK_PKG, venue: VENUE, tradeCid: '00trade000000000', reason: 'suresi doldu' })
  assert.equal(r.commands[0].ExerciseCommand.choice, 'Trade_Cancel')
})

test('tradeId dogrulamasi', () => {
  assert.throws(() => assertValidTradeId('a:b'), /iceremez/)
  assert.throws(() => assertValidTradeId(''), /gecersiz/)
  const id = newTradeId('mk')
  assert.ok(id.startsWith('mk-'))
})

test('belge formati okunabilir ve ayristirilabilir', () => {
  const legs = {
    [LEG_OFFER]: leg({ sender: MAKER, receiver: TAKER, instrumentId: SWORD, amount: '1' }),
    [LEG_ASK]: leg({ sender: TAKER, receiver: MAKER, instrumentId: CC, amount: '25.0' }),
  }
  const doc = tradeDocument({ tradeId: 'tr-1', maker: MAKER, taker: TAKER, legs, expiresAt: '2026-12-01T00:00:00Z' })
  assert.ok(doc.startsWith('arccade-game-sdk:trade:1:'))
  assert.ok(doc.includes('leg.offer='))
  assert.ok(doc.includes('leg.ask='))
})
