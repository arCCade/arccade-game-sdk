/**
 * Duz deger transferi — zincire yazilan ucuncu ve son deger olayi turu.
 *
 * Kullanim alanlari: odul dagitimi, oyuncular arasi gonderim, turnuva
 * odemesi, iade. Takastan farki karsilik olmamasidir; `cycle`'dan farki
 * kilit ve settlement bulunmamasidir.
 *
 * BU EN COK ISTISMAR EDILEBILIR UCTUR ve bilerek en dar tutulmustur:
 *
 *   - Tek yonlu, karsiliksiz. Iki yonlu bir sey yaziyorsaniz `trade` kullanin.
 *   - Gonderen HER ZAMAN imzalar. SDK, kiracinin bir oyuncunun bakiyesini
 *     onun imzasi olmadan hareket ettirmesine izin vermez.
 *   - Kendine transfer reddedilir: sahte hacim uretmenin en ucuz yolu budur.
 *   - Toplu odemede AYNI alici tekrar edemez; ayni islemde ayni tarafa iki kez
 *     odeme yapmak, tek kalemi bolerek islem sayisi sismek demektir.
 *
 * Bir oyuncunun bir baskasina tekrar tekrar minik tutarlar gondererek hacim
 * uretmesi hala mumkundur — ama her seferinde gercek CC ve gercek ag ucreti
 * yakar. Ekonomik caydiricilik disinda bir koruma, kiraci duzeyindeki kota
 * katmanindadir (bkz. `tenant.js`).
 */

import { textDigest } from './digest.js'

export const TRANSFER_TAG_PREFIX = 'arccade-game-sdk:transfer:1:'

/** Transferin sebebi — raporlamada siniflandirma icin, zincire digest olarak girer. */
export const REASON_REWARD = 'reward'
export const REASON_PAYOUT = 'payout'
export const REASON_REFUND = 'refund'
export const REASON_P2P = 'p2p'

const REASONS = new Set([REASON_REWARD, REASON_PAYOUT, REASON_REFUND, REASON_P2P])

export function transferDocument({ transferId, sender, recipients, reason, meta = {} }) {
  const parts = [`transferId=${transferId}`, `sender=${sender}`, `reason=${reason}`]
  for (const r of recipients) {
    parts.push(`to=${r.receiver}:${r.amount}:${r.instrumentId.admin}/${r.instrumentId.id}`)
  }
  for (const [k, v] of Object.entries(meta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    parts.push(`meta.${k}=${v}`)
  }
  return TRANSFER_TAG_PREFIX + parts.join('|')
}

export const transferDigest = (t) => textDigest(transferDocument(t))

/**
 * Bir veya daha cok aliciya CC transferi (`AmuletRules_Transfer`).
 *
 * Toplu odeme TEK islemdir: N oyuncuya odul dagitmak N islem degil 1 islem
 * eder. Bu hem ucuz hem de nitelikli faaliyet sayimini durust tutar — SDK,
 * tek bir odemeyi boluperek islem sayisi sisirmeyi kolaylastirmaz.
 */
export function buildTransferCommands({
  amuletPackageId,
  sender,
  provider,
  recipients,
  inputAmuletCids,
  amuletRulesCid,
  openMiningRoundCid,
  dsoParty,
  transferId,
  reason = REASON_P2P,
  commandId,
  meta = {},
}) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('en az bir alici gerekli')
  }
  if (!REASONS.has(reason)) {
    throw new Error(`bilinmeyen sebep: ${reason} (gecerli: ${[...REASONS].join(', ')})`)
  }
  if (!Array.isArray(inputAmuletCids) || inputAmuletCids.length === 0) {
    throw new Error('inputAmuletCids bos olamaz')
  }

  const seen = new Set()
  for (const r of recipients) {
    if (!r.receiver) throw new Error('alici partisi gerekli')
    if (r.receiver === sender) {
      // Sahte hacim uretmenin en ucuz yolu; kaynakta kapatiliyor.
      throw new Error('kendine transfer reddedilir')
    }
    if (seen.has(r.receiver)) {
      throw new Error(`ayni alici tekrar edemez: ${r.receiver}`)
    }
    seen.add(r.receiver)
    if (!(Number(r.amount) > 0)) throw new Error(`transfer tutari pozitif olmali: ${r.amount}`)
  }

  const outputs = recipients.map((r) => ({
    receiver: r.receiver,
    amount: String(r.amount),
    receiverFeeRatio: '0.0',
  }))

  const cmd = {
    ExerciseCommand: {
      templateId: `${amuletPackageId}:Splice.AmuletRules:AmuletRules`,
      contractId: amuletRulesCid,
      choice: 'AmuletRules_Transfer',
      choiceArgument: {
        transfer: {
          sender,
          provider,
          inputs: inputAmuletCids.map((cid) => ({ tag: 'InputAmulet', value: cid })),
          outputs,
          beneficiaries: null,
        },
        context: {
          openMiningRound: openMiningRoundCid,
          issuingMiningRounds: [],
          validatorRights: [],
        },
        expectedDso: dsoParty,
      },
    },
  }

  return {
    transferId,
    // Belge uygulamada yayinlanir; zincire yalnizca sebep ve tutarlar girer.
    document: transferDocument({ transferId, sender, recipients, reason, meta }),
    digest: transferDigest({ transferId, sender, recipients, reason, meta }),
    commands: [cmd],
    // Gonderen HER ZAMAN imzalar: kiraci, oyuncunun bakiyesini onun imzasi
    // olmadan hareket ettiremez.
    actAs: [sender, provider].filter((v, i, a) => a.indexOf(v) === i),
    submission: {
      commands: {
        commands: [cmd],
        commandId: commandId ?? `transfer-${transferId}`,
        actAs: [sender, provider].filter((v, i, a) => a.indexOf(v) === i),
        readAs: [sender, provider].filter((v, i, a) => a.indexOf(v) === i),
      },
    },
  }
}
