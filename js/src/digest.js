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
  // `BigInt(true)` 1n verir: boolean sessizce tamsayiya donusur ve `b:4:true`
  // yerine `i:1:1` hash'lenir. Iki farkli deger ayni belgeyi uretirse taahhut
  // semasi kirilir; boolean icin `canonBool` var.
  if (typeof i === 'boolean') {
    throw new Error(
      `arccade-sdk-digest-v1: desteklenmeyen tamsayi turu: boolean (canonBool kullanin): ${i}`,
    )
  }
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
  // Bos dizenin sha256'si gecerli bir degerdir ama BURADA bir hatadir: bos bir
  // belge, olusturulamamis bir belgeden ayirt edilemez. Daml tarafi da reddeder.
  if (typeof t !== 'string' || t.length === 0) {
    throw new Error('arccade-sdk-digest-v1: gecersiz bos metin: bos dize digest almaz')
  }
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
    // Kirpma YOK. `" 1.0"` ile `"1.0"` ayni birimlere cozulurse, iki farkli
    // girdi ayni taahhude gider; dilbilgisi neyi kabul ettigini kendi soylesin.
    s = d
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
    // `Date.parse` MILISANIYE hassasiyetindedir: mikrosaniye tasiyan bir ledger
    // damgasi sessizce kirpilir ve digest, Daml'in urettiginden farkli olur.
    // Saniyeye kadarki kismi Date'e birak, kesri kendimiz oku.
    const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(t)
    if (m) {
      const whole = Date.parse(`${m[1].replace(' ', 'T')}${m[3] ?? 'Z'}`)
      if (Number.isNaN(whole)) throw new Error(`arccade-sdk-digest-v1: gecersiz zaman: ${t}`)
      const frac = ((m[2] ?? '') + '000000').slice(0, 6)
      return BigInt(whole / 1000) * 1000000n + BigInt(frac)
    }
    const ms = Date.parse(t)
    if (Number.isNaN(ms)) throw new Error(`arccade-sdk-digest-v1: gecersiz zaman: ${t}`)
    return BigInt(ms) * 1000n
  }
  throw new Error(`arccade-sdk-digest-v1: desteklenmeyen zaman turu: ${typeof t}`)
}

export const canonTime = (t) => canonTimeMicros(toMicros(t))

// ---------------------------------------------------------------------------
// Merkle — donem capasinin dogrulama tarafi
// ---------------------------------------------------------------------------
//
// Kok zincirde hesaplanir; DOGRULAMA burada yapilir. Denetci Daml kosmaz:
// yayinlanan raporu okur, satiri kanonik metne cevirir, yaprak degerini
// uretir ve icerme kanitini katlar. Daml tarafiyla bayt bayt ayni olmasi
// sarttir — altin vektor ikisini birbirine baglar.

/** Bos donemin koku. Dongusuz bir gun de capalanir. */
export const merkleEmpty = () => documentDigest('arccade.merkle-empty', 1, [])

/** Ic dugum. Yapraklardan AYRI sema; bkz. periodRowVerify. */
export function merkleNode(l, r) {
  return documentDigest('arccade.merkle-node', 1, [['l', canonText(l)], ['r', canonText(r)]])
}

/** Bir seviyeyi ikiserli birlestirir; tek kalan YUKSELTILIR, kopyalanmaz. */
export function merklePairUp(level) {
  const out = []
  for (let i = 0; i < level.length; i += 2) {
    out.push(i + 1 < level.length ? merkleNode(level[i], level[i + 1]) : level[i])
  }
  return out
}

export function merkleRoot(leaves) {
  if (leaves.length === 0) return merkleEmpty()
  let level = leaves
  while (level.length > 1) level = merklePairUp(level)
  return level[0]
}

