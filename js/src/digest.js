/**
 * arccade-sdk-digest-v1/sha256 — kanonik belge kodlamasi ve commitment.
 *
 * Bu dosya, `daml/ArCCade/GameSdk/Digest.daml` ve `tools/digest_reference.py`
 * ile BAYT BAYT ayni sonucu uretmek ZORUNDADIR. Uc implementasyondan biri
 * saparsa altin vektor testleri kirilir (`npm test`, `daml test`,
 * `python3 tools/digest_reference.py`).
 *
 * Neden bu kadar onemli: commitment'in degeri, ucuncu bir tarafin yayinlanan
 * belgeye duz `sha256sum` calistirip zincirdeki digest'i bulabilmesine
 * dayanir. Parite bozulursa denetlenebilirlik iddiasi coker.
 *
 * JavaScript'e ozgu iki tuzak burada bilerek ele aliniyor:
 *
 *   1. UZUNLUK KOD NOKTASI cinsinden sayilir. `str.length` UTF-16 birimi sayar
 *      ve BMP disi karakterlerde (emoji vb.) sapar. `[...str].length` dogru
 *      olanidir. Java portu `codePointCount` kullanmali.
 *   2. TUTARLAR asla `Number` uzerinden gecmez. Ondalik metin BigInt ile
 *      1e-10 tamsayi birimine cevrilir; `parseFloat` kullanmak sessiz
 *      hassasiyet kaybi demektir.
 */

import { createHash } from 'node:crypto'

export const SCHEME_PREFIX = 'arccade-sdk-digest-v1'
export const DIGEST_ALG_ID = 'arccade-sdk-digest-v1/sha256'

/** Kod noktasi cinsinden uzunluk (UTF-16 birimi DEGIL). */
export function codePointLength(s) {
  let n = 0
  for (const _ of s) n += 1
  return n
}

/** Genel kodlama: `<tag>:<uzunluk>:<deger>`. */
export function canon(tag, value) {
  return `${tag}:${codePointLength(value)}:${value}`
}

export const canonText = (s) => canon('t', s)

export function canonInt(i) {
  const v = typeof i === 'bigint' ? i : BigInt(i)
  return canon('i', v.toString())
}

export const canonBool = (b) => canon('b', b ? 'true' : 'false')

/** Zaman: epoch'tan beri TAMSAYI MIKROSANIYE. ISO metni asla kullanilmaz. */
export function canonTimeMicros(micros) {
  const v = typeof micros === 'bigint' ? micros : BigInt(micros)
  return canon('m', v.toString())
}

export const canonParty = (p) => canon('p', p)

export function canonOptional(f, x) {
  return x === null || x === undefined ? canon('o', '') : canon('o', f(x))
}

/** Liste: eleman sayisi + `|` ile birlestirme. Elemanlar zaten kanonik olmali. */
export function canonList(items) {
  const xs = Array.from(items)
  return canon('l', `${xs.length}:${xs.join('|')}`)
}

/**
 * Kayit: alanlar ADA GORE siralanir.
 *
 * Siralama, Daml'in `sortOn fst` ve Python'un `sorted(key=...)` ile ayni
 * olmasi icin ASCII kod noktasi sirasidir. `Array.prototype.sort()`'un
 * varsayilan karsilastirmasi UTF-16 kod birimi sirasidir; alan adlari
 * ASCII [a-zA-Z0-9-] ile sinirli oldugu icin ikisi ayni sonucu verir.
 * Bu kisit `assertFieldName` ile zorlanir.
 */
export function canonFields(kvs) {
  const entries = Array.from(kvs)
  for (const [k] of entries) assertFieldName(k)
  const sorted = entries.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const body = sorted.map(([k, v]) => `${canon('k', k)}=${v};`).join('')
  return canon('r', body)
}

const FIELD_NAME_RE = /^[a-zA-Z0-9-]+$/

