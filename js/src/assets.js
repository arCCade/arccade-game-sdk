/**
 * Varlik katmani — ekosistemin uzerine insa edecegi temel.
 *
 * # Tasarim hedefi
 *
 * Bu katman TEK BIR OYUN TURUNE bagli degildir. MMORPG item'i, kart oyunu
 * kartı, yaris aracı, sezon bileti, oyun ici para birimi, turnuva jetonu —
 * hepsi ayni iki modelden birine oturur:
 *
 *   FUNGIBLE  Tur bazli. "500 altin", "3 iksir". Kopyalar birbirinin AYNI.
 *             Ucuz, cuzdanda duzgun gorunur, yiginlanabilir.
 *
 *   UNIQUE    Ornek bazli. "su kilic, +9 roll'uyla". Her ornek KENDI
 *             instrument'i, miktar her zaman 1. Nadirlik, artan statlar,
 *             "bu benim kilicim" mumkun.
 *
 * Ikisi ayni anda kullanilabilir ve kullanilmalidir: siradan tuketilebilirler
 * fungible, nadir/benzersiz olanlar unique.
 *
 * # Ozellikler (stat) nerede yasar
 *
 * ZINCIRDE DEGIL. Bir kilicin saldiri gucu, gorseli, aciklamasi, oyun ici
 * etkisi uygulamanin kendi veritabanindadir — bunlari zincire yazmak SDK'nin
 * mimari kuralini ihlal ederdi (deger tasimayan veri zincire yazilmaz).
 *
 * Ama zincire OZELLIK BELGESININ DIGEST'I baglanir. Sonuc:
 *
 *   * Bir oyuncu kilici satin alirken +9 oldugunu DOGRULAYABILIR.
 *   * Satistan sonra uygulama onu sessizce +3'e dusuremez — digest tutmaz.
 *   * Ucuncu taraf bir pazar yeri, kendi veritabanina guvenmeden dogrulama
 *     yapabilir.
 *
 * Bu, zaten kurulu olan digest mekanizmasinin aynisidir; yeni bir sey gerekmez.
 */

import { createHash } from 'node:crypto'

import { canonDocument, canonInt, canonText, textDigest } from './digest.js'
import { assertValidTenantId } from './tenant.js'

export const FUNGIBLE = 'fungible'
export const UNIQUE = 'unique'

/** Benzersiz ornekleri tur kimliginden ayiran isaret. */
export const INSTANCE_SEPARATOR = '#'

const LOCAL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,94}[a-z0-9]$/

export function assertValidLocalId(localId) {
  if (typeof localId !== 'string' || !LOCAL_ID_RE.test(localId)) {
    throw new Error(
      `gecersiz varlik kimligi (2-96 karakter, [a-z0-9._-], tire/nokta ile baslayip bitemez): ${JSON.stringify(localId)}`,
    )
  }
}

/**
 * Fungible bir varligin instrument kimligi.
 *
 *   `<tenantId>/<localId>`      ornek: `mygame/gold`, `mygame/health-potion`
 */
export function fungibleInstrument(registryParty, tenantId, localId) {
  assertValidTenantId(tenantId)
  assertValidLocalId(localId)
  return { admin: registryParty, id: `${tenantId}/${localId}` }
}

/**
 * Benzersiz bir orneğin instrument kimligi.
 *
 *   `<tenantId>/<localId>#<instanceId>`
 *   ornek: `mygame/sword-of-dawn#4a91c8f2`
 *
 * `instanceId` uygulamanin urettigi kararli bir kimliktir; ayni ornek icin
 * ayni deger uretilmelidir (yeniden basim degil, ayni varlik).
 */
export function uniqueInstrument(registryParty, tenantId, localId, instanceId) {
  assertValidTenantId(tenantId)
  assertValidLocalId(localId)
  if (typeof instanceId !== 'string' || !/^[a-z0-9-]{4,64}$/.test(instanceId)) {
    throw new Error(`gecersiz ornek kimligi (4-64 karakter, [a-z0-9-]): ${JSON.stringify(instanceId)}`)
  }
  return { admin: registryParty, id: `${tenantId}/${localId}${INSTANCE_SEPARATOR}${instanceId}` }
}

