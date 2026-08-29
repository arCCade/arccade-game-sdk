/**
 * Marketplace / item ticareti — zincir ustune YAZILAN ikinci deger olayi turu.
 *
 * MIMARI KURAL. Bu SDK'da deger tasimayan hicbir yazma API'si YOKTUR ve
 * olmayacaktir. Oyun aktivitesi — skor, seviye, envanter durumu, eslesme,
 * siralama, oturum kaydi — uygulamanin KENDI VERITABANINDA kalir. Zincire
 * yalnizca sunlar yazilir:
 *
 *   1. Deger taahhudu ve settlement'i   -> `cycle.js`  (stake kilitlenir, cozulur)
 *   2. Sahiplik degisimi                -> `trade.js`  (bu dosya: takas/satis)
 *   3. Duz deger transferi              -> `transfer.js`
 *
 * SDK'nin spam korumasi bir kural listesi degil, bir YOKLUKTUR: "skoru zincire
 * yaz" diye bir uc olmadigi icin kimse onu spam'leyemez. Var olan uclarin
 * hepsi gercek deger hareket ettirir, dolayisiyla her biri saldirgana gercek
 * maliyet yukler.
 *
 * Takas mekanigi token standardinin allocation'lari uzerinden yurur; her bacak
 * KENDI `instrumentId`'sini tasir, dolayisiyla ayni primitif su uc durumu da
 * karsilar:
 *
 *   item  <-> CC            (marketplace satisi)
 *   item  <-> item          (takas)
 *   asset <-> asset         (ucuncu tarafin kendi varliklari)
 *
 * Allocation V1 burada DOGRU secimdir. `Allocation_Withdraw`'in tek basina
 * gonderen tarafindan cagrilabilmesi stake icin kabul edilemezdi (o bir kilit
 * degil, rezervasyondur) — ama bir TAKAS icin dogru davranis budur: karsi
 * taraf settle etmeden once vazgecebilmek, escrow'a mahkum olmamak demektir.
 * Custody, Settle anina kadar taraflarda kalir.
 */

import { randomUUID } from 'node:crypto'

import { textDigest } from './digest.js'

export const TRADE_TAG_PREFIX = 'arccade-game-sdk:trade:1:'

/** Takas bacaklarinin kanonik anahtarlari. */
export const LEG_OFFER = 'offer'
export const LEG_ASK = 'ask'

export function newTradeId(prefix = 't') {
  const id = `${prefix}-${randomUUID()}`
  assertValidTradeId(id)
  return id
}

export function assertValidTradeId(tradeId) {
  if (typeof tradeId !== 'string' || tradeId.length === 0 || tradeId.length > 64) {
    throw new Error(`gecersiz tradeId (bos olmamali, <=64 karakter): ${JSON.stringify(tradeId)}`)
  }
  if (tradeId.includes(':') || tradeId.includes('|')) {
    throw new Error(`tradeId ':' veya '|' iceremez: ${tradeId}`)
  }
}

/**
 * Bir takas bacagi: "X, Y'ye N birim INSTR gonderir".
 *
 * `instrumentId.admin` o varligin registry'sidir. CC icin DSO; bir oyun
 * item'i icin o item'i basan uygulamanin registry partisi. SDK varligi
 * yorumlamaz — yalnizca bacaklari tasir ve atomik settle eder.
 */
export function leg({ sender, receiver, instrumentId, amount }) {
  if (!sender || !receiver) throw new Error('takas bacagi sender ve receiver ister')
  if (sender === receiver) throw new Error('takas bacaginda sender ve receiver ayni olamaz')
  if (!instrumentId?.admin || !instrumentId?.id) {
    throw new Error('instrumentId {admin, id} olmali (varligin registry partisi + kimligi)')
  }
  if (!(Number(amount) > 0)) throw new Error(`takas bacagi tutari pozitif olmali: ${amount}`)
  return { sender, receiver, instrumentId, amount: String(amount) }
}

/**
 * Takasin kanonik belgesi ve digest'i.
 *
 * Zincire yalnizca digest girer; belge uygulamanin kendi tarafinda yayinlanir.
 * Bir item'in adi, gorseli, nadirlik seviyesi, oyun ici etkisi — hicbiri
 * zincire yazilmaz. Zincirde olan sey SAHIPLIK DEGISIMIDIR.
 */

/**
 * Belge bilesenleri ayiriciyi ICEREMEZ.
 *
 * Parcalar `|` ile birlestiriliyor. Bir parti adi ya da meta degeri `|`
 * tasirsa, birlestirilmis metin bir fazla bileseni varmis gibi okunur: iki
 * FARKLI girdi ayni belgeyi -- dolayisiyla ayni digest'i -- uretir. Bir
 * taahhut semasinda bu, kacirma degil dogrudan sahteciliktir.
 */
