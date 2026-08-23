/**
 * Cok kiracilik testleri: izolasyon, ad alani, anahtar, kota.
 *
 * Bu testlerin varlik sebebi somut: ucuncu taraflar arCCade'in participant'i
 * uzerinde calisacagi icin izolasyon ledger tarafindan degil BU KATMAN
 * tarafindan saglaniyor. Kirilirsa kiraci A, kiraci B'nin varligina dokunur.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  TenantQuota,
  assertTenantLegs,
  assertTenantOwnsInstrument,
  assertValidTenantId,
  generateTenantKey,
  hashTenantKey,
  namespacedInstrumentId,
  parseInstrumentId,
  tenantIdFromKey,
  verifyTenantKey,
} from '../src/tenant.js'

const REGISTRY = 'arccade-registry::1220aa'
const DSO = 'dso::1220bb'
const CC = { admin: DSO, id: 'Amulet' }

test('kiraci kimligi dogrulamasi', () => {
  assertValidTenantId('mygame')
  assertValidTenantId('my-game-2')
  assert.throws(() => assertValidTenantId('My-Game'), /gecersiz/)   // buyuk harf
  assert.throws(() => assertValidTenantId('-abc'), /gecersiz/)      // tire ile baslar
  assert.throws(() => assertValidTenantId('ab'), /gecersiz/)        // cok kisa
  assert.throws(() => assertValidTenantId('a--b'), /ardisik tire/)
})

test('item kimligi kiraci ad alanina alinir', () => {
  const id = namespacedInstrumentId(REGISTRY, 'mygame', 'sword-of-dawn')
  assert.equal(id.admin, REGISTRY)
  assert.equal(id.id, 'mygame/sword-of-dawn')
  assert.deepEqual(parseInstrumentId(id), { tenantId: 'mygame', localId: 'sword-of-dawn' })
})

test('CC gibi ad alansiz varliklar ortak kalir', () => {
  assert.deepEqual(parseInstrumentId(CC), { tenantId: null, localId: 'Amulet' })
  // Her kiraci CC ile islem yapabilir.
  assertTenantOwnsInstrument('mygame', CC)
  assertTenantOwnsInstrument('othergame', CC)
})

test('IZOLASYON: kiraci baska kiracinin varligina dokunamaz', () => {
  const theirs = namespacedInstrumentId(REGISTRY, 'othergame', 'shield')
  assert.throws(() => assertTenantOwnsInstrument('mygame', theirs), /izolasyon/)
})

test('IZOLASYON: takas bacaklarinin tamami denetlenir', () => {
  const mine = namespacedInstrumentId(REGISTRY, 'mygame', 'sword')
  const theirs = namespacedInstrumentId(REGISTRY, 'othergame', 'shield')
  // Kendi item'i <-> CC: gecerli.
  assertTenantLegs('mygame', {
    offer: { instrumentId: mine },
    ask: { instrumentId: CC },
  })
  // Kendi item'i <-> BASKASININ item'i: reddedilir.
  assert.throws(
    () => assertTenantLegs('mygame', { offer: { instrumentId: mine }, ask: { instrumentId: theirs } }),
    /izolasyon/,
  )
})

test('ad alani ayiricisi item kimligine sizamaz', () => {
  assert.throws(() => namespacedInstrumentId(REGISTRY, 'mygame', 'a/b'), /'\/' olamaz/)
  assert.throws(() => namespacedInstrumentId(REGISTRY, 'mygame', 'a:b'), /':' veya/)
  assert.throws(() => namespacedInstrumentId(REGISTRY, 'mygame', ''), /gecersiz item/)
})

test('anahtar uretimi ve dogrulamasi', () => {
  const k = generateTenantKey('mygame')
  assert.ok(k.secret.startsWith('ags_mygame_'))
  assert.equal(k.hash, hashTenantKey(k.secret))
  assert.ok(verifyTenantKey(k.secret, k.hash))
  assert.ok(!verifyTenantKey(k.secret + 'x', k.hash))
  assert.ok(!verifyTenantKey('ags_baska_xxx', k.hash))
})

test('anahtardan kiraci okunur ama bu dogrulama yerine gecmez', () => {
  const k = generateTenantKey('mygame')
  assert.equal(tenantIdFromKey(k.secret), 'mygame')
  assert.equal(tenantIdFromKey('bozuk'), null)
  // Uydurma bir anahtar kiraci adi tasiyabilir — bu yuzden hash dogrulamasi sart.
  assert.equal(tenantIdFromKey('ags_mygame_uydurma'), 'mygame')
  assert.ok(!verifyTenantKey('ags_mygame_uydurma', k.hash))
})

test('anahtar sirri iki kez ayni uretilmez', () => {
  const a = generateTenantKey('mygame')
  const b = generateTenantKey('mygame')
  assert.notEqual(a.secret, b.secret)
  assert.notEqual(a.hash, b.hash)
})

test('kota: pencere icinde sinir, sonra sifirlanir', () => {
  const q = new TenantQuota({ windowSeconds: 60, maxWrites: 3 })
  const t0 = 1_000_000
  assert.equal(q.consume('mygame', t0).allowed, true)
  assert.equal(q.consume('mygame', t0).allowed, true)
  const third = q.consume('mygame', t0)
  assert.equal(third.allowed, true)
  assert.equal(third.remaining, 0)
  assert.equal(q.consume('mygame', t0).allowed, false)
  // Pencere kayinca yeniden acilir.
  assert.equal(q.consume('mygame', t0 + 60_001).allowed, true)
})

test('kota kiracilar arasinda paylasilmaz', () => {
  const q = new TenantQuota({ windowSeconds: 60, maxWrites: 1 })
  const t0 = 1_000_000
  assert.equal(q.consume('mygame', t0).allowed, true)
  assert.equal(q.consume('mygame', t0).allowed, false)
  // Baska kiraci etkilenmez.
  assert.equal(q.consume('othergame', t0).allowed, true)
})