/** Bir instrument kimligini bilesenlerine ayirir. */
export function parseAsset(instrumentId) {
  const raw = instrumentId.id
  const slash = raw.indexOf('/')
  if (slash < 0) {
    // Ad alansiz: CC gibi ekosistem geneli varliklar.
    return { tenantId: null, localId: raw, instanceId: null, assetClass: FUNGIBLE }
  }
  const tenantId = raw.slice(0, slash)
  const rest = raw.slice(slash + 1)
  const hash = rest.indexOf(INSTANCE_SEPARATOR)
  if (hash < 0) {
    return { tenantId, localId: rest, instanceId: null, assetClass: FUNGIBLE }
  }
  return {
    tenantId,
    localId: rest.slice(0, hash),
    instanceId: rest.slice(hash + 1),
    assetClass: UNIQUE,
  }
}

export const isUnique = (instrumentId) => parseAsset(instrumentId).assetClass === UNIQUE

/**
 * Benzersiz bir varligin miktari HER ZAMAN 1 olmalidir.
 *
 * Bu kontrol takas ve transfer yollarinda calistirilir: "3 adet su kilic"
 * anlamsizdir ve sessizce gecerse cift harcama gibi gorunen tuhafliklara yol
 * acar.
 */
export function assertAmountValidForAsset(instrumentId, amount) {
  if (isUnique(instrumentId) && Number(amount) !== 1) {
    throw new Error(
      `benzersiz varligin miktari 1 olmali (${instrumentId.id} icin ${amount} verildi)`,
    )
  }
  if (!(Number(amount) > 0)) {
    throw new Error(`varlik miktari pozitif olmali: ${amount}`)
  }
}

/**
 * Varligin KANONIK OZELLIK BELGESI.
 *
 * Uygulama hangi ozellikleri baglayici saymak istiyorsa onlari verir. Alan
 * adlari ASCII olmalidir (siralamanin diller arasi ayni olmasi icin).
 *
 * Yalnizca SAYISAL ve METINSEL ozellikler baglanir; gorsel, aciklama, lokalize
 * metin gibi sunum verileri belgeye konabilir ama konmasi ZORUNLU degildir —
 * karar uygulamanin: neyi degistirilemez ilan ediyorsa onu koyar.
 */
export function assetAttributeDocument({ instrumentId, attributes, schemaVersion = 1 }) {
  const kvs = [['instrument', canonText(instrumentId.id)]]
  for (const [k, v] of Object.entries(attributes)) {
    if (typeof v === 'number' && Number.isInteger(v)) kvs.push([k, canonInt(v)])
    else if (typeof v === 'bigint') kvs.push([k, canonInt(v)])
    else if (typeof v === 'string') kvs.push([k, canonText(v)])
    else {
      throw new Error(
        `ozellik degeri tamsayi ya da metin olmali (${k}: ${typeof v}) — ondalik icin metin kullanin`,
      )
    }
  }
  return canonDocument('arccade-asset-attributes', schemaVersion, kvs)
}

export const assetAttributeDigest = (a) => textDigest(assetAttributeDocument(a))

/**
 * Bir orneğin kimligini ozelliklerinden TURETIR.
 *
 * Boylece ayni ozelliklere sahip iki basim ayni kimligi alir ve uygulama
 * yanlislikla ayni varligi iki kez basarsa bu fark edilir. Kullanimi istege
 * baglidir; kendi kimlik semaniz varsa onu kullanabilirsiniz.
 */
export function deriveInstanceId({ tenantId, localId, attributes, salt = '' }) {
  const doc = assetAttributeDocument({
    instrumentId: { id: `${tenantId}/${localId}` },
    attributes,
  })
  return createHash('sha256').update(doc + '|' + salt, 'utf8').digest('hex').slice(0, 32)
}
