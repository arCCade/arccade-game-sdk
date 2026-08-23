/**
 * Altin vektor ve kenar durum testleri.
 *
 * Buradaki iki digest sabiti, Daml (`Test.GameSdk.VectorsTest:goldenVectors`)
 * ve Python (`tools/digest_reference.py`) tarafindan BAGIMSIZ olarak
 * uretilmistir. Uc implementasyondan biri saparsa bu test kirilir.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import {
  amountUnits,
  canonBool,
  canonDecimal,
  canonFields,
  canonInt,
  canonList,
  canonOptional,
  canonText,
  canonTimeMicros,
  codePointLength,
  textDigest,
} from '../src/digest.js'

import {
  pixelRaceEntryDigest,
  tradeWarsEntryDigest,
  seedMatchesCommit,
} from '../examples/arccade-games.js'

const TW_SAMPLE = {
  cycleId: 'tw-sample-1',
  tier: 'silver',
  virtualBalance: '10000.0',
  allocations: [
    { symbol: 'BTC', allocationPercent: '60.0' },
    { symbol: 'ETH', allocationPercent: '40.0' },
  ],
  entryPrices: [
    { symbol: 'BTC', price: '60000.0', source: 'binance', asOf: 1_000_000n },
    { symbol: 'ETH', price: '3000.0', source: 'binance', asOf: 1_000_000n },
  ],
}

const PR_SAMPLE = {
  cycleId: 'pr-sample-1',
  tier: 'bronze',
  maxGamesPerSession: 3,
  rngSeedCommit: '0'.repeat(64),
}

test('altin vektor: trade-wars girisi Daml/Python ile ayni', () => {
  assert.equal(
    tradeWarsEntryDigest(TW_SAMPLE),
    '5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852',
  )
})

test('altin vektor: pixel-race girisi Daml/Python ile ayni', () => {
  assert.equal(
    pixelRaceEntryDigest(PR_SAMPLE),
    '0b2349e05633cf279ca0ee1d3f5efd8b2308f3e2ee947a32f5c3397e456d0204',
  )
})

test('textDigest, duz sha256sum ile ayni deger uretir', () => {
  // Ucuncu taraf dogrulanabilirliginin temeli: kutuphane gerekmez.
  const shell = execFileSync('sh', ['-c', "printf 'arccade' | sha256sum | cut -d' ' -f1"])
    .toString()
    .trim()
  assert.equal(textDigest('arccade'), shell)
})

test('kanonik kodlama Daml ile ayni', () => {
  assert.equal(canonText('abc'), 't:3:abc')
  assert.equal(canonInt(42), 'i:2:42')
  assert.equal(canonBool(true), 'b:4:true')
  assert.equal(canonBool(false), 'b:5:false')
  assert.equal(canonDecimal('1.5'), 'd:11:15000000000')
  assert.equal(canonDecimal('0.0'), 'd:1:0')
  assert.equal(canonTimeMicros(1_000_000n), 'm:7:1000000')
  assert.equal(canonOptional(canonText, null), 'o:0:')
  assert.equal(canonOptional(canonText, 'x'), 'o:5:t:1:x')
  assert.equal(canonList(['a', 'b']), 'l:5:2:a|b')
  assert.equal(canonList([]), 'l:2:0:')
})

test('alanlar ada gore siralanir: giris sirasi digest i degistirmez', () => {
  assert.equal(
    canonFields([
      ['b', '2'],
      ['a', '1'],
    ]),
    canonFields([
      ['a', '1'],
      ['b', '2'],
    ]),
  )
})

test('ASCII disi alan adi reddedilir', () => {
  // Siralamanin diller arasi ayni olmasi buna bagli.
  assert.throws(() => canonFields([['ücret', 'x']]), /ASCII/)
  assert.throws(() => canonFields([['a b', 'x']]), /ASCII/)
})

test('uzunluk KOD NOKTASI sayar, UTF-16 birimi degil', () => {
  // Emoji UTF-16'da 2 birim, 1 kod noktasi. Java portu codePointCount kullanmali.
  assert.equal('🎮'.length, 2)
  assert.equal(codePointLength('🎮'), 1)
  assert.equal(canonText('🎮'), 't:1:🎮')
})

test('amountUnits: tamsayi 1e-10 birimi, gidis-donus guvenli', () => {
  assert.equal(amountUnits('1.0'), 10_000_000_000n)
  assert.equal(amountUnits('12.3456789012'), 123_456_789_012n)
  assert.equal(amountUnits('0.0'), 0n)
  assert.equal(amountUnits('0.0000000001'), 1n)
  assert.equal(amountUnits('-1.5'), -15_000_000_000n)
  // Sondaki sifirlar zarar vermez.
  assert.equal(amountUnits('1.50000000000000'), 15_000_000_000n)
})

test('amountUnits: hassasiyet kaybi sessizce yutulmaz', () => {
  assert.throws(() => amountUnits('0.00000000001'), /kayipsiz/)
  assert.throws(() => amountUnits(1.5), /Number/)
  assert.throws(() => amountUnits('922337203.7'), /bandin disinda/)
  assert.throws(() => amountUnits('abc'), /gecersiz/)
})

test('tohum taahhut/acma zinciri', () => {
  const seed = 'gizli-tohum-123'
  const commit = textDigest(seed)
  assert.ok(seedMatchesCommit(seed, commit))
  assert.ok(!seedMatchesCommit('baska-tohum', commit))
})