/** `ix` numarali yaprak icin icerme kaniti: `[{siblingOnLeft, sibling}]`. */
export function merkleProof(ix, leaves) {
  if (ix < 0 || ix >= leaves.length) return []
  const steps = []
  let level = leaves
  let i = ix
  while (level.length > 1) {
    const sibIx = i % 2 === 0 ? i + 1 : i - 1
    // yukseltilmis dugumun bu seviyede kardesi yoktur
    if (sibIx < level.length) {
      steps.push({ siblingOnLeft: i % 2 === 1, sibling: level[sibIx] })
    }
    level = merklePairUp(level)
    i = Math.floor(i / 2)
  }
  return steps
}

export function merkleFold(leaf, steps) {
  return steps.reduce(
    (acc, s) => (s.siblingOnLeft ? merkleNode(s.sibling, acc) : merkleNode(acc, s.sibling)),
    leaf,
  )
}

export function merkleVerify(leaf, steps, root) {
  return merkleFold(leaf, steps) === root
}

/**
 * Bir denetim satirinin kanonik metni. Yayinlanan rapor bunu AYNEN
 * icermelidir. Alan adlari ve siralari Daml `Audit.periodLeafDocument` ile
 * birebir ayni olmak zorundadir.
 *
 * Tutarlar TAMSAYI 1e-10 birimi olarak verilir (`committedUnits` vb.),
 * ondalik olarak degil.
 */
export const DISPOSITIONS = Object.freeze([
  'returned-in-full',
  'returned-with-forfeit',
  'forfeited-in-full',
  'aborted',
  'expired-unsettled',
])

/**
 * Disposition ETIKETTIR, constructor adi DEGIL.
 *
 * Daml `dispositionTag` `ReturnedInFull` -> `"returned-in-full"` uretir.
 * Cagiran `"ReturnedInFull"` gecerse belge sessizce farkli baytlar uretir ve
 * yaprak Daml'inkiyle tutmaz — bu hata ancak bir denetci kaniti dogrulamaya
 * calistiginda, yani en gec anda ortaya cikardi. Bu yuzden dogrulanir.
 */
export function assertDisposition(d) {
  if (!DISPOSITIONS.includes(d)) {
    throw new Error(
      `arccade-sdk-digest-v1: gecersiz disposition: ${JSON.stringify(d)}; ` +
      `beklenen etiketler: ${DISPOSITIONS.join(', ')}`,
    )
  }
  return d
}

export function periodLeafDocument(row) {
  return canonDocument('arccade.cycle-audit-row', 1, [
    ['cycleId', canonText(row.cycleId)],
    ['player', canonParty(row.player)],
    ['gameCode', canonText(row.gameCode)],
    ['concurrencyIndex', canonInt(row.concurrencyIndex)],
    ['entryDigest', canonText(row.entryDigest)],
    ['outcomeDigest', canonText(row.outcomeDigest)],
    ['committedUnits', canonInt(row.committedUnits)],
    ['feeUnits', canonInt(row.feeUnits)],
    ['returnedUnits', canonInt(row.returnedUnits)],
    ['forfeitedUnits', canonInt(row.forfeitedUnits)],
    ['payoutUnits', canonInt(row.payoutUnits)],
    ['disposition', canonText(assertDisposition(row.disposition))],
    ['committedAtMicros', canonInt(row.committedAtMicros)],
    ['settledAtMicros', canonInt(row.settledAtMicros)],
    ['custodyTag', canonText(row.custodyTag)],
  ])
}

export const periodLeaf = (row) => textDigest(periodLeafDocument(row))

/**
 * DENETCININ KULLANMASI GEREKEN UC.
 *
 * Yapragi SATIRDAN hesaplar. Ham `merkleVerify`'i bir hash uzerinde cagirmak
 * bir ic dugum icin de true doner — katlama, basladigi degerin ne oldugunu
 * bilemez. Yapragi satirdan turetmek, "bu bir dongu satiridir" iddiasini
 * `arccade.cycle-audit-row` semasina baglar.
 */
export function periodRowVerify(row, steps, root) {
  return merkleVerify(periodLeaf(row), steps, root)
}