export function assertFieldName(name) {
  if (!FIELD_NAME_RE.test(name)) {
    throw new Error(
      `arccade-sdk-digest-v1: alan adi ASCII [a-zA-Z0-9-] olmali, siralama diller arasi belirsizlige duser: ${JSON.stringify(name)}`,
    )
  }
}

export function canonDocument(schema, version, kvs) {
  return SCHEME_PREFIX + '|' + canonText(schema) + canonInt(version) + canonFields(kvs)
}

/**
 * Kanonik metnin HAM BAYTLARININ sha256'si.
 *
 * Daml tarafinda `sha256` bir HEX DIZESI bekledigi icin metin once `toHex` ile
 * baytlara cevrilir; sonuc buradakiyle ayni olur. Ucuncu taraf ayni degeri
 * `sha256sum` ile elde eder.
 */
export function textDigest(t) {
  return createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex')
}

export function documentDigest(schema, version, kvs) {
  return textDigest(canonDocument(schema, version, kvs))
}

const UNITS_SCALE = 10n ** 10n
/** Daml Int siniri; 1e-10 birimde temsil edilebilir bant. */
const MAX_UNITS = 9223372036854775807n
const MIN_UNITS = -9223372036854775808n

/**
 * Ondalik tutar -> tamsayi 1e-10 birimi, gidis-donus guvenligiyle.
 *
 * Girdi METIN olmalidir (`"12.3456789012"`). `Number` kabul edilir ama
 * yalnizca tamsayi degerler icin; kesirli bir `Number` sessiz hassasiyet
 * kaybi riski tasidigi icin reddedilir.
 */
export function amountUnits(d) {
  let s
  if (typeof d === 'string') {
    s = d.trim()
  } else if (typeof d === 'bigint') {
    s = d.toString()
  } else if (typeof d === 'number') {
    if (!Number.isInteger(d)) {
      throw new Error(
        `arccade-sdk-digest-v1: kesirli tutar Number olarak verilemez (hassasiyet kaybi riski), metin kullanin: ${d}`,
      )
    }
    s = String(d)
  } else {
    throw new Error(`arccade-sdk-digest-v1: desteklenmeyen tutar turu: ${typeof d}`)
  }

  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s)
  if (!m) throw new Error(`arccade-sdk-digest-v1: gecersiz ondalik tutar: ${JSON.stringify(s)}`)

  const [, sign, intPart, fracRaw = ''] = m
  if (fracRaw.length > 10) {
    // Gidis-donus guvenligi: 1e-10'dan ince bir deger kayipsiz temsil edilemez.
    const tail = fracRaw.slice(10)
    if (/[^0]/.test(tail)) {
      throw new Error(
        `arccade-sdk-digest-v1: tutar 1e-10 birimine kayipsiz cevrilemedi: ${s}`,
      )
    }
  }
  const frac = fracRaw.slice(0, 10).padEnd(10, '0')
  const units = BigInt(intPart) * UNITS_SCALE + BigInt(frac || '0')
  const signed = sign === '-' ? -units : units

  if (signed > MAX_UNITS || signed < MIN_UNITS) {
    throw new Error(
      `arccade-sdk-digest-v1: tutar temsil edilebilir bandin disinda (+/-922337203.6854775807): ${s}`,
    )
  }
  return signed
}

/** Tutarlar asla islenmis ondalik olarak hash'lenmez. */
export function canonDecimal(d) {
  return canon('d', amountUnits(d).toString())
}

/** ISO 8601 / Date -> epoch mikrosaniye. */
export function toMicros(t) {
  if (typeof t === 'bigint') return t
  if (t instanceof Date) return BigInt(t.getTime()) * 1000n
  if (typeof t === 'number') return BigInt(Math.trunc(t)) * 1000n
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    if (Number.isNaN(ms)) throw new Error(`arccade-sdk-digest-v1: gecersiz zaman: ${t}`)
    return BigInt(ms) * 1000n
  }
  throw new Error(`arccade-sdk-digest-v1: desteklenmeyen zaman turu: ${typeof t}`)
}

export const canonTime = (t) => canonTimeMicros(toMicros(t))
