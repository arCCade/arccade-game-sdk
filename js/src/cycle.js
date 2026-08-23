/**
 * Iki-yazmalik dongunun komut kuruculari.
 *
 * SDK'nin asil degeri burada: dongu disiplini kod haline getirilmistir, boylece
 * oyun gelistiricisi yanlis yapamaz. Ozellikle:
 *
 *   - YAZMA 1 tam olarak IKI komuttur ve ikisi ayni gonderimde gitmek
 *     ZORUNDADIR. Ayri gonderilirlerse kilit ile GameStake arasindaki bag
 *     kopar; commit basarili olup transfer basarisiz olabilir (ya da tersi).
 *   - YAZMA 2'de SIRA onemlidir: `GameStake_Settle` kilidi CEKER, dolayisiyla
 *     kilidi arsivleyen `LockedAmulet_UnlockV2`'den ONCE gelmelidir.
 *   - `optContext` custody etiketini tasir. Jenerik bir metin yazmak
 *     ("arCCade game stake" gibi) stake'i kullanilamaz hale getirir: settlement
 *     etiketi dogrulayamaz ve dongu yalnizca abort edilebilir.
 *
 * Komutlar JSON Ledger API v2 bicimindedir; gonderimi cagirana birakilir
 * (`submit-and-wait-for-transaction`).
 */

import { randomUUID } from 'node:crypto'

import { DIGEST_ALG_ID, textDigest } from './digest.js'

export const CUSTODY_TAG_PREFIX = 'arccade-game-sdk:1:'
export const DRY_RUN_VENUE_PREFIX = 'dryrun-'

/** `arccade-game-sdk:1:<cycleId>:<entryDigest>` */
export function custodyTagFor(cycleId, entryDigest) {
  assertValidCycleId(cycleId)
  assertHex64(entryDigest)
  return CUSTODY_TAG_PREFIX + cycleId + ':' + entryDigest
}

/**
 * Yeni, benzersiz bir dongu kimligi uretir.
 *
 * BENZERSIZLIK ONEMLI: contract key olmadigi icin ledger ayni `cycleId` +
 * `entryDigest` ikilisinin tekrar kullanilmasini engelleyemez, ve ayni etiketi
 * tasiyan tek bir kilit birden cok donguyu "kanitlayabilir". Bu, tasarimin
 * bilinen ve raporlanan sinirlarindan biridir. SDK bunu KAYNAGINDA kapatir:
 * dongu kimligini her zaman buradan alin, elle uretmeyin.
 */
export function newCycleId(prefix = 'c') {
  const id = `${prefix}-${randomUUID()}`
  assertValidCycleId(id)
  return id
}

export function assertValidCycleId(cycleId) {
  if (typeof cycleId !== 'string' || cycleId.length === 0 || cycleId.length > 64) {
    throw new Error(`gecersiz cycleId (bos olmamali, <=64 karakter): ${JSON.stringify(cycleId)}`)
  }
  if (cycleId.includes(':') || cycleId.includes('|')) {
    throw new Error(`cycleId ':' veya '|' iceremez (etiket ayristirilamaz olur): ${cycleId}`)
  }
}

export function assertHex64(h) {
  if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) {
    throw new Error(`64 karakterlik kucuk harf sha256 bekleniyordu: ${JSON.stringify(h)}`)
  }
}

const tpl = (packageId, module_, entity) => `${packageId}:${module_}:${entity}`

/**
 * YAZMA 1 — commitment.
 *
 * Iki komut, tek gonderim, tek updateId:
 *   1. `AmuletRules_Transfer` — venue'ya iade edilmeyen ucret, oyuncuya
 *      `TimeLock`'lu stake ciktisi (gercek `LockedAmulet`), ustu para.
 *   2. `Entitlement_Commit` — slot tuketilir, `GameStake` yaratilir.
 *
 * Iki komut birbirini GOREMEZ (tek gonderimde cikti-girdi zincirlemesi yok).
 * Bag bu yuzden atomiklik + custody etiketi uzerinden kurulur ve settlement
 * aninda dogrulanir.
 */