function assertNoSeparator(parts) {
  for (const p of parts) {
    if (String(p).includes('|')) {
      throw new Error(
        `arccade-sdk-digest-v1: belge bileseni '|' iceremez (belge ayristirilamaz olur): ${JSON.stringify(p)}`,
      )
    }
  }
}

export function tradeDocument({ tradeId, maker, taker, legs, expiresAt, meta = {} }) {
  assertValidTradeId(tradeId)
  const parts = [
    `tradeId=${tradeId}`,
    `maker=${maker}`,
    `taker=${taker ?? ''}`,
    `expiresAt=${typeof expiresAt === 'string' ? expiresAt : expiresAt.toISOString()}`,
  ]
  for (const [k, l] of Object.entries(legs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    parts.push(`leg.${k}=${l.sender}>${l.receiver}:${l.amount}:${l.instrumentId.admin}/${l.instrumentId.id}`)
  }
  for (const [k, v] of Object.entries(meta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    parts.push(`meta.${k}=${v}`)
  }
  assertNoSeparator(parts)
  return TRADE_TAG_PREFIX + parts.join('|')
}

export const tradeDigest = (t) => textDigest(tradeDocument(t))

const tpl = (packageId, module_, entity) => `${packageId}:${module_}:${entity}`

/**
 * ADIM 1 — teklif. Maker imzalar, venue gozlemler. Taker `None` ise acik teklif.
 *
 * Bu YAZMA degil bir DAVETTIR ve deger tasir: teklifin kabulu sahiplik
 * degistirir. Deger tasimayan "ilan goruntulendi", "favorilere eklendi" gibi
 * olaylar uygulamanin veritabaninda kalir.
 */
export function buildTradeProposalCommands({
  sdkPackageId, venue, maker, taker = null, tradeId, legs, expiresAt,
  settleBefore, commandId, meta = {},
}) {
  assertValidTradeId(tradeId)
  if (!legs?.[LEG_OFFER] || !legs?.[LEG_ASK]) {
    throw new Error(`takas iki bacak ister: "${LEG_OFFER}" ve "${LEG_ASK}"`)
  }
  const exp = typeof expiresAt === 'string' ? expiresAt : expiresAt.toISOString()
  const settle = typeof settleBefore === 'string' ? settleBefore : settleBefore.toISOString()

  const cmd = {
    CreateCommand: {
      templateId: tpl(sdkPackageId, 'ArCCade.GameSdk.Trade', 'TradeProposal'),
      createArguments: {
        venue, tradeId, maker, taker,
        legs: { values: Object.fromEntries(Object.entries(legs)) },
        expiresAt: exp,
        settleBefore: settle,
        tradeDigest: tradeDigest({ tradeId, maker, taker, legs, expiresAt: exp, meta }),
        meta: { values: meta },
      },
    },
  }
  return {
    tradeId,
    commands: [cmd],
    actAs: [maker],
    submission: {
      commands: {
        commands: [cmd],
        commandId: commandId ?? `trade-propose-${tradeId}`,
        actAs: [maker],
        readAs: [maker, venue],
      },
    },
  }
}

/**
 * ADIM 2 — atomik settlement. Venue tum bacaklari TEK islemde calistirir.
 *
 * Canton motoru hepsi-ya-hicbiri garantisi verir: item gider ama CC gelmez
 * gibi bir ara durum yoktur.
 */
export function buildTradeSettleCommands({
  sdkPackageId, venue, maker, taker, tradeCid, allocations, commandId,
}) {
  if (!allocations || Object.keys(allocations).length === 0) {
    throw new Error('settle icin her bacagin allocation contract id si gerekli')
  }
  const cmd = {
    ExerciseCommand: {
      templateId: tpl(sdkPackageId, 'ArCCade.GameSdk.Trade', 'Trade'),
      contractId: tradeCid,
      choice: 'Trade_Settle',
      choiceArgument: { allocations: { values: allocations } },
    },
  }
  return {
    commands: [cmd],
    actAs: [venue],
    submission: {
      commands: {
        commands: [cmd],
        commandId: commandId ?? `trade-settle-${tradeCid.slice(0, 16)}`,
        actAs: [venue],
        readAs: [venue, maker, taker].filter(Boolean),
      },
    },
  }
}

export function buildTradeCancelCommands({
  sdkPackageId, venue, tradeCid, reason = '', commandId,
}) {
  const cmd = {
    ExerciseCommand: {
      templateId: tpl(sdkPackageId, 'ArCCade.GameSdk.Trade', 'Trade'),
      contractId: tradeCid,
      choice: 'Trade_Cancel',
      choiceArgument: { reason },
    },
  }
  return {
    commands: [cmd],
    actAs: [venue],
    submission: {
      commands: { commands: [cmd], commandId: commandId ?? `trade-cancel-${tradeCid.slice(0, 16)}`, actAs: [venue] },
    },
  }
}
