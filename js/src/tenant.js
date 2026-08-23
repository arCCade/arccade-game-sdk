/**
 * Cok kiracili model — arCCade'in SDK'yi kendi validator'i uzerinden ucuncu
 * taraflara actigi katman.
 *
 * # Neden bu katman var
 *
 * SDK'yi kullanan uygulamalar KENDI validator'larini calistirmaz; arCCade'in
 * participant'i uzerinden calisirlar ve arCCade onlara bir ANAHTAR verir. Bu,
 * arCCade'i bir oyun studyosu degil altyapi saglayicisi yapar ve uc sorumluluk
 * dogurur:
 *
 *   1. IZOLASYON. Kiraci A, kiraci B'nin venue'sunu, oyuncularini ya da
 *      varliklarini hareket ettiremez. Ayni participant uzerinde durduklari
 *      icin bu, ledger'in degil BU KATMANIN sorumlulugudur.
 *   2. AD ALANI. Kiraci A, kiraci B'nin item'ini basamaz. Item kimlikleri
 *      kiraci onekiyle ad alanina alinir.
 *   3. KOTA. Ekonomik caydiricilik spam'in tek savunmasi degildir; kiraci
 *      basina islem kotasi idari savunmadir.
 *
 * # Neden ad alani ZORUNLU
 *
 * Ucuncu taraflarin kendi validator'i olmadigi icin kendi registry'lerini de
 * calistiramazlar. Dolayisiyla item'lerin `instrumentId.admin` alani arCCade'in
 * registry partisidir — yani TUM kiracilarin item'leri ayni admin altindadir.
 * Ad alani olmazsa kiraci A, `"sword-of-dawn"` diye kiraci B'nin item'ini
 * basabilir. Onek bunu yapisal olarak imkansiz kilar.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Kiraci kimligi: kucuk harf, rakam ve tire; 3-32 karakter. */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/

export function assertValidTenantId(tenantId) {
  if (typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId)) {
    throw new Error(
      `gecersiz kiraci kimligi (3-32 karakter, [a-z0-9-], tire ile baslayip bitemez): ${JSON.stringify(tenantId)}`,
    )
  }
  if (tenantId.includes('--')) {
    throw new Error(`kiraci kimliginde ardisik tire olamaz: ${tenantId}`)
  }
}

/**
 * Bir kiracinin item kimligini ad alanina alir.
 *
 * `instrumentId.id` = `<tenantId>/<localId>`
 *
 * Ayirici olarak `/` secildi cunku hem `:` (etiket ayiricisi) hem `|` (liste
 * ayiricisi) digest kodlamasinda anlamli; `/` degil.
 */
export function namespacedInstrumentId(registryParty, tenantId, localId) {
  assertValidTenantId(tenantId)
  if (typeof localId !== 'string' || localId.length === 0 || localId.length > 96) {
    throw new Error(`gecersiz item kimligi (1-96 karakter): ${JSON.stringify(localId)}`)
  }
  if (localId.includes('/')) {
    throw new Error(`item kimliginde '/' olamaz (ad alani ayiricisi): ${localId}`)
  }
  if (localId.includes(':') || localId.includes('|')) {
    throw new Error(`item kimliginde ':' veya '|' olamaz: ${localId}`)
  }
  return { admin: registryParty, id: `${tenantId}/${localId}` }
}

/** Ad alanina alinmis bir kimligi cozer. CC gibi ad alansiz varliklar icin null. */
export function parseInstrumentId(instrumentId) {
  const i = instrumentId.id.indexOf('/')
  if (i < 0) return { tenantId: null, localId: instrumentId.id }
  return { tenantId: instrumentId.id.slice(0, i), localId: instrumentId.id.slice(i + 1) }
}

/**
 * IZOLASYON KONTROLU — her kiraci cagrisinda calistirilmali.
 *
 * Kiracinin dokunmaya calistigi her varligin ya kendi ad alaninda ya da
 * ad alansiz (CC gibi ortak) olmasini sart kosar.
 */