export function buildCommitCommands(opts) {
  const {
    sdkPackageId,
    amuletPackageId,
    venue,
    operator,
    player,
    entitlementCid,
    gameCode,
    cycleId,
    entryDigest,
    stakeAmount,
    feeAmount,
    instrumentId,
    lockExpiresAt,
    amuletRulesCid,
    openMiningRoundCid,
    inputAmuletCids,
    dsoParty,
    commandId,
    stakeMeta = {},
  } = opts

  assertValidCycleId(cycleId)
  assertHex64(entryDigest)
  if (!Array.isArray(inputAmuletCids) || inputAmuletCids.length === 0) {
    throw new Error('inputAmuletCids bos olamaz: kilitlenecek Amulet girdisi yok')
  }
  const expiresAt = typeof lockExpiresAt === 'string' ? lockExpiresAt : lockExpiresAt.toISOString()
  const custodyTag = custodyTagFor(cycleId, entryDigest)

  const timeLock = {
    holders: [venue],
    expiresAt,
    // Kilidi donguye baglayan alan. Jenerik metin YAZMAYIN.
    optContext: custodyTag,
  }

  const stakeOutput = {
    receiver: player,
    amount: String(stakeAmount),
    receiverFeeRatio: '0.0',
    lock: timeLock,
  }

  const outputs = []
  if (Number(feeAmount) > 0) {
    outputs.push({ receiver: venue, amount: String(feeAmount), receiverFeeRatio: '0.0' })
  }
  outputs.push(stakeOutput)

  const transferCmd = {
    ExerciseCommand: {
      templateId: tpl(amuletPackageId, 'Splice.AmuletRules', 'AmuletRules'),
      contractId: amuletRulesCid,
      choice: 'AmuletRules_Transfer',
      choiceArgument: {
        transfer: {
          sender: player,
          provider: venue,
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

  const commitCmd = {
    ExerciseCommand: {
      templateId: tpl(sdkPackageId, 'ArCCade.GameSdk.Cycle', 'PlayerEntitlement'),
      contractId: entitlementCid,
      choice: 'Entitlement_Commit',
      choiceArgument: {
        gameCode,
        cycleId,
        terms: {
          stakeAmount: String(stakeAmount),
          feeAmount: String(feeAmount),
          feeReceiver: venue,
          instrumentId,
          custody: 'TimeLockedHolding',
          lockHolders: [venue],
          lockExpiresAt: expiresAt,
          custodyTag,
        },
        entryDigest,
        stakeMeta: { values: stakeMeta },
      },
    },
  }

  return {
    custodyTag,
    cycleId,
    // SIRA: transfer once, cunku kilit commit'ten once var olmali degil —
    // ayni islemde olduklari icin sira teknik olarak serbest, ama transferin
    // once yazilmasi olay akisinda kilidi stake'ten once gosterir ve
    // raporlamayi okunakli kilar.
    commands: [transferCmd, commitCmd],
    actAs: [player, venue, operator],
    readAs: [player, venue],
    submission: {
      commands: {
        commands: [transferCmd, commitCmd],
        commandId: commandId ?? `commit-${cycleId}`,
        actAs: [player, venue, operator],
        readAs: [player, venue],
      },
    },
  }
}

/**
 * YAZMA 2 — settlement.
 *
 * SIRA ZORUNLU: `GameStake_Settle` kilidi `Holding` arayuzunden ceker, bu
 * yuzden kilidi arsivleyen `LockedAmulet_UnlockV2`'den ONCE gelmelidir.
 * Tersine cevrilirse settlement "custody kaniti yok" ile reddedilir.
 */
export function buildSettleCommands(opts) {
  const {
    sdkPackageId,
    amuletPackageId,
    venue,
    operator,
    player,
    stakeCid,
    lockedAmuletCid,
    disposition = 'ReturnedInFull',
    returnedAmount,
    forfeitedAmount = '0.0',
    payoutAmount = '0.0',
    outcomeDocument,
    outcomeDigest,
    revealOutcome = true,
    revealedEntry = null,
    commandId,
    settlementMeta = {},
  } = opts

  const digest = outcomeDigest ?? (outcomeDocument ? textDigest(outcomeDocument) : null)
  if (!digest) throw new Error('outcomeDocument ya da outcomeDigest verilmeli')
  assertHex64(digest)

  if (disposition === 'ReturnedInFull' && Number(forfeitedAmount) !== 0) {
    throw new Error('ReturnedInFull stake in tamamini iade etmeli (forfeitedAmount 0 olmali)')
  }
  if (disposition === 'ForfeitedInFull' && Number(returnedAmount) !== 0) {
    throw new Error('ForfeitedInFull hicbir sey iade etmemeli (returnedAmount 0 olmali)')
  }

  const settleCmd = {
    ExerciseCommand: {
      templateId: tpl(sdkPackageId, 'ArCCade.GameSdk.Cycle', 'GameStake'),
      contractId: stakeCid,
      choice: 'GameStake_Settle',
      choiceArgument: {
        disposition,
        returnedAmount: String(returnedAmount),
        forfeitedAmount: String(forfeitedAmount),
        payoutAmount: String(payoutAmount),
        outcomeDigest: digest,
        revealedOutcome: revealOutcome && outcomeDocument ? outcomeDocument : null,
        revealedEntry,
        custodyRef: lockedAmuletCid ? { tag: 'HoldingRef', value: lockedAmuletCid } : null,
        settlementMeta: { values: settlementMeta },
      },
    },
  }

  const commands = [settleCmd]
  if (lockedAmuletCid) {
    commands.push({
      ExerciseCommand: {
        templateId: tpl(amuletPackageId, 'Splice.Amulet', 'LockedAmulet'),
        contractId: lockedAmuletCid,
        choice: 'LockedAmulet_UnlockV2',
        choiceArgument: {},
      },
    })
  }

  return {
    commands,
    actAs: [operator, venue, player],
    readAs: [operator, venue, player],
    outcomeDigest: digest,
    submission: {
      commands: {
        commands,
        commandId: commandId ?? `settle-${stakeCid.slice(0, 16)}`,
        actAs: [operator, venue, player],
        readAs: [operator, venue, player],
      },
    },
  }
}

/**
 * Dongunun iptali. Kanit BILEREK istege baglidir: abort'un varlik sebebi
 * zaten kilidin olusmamis olabilmesidir. Dongu SAYILMAZ ve daha uzun
 * `abortCooldownSeconds` slotu kullanim disi tutar.
 */
export function buildAbortCommands({
  sdkPackageId, venue, operator, player, stakeCid, reason,
  lockedAmuletCid = null, commandId,
}) {
  const cmd = {
    ExerciseCommand: {
      templateId: tpl(sdkPackageId, 'ArCCade.GameSdk.Cycle', 'GameStake'),
      contractId: stakeCid,
      choice: 'GameStake_Abort',
      choiceArgument: {
        reason,
        custodyRef: lockedAmuletCid ? { tag: 'HoldingRef', value: lockedAmuletCid } : null,
      },
    },
  }
  const actAs = [operator, player]
  return {
    commands: [cmd],
    actAs,
    submission: {
      commands: {
        commands: [cmd],
        commandId: commandId ?? `abort-${stakeCid.slice(0, 16)}`,
        actAs,
        readAs: [operator, venue, player],
      },
    },
  }
}

/**
 * Oyuncunun kosulsuz cikis yolu — kilit suresi dolduktan sonra arCCade'e de
 * DSO'ya da ihtiyac duymadan hem parasini hem slotunu geri alir.
 *
 * `LockedAmulet_OwnerExpireLockV2`'nin controller'i tek basina sahiptir.
 */
export function buildExpireCommands({
  sdkPackageId, amuletPackageId, player, stakeCid, lockedAmuletCid = null, commandId,
}) {
  const commands = [
    {
      ExerciseCommand: {
        templateId: tpl(sdkPackageId, 'ArCCade.GameSdk.Cycle', 'GameStake'),
        contractId: stakeCid,
        choice: 'GameStake_ExpireUnsettled',
        choiceArgument: {},
      },
    },
  ]
  if (lockedAmuletCid) {
    commands.push({
      ExerciseCommand: {
        templateId: tpl(amuletPackageId, 'Splice.Amulet', 'LockedAmulet'),
        contractId: lockedAmuletCid,
        choice: 'LockedAmulet_OwnerExpireLockV2',
        choiceArgument: {},
      },
    })
  }
  return {
    commands,
    actAs: [player],
    submission: {
      commands: {
        commands,
        commandId: commandId ?? `expire-${stakeCid.slice(0, 16)}`,
        actAs: [player],
        readAs: [player],
      },
    },
  }
}

export { DIGEST_ALG_ID }
