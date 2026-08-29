/**
 * @arccade/game-sdk — Canton Network uzerinde oyun ekonomisi primitifleri.
 *
 * # Mimari kural
 *
 * Bu SDK'da DEGER TASIMAYAN HICBIR YAZMA API'SI YOKTUR.
 *
 * Oyun aktivitesi — skor, seviye, envanter durumu, eslesme, siralama, oturum
 * kaydi, basari rozeti — uygulamanin KENDI VERITABANINDA kalir. Zincire
 * yalnizca sahiplik ve deger degistiren olaylar yazilir:
 *
 *   1. `cycle`     deger taahhudu + settlement   (stake kilitlenir, cozulur)
 *   2. `trade`     sahiplik degisimi             (marketplace, item takasi)
 *   3. `transfer`  duz deger hareketi
 *
 * # Spam korumasi
 *
 * SDK'nin spam korumasi bir kural listesi degil, bir YOKLUKTUR: "skoru zincire
 * yaz" diye bir uc bulunmadigi icin kimse onu spam'leyemez. Var olan her uc
 * gercek deger hareket ettirir ve dolayisiyla saldirgana gercek maliyet yukler
 * — sahte hacim uretmek, uretenin kendi sermayesini baglamasi demektir.
 *
 * Buna ek olarak `cycle` katmani sunlari ledger seviyesinde zorlar: asgari
 * kilit suresi, asgari/azami dongu suresi, oyuncu basina es zamanlilik siniri
 * (slot jetonu), cooldown, ucret tabani. Ayrintilar `docs/DESIGN.md`.
 *
 * # Belgeler
 *
 * Oyunun bildigi her sey kanonik bir metin belgesine indirgenir ve zincire
 * yalnizca onun sha256'si girer. Belge uygulama tarafinda yayinlanir; ucuncu
 * taraf `sha256sum` ile dogrular. Kutuphane gerekmez.
 */

export {
  SCHEME_PREFIX,
  DIGEST_ALG_ID,
  canon,
  canonBool,
  canonDecimal,
  canonDocument,
  canonFields,
  canonInt,
  canonList,
  canonOptional,
  canonParty,
  canonText,
  canonTime,
  canonTimeMicros,
  codePointLength,
  documentDigest,
  amountUnits,
  textDigest,
  toMicros,
  merkleEmpty,
  merkleNode,
  merklePairUp,
  merkleRoot,
  merkleProof,
  merkleFold,
  merkleVerify,
  periodLeaf,
  periodLeafDocument,
  periodRowVerify,
  assertDisposition,
  DISPOSITIONS,
} from './digest.js'

// Ledger'in transaction TREE akisindan rapor satiri kurmak. Kurallar
// `test-vectors/` altindaki fixture'da yasar; bu, ona uyan uygulamalardan
// biridir.
export {
  REPORT_ORDER,
  closingFacts,
  commitFacts,
  isoToMicros,
  rowsFromTransactions,
  toLeafRow,
} from './cycleAudit.js'

export {
  CUSTODY_TAG_PREFIX,
  DRY_RUN_VENUE_PREFIX,
  assertHex64,
  assertValidCycleId,
  buildAbortCommands,
  buildCommitCommands,
  buildDryRunCommitCommands,
  buildExpireCommands,
  buildSettleCommands,
  custodyTagFor,
  newCycleId,
} from './cycle.js'

export {
  LEG_ASK,
  LEG_OFFER,
  TRADE_TAG_PREFIX,
  assertValidTradeId,
  buildTradeCancelCommands,
  buildTradeProposalCommands,
  buildTradeSettleCommands,
  leg,
  newTradeId,
  tradeDigest,
  tradeDocument,
} from './trade.js'

export {
  REASON_P2P,
  REASON_PAYOUT,
  REASON_REFUND,
  REASON_REWARD,
  TRANSFER_TAG_PREFIX,
  buildTransferCommands,
  transferDigest,
  transferDocument,
} from './transfer.js'

export {
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
} from './tenant.js'

export {
  FUNGIBLE,
  INSTANCE_SEPARATOR,
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
} from './assets.js'

// The half of the audit side this client was missing: the period anchor Daml
// decides, the venue policy every stake commits to, the settlement arithmetic
// Cycle.daml enforces, and the ledger-time arithmetic underneath all three.
// Python and Java shipped these; the client on npm did not, so a published
// report could not be independently verified in JavaScript at all.
export {
  ANCHOR_FIELDS,
  ANCHOR_SCHEMA,
  ANCHOR_SCHEMA_VERSION,
  ANCHOR_TOTAL_FIELDS,
  anchorDigest,
  anchorDocument,
  anchorTotals,
} from './periodAnchor.js'

export {
  POLICY_FIELDS,
  POLICY_SCHEMA,
  POLICY_SCHEMA_VERSION,
  policyDigest,
  policyDocument,
  validPolicy,
} from './policy.js'

export {
  SETTLEMENT_FIELDS,
  assertSettlementValid,
  settlementIsValid,
} from './settlement.js'

// Daml's Int division truncates TOWARD ZERO. JavaScript's `/` is float
// division and `Math.floor` rounds toward negative infinity; the two differ
// only on negatives — a clock-skewed or pre-epoch timestamp.
export {
  addSeconds,
  epochSeconds,
  intDivide,
  secondsBetween,
} from './ledgerTime.js'