export function assertTenantOwnsInstrument(tenantId, instrumentId) {
  assertValidTenantId(tenantId)
  const { tenantId: owner } = parseInstrumentId(instrumentId)
  if (owner !== null && owner !== tenantId) {
    throw new Error(
      `kiraci izolasyonu ihlali: "${tenantId}" kiracisi "${owner}" kiracisinin varligina dokunamaz (${instrumentId.id})`,
    )
  }
}

/** Bir takasin/transferin tum bacaklarini izolasyon acisindan dogrular. */
export function assertTenantLegs(tenantId, legs) {
  for (const l of Object.values(legs)) {
    assertTenantOwnsInstrument(tenantId, l.instrumentId)
  }
}

// ------------------------------------------------------------------ anahtar

const KEY_PREFIX = 'ags_'

/**
 * Yeni bir SDK anahtari uretir.
 *
 * Donen `secret` KIRACIYA BIR KEZ gosterilir ve saklanmaz; sunucu tarafinda
 * yalnizca `hash` tutulur. Anahtar kaybedilirse yenisi uretilir, mevcut olan
 * geri getirilemez.
 */
export function generateTenantKey(tenantId) {
  assertValidTenantId(tenantId)
  const secret = `${KEY_PREFIX}${tenantId}_${randomBytes(24).toString('base64url')}`
  return { tenantId, secret, hash: hashTenantKey(secret) }
}

export function hashTenantKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * Anahtari sabit zamanda dogrular.
 *
 * Duz `===` karsilastirmasi, yanit suresinden anahtarin karakterlerini
 * sizdirabilir; bu yuzden `timingSafeEqual` kullanilir.
 */
export function verifyTenantKey(secret, expectedHash) {
  if (typeof secret !== 'string' || typeof expectedHash !== 'string') return false
  const a = Buffer.from(hashTenantKey(secret), 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Anahtardan kiraci kimligini okur (dogrulama YERINE GECMEZ). */
export function tenantIdFromKey(secret) {
  if (typeof secret !== 'string' || !secret.startsWith(KEY_PREFIX)) return null
  const rest = secret.slice(KEY_PREFIX.length)
  const i = rest.indexOf('_')
  if (i < 0) return null
  const id = rest.slice(0, i)
  try {
    assertValidTenantId(id)
    return id
  } catch {
    return null
  }
}

// -------------------------------------------------------------------- kota

/**
 * Kiraci basina islem kotasi — spam'in IDARI savunmasi.
 *
 * Ekonomik caydiricilik (her islemin gercek CC ve ag ucreti yakmasi) ilk
 * savunmadir ama tek basina yeterli degildir: sermayesi bol bir kiraci
 * ekonomik olarak "mesru" ama operasyonel olarak zararli bir hacim uretebilir.
 * Kota bu ikinci katmandir.
 *
 * Kayan pencere sayaci; kalici depo cagirana birakilir (bellek ici varsayilan
 * yalnizca tek surec icindir).
 */
export class TenantQuota {
  constructor({ windowSeconds = 60, maxWrites = 60, store = new Map() } = {}) {
    this.windowSeconds = windowSeconds
    this.maxWrites = maxWrites
    this.store = store
  }

  /** @returns {{allowed: boolean, remaining: number, resetAt: number}} */
  consume(tenantId, nowMs = Date.now(), cost = 1) {
    assertValidTenantId(tenantId)
    const windowMs = this.windowSeconds * 1000
    const bucket = this.store.get(tenantId) ?? { start: nowMs, used: 0 }
    if (nowMs - bucket.start >= windowMs) {
      bucket.start = nowMs
      bucket.used = 0
    }
    const resetAt = bucket.start + windowMs
    if (bucket.used + cost > this.maxWrites) {
      this.store.set(tenantId, bucket)
      return { allowed: false, remaining: Math.max(0, this.maxWrites - bucket.used), resetAt }
    }
    bucket.used += cost
    this.store.set(tenantId, bucket)
    return { allowed: true, remaining: this.maxWrites - bucket.used, resetAt }
  }
}
