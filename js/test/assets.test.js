/**
 * Varlik katmani testleri — iki model, ozellik baglama, izolasyon.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FUNGIBLE,
  UNIQUE,
  assetAttributeDigest,
  assetAttributeDocument,
  assertAmountValidForAsset,
  assertValidLocalId,
  deriveInstanceId,
  fungibleInstrument,
  isUnique,
  parseAsset,
  uniqueInstrument,
} from '../src/assets.js'
import { assertTenantOwnsInstrument } from '../src/tenant.js'

const REG = 'arccade-registry::1220aa'
const CC = { admin: 'dso::1220bb', id: 'Amulet' }

test('fungible: tur bazli kimlik', () => {
  const gold = fungibleInstrument(REG, 'mygame', 'gold')
  assert.equal(gold.id, 'mygame/gold')
  assert.equal(parseAsset(gold).assetClass, FUNGIBLE)
  assert.ok(!isUnique(gold))
})

test('unique: ornek bazli kimlik', () => {
  const sword = uniqueInstrument(REG, 'mygame', 'sword-of-dawn', '4a91c8f2')
  assert.equal(sword.id, 'mygame/sword-of-dawn#4a91c8f2')
  const p = parseAsset(sword)
  assert.equal(p.assetClass, UNIQUE)
  assert.equal(p.tenantId, 'mygame')
  assert.equal(p.localId, 'sword-of-dawn')
  assert.equal(p.instanceId, '4a91c8f2')
})

test('iki model ayni anda kullanilabilir', () => {
  const potion = fungibleInstrument(REG, 'mygame', 'health-potion')  // yiginlanabilir
  const sword = uniqueInstrument(REG, 'mygame', 'sword-of-dawn', 'aaaa1111')
  assert.ok(!isUnique(potion))
  assert.ok(isUnique(sword))
  // Ikisi de ayni kiraciya ait, izolasyondan gecer.
  assertTenantOwnsInstrument('mygame', potion)
  assertTenantOwnsInstrument('mygame', sword)
})

test('CC ad alansiz ve fungible kalir', () => {
  const p = parseAsset(CC)
  assert.equal(p.tenantId, null)
  assert.equal(p.assetClass, FUNGIBLE)
})

test('benzersiz varligin miktari 1 olmali', () => {
  const sword = uniqueInstrument(REG, 'mygame', 'sword-of-dawn', 'aaaa1111')
  assertAmountValidForAsset(sword, 1)
  assert.throws(() => assertAmountValidForAsset(sword, 3), /miktari 1 olmali/)
  assert.throws(() => assertAmountValidForAsset(sword, 0), /miktari 1 olmali/)
  // Fungible'da serbest.
  const gold = fungibleInstrument(REG, 'mygame', 'gold')
  assertAmountValidForAsset(gold, 500)
  assert.throws(() => assertAmountValidForAsset(gold, 0), /pozitif/)
})

test('kimlik dogrulamasi', () => {
  assert.throws(() => assertValidLocalId('Gold'), /gecersiz varlik/)      // buyuk harf
  assert.throws(() => assertValidLocalId('-gold'), /gecersiz varlik/)     // tire ile baslar
  assert.throws(() => assertValidLocalId('a'), /gecersiz varlik/)         // cok kisa
  assert.throws(() => uniqueInstrument(REG, 'mygame', 'sword', 'AB'), /ornek kimligi/)
})

test('OZELLIK BAGLAMA: satis sonrasi sessizce degistirilemez', () => {
  const sword = uniqueInstrument(REG, 'mygame', 'sword-of-dawn', 'aaaa1111')
  const before = assetAttributeDigest({ instrumentId: sword, attributes: { attack: 9, tier: 'legendary' } })
  // Uygulama statı dusurmeye kalkarsa digest tutmaz.
  const after = assetAttributeDigest({ instrumentId: sword, attributes: { attack: 3, tier: 'legendary' } })
  assert.notEqual(before, after)
  assert.match(before, /^[0-9a-f]{64}$/)
})

test('ozellik belgesi alan sirasindan bagimsiz', () => {
  const sword = uniqueInstrument(REG, 'mygame', 'sword-of-dawn', 'aaaa1111')
  const a = assetAttributeDigest({ instrumentId: sword, attributes: { attack: 9, speed: 3 } })
  const b = assetAttributeDigest({ instrumentId: sword, attributes: { speed: 3, attack: 9 } })
  assert.equal(a, b)
})

test('ozellik belgesi instrument kimligini icerir: baska varliga kopyalanamaz', () => {
  const a = uniqueInstrument(REG, 'mygame', 'sword-of-dawn', 'aaaa1111')
  const b = uniqueInstrument(REG, 'mygame', 'sword-of-dawn', 'bbbb2222')
  const attrs = { attack: 9 }
  assert.notEqual(
    assetAttributeDigest({ instrumentId: a, attributes: attrs }),
    assetAttributeDigest({ instrumentId: b, attributes: attrs }),
  )
})

test('ondalik ozellik metin olarak verilmeli', () => {
  const sword = uniqueInstrument(REG, 'mygame', 'sword', 'aaaa1111')
  assert.throws(
    () => assetAttributeDocument({ instrumentId: sword, attributes: { crit: 1.5 } }),
    /tamsayi ya da metin/,
  )
  // Metin olarak sorunsuz.
  assetAttributeDocument({ instrumentId: sword, attributes: { crit: '1.5' } })
})

test('ornek kimligi ozelliklerden turetilebilir', () => {
  const a = deriveInstanceId({ tenantId: 'mygame', localId: 'sword', attributes: { attack: 9 } })
  const b = deriveInstanceId({ tenantId: 'mygame', localId: 'sword', attributes: { attack: 9 } })
  const c = deriveInstanceId({ tenantId: 'mygame', localId: 'sword', attributes: { attack: 8 } })
  assert.equal(a, b)          // ayni ozellikler -> ayni kimlik
  assert.notEqual(a, c)       // farkli ozellikler -> farkli kimlik
  assert.equal(a.length, 32)
  // Salt ile ayni ozelliklerden farkli ornekler uretilebilir.
  assert.notEqual(a, deriveInstanceId({ tenantId: 'mygame', localId: 'sword', attributes: { attack: 9 }, salt: '2' }))
})

test('IZOLASYON benzersiz varliklarda da gecerli', () => {
  const theirs = uniqueInstrument(REG, 'othergame', 'shield', 'cccc3333')
  assert.throws(() => assertTenantOwnsInstrument('mygame', theirs), /izolasyon/)
})
