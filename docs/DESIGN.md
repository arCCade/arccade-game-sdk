# arccade-game-sdk — UYGULAMA DURUMU (bu bolum spesifikasyondan SONRA yazildi)

> **UYARI.** Asagidaki spesifikasyon TASARIMIN TAMAMINI anlatir ve bazi
> yerlerde henuz yazilmamis parcalari "ships in 1.0.0" / "verified" diye
> tarif eder. Komiteye giden her metin bu tabloya gore duzeltilmelidir.

| Parca | Durum |
|---|---|
| `Time`, `Digest`, `Types`, `Policy`, `Custody`, `Cycle` | v1.1.0'da UYGULANDI, TestNet'te vetted |
| `PlayerRoster` + zincir ustu `concurrencyLimit` zorlamasi | v1.4.0'da UYGULANDI, 27 Agu 2026'da TestNet'te vetted |
| `Games.TradeWars`, `Games.PixelRace` adaptorleri | UYGULANDI |
| Iki yazmalik dongu (commit + settle) | UYGULANDI ve TestNet'te ucdan uca kosuldu |
| Kip disiplini (`GameVenue.ensure`) | v1.1.0'da UYGULANDI (1.0.0'da EKSIKTI — asagiya bakin) |
| Python referans implementasyonu + altin vektor | UYGULANDI, `daml test` ile zorlaniyor |
| `Audit` modulu, `CycleAuditRow`, `VenuePeriodAnchor`, Merkle yardimcilari | v1.5.0'da UYGULANDI, 27 Agu 2026'da TestNet'te vetted — Daml/JS/Python paritesi altin vektorle kilitli |
| `GameVenue_AnchorPeriod` | v1.5.0'da UYGULANDI, mutasyonla dogrulandi |
| Java digest portu | **YAZILMADI** |
| Backend entegrasyonu (commitment/settlement yolu, Pixel Race stake-at-start) | **YAZILMADI** |
| Canli custody (gercek `LockedAmulet`) | **KOSULMADI** — TestNet cuzdaninda 0 CC var; mekanik MainNet'te zaten calisiyor |

## 1.0.0'da bulunan ve 1.1.0'da duzeltilen kusur

Dusmanca inceleme (63 ajan), `GameVenue.ensure`'un spesifikasyondaki kip
disiplini kosullarini TASIMADIGINI buldu ve fiilen kosarak gosterdi:
`ModeLive` bir venue `requireCustodyProof = False` ile kurulup **hic kilit
olmadan** 100 CC'lik bir dongu settle edebiliyordu. Bu haliyle S1 ve S6 birer
iddiaydi, ledger degismezi degil.

v1.1.0 sunlari kontrata bagladi: canli venue custody kanitindan vazgecemez;
kuru kosum venue'su `dryrun-` onekli olmak zorunda ve ucret alamaz/odul
dagitamaz; `GameStake` dogrudan yaratilsa bile etiket baglantisi, ucret tabani
ve stake bandi `ensure` ile zorlanir. `Test.GameSdk.ModeDisciplineTest`
alti testle bunu dogrular.

---

# arccade-game-sdk v1.0.0 — Tasarim Spesifikasyonu

> Uretim: 8 ajanli tasarim turu (1 kisit taramasi + 3 bagimsiz tasarim + 3 juri + sentez).
> Kazanan tasarim juri puanlari: 9/10, 8/10, 9/10.

## Tez

A game cycle is exactly two ledger transactions, both value-bearing: a commitment that pays a non-refundable fee to the venue and time-locks the player's CC (real LockedAmulet, venue as lock holder) while consuming a PlayerEntitlement slot to create one jointly-signed GameStake, and a settlement that fetches the lock through the standard Holding interface to prove the encumbrance, recomputes the sha256 commitment on-ledger before the money moves, and releases the funds — with everything the game knows (prices, seeds, scores, XP, leaderboards) reduced to two digests over canonical published documents that any third party reproduces with plain sha256.

## Dongu basina yazma: 2

- WRITE 1 — COMMITMENT. ONE transaction, submitted with actAs = [player, venue, operator], readAs = [], disclosedContracts = [AmuletRules, OpenMiningRound] fetched together from Scan in one call. commands = [ (a) ExerciseCommand AmuletRules_Transfer on AmuletRules: inputs = the player's selected Amulets, provider = venue, outputs = [ TransferOutput{receiver = venue, amount = terms.feeAmount} , TransferOutput{receiver = player, amount = terms.stakeAmount, lock = Some TimeLock{holders = [venue], expiresAt = terms.lockExpiresAt, optContext = Some terms.custodyTag}} ]; (b) ExerciseCommand Entitlement_Commit on the player's PlayerEntitlement cid ]. LEDGER EFFECTS: LockedAmulet created (the encumbrance), fee Amulet to the venue (the S3 exposure, spent before the outcome exists), change Amulet back to the player, PlayerEntitlement archived, GameStake created. Net app-side: 1 archive + 1 create. One updateId. VALUE-BEARING: it both moves and encumbers user value.

- WRITE 2 — SETTLEMENT. ONE transaction, submitted with actAs = [operator, venue, player]. commands = [ (a) ExerciseCommand GameStake_Settle on the GameStake cid, with custodyRef = Some (HoldingRef <lockedAmuletCid>); (b) ExerciseCommand LockedAmulet_UnlockV2 on <lockedAmuletCid>; (c) OPTIONAL ExerciseCommand AmuletRules_Transfer paying payoutAmount from PRE-EXISTING venue-owned Amulets to the player (a prize) ]. ORDER MATTERS: Settle fetches the LockedAmulet through the Holding interface to prove the encumbrance, so it must run before the unlock archives it. All three parties are needed and each for a distinct reason, both verified in this session: player for LockedAmulet_UnlockV2's controller set (amulet.owner :: lock.holders), venue for the same controller set AND for VISIBILITY of the locked holding (a submission cannot fetch a contract none of its reading parties sees — this failed in test until venue was added), operator as the choice controller. LEDGER EFFECTS: GameStake archived (its exercise node carrying disposition, returnedAmount, forfeitedAmount, payoutAmount, outcomeDigest and any reveal), PlayerEntitlement recreated with the new cooldown and counters, LockedAmulet archived, Amulet returned to the player. Net app-side: 1 archive + 1 create, and the created contract is the same idle slot that existed before write 1. NOTHING is created to record the outcome. VALUE-BEARING.

- NOT A CYCLE WRITE, amortised and explicitly outside the qualifying fee base: one GameVenue creation ever; GameVenue_IssueEntitlements once per player-slot at onboarding (batched, ~50 grants per transaction); GameVenue_UpdatePolicy / _SetAuditor (rare); GameVenue_AnchorPeriod (one VenuePeriodAnchor per venue per reporting period, default one UTC day, ~0.1% of a write per cycle at 1,000 cycles/day). There is NO oracle write, NO price record, NO game result, NO claim receipt, NO leaderboard write, NO per-cycle audit receipt and NO FeaturedAppActivityMarker. The SDK deliberately declines to manufacture a marker for the commitment leg: a marker is a non-value contract and arCCade's own S2 says its fees must be excluded anyway.

- EXCEPTION PATHS, one transaction each, reported in their own class because a high rate of either is an audit signal: GameStake_Abort (operator + player; the commitment's sibling transfer never materialised or the venue cancels — the stake, if any, is released by a sibling LockedAmulet_UnlockV2 in the same transaction, the cycle is not counted, and abortCooldownSeconds applies) and GameStake_ExpireUnsettled (player alone after terms.lockExpiresAt, paired with LockedAmulet_OwnerExpireLockV2 — the player's unconditional exit).

- WHAT IS GONE relative to today: PriceRecord(entry), PriceRecord(exit), GameRound, GameResult, ClaimReceipt, CancelReceipt, LeaderboardEntry (Trade Wars: six app writes per round, none of which move or encumber value); RaceSession, GamePlay, GamePlayResult, SessionResult and the RaceSession re-create that RecordGameResult performed on every single game (Pixel Race). Six-plus app writes per cycle become one, and the two transactions that remain actually move value, which the current six do not.


## Moduller

### `ArCCade.GameSdk.Time`
Ledger time only. epochMicros/epochSeconds/secondsBetween/addSeconds. Re-implemented rather than imported from ArCCade.Common so the SDK has zero dependency on arccade-game-contracts. Every duration check in the package flows through these, fed by `now <- getTime`; no choice anywhere accepts a caller-supplied epoch.

Bagimliliklar: daml-stdlib (DA.Date, DA.Time)

### `ArCCade.GameSdk.Digest`
The commitment scheme "arccade-sdk-digest-v1/sha256". ONE mechanism: a payload renders to a canonical TEXT document and the commitment is sha256 of that text, so (a) a third party verifies a published payload with plain sha256 over the exact bytes arCCade published, and (b) the pre-image is a Text, so a settlement choice can take it as an argument, recompute on-ledger and reject a mismatch. Exports canon/canonText/canonInt/canonDecimal/canonBool/canonTime/canonParty/canonOptional/canonList/canonFields/canonDocument, documentDigest, amountUnits/unitsAmount, isHex64, assertDigestMatches, and merkleEmpty/merkleNode/merklePairUp/merkleRoot/merkleWalk/merkleVerify. Copied in spirit from Splice.Amulet.CryptoHash, never imported, so no splice-amulet package-id is pinned.

Bagimliliklar: ArCCade.GameSdk.Time, daml-stdlib (DA.Text.sha256, DA.List.sortOn)

### `ArCCade.GameSdk.Types`
Value types, no templates: CustodyMechanic (TimeLockedHolding | TokenAllocation), CustodyRef (HoldingRef | AllocationRef | NoRef), Disposition (5 constructors), VenueMode (ModeLive | ModeDryRun), VenuePolicy (12 fields), StakeTerms (8 fields), EntitlementGrant, dispositionTag/modeTag, custodyTagPrefix/custodyTagFor, isValidCycleId. Every variant the package will ever need is declared in 1.0.0 on purpose: adding a constructor to a serializable variant later is an upgrade question best not answered under pressure.

Bagimliliklar: splice-api-token-holding-v1 (InstrumentId), splice-api-token-allocation-v1 (Allocation, for the typed custody seam), daml-stdlib (DA.Text)

### `ArCCade.GameSdk.Policy`
policyDocument/policyDigest (the exact policy in force is committed to on every stake), validPolicy (used in `ensure`, so an incoherent policy is not creatable — in particular minLockSeconds >= minCycleSeconds, because a lock that can expire mid-cycle is not a lock), assertTermsMeetPolicy (stake bounds, fee floor, custody-tag binding, venue in lock holders, lock duration bounds measured from ledger time).

Bagimliliklar: ArCCade.GameSdk.Types, ArCCade.GameSdk.Time, ArCCade.GameSdk.Digest

### `ArCCade.GameSdk.Custody`
The S6 keystone and the whole custody seam. verifyLockedHolding fetches the standard Holding interface view and asserts owner == player, instrumentId, amount >= stake, lock present, venue in lock.holders, lock.expiresAt == the agreed expiry, and lock.context == this cycle's custody tag. Legal because the venue is a lock holder and therefore a signatory of LockedAmulet (Splice/Amulet.daml:187). verifyCustody dispatches on CustodyMechanic and fails closed on TokenAllocation; adding that one branch is the whole migration to allocation custody.

Bagimliliklar: ArCCade.GameSdk.Types, splice-api-token-holding-v1

### `ArCCade.GameSdk.Cycle`
The entire per-cycle on-ledger surface: GameVenue, PlayerEntitlement, GameStake, plus recycleEntitlement and sdkVersionId/emptyMeta. One module because the templates are mutually recursive (the entitlement creates the stake; the stake recreates the entitlement) and Daml has no circular imports. It is also why the value-bearing templates live in the SDK and not in a game package above it: retroactive interface instances do not exist.

Bagimliliklar: ArCCade.GameSdk.Types, ArCCade.GameSdk.Policy, ArCCade.GameSdk.Custody, ArCCade.GameSdk.Digest, ArCCade.GameSdk.Time, splice-api-token-holding-v1, splice-api-token-metadata-v1

### `ArCCade.GameSdk.Audit`
OFF-CYCLE and explicitly non-qualifying. CycleAuditRow, periodLeafDocument/periodLeaf and template VenuePeriodAnchor: one write per venue per reporting period (default one UTC day) carrying a Merkle root over 100% of cycles, chained to the previous period. It is the only mechanism in the package that lets an auditor prove an OMISSION — a cycle seen on Scan but absent from the published report. At 1,000 cycles/day it costs 0.1% of one write per cycle. There is deliberately NO per-cycle audit record.

Bagimliliklar: ArCCade.GameSdk.Digest, ArCCade.GameSdk.Types

### `ArCCade.GameSdk.Games.TradeWars`
Thin adapter: pure functions and data only, NO templates. gameCode = "trade-wars-v4"; PricePoint, AssetAllocation, TradeWarsEntry, TradeWarsOutcome; entryDocument/outcomeDocument (the canonical published text) and entryDigest/outcomeDigest = documentDigest of it. Normative definition the Java backend mirrors byte-for-byte.

Bagimliliklar: ArCCade.GameSdk.Digest

### `ArCCade.GameSdk.Games.PixelRace`
Same shape: gameCode = "pixel-race-v1"; GamePlay, PixelRaceEntry (commits rngSeedCommit), PixelRaceOutcome (reveals rngSeed). The entry commits the seed and the outcome reveals it, so GameStake_Settle's on-ledger digest check proves the seed was fixed before play — a provable-fairness claim Pixel Race cannot make today, at zero extra write.

Bagimliliklar: ArCCade.GameSdk.Digest

### `(separate package) arccade-game-sdk-test`
Test.GameSdk.Mocks (MockLockedHolding, mirroring LockedAmulet's signatories and Holding instance), Fixture, CustodyTest, LifecycleTest, Vectors. In its OWN daml package: a template implementing Holding must not ship in the production DAR, and the shipped DAR must not depend on daml-script. The SDK builds with -Werror=unused-dependency and no daml-script at all.

Bagimliliklar: arccade-game-sdk (data-dependency on the built DAR), daml-script, splice-api-token-holding-v1, splice-api-token-metadata-v1


## Sablonlar

### `GameVenue` (ArCCade.GameSdk.Cycle) — deger tasiyor: False

- signatory: signatory operator
- observer: observer venue, optionalToList auditor
- ensure: validPolicy policy && not (null gameCodes) && T.length venueId > 0 && (mode == ModeDryRun || policy.requireCustodyProof) && (mode == ModeLive || (dryRunVenuePrefix `T.isPrefixOf` venueId && policy.minPlatformFee == 0.0 && policy.maxPayoutAmount == 0.0))

- alanlar:

  - `venue : Party  -- the gaming PartyID: lock holder, fee receiver, featured-app provider`

  - `operator : Party  -- signing/admin party; equal to the validator party today, kept separate so the gaming PartyID can be split out without a package change`

  - `venueId : Text`

  - `sdkVersion : Text`

  - `mode : VenueMode`

  - `gameCodes : [Text]  -- ["trade-wars-v4","pixel-race-v1"]: the ledger-visible S5 statement`

  - `policy : VenuePolicy`

  - `custody : CustodyMechanic`

  - `instrumentId : Holding.InstrumentId`

  - `auditor : Optional Party`

  - `meta : Metadata.Metadata`

- choice'lar:

  - **GameVenue_IssueEntitlements** (controller: operator (nonconsuming)) -> [ContractId PlayerEntitlement]

    - arg `grants : [EntitlementGrant]`

    - govde: now <- getTime; forA grants $ \g -> do { assertMsg "concurrencyIndex outside policy limit" (g.concurrencyIndex >= 0 && g.concurrencyIndex < policy.concurrencyLimit); create PlayerEntitlement with venue; operator; venueId; mode; player = g.player; concurrencyIndex = g.concurrencyIndex; tier = g.tier; policy; custody; instrumentId; auditor; nextEligibleAt = now; cyclesCompleted = 0; lifetimeStaked = 0.0; meta = emptyMeta }. Batched so onboarding N players costs one transaction. Amortised, off-cycle, outside the qualifying fee base.

  - **GameVenue_UpdatePolicy** (controller: operator (consuming)) -> ContractId GameVenue

    - arg `newPolicy : VenuePolicy`

    - arg `newGameCodes : [Text]`

    - govde: create this with policy = newPolicy; gameCodes = newGameCodes. `ensure validPolicy` re-checks the new policy. Open cycles are provably unaffected because GameStake carries its own policy snapshot and policyHash — non-retroactivity is a player-protection property, not a fetch optimisation.

  - **GameVenue_SetAuditor** (controller: operator (consuming)) -> ContractId GameVenue

    - arg `newAuditor : Optional Party`

    - govde: create this with auditor = newAuditor. Note honestly: this does NOT retro-add the auditor to existing entitlements or stakes, so auditor onboarding is effective from the next issuance/cycle.

  - **GameVenue_AnchorPeriod** (controller: operator (nonconsuming)) -> ContractId VenuePeriodAnchor

    - arg `periodId : Text`

    - arg `periodStartMicros : Int`

    - arg `periodEndMicros : Int`

    - arg `rows : [CycleAuditRow]`

    - arg `committedUnits : Int`

    - arg `feeUnits : Int`

    - arg `payoutUnits : Int`

    - arg `qualifyingTxCount : Int`

    - arg `nonQualifyingTxCount : Int`

    - arg `reportUri : Text`

    - arg `reportDigest : Text`

    - arg `prevAnchorDigest : Text`

    - govde: assertMsg "period is empty or reversed" (periodEndMicros > periodStartMicros); let leaves = map periodLeaf rows; assertMsg "duplicate cycleId in the period" (length (dedup (map (.cycleId) rows)) == length rows); let root = merkleRoot leaves; let doc = canonDocument "arccade.period-anchor" 1 [("venueId",canonText venueId),("periodId",canonText periodId),("periodStartMicros",canonInt periodStartMicros),("periodEndMicros",canonInt periodEndMicros),("cycleCount",canonInt (length rows)),("committedUnits",canonInt committedUnits),("feeUnits",canonInt feeUnits),("payoutUnits",canonInt payoutUnits),("qualifyingTxCount",canonInt qualifyingTxCount),("nonQualifyingTxCount",canonInt nonQualifyingTxCount),("merkleRootHex",canonText root),("reportDigest",canonText reportDigest),("prevAnchorDigest",canonText prevAnchorDigest)]; create VenuePeriodAnchor with venue; operator; venueId; mode; periodId; periodStartMicros; periodEndMicros; cycleCount = length rows; committedUnits; feeUnits; payoutUnits; qualifyingTxCount; nonQualifyingTxCount; merkleRootHex = root; reportUri; reportDigest; prevAnchorDigest; anchorDigest = documentDigest doc; auditor. The root and the anchor digest are recomputed in Daml so the venue cannot store an anchor inconsistent with its own contents.

### `PlayerEntitlement` (ArCCade.GameSdk.Cycle) — deger tasiyor: False

- signatory: signatory operator
- observer: observer player, venue, optionalToList auditor
- ensure: concurrencyIndex >= 0 && validPolicy policy

- alanlar:

  - `venue : Party`

  - `operator : Party`

  - `venueId : Text`

  - `mode : VenueMode`

  - `player : Party`

  - `concurrencyIndex : Int  -- 0..concurrencyLimit-1; the slot this token represents`

  - `tier : Text`

  - `policy : VenuePolicy  -- denormalised at issue time`

  - `custody : CustodyMechanic`

  - `instrumentId : Holding.InstrumentId`

  - `nextEligibleAt : Time  -- cooldown gate, set by the previous settlement from ledger time`

  - `cyclesCompleted : Int`

  - `lifetimeStaked : Decimal`

  - `auditor : Optional Party`

  - `meta : Metadata.Metadata`

- choice'lar:

  - **Entitlement_Commit** (controller: operator, player (CONSUMING)) -> ContractId GameStake

    - arg `gameCode : Text`

    - arg `cycleId : Text`

    - arg `terms : StakeTerms`

    - arg `entryDigest : Text`

    - arg `stakeMeta : Metadata.Metadata`

    - govde: now <- getTime; assertMsg "player is in cooldown" (now >= nextEligibleAt); assertMsg "cycleId is empty, too long, or contains ':' or '|'" (isValidCycleId cycleId); assertMsg "entry digest is not a 64-char lowercase sha256" (isHex64 entryDigest); assertMsg "instrument does not match the entitlement" (terms.instrumentId == instrumentId); assertMsg "custody mechanic does not match the entitlement" (terms.custody == custody); assertTermsMeetPolicy policy cycleId entryDigest venue now terms; create GameStake with venue; operator; venueId; mode; player; gameCode; cycleId; concurrencyIndex; tier; policy; custody; terms; committedAt = now; entryDigest; digestAlg = digestAlgId; policyHash = policyDigest policy; cyclesCompletedBefore = cyclesCompleted; lifetimeStakedBefore = lifetimeStaked; auditor; meta = stakeMeta. This is WRITE 1, command 2; command 1 is the AmuletRules_Transfer that creates the lock. The two commands cannot see each other (no output-to-input chaining in one submission), which is exactly why the binding is atomicity plus the custody tag and is verified at settlement instead.

  - **Entitlement_Revoke** (controller: operator (consuming)) -> ()

    - arg `reason : Text`

    - govde: pure (). Account-level kill switch (S4): a player with no entitlement cannot open a cycle. The reason is recorded in the exercise node.

  - **Entitlement_Retire** (controller: operator, player (consuming)) -> ()

    - govde: pure (). Consensual wind-down, so a player can leave without the venue acting unilaterally.

### `GameStake` (ArCCade.GameSdk.Cycle) — deger tasiyor: True

- signatory: signatory operator, player
- observer: observer venue, optionalToList auditor
- ensure: terms.stakeAmount > 0.0 && terms.feeAmount >= 0.0 && isHex64 entryDigest && isValidCycleId cycleId && terms.custodyTag == custodyTagFor cycleId entryDigest

- alanlar:

  - `venue : Party`

  - `operator : Party`

  - `venueId : Text`

  - `mode : VenueMode`

  - `player : Party`

  - `gameCode : Text  -- the SDK never interprets this`

  - `cycleId : Text  -- also the payload of the lock context`

  - `concurrencyIndex : Int`

  - `tier : Text`

  - `policy : VenuePolicy  -- snapshot: a later GameVenue_UpdatePolicy cannot reach into an open cycle`

  - `custody : CustodyMechanic`

  - `terms : StakeTerms`

  - `committedAt : Time  -- ledger time, never a caller argument`

  - `entryDigest : Text  -- 64-char sha256 of the canonical entry document`

  - `digestAlg : Text`

  - `policyHash : Text`

  - `cyclesCompletedBefore : Int`

  - `lifetimeStakedBefore : Decimal`

  - `auditor : Optional Party`

  - `meta : Metadata.Metadata`

- choice'lar:

  - **GameStake_Settle** (controller: operator (CONSUMING)) -> ContractId PlayerEntitlement

    - arg `disposition : Disposition`

    - arg `returnedAmount : Decimal`

    - arg `forfeitedAmount : Decimal`

    - arg `payoutAmount : Decimal`

    - arg `outcomeDigest : Text`

    - arg `revealedOutcome : Optional Text`

    - arg `revealedEntry : Optional Text`

    - arg `custodyRef : Optional CustodyRef`

    - arg `settlementMeta : Metadata.Metadata`

    - govde: now <- getTime; assertMsg "outcome digest is not a 64-char lowercase sha256" (isHex64 outcomeDigest); assertMsg "cycle has not run for the minimum duration" (secondsBetween committedAt now >= policy.minCycleSeconds); assertMsg "cycle overran the maximum duration" (secondsBetween committedAt now <= policy.maxCycleSeconds); assertMsg "disposition is not valid for a normal settlement" (disposition == ReturnedInFull || disposition == ReturnedWithForfeit || disposition == ForfeitedInFull); assertMsg "settled amounts do not add up to the staked amount" (returnedAmount + forfeitedAmount == terms.stakeAmount); assertMsg "returnedAmount must not be negative" (returnedAmount >= 0.0); assertMsg "forfeitedAmount must not be negative" (forfeitedAmount >= 0.0); assertMsg "ReturnedInFull must return the whole staked amount" (disposition /= ReturnedInFull || forfeitedAmount == 0.0); assertMsg "a time-locked stake cannot be forfeited inside the settlement transaction; take the at-risk amount as terms.feeAmount at commitment" (custody /= TimeLockedHolding || forfeitedAmount == 0.0); assertMsg "payoutAmount must not be negative" (payoutAmount >= 0.0); assertMsg "payoutAmount exceeds the policy ceiling" (payoutAmount <= policy.maxPayoutAmount); assertDigestMatches "entry" entryDigest revealedEntry; assertDigestMatches "outcome" outcomeDigest revealedOutcome; verifyCustody custody custodyRef policy.requireCustodyProof player venue terms.instrumentId terms.stakeAmount terms.lockExpiresAt terms.custodyTag; recycleEntitlement this True (addSeconds now policy.cooldownSeconds). Creates NO receipt: the disposition, the amounts and the outcome digest live in this exercise node, in the same transaction as the value movement. This is WRITE 2, command 1; command 2 is LockedAmulet_UnlockV2 and command 3 (optional) is an AmuletRules_Transfer paying payoutAmount from venue float. Order matters: Settle fetches the LockedAmulet, so it must precede the unlock that archives it.

  - **GameStake_Abort** (controller: operator, player (CONSUMING)) -> ContractId PlayerEntitlement

    - arg `reason : Text`

    - arg `custodyRef : Optional CustodyRef`

    - govde: now <- getTime; case custodyRef of { Some (HoldingRef cid) -> verifyLockedHolding cid player venue terms.instrumentId terms.stakeAmount terms.lockExpiresAt terms.custodyTag; _ -> pure () }; recycleEntitlement this False (addSeconds now policy.abortCooldownSeconds). Proof is optional here on purpose: the whole point of an abort is that the encumbrance may not exist (the commitment's sibling transfer never materialised, or the venue is cancelling). The cycle is NOT counted, and the longer abortCooldownSeconds keeps the slot out of use — so an unfunded commit buys a farmer no throughput.

  - **GameStake_ExpireUnsettled** (controller: player (CONSUMING)) -> ContractId PlayerEntitlement

    - govde: now <- getTime; assertMsg "lock has not expired yet" (now >= terms.lockExpiresAt); recycleEntitlement this False now. Pairs with LockedAmulet_OwnerExpireLockV2, whose controller is the owner alone: after expiry the player recovers the funds without arCCade and without the DSO, and clears the SDK record here. There is no state in which arCCade can strand a player's funds or their entitlement.

### `VenuePeriodAnchor` (ArCCade.GameSdk.Audit) — deger tasiyor: False

- signatory: signatory operator
- observer: observer venue, optionalToList auditor
- ensure: (none — the invariants are enforced in GameVenue_AnchorPeriod, which recomputes merkleRootHex and anchorDigest in Daml)

- alanlar:

  - `venue : Party`

  - `operator : Party`

  - `venueId : Text`

  - `mode : VenueMode`

  - `periodId : Text`

  - `periodStartMicros : Int`

  - `periodEndMicros : Int`

  - `cycleCount : Int`

  - `committedUnits : Int`

  - `feeUnits : Int`

  - `payoutUnits : Int`

  - `qualifyingTxCount : Int`

  - `nonQualifyingTxCount : Int`

  - `merkleRootHex : Text`

  - `reportUri : Text`

  - `reportDigest : Text`

  - `prevAnchorDigest : Text`

  - `anchorDigest : Text`

  - `auditor : Optional Party`

- choice'lar:


## Commitment / Digest

SCHEME "arccade-sdk-digest-v1/sha256". One mechanism, not two: a payload is rendered to a CANONICAL TEXT DOCUMENT and the commitment is sha256 of that text. This choice is load-bearing — it means (a) a third party verifies a published payload by running plain sha256 over the exact bytes arCCade published, with no library and no structural walk, and (b) the pre-image is a Text, so GameStake_Settle can take it as a choice argument, recompute the digest ON LEDGER and reject a mismatch. The commitment is enforced by the ledger, not merely recorded. Verified: settling with revealedEntry = Some "tampered" fails; settling with the true document succeeds.

ENCODING (normative). Every value renders as `<tag>:<length>:<value>` where length is counted in UNICODE CODE POINTS (Daml T.length; Python len(str); Java MUST use codePointCount, not String.length, which counts UTF-16 units). The length prefix is what makes the encoding injective — separators cannot be forged by content.
  canonText s      = "t:" <> len <> ":" <> s
  canonInt i       = "i:" <> len <> ":" <> show i
  canonDecimal d   = "d:" <> len <> ":" <> show (amountUnits d)
  canonBool b      = "b:" <> len <> ":" <> ("true"|"false")
  canonTime t      = "m:" <> len <> ":" <> show (epochMicros t)     -- integer micros since 1970-01-01T00:00:00Z, never an ISO string
  canonParty p     = "p:" <> len <> ":" <> partyToText p            -- full party id including namespace fingerprint
  canonOptional    = canon "o" "" | canon "o" (f x)
  canonList xs     = "l:" <> len <> ":" <> show (length xs) <> ":" <> intercalate "|" xs
  canonFields kvs  = "r:" <> len <> ":" <> concat [ canon "k" k <> "=" <> v <> ";" | (k,v) <- sortOn fst kvs ]
  canonDocument schema version kvs = "arccade-sdk-digest-v1|" <> canonText schema <> canonInt version <> canonFields kvs
Field names MUST be ASCII [a-z A-Z 0-9 -] so sort order is unambiguous across languages. Fields are SORTED BY NAME, so field order is not part of the document and a field appended in a later version cannot silently change a v1 digest. Every document carries its schema and version, so two payload types cannot collide even if their fields coincide.

AMOUNTS. Never hashed as a rendered Decimal — Decimal rendering is not a canonical form another language matches by accident. amountUnits d = truncate (d * 1e10) with a round-trip guard: if intToDecimal u / 1e10 /= d it errors rather than silently losing precision or overflowing. Verified empirically on this host: amountUnits 12.3456789012 = 123456789012 exactly; the representable band is exactly ±922337203.6854775807 CC (amountUnits 922337203.6854775807 = maxInt), which a CC stake is nowhere near; truncate rounds toward zero in Daml, Java BigDecimal.setScale(0, DOWN) and JS BigInt alike, so negatives agree.

WHAT IS COMMITTED. Two documents per cycle. The ENTRY document is fixed before play and its digest is stored in GameStake.entryDigest in write 1 (Trade Wars: gameCode, cycleId, tier, virtualBalance, the asset mix and the full entry price vector with source and asOf — so entry prices cannot be retro-fitted after the market moves; Pixel Race: gameCode, cycleId, tier, maxGamesPerSession and rngSeedCommit — so the seed provably predates play). The OUTCOME document is produced at the end and is never stored: only its digest is passed to GameStake_Settle, where it lives in the exercise node of the transaction that moves the money.

WHERE THE COMMITMENT LIVES ON LEDGER — the S6 answer that does not require trusting arCCade. custodyTagFor cycleId entryDigest = "arccade-game-sdk:1:" <> cycleId <> ":" <> entryDigest is written into TimeLock.optContext in write 1. That field is stored verbatim on LockedAmulet, whose signatories include the DSO, and surfaces in the standard HoldingView.lock.context — so the cycle id AND the entry commitment are visible from registry data alone, from the commitment transaction onward, without reading any arCCade contract. GameStake_Settle then closes the loop: it fetches the Holding and asserts lk.context == terms.custodyTag, so a settled cycle provably carried the correct commitment on a DSO-signed contract before its outcome existed. A venue that writes the wrong tag has bricked that stake — it can only be aborted, and aborts are counted. Verified: AmuletRules performs no length or charset validation on optContext (only assertWithinDeadline on expiresAt and maxNumLockHolders on holders), and Splice itself puts a structured string there (mkAllocationLockContext = "allocation for settlement of " <> ref.id). The tag is bounded at 148 chars by isValidCycleId (cycleId non-empty, <= 64 chars, no ':' or '|'). A sha256 digest and a synthetic cycle id are safe to place in a field whose visibility the HoldingV1 docs warn may be wider than the contracts it describes; nothing else goes there.

CROSS-LANGUAGE REPRODUCIBILITY — PROVEN, NOT CLAIMED. A 25-line Python implementation of the rules above produces, for the sample Trade Wars entry, exactly 0a31821f2db2a8042b4f6363543f39df22e534b5c71722c07750621d2297a636, and Test.GameSdk.Vectors asserts that same constant from the Daml side; both pass. The Java port must assert it too, and CI fails if any of the three drift. Also asserted: sha256 "abc" = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad (i.e. the primitive is standard SHA-256, so any language reproduces it), canonDecimal 20.5 = "d:12:205000000000", canonDecimal (-3.25) = "d:12:-32500000000".

WHAT THIS DOES AND DOES NOT PROVE. It proves arCCade fixed a specific value before the outcome existed and cannot restate it afterwards, and — because the digest is recomputed on ledger — that a settled cycle's revealed payload is the committed one. It does NOT prove the payload was true: a dishonest venue could still commit to a bad price feed. Committee language must therefore say "commitment", never "proof of fair play". The mitigation is a signed oracle feed whose signatures live inside the entry document.


## Custody

MECHANIC: TimeLockedHolding — AmuletRules_Transfer with TransferOutput.lock = Some TimeLock{holders = [venue], expiresAt, optContext = Some custodyTag}, producing a real LockedAmulet owned by the player. arCCade is ALREADY RUNNING THIS ON MAINNET for both games (AmuletLockService.lockAmulet, called by NonCustodialStakeService.doPrepareStake and PixelRaceService), including the platform-fee output riding on the same transfer. The custody model does not change at all; only the app-side bookkeeping does. That is what makes this shippable rather than aspirational.

IT IS ALSO THE STRONGEST OF THE OPTIONS, verified in the 0.7.1 sources on this host. LockedAmulet's signatories are lock.holders plus the amulet's signatories (dso, owner), so the venue is a genuine stakeholder. LockedAmulet_UnlockV2's controller is `amulet.owner :: lock.holders`: before expiry NEITHER side can move the funds alone — the player cannot withdraw and arCCade cannot seize. LockedAmulet_OwnerExpireLockV2's controller is `amulet.owner` alone after expiresAt, so the player always has an unconditional path back to their own money without arCCade and without the DSO. Contrast token-standard Allocation V1, where Allocation_Withdraw's controller is the sender alone: that is a reservation the user can exit, not a lock, and it must never be described to the committee as one. This design therefore actually delivers arCCade's own S4 promise of a minimum ledger lock duration. Non-custodial throughout: the CC never leaves the player's wallet, it is encumbered in place.

ON-LEDGER VERIFICATION (S6). ArCCade.GameSdk.Custody.verifyLockedHolding fetches the standard Holding interface view inside GameStake_Settle and asserts owner == player, instrumentId, amount >= stake, lock present, venue in lock.holders, lock.expiresAt == terms.lockExpiresAt (so the agreed duration is checked against the registry's own record, not arCCade's assertion) and lock.context == this cycle's tag. Legal because the venue is a lock holder; the fetch authority comes from the player's signature on GameStake and the visibility from the venue being in actAs. Verified with six scripted cases: the correct lock passes; wrong tag, under-funded lock, wrong expiry, an unlocked holding and a lock held by someone else all fail.

THE TWO-WRITE INVARIANT, AND ITS PRICE, STATED PLAINLY. LockedAmulet_UnlockV2's body is `create amulet` — it always pays the FULL amount to the owner — and TransferInput has only InputAmulet, so a locked amulet is not a valid transfer input (both verified in Splice/Amulet.daml and Splice/AmuletRules.daml:1828). Therefore value can be routed to the venue only at commitment, and only to the player at settlement. Consequences: (1) outcome-dependent forfeiture of the locked stake CANNOT happen inside the settlement transaction, and GameStake_Settle enforces `custody /= TimeLockedHolding || forfeitedAmount == 0.0` rather than letting a third transaction appear silently; (2) the honest way to express real loss is to take the at-risk amount as terms.feeAmount UP FRONT in write 1 — which is strictly better for S3 anyway, because a fee spent before the outcome exists cannot be dodged; (3) a PRIZE in the other direction does work in the same settlement transaction, because it is funded from pre-existing venue-owned Amulets whose contract ids are known when the submission is built — payoutAmount is recorded in the exercise node and bounded by policy.maxPayoutAmount.

DEPENDENCIES — the seam is a module, not a flag. The SDK imports ONLY splice-api-token-metadata-v1, splice-api-token-holding-v1 and splice-api-token-allocation-v1, all frozen 1.0.0 LF 2.1 packages that are safe to pin. Verified with `damlc inspect-dar` on the built DAR: exactly those three splice dalfs, and zero occurrences of "amulet" anywhere in the package. Amulet is reached only through the Holding interface contract id and through commands the backend builds, so a DSO upgrade of splice-amulet (currently 0.1.22, and it moves with every release) cannot invalidate this DAR. The SDK defines NO interfaces of its own, because interfaces cannot be upgraded and a future field would force a whole new interface package.

MIGRATION TO ALLOCATION CUSTODY is pre-cut: CustodyMechanic already has TokenAllocation, CustodyRef already has AllocationRef carrying a real ContractId Allocation.Allocation, and verifyCustody already dispatches on the mechanic and fails closed. Turning it on is one new branch plus a GameVenue.custody change — no new package, no new templates. It is not the launch mechanic because a V1 allocation is a strictly weaker lock, V2 committed allocations depend on a splice-amulet version that cannot be confirmed vetted on arCCade's network from this host, and switching custody and bookkeeping in the same release is how MainNet breaks.


## Anti-farming

Given no contract keys at LF 2.1, only three things are genuinely enforceable, and the SDK uses all three rather than dressing a rate limit as a control.

1. CAPITAL COMMITMENT (primary, per S4). The stake is genuinely encumbered for at least policy.minLockSeconds and the platform fee plus the Splice traffic fee are genuinely gone. A sybil fleet must fund stake + fee across every account SIMULTANEOUSLY and leave it locked. This is the only defence that scales with the attacker's cost rather than with arCCade's detection, and the SDK makes it real by refusing to settle any cycle whose lock does not exist, does not carry this cycle's tag, does not name the venue as holder, does not cover the amount, or does not carry the agreed expiry.

2. PlayerEntitlement AS A CONSUMABLE SLOT — the key-free substitute for per-player uniqueness. A player is issued exactly concurrencyLimit entitlements, each with a concurrencyIndex. Entitlement_Commit CONSUMES one; GameStake_Settle recreates it. Two concurrent cycles on one slot are impossible because the second submission tries to consume an archived contract and is rejected by the LEDGER, not by a service. Verified: after a successful commit, a second Entitlement_Commit on the same cid fails. It costs zero extra transactions — the archive rides in write 1 and the create rides in write 2 — and nothing terminal ever accumulates in the ACS, which directly addresses the incident where 41 GameResults and 9 SessionResults pushed the ACS past the JSON API's 200-contract limit and every query started returning 413. Belt and braces that comes free: AmuletRules_Transfer consumes specific input Amulet cids, so two racing commitments for the same player contend on the same holdings and one loses. Honest limitation THROUGH 1.3.0, CLOSED IN 1.4.0: one-entitlement-per-slot-per-player was venue discipline at issuance, not a ledger guarantee. The PlayerRoster chain makes both the COUNT and the UNIQUENESS structural — issuance walks the chain itself and mints over [0 .. concurrencyLimit - 1] — so the limit is now enforced by the ledger. Issuance lineage stays in the published report anyway, because it is still the evidence that the roster was initialised at all.

3. LEDGER-TIME DURATION GATES, never platform-supplied timestamps. Entitlement_Commit asserts now >= nextEligibleAt (cooldown between cycles) and minLockSeconds <= (lockExpiresAt - now) <= maxLockSeconds. GameStake_Settle asserts minCycleSeconds <= (now - committedAt) <= maxCycleSeconds. validPolicy additionally forces minLockSeconds >= minCycleSeconds in `ensure`, so a policy where the lock can expire mid-cycle is not creatable. All from getTime. Verified: settling before minCycleSeconds fails; committing again inside cooldownSeconds fails; committing inside the longer abortCooldownSeconds after an abort fails. Note the asymmetry to state to the committee: the registry imposes a CEILING on lock duration (assertWithinDeadline on lock.expiresAt, bounded by tokenStandardMaxTTL, default 90 days) but no floor — the floor is entirely arCCade's, which is why it must come from ledger time and be re-verified against the registry's own lock.expiresAt at settlement.

4. ACCOUNT-LEVEL CONTROLS. Entitlement_Revoke (operator kill switch), Entitlement_Retire (consensual wind-down), per-lane minStakeAmount/maxStakeAmount, and issuance itself as the gate — no entitlement, no cycle.

5. UNFUNDED-COMMIT DETERRENT. Because write 1's two commands cannot see each other, a player could open a cycle whose lock never materialised. It cannot settle (custody proof fails, verified), and GameStake_Abort recycles the slot WITHOUT counting the cycle and under abortCooldownSeconds — so the attempt costs the farmer their slot for longer than a real cycle would. The backend must additionally not admit the player into the game until it has seen the LockedAmulet create event in the same transaction.

6. ECONOMIC EXPOSURE AS THE REAL DEFENCE (S3). terms.feeAmount is non-refundable and is paid as an output of the SAME transfer that creates the lock, with policy.minPlatformFee as an on-ledger floor. Because it is spent before the outcome exists, it cannot be escaped by refusing to settle — which is precisely the hole in any design whose fee is captured at settlement out of a sender-withdrawable allocation. The SDK does not choose the number (that is a commercial decision) but it makes a non-zero number expressible, enforced and auditable, and makes a zero number visible for what it is.

WHAT IS DELIBERATELY NOT CLAIMED: no on-ledger global rate limit, no sybil detection, no cap on account count, no device or IP controls. Those stay in the backend, they are rate limits, and per S1 they were never economic actions. Keep the existing per-user ReentrantLock in GameStakeService/NonCustodialStakeService: the entitlement now serialises a player's cycles at the ledger level, and an unguarded retry storm would surface as contention rejections rather than clean errors.

PROPOSED LAUNCH POLICY: minStakeAmount 5 CC, maxStakeAmount 500 CC, minLockSeconds 3600, maxLockSeconds 172800, minCycleSeconds 300, maxCycleSeconds 86400, cooldownSeconds 60, abortCooldownSeconds 900, concurrencyLimit 1 (raise to 2 after the entitlement backfill settles), minPlatformFee = the configured GameFeesConfig platform fee, maxPayoutAmount 0.0 at launch, requireCustodyProof True.


## Ledger Time

Every duration in the package derives from `now <- getTime` inside the choice body. No choice anywhere accepts a caller-supplied epoch or timestamp for a duration test, and there is no deprecated currentEpoch field to ignore — the package starts clean.

ArCCade.GameSdk.Time is the only place time is converted: epochMicros (via subTime from 1970-01-01T00:00:00Z), epochSeconds, secondsBetween a b = epochSeconds b - epochSeconds a, addSeconds. Re-implemented rather than imported from ArCCade.Common so the SDK has no dependency on arccade-game-contracts.

Ledger time is the sole authority for: the cooldown gate (Entitlement_Commit: now >= nextEligibleAt), the lock-duration band (Entitlement_Commit: minLockSeconds <= secondsBetween now terms.lockExpiresAt <= maxLockSeconds), the minimum and maximum cycle duration (GameStake_Settle: policy.minCycleSeconds <= secondsBetween committedAt now <= policy.maxCycleSeconds), the expiry escape hatch (GameStake_ExpireUnsettled: now >= terms.lockExpiresAt), and the cooldown written into the recycled entitlement (addSeconds now cooldownSeconds / abortCooldownSeconds). GameStake.committedAt is set from getTime inside Entitlement_Commit and never from an argument.

Time is written into digests only as canonTime = integer MICROSECONDS since epoch, never as an ISO string. One thing is deliberately NOT put inside a pre-computed commitment: the ledger time of the open. On a real ledger the participant picks ledger time within a tolerance window at submission, so requiring an exact committedAt inside a digest computed before submission would make transactions fail randomly. The digest binds the DEADLINE (lockExpiresAt, which the caller does control and which settlement compares field-for-field against the registry's own lock.expiresAt); committedAt is recorded on GameStake and is independently visible as the transaction record time.

This is not theoretical hygiene: TestNet already rejected a claim whose caller-supplied timestamp was 11.5 days in the future with "Round not ended yet", and Pixel Race's ClaimSession still trusts a caller-supplied currentEpoch today. The SDK makes that class of bug unrepresentable.


## Migrasyon Plani

TRADE WARS. GameRound -> GameStake plus a real lock. ccStaked : Decimal -> the locked amulet's amount (the number stops being an assertion and becomes an encumbrance). stakeTxHash : Text -> DELETED, replaced by the LockedAmulet contract and two Scan-visible transactions. tier, assets, virtualBalance, roundDurationMinutes, entryPrices -> fields of the entry document behind entryDigest, so entry prices are frozen before the round can open; the PriceRecord(entry) write disappears. exitPrices, virtualPnl, xpEarned -> the outcome document behind outcomeDigest; PriceRecord(exit), GameResult, ClaimReceipt, CancelReceipt and LeaderboardEntry disappear from the ledger and become rows in the period report, Merkle-anchored. ClaimRound + ClaimCC -> a single GameStake_Settle. CancelRound -> GameStake_Abort. calculateVirtualPnl / getTierMultiplier -> backend. In doPrepareStake: keep the fee breakdown, amulet selection and AmuletRules/OpenMiningRound disclosure logic exactly as they are; change the TimeLock optContext from the shared literal "arCCade game stake" to custodyTagFor cycleId entryDigest (this also fixes the live collision AmuletLockService warns about, where swap escrow locks carry a byte-identical context); stop calling jsonApiClient.exerciseChoice directly and hand the built choiceArg to gameSdkService.commit, which appends the Entitlement_Commit command and submits both atomically; delete the tradeWarsService.createGameRound call. Code DISAPPEARS rather than being written: persistSessionWithRollback's LockedAmulet rollback path and the orphaned-lock logging exist because the lock and the DB row could diverge — with the SDK they are one atomic transaction, so an orphaned lock with no ledger record is no longer representable. Settlement stops hunting for the right LockedAmulet by scanning the user's locks: the open GameStake names its own cycleId and the matching lock is found by lock.context == the tag.

PIXEL RACE — one hard prerequisite. Today PixelRaceService.endGame creates the lock inside the handler that also writes score, best_score and weekly_best_score: the stake happens AFTER the round is played, so today's "commitment" is not one, and any S1 claim made while that is live is falsifiable by anyone reading arCCade's own transaction stream. This must move to session start (a POST /api/pixel-race/start that calls gameSdkService.commit with the PixelRaceEntry digest including rngSeedCommit) BEFORE the framework claim is filed. It also fixes an existing oddity where a failed stake is only discovered after the user has already played. RaceSession -> GameStake; maxGamesPerSession, difficulty -> the entry document; the RNG seed -> rngSeedCommit at open, revealed as rngSeed at settlement so the ledger itself proves the seed predated play. StartGame, GamePlay, RecordGameResult (which re-created RaceSession on EVERY game — a 3-game session wrote four contracts to record scores that move no value), EndGame, GamePlayResult, SessionResult, ClaimSession -> all gone; per-play scores become rows in pixel_race_stats and elements of the plays[] array in the outcome document. Because both games now use the same GameVenue, the same PlayerEntitlement and the same GameStake, S5's one-PartyID claim stops being an assertion and becomes a fact readable from GameVenue.gameCodes.

BACKEND (Java/Spring, 8080). (1) NEW CantonJsonApiClient#submitCommands(List<JsonNode> commands, List<String> actAs, List<String> readAs, List<JsonNode> disclosedContracts, String commandId, String userId) — the single enabling change; the class already builds exactly this body in five places with a single-element commands array, and every existing helper collapses to a one-command call to it. Keep the LAST_UPDATE_ID capture so transactionLogService still gets one updateId per cycle. (2) NEW GameSdkConfig (prefix arccade.gamesdk): enabled, packageRef, venuePartyId, operatorPartyId, venueContractId, mode, plus the policy values. Use a package-NAME template reference ("#arccade-game-sdk:ArCCade.GameSdk.Cycle:GameStake") rather than the pinned package id DamlGameConfig uses today — GOTCHA: DamlGameService.queryContracts filters results by exact templateId string equality and the ledger returns a package-id-qualified templateId, so that filter must compare the module:entity suffix or resolve the package id once at startup. (3) NEW GameSdkService — the only class that knows SDK template names: commit(...) returning {updateId, lockedAmuletCid, stakeCid}, settle(...), abort(...), findOpenStake(playerParty), findEntitlement(playerParty, concurrencyIndex), issueEntitlements(grants). (4) AmuletLockService: add buildLockCommand(...) returning the ExerciseCommand JsonNode instead of submitting; keep lockAmulet delegating to it for swap/bridge callers; change optContext for game stakes only. (5) NEW EntitlementBackfillJob — batched GameVenue_IssueEntitlements for existing users (~50 grants per transaction, one-time), and the same call wired into UserOnboardingService for new users. (6) Java port of ArCCade.GameSdk.Digest plus the two adapters, sharing the golden vectors emitted by Test.GameSdk.Vectors — use codePointCount for lengths and integer 1e-10 units end to end, never a double. (7) Reporting: build per-cycle rows from the ledger's TRANSACTION TREE stream rather than from the game database, so the report derives from the same evidence the auditor uses; the existing GameResult/ClaimReceipt readers become tree consumers keyed on cycleId, and the leaderboard becomes purely a backend table. LeaderboardDamlService's readers must move to Supabase BEFORE the writes stop. (8) Fee-base classifier: label every venue-submitted transaction as commit/settle/abort/expire/admin/anchor and record traffic and fee per class — it slots straight into TrafficCostIngestService, which already ingests per-transaction paidTrafficCost keyed idempotently on updateId. (9) TerminalContractSweeper: point it at the legacy package only; the SDK needs no sweeper. (10) Ops: monitor players with zero entitlements and no open stake (a lost entitlement locks a player out — reissuance must be a first-class, monitored procedure), abort rate, settlement latency versus lockExpiresAt, and UTXO hygiene (a staking game that repeatedly splits and returns change manufactures dust; keep under ~10 holdings per user).

SDK-PROXY (Node, 8093). Almost nothing for launch — the games never used the proxy's ledger paths. Two additive reads: extend GET /api/token/holdings/:partyId to surface the standard lock fields (holders, expiresAt, context) it currently drops, and add GET /api/game/custody/:partyId listing Holding-interface contracts whose lock.context starts with "arccade-game-sdk:" — the S6 endpoint, built entirely on standard interfaces, zero new ledger writes.

IN-FLIGHT ROUNDS. Nothing is migrated and nothing is rewritten. arccade-game-sdk 1.0.0 is a NEW package name, so there is no upgrade validation against arccade-game-contracts 0.3.0 and no KNOWN_PACKAGE_VERSION collision; both stay vetted and both keep working. Flag arccade.gamesdk.enabled turns on new commitments; arccade.game.legacy-cycle.accept-new=false stops new legacy ones. Claim paths dual-read: findOpenStake first, then the legacy GameRound/RaceSession scan. The critical safety property is that CUSTODY IS PACKAGE-INDEPENDENT — a legacy in-flight stake is a LockedAmulet belonging to splice-amulet, not to either arCCade package, so even if a legacy app-side record is lost the funds are recoverable by the same LockedAmulet_UnlockV2, or by the player alone after expiry.

CUT-OVER. Day 0: build both DARs, run all nine scripts, upload and vet arccade-game-sdk on TestNet, create the dry-run venue and run a full two-write cycle with 0 CC. Day 1 (needs a funded wallet): first live cycle on TestNet, verifying the two updateIds and that the LockedAmulet's lock.context equals the GameStake's custodyTag. Day 2: upload and vet on MainNet (additive, no user impact), create the one live GameVenue, run EntitlementBackfillJob. Day 3: enable for an internal allowlist and run both games end to end. Day 4: legacy-cycle.accept-new=false. Drain window = the longest legacy lock TTL (2h Trade Wars, sessionDuration+1h Pixel Race) plus margin; 24h is generous. Day 30: delete the legacy service call paths and un-vet arccade-game-contracts. Rollback at any point before Day 30 is flipping two flags — the legacy path is still there and its custody is the same LockedAmulet.


## Komite cercevesi eslesmesi

### S1
Both writes move or encumber user value on ledger. The commitment creates a LockedAmulet from the player's own funds (encumbrance) and transfers a non-refundable fee to the venue (movement); the settlement archives the LockedAmulet and creates the player's Amulet (movement). Both generate traffic fees and both would exist without any reward programme — without them the game has no stake and no payout. Everything that does NOT qualify has been removed from the ledger entirely rather than kept and argued about: no PriceRecord, no GameResult, no ClaimReceipt, no LeaderboardEntry, no per-game or per-play contracts, no audit receipt, no activity marker. There is nothing on-chain in this package whose only purpose is to be read. arCCade is not asking the committee to accept that a participation record qualifies; it is not writing participation records. Note that today NONE of arCCade's six writes per Trade Wars round would qualify under this test: ccStaked is a Decimal and stakeTxHash is the hash of a transfer that happened somewhere else. One prerequisite is stated openly: Pixel Race currently stakes inside endGame, i.e. after the round is played, and that must move to session start before this claim is filed.

### S2
Exactly two transactions per completed cycle, both value-bearing, and the SDK cannot produce more: GameStake is created only by Entitlement_Commit and consumed by exactly one of three consuming choices, none of which creates anything except the recycled entitlement. The qualifying fee base is therefore machine-detectable without app-specific parsing — it is precisely the set of transactions containing a Holding/LockedAmulet event for this venue, which the token-standard InterfaceFilter and the TransferEventsV2 EventLog expose to any third party. There is no third write to exclude, because the outcome record was eliminated rather than reclassified. Off-cycle writes are named and separable because they are not per-cycle: one GameVenue ever, one entitlement issuance per player-slot at onboarding, rare policy updates, and one period anchor per day. The SDK also declines to create a FeaturedAppActivityMarker for the commitment leg even though the amulet implementation leaves that leg unfeatured — a marker is a non-value contract whose fees S2 would require excluding anyway, so arCCade forgoes the reward instead. That is a real revenue decision, made in the direction that costs arCCade money, and it should be an explicit product sign-off. Post-CIP-104 app rewards are traffic-based, so removing four to six writes per cycle genuinely shrinks arCCade's own reward base: the framework is expensive to arCCade, which is the point.

### S3
The player has three simultaneous exposures, all verifiable on ledger. (a) A non-refundable platform fee paid to the venue as an output of the commitment transfer (terms.feeAmount, terms.feeReceiver, floor enforced by policy.minPlatformFee). Because it is spent BEFORE the outcome exists, it cannot be escaped by refusing to settle — the failure mode of any design that captures its fee at settlement out of a sender-withdrawable allocation. (b) The Splice traffic fee on that transfer. (c) Illiquidity: the stake is encumbered for at least policy.minLockSeconds and the player cannot unilaterally unlock, because LockedAmulet_UnlockV2 requires owner AND holders. The honest weakness arCCade should say out loud: the stake itself returns 1:1 and P/L is virtual. The SDK's answer is structural rather than rhetorical — the way to add real loss exposure on this mechanic is to raise the at-risk amount taken up front, not to add on-chain records, and the ledger enforces that a time-locked stake cannot be forfeited at settlement (custody /= TimeLockedHolding || forfeitedAmount == 0.0) so no third transaction can appear silently. Disposition, returnedAmount, forfeitedAmount and payoutAmount with the checked invariant returnedAmount + forfeitedAmount == stakeAmount are in place for the allocation mechanic, where conditional capture is possible in one settlement. The SDK deliberately does not hard-code a rake: it makes exposure a first-class, enforced, auditable field instead of a promise.

### S4
Minimum ledger lock duration: policy.minLockSeconds, asserted at commitment against the actual TimeLock expiry from ledger time, re-verified at settlement against the registry's own lock.expiresAt, and thereafter enforced by the registry rather than by arCCade — LockedAmulet_UnlockV2's controller is owner :: lock.holders, so this is a lock the user genuinely cannot exit early, unlike an Allocation V1 reservation whose Allocation_Withdraw controller is the sender alone. Minimum and maximum cycle duration: policy.minCycleSeconds / maxCycleSeconds, enforced by refusing settlement outside the band, which kills the run-ten-thousand-one-second-rounds attack. Per-account concurrent participation: PlayerEntitlement is a consumable slot archived by the commitment and recreated by the settlement, so a second concurrent cycle on a slot is rejected by the ledger, not by a service — the only key-free per-player limit that is real rather than advisory now that LF 2.1 has no contract keys. Cooldown between cycles, and a longer cooldown after an abort so an unfunded commitment buys a farmer no throughput. Account-level controls: Entitlement_Revoke, Entitlement_Retire, per-lane stake bounds, and issuance itself as the gate. Capital commitment remains primary and is now genuine: N sybils need N x (minStake + fee) simultaneously committed, with the stake locked for minLockSeconds. Two limitations stated rather than glossed: one-entitlement-per-slot is venue discipline at issuance, not a ledger guarantee; and global rate limits, account-count caps and device fingerprinting are off-chain and are rate limits, which per S1 were never economic actions anyway.

### S5
ONE GameVenue, one venue PartyID, both games — and this is readable from the ledger rather than asserted: GameVenue.gameCodes = ["trade-wars-v4","pixel-race-v1"] and GameVenue.custody = TimeLockedHolding, with both games' stakes being GameStake contracts pointing at the same venue with the same custody, the same fee model and the same settlement path. Verified by running both games through the identical code path in Test.GameSdk.LifecycleTest. Trade Wars and Pixel Race differ only in the off-chain document behind the digest and in pure adapter functions that define its encoding — zero templates, zero custody difference, zero settlement difference; gameCode is a Text the SDK never interprets. Conversely the SDK makes the trigger for a SEPARATE PartyID explicit and checkable, because GameVenue.custody and GameVenue.policy are exactly what a materially different model would have to change: a game needing TokenAllocation custody, a game denominated in a non-Amulet instrument (different registry, different admin), a pooled tournament netting many players in one multi-leg settlement, or any move to custodial escrow. Adding another single-leg staking game is NOT such a case and must not spawn a party. The Swap product, which uses allocations and a different settlement mechanic, correctly keeps its own party under this rule.

### S6
AMOUNT, HOLDER, LOCK DURATION and DISPOSITION are all verifiable without trusting arCCade, because they are fields of registry contracts whose signatory set includes the DSO. The LockedAmulet create event carries owner, amount, lock.holders and lock.expiresAt in the standard HoldingView; the settlement's Amulet creates carry the amounts returned. The lock names its own cycle AND its own entry commitment through TimeLock.optContext = "arccade-game-sdk:1:<cycleId>:<entryDigest>", which surfaces as HoldingView.lock.context — so the two halves are tied together in registry data, and a settled cycle provably carried the correct commitment digest on a DSO-signed contract before its outcome existed. An auditor needs no arCCade API for any of this: filter the Ledger API by InterfaceFilter on #splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding, keep the holdings whose lock.context begins with "arccade-game-sdk:", and you have every stake's amount, holder, duration and cycle. The app's own contribution is checked, not asserted: GameStake_Settle FETCHES the Holding and asserts owner, instrument, amount, holder set, expiry and tag before releasing — verified working in six scripted cases — and it recomputes the sha256 commitment on-ledger and rejects a mismatched reveal. Supporting information (prices, seeds, scores, XP, matchmaking, leaderboards, history) lives off-chain, bound by two digests over canonical documents that anyone reproduces with plain sha256; the Daml and an independent Python implementation agree byte-for-byte on the golden vector. Two caveats stated plainly rather than left to be found: the outcome lives in the settlement exercise node, so a consumer on the flat/ACS stream sees a create and an archive and cannot reconstruct the round — the Optional auditor observer (zero write cost) and the transaction TREE stream are how a committee auditor gets a first-hand feed; and the per-period Merkle anchor, chained to the previous period, is what lets an auditor prove a cycle they saw on Scan was OMITTED from arCCade's published report.


## Sonraya birakilanlar

- LIVE CUSTODY ON TESTNET — the one step 0 CC blocks. Everything else ships today: the DAR compiles and vets, GameVenue/entitlement issuance/Entitlement_Commit/GameStake_Settle all run against a real participant in ModeDryRun (requireCustodyProof=False, venueId prefixed "dryrun-", minPlatformFee and maxPayoutAmount forced to 0.0 by `ensure`, and the mode stamped on every entitlement and stake so no dry-run contract can ever be counted as qualifying). What cannot run is AmuletRules_Transfer, because it needs input Amulets. UNBLOCKED BY: CC in a wallet the test player party controls — specifically minStakeAmount + minPlatformFee per concurrent test cycle (5.25 CC at the proposed policy, so ~50 CC funds a full day of testing) plus traffic. THEN, in order: (1) run one live cycle and confirm the LockedAmulet's lock.context equals the GameStake's custodyTag byte-for-byte; (2) confirm AmuletRules accepts a ~111-character optContext (no length validation exists in the 0.1.22 source and Splice itself writes a structured string there, but this has never been exercised against a live registry); (3) confirm both commands land in ONE transaction with one updateId.

- VENUE-ALONE SETTLEMENT (no player in actAs). Not achievable in 1.0.0 and the reason is structural, not an oversight: the Holding interface has NO choices, so the unlock cannot be driven through it, and to nest LockedAmulet_UnlockV2 inside GameStake_Settle — where the player's signature on GameStake would supply the authority — the SDK would have to import splice-amulet and pin package-id fb10433a (0.1.22) into the DAR. Today this costs nothing, because arCCade's participant holds submission rights for external player parties and already submits actAs=[player, venue] in NonCustodialStakeService and PixelRaceDamlService.endSession. UNBLOCKED BY: a decision to move to true external signing where the player's key lives only in the browser. THEN the options are (a) a sibling package arccade-game-sdk-hooks defining a minimal SettlementHook interface that GameStake_Settle exercises, with a venue-signed adapter template whose choice body performs the unlock — costs one interface, which can never be upgraded, or (b) importing splice-amulet and accepting the package-id pin. Decide when the external-signing decision is made, not before.

- CONDITIONAL FORFEITURE OF THE LOCKED STAKE IN ONE SETTLEMENT. Impossible on TimeLockedHolding: LockedAmulet_UnlockV2 always pays the full amount to the owner and a locked amulet is not a valid TransferInput, so routing part of the stake to the venue needs a third transaction. GameStake_Settle enforces forfeitedAmount == 0.0 for this mechanic so the extra transaction cannot appear silently. UNBLOCKED BY: the TokenAllocation branch of verifyCustody, where Allocation_ExecuteTransfer moves a chosen amount to the venue in the settlement itself. The Disposition constructors and the forfeitedAmount field are already in 1.0.0 precisely so that turning this on adds no field to a vetted package.

- TOKEN-STANDARD ALLOCATION CUSTODY (V1, then V2 committed=True with settlementDeadline and nextIterationFunding). The seam is cut: CustodyMechanic.TokenAllocation, CustodyRef.AllocationRef with a typed ContractId Allocation.Allocation, and verifyCustody failing closed on that branch. UNBLOCKED BY: confirmation of which splice-amulet version is vetted on the network arCCade targets and whether it implements AmuletAllocationV2 (everything here is read from the 0.7.1 bundle where splice-amulet-current = 0.1.22), plus an integration test of AllocationFactory_Allocate with a real choice context and disclosed contracts. Note for whoever builds it: AllocationFactory_Allocate can return AllocationInstructionResult_Pending, which would silently add a contract and a step — the implementation MUST assert the Completed branch, the way the transfer path must assert one-step completion.

- THIRD-PARTY WALLET SUPPORT via the AllocationRequest interface. Skipped in 1.0.0 for two reasons: the launch mechanic is a TimeLock rather than an allocation, and the standard's flow needs the request contract to exist BEFORE the wallet allocates, which is a third write. UNBLOCKED BY: moving to allocation custody AND accepting a three-transaction cycle for wallet-driven players (arCCade's own frontend would keep the two-write path). Must be weighed against the write-count claim, not assumed additive.

- FULL AUDIT REPORTING SURFACE (the seven read-only endpoints, content-addressed document store, seat/entitlement lineage, inclusion-proof endpoint). The on-ledger half — VenuePeriodAnchor and the Merkle helpers — is in 1.0.0 and tested; the HTTP surface and the daily anchoring job are backend work scheduled after the first live cycles, because the report must be built from the ledger transaction stream rather than the game database and that consumer does not exist yet.

- MEASURED TRAFFIC AND FEE NUMBERS. Every byte and cost figure in committee material must come from a real participant, not from field counts. Nothing in this spec quotes a traffic percentage for that reason.


## Kabul edilen riskler

- JUDGES DISAGREED ON THE HIGHEST-VALUE GRAFT — venue-alone settlement — AND I DECIDED AGAINST IT. Judge 1 called moving LockedAmulet_UnlockV2 inside GameStake_Settle 'the single highest-value change available', because design 1 demonstrably settles with the venue alone. I verified it is not available here: the Holding interface has NO choices, so the unlock cannot be driven through an interface, and nesting it in a choice body requires importing splice-amulet and pinning package-id fb10433a (0.1.22) into a DAR whose whole selling point is that it pins only frozen 1.0.0 packages. A test also showed a second, independent blocker: the submission must include a lock stakeholder for VISIBILITY, not merely authority. Accepted because arCCade's participant already submits actAs=[player, venue] in production today, so the cost is zero now; the seam and its trigger are in deferredToLater. If arCCade moves to true external signing, this becomes a real blocker for the auto-claim worker and must be solved before that migration, not after.

- CONDITIONAL FORFEITURE IS IMPOSSIBLE IN TWO WRITES ON THIS MECHANIC, and I chose to enforce that rather than hide it. LockedAmulet_UnlockV2 always pays the owner, and TransferInput has only InputAmulet, so a locked amulet cannot be spent to the venue. GameStake_Settle therefore refuses forfeitedAmount > 0.0 for TimeLockedHolding. Judge 2 flagged this as capping S3 at fee-plus-illiquidity, and that is correct. Accepted because the alternative — allowing it and quietly spending a third transaction — would make the headline claim false, and because taking the at-risk amount as an up-front fee is strictly stronger for S3 anyway: a fee paid at commitment cannot be dodged, whereas a fee captured at settlement from a sender-withdrawable allocation can.

- THE TWO-COMMAND ATOMIC SUBMISSION HAS NOT BEEN EXECUTED ON THIS PARTICIPANT. Every candidate design's write count rests on it, and all three judges flagged it. Daml Script's Applicative Commands is not evidence about the JSON Ledger API. Accepted with a mitigation that no other design had: arCCade's production code already extracts the LockedAmulet cid from a single transaction tree in NonCustodialStakeService, which is direct evidence that write 1's registry half lands synchronously today. It is step 11 in the implementation order and nothing downstream should be built before it passes. If it fails, the honest count is three per cycle and arCCade must say so first.

- MAKING THE VENUE A LOCK HOLDER GIVES ARCCADE A QUASI-CUSTODIAL POWER: it can refuse to co-sign an early unlock, freezing the player's funds until lockExpiresAt (bounded by maxLockSeconds, proposed 48h). It is not seizure — unlock only ever pays the owner, and after expiry LockedAmulet_OwnerExpireLockV2 is owner-only — but a hostile reviewer can frame it that way. Accepted, and it must be stated WITH the expiry bound rather than left to be discovered.

- ~~ONE-ENTITLEMENT-PER-SLOT IS VENUE DISCIPLINE, NOT A LEDGER GUARANTEE.~~ **1.4.0'DA KAPANDI.** Burada "LF 2.1'de indirgenemez" diye kabul edilmisti; degildi. Yanlis olan varsayim, key olmadan benzersizligin ancak ITIRAF yoluyla — yani cagiranin verdigi girdi uzerinde assert ile — kanitlanabilecegiydi. `PlayerRoster` zinciri onu YAPISAL hale getirir: venue basi gosterir, her shard sonrakini, ve `GameVenue_IssueEntitlements` zinciri kendisi yurur, dolayisiyla cagiran bir shard'i atlayarak "bu oyuncu yok" diye gosteremez. Adet de ayni sekilde yapisaldir — slotlar `[0 .. concurrencyLimit - 1]` uzerinde uretilir, cagiranin verdigi indeksten degil. Operatorun ikinci kez basmasi artik itibar meselesi degil, ledger tarafindan reddedilen bir islemdir. Kalan durus: `GameVenue_InitRoster` cagrilana kadar 1.3.0 venue'lari hic basim yapamaz — sessizce eski davranisa DUSMEZ, kapali biter.

- A LOST PlayerEntitlement LOCKS A PLAYER OUT ENTIRELY — no key, no lookup, and at concurrencyLimit 1 no spare. 1.4.0 BUNU DARALTIR: oyuncu roster'da oldugu icin operatorun ikinci kez basmasi artik reddedilir, yani "kaybolan slotu yeniden bas" eski kacis yolu KAPALIDIR. Kalan kurtarma yolu oyuncunun kendi tarafidir — `GameStake_ExpireUnsettled` — ve o da yalnizca acik bir stake varsa ise yarar. Bu bilincli bir takas: sinirin gercekten baglayici olmasi, "yeniden basalim" kolayliginin kaybi demektir. Sifir entitlement'i ve acik stake'i olmayan oyuncu metrigi bu yuzden artik nice-to-have degil, launch SARTIDIR; ve slot iadesi icin ayri, denetlenebilir bir choice (roster'dan dusurup yeniden basan) 1.5.0'in acik isidir.

- THE OUTCOME IS RECOVERABLE ONLY FROM THE TRANSACTION TREE STREAM. A consumer on the flat/ACS-delta stream sees a create and an archive and cannot reconstruct the round, and whether Scan exposes exercise-choice arguments for DSO-visible nodes is unverified. Accepted as the deliberate price of archive-with-no-create, hedged three ways: the entry commitment also rides in the DSO-signed lock context (so the commitment half survives even if exercise arguments are invisible), the Optional auditor observer costs zero writes, and the period anchor gives 100% coverage independent of both.

- I INCLUDED THE PERIOD ANCHOR OVER JUDGE 3'S SCOPE OBJECTION. Judges 1 and 2 both endorsed it; judge 3 ranked the design it came from lowest on delivery scope. Decided in favour because it is the only mechanism that proves an OMISSION, it is off-cycle at roughly one write per thousand cycles, and it is deliberately trimmed to a single template with no choices and placed LAST in the implementation order so it can be dropped without touching the cycle. I did NOT take the sampled per-cycle CycleAuditRecord or the FeaturedAppActivityMarker from the same design — judge 2 named both as putting non-value writes back inside qualifying transactions, which is precisely the trap arCCade's framework exists to avoid.

- DIGEST PARITY ACROSS DAML, JAVA AND JS IS THE QUIET RISK. A divergence in length counting (Java's String.length is UTF-16 units, not code points) or in truncation direction would fail no test and would surface only when the committee tried to verify a published payload. Accepted with the strongest available mitigation: the scheme is proven byte-identical between Daml and an independent Python implementation today, and the golden vectors are a CI gate rather than a document.

- THE ~111-CHARACTER LOCK CONTEXT IS UNVERIFIED AGAINST A LIVE REGISTRY. AmuletRules performs no length or charset validation in the 0.1.22 source and Splice itself writes a structured string there, but the HoldingV1 doc calls the field a 'short, human-readable description'. Accepted with a documented fallback: if a live registry objects, drop to "arccade-game-sdk:1:<cycleId>" and carry the commitment on GameStake alone, which weakens S6 to app-visible evidence but breaks nothing. It is an explicit item in step 11.

- COMMITTING TO PRICES AND SCORES MAKES THEM TAMPER-EVIDENT, NOT TRUE. Nothing on-chain proves the price feed was honest; exit prices are revealed at settlement, so a dishonest venue could still cherry-pick a source. Accepted: committee language must say 'commitment', never 'proof of fair play', and the durable fix is a signed oracle feed whose signatures live inside the entry document.

- TRANSFERS CHARGE NO OUTPUT FEES TODAY (CIP-78 stripped them, TransferConfigV2 retains only holdingFee), so an exactly-locked stake returns exactly. That is DSO-governed config, not code. Accepted with a monitoring requirement on AmuletConfig, since a config change would silently break settlement of every open cycle rather than paying out less.


## Uygulama sirasi

1. 1. SCAFFOLD + TIME. Create the package: name arccade-game-sdk, version 1.0.0, sdk-version 3.4.10, source daml, build-options [--target=2.1, -Werror=unused-dependency], dependencies daml-prim + daml-stdlib ONLY (no daml-script), data-dependencies splice-api-token-metadata-v1-current.dar, splice-api-token-holding-v1-current.dar, splice-api-token-allocation-v1-current.dar. Write ArCCade.GameSdk.Time (epochMicros, epochSeconds, secondsBetween, addSeconds). TEST: `daml build` succeeds with no warnings.

2. 2. DIGEST + PYTHON REFERENCE. Write ArCCade.GameSdk.Digest exactly as specified in commitmentSpec: canon/canonText/canonInt/canonDecimal/canonBool/canonTime/canonParty/canonOptional/canonList/canonFields/canonDocument, documentDigest, amountUnits with the round-trip guard, unitsAmount, isHex64, assertDigestMatches, and the Merkle helpers. NOTE two LF 2.1 constraints found the hard way: locally recursive let/where bindings are rejected ("recursion can only happen at the top level"), so merklePairUp and merkleWalk must be top level; and DA.Text has no `concat`, use T.intercalate "". Write the ~25-line Python reference alongside it. TEST: a script asserts sha256 "abc" = ba7816bf...15ad, canonDecimal 20.5 = "d:12:205000000000", canonDecimal (-3.25) = "d:12:-32500000000", amountUnits 12.3456789012 = 123456789012, amountUnits 922337203.6854775807 = maxInt, and a Merkle inclusion proof verifies while a forged leaf does not.

3. 3. TYPES + POLICY. Write ArCCade.GameSdk.Types (CustodyMechanic, CustodyRef, Disposition, VenueMode, VenuePolicy, StakeTerms, EntitlementGrant, dispositionTag, modeTag, custodyTagPrefix, custodyTagFor, isValidCycleId) and ArCCade.GameSdk.Policy (policyDocument, policyDigest, validPolicy, assertTermsMeetPolicy). NOTE: a record field name clashes with a same-named top-level function in the same module — name the outcome field entryCommitment, not entryDigest. TEST: `daml build`; a script asserts validPolicy rejects minLockSeconds < minCycleSeconds and accepts the proposed launch policy.

4. 4. CUSTODY + MOCK + PROOF TEST. Write ArCCade.GameSdk.Custody (verifyLockedHolding, verifyCustody). Create the SEPARATE package arccade-game-sdk-test (daml-script + a data-dependency on the built SDK DAR) with Test.GameSdk.Mocks.MockLockedHolding mirroring LockedAmulet's signatories (dso, owner, holders) and its Holding interface instance. TEST: Test.GameSdk.CustodyTest — a venue-controlled choice verifies a correct lock, and submitMustFail rejects a wrong tag, an under-funded lock, a wrong expiry, an unlocked holding, and a lock held by a third party. Six cases, all passing.

5. 5. CYCLE TEMPLATES. Write ArCCade.GameSdk.Cycle: GameVenue, PlayerEntitlement, GameStake and recycleEntitlement, with every choice body as given in the templates section. TEST: Test.GameSdk.Fixture (setupLive, mkTerms) plus Test.GameSdk.LifecycleTest — a full Trade Wars cycle with a mock lock, and submitMustFail on each of: settling before minCycleSeconds, a second commit on the consumed entitlement, a tampered reveal, a forfeit attempt on a time-locked stake, a payout above the ceiling, settling without a custody proof at a live venue, and settling against a lock carrying another cycle's tag. Then assert the recycled entitlement has cyclesCompleted 1 and lifetimeStaked equal to the stake, that a commit inside the cooldown fails and one after it succeeds. VISIBILITY GOTCHA: the settlement submission must include the venue (a lock stakeholder) in actAs or readAs, or the fetch fails with "contract not visible to the reading parties" even though the authority is present.

6. 6. EXCEPTION PATHS + MODE DISCIPLINE. Add the abortPath, playerSelfRecovery and modeDiscipline scripts. TEST: an unfunded cycle cannot settle but can be aborted, does not increment cyclesCompleted, and is blocked by abortCooldownSeconds; GameStake_ExpireUnsettled fails before lockExpiresAt and succeeds after; a live venue with requireCustodyProof=False is not creatable, a dry-run venue without the "dryrun-" prefix is not creatable, and a dry-run venue charging a fee is not creatable.

7. 7. GAME ADAPTERS + CROSS-LANGUAGE PARITY. Write ArCCade.GameSdk.Games.TradeWars and .PixelRace (documents + digests only, no templates). TEST: Test.GameSdk.Vectors asserts TW.entryDigest of the sample entry equals the constant produced independently by the Python reference (0a31821f2db2a8042b4f6363543f39df22e534b5c71722c07750621d2297a636), and Test.GameSdk.LifecycleTest runs a Pixel Race cycle through the SAME venue and entitlement type, revealing the seed document so the ledger proves the seed predated play. This step is what makes the S5 and reproducibility claims facts.

8. 8. AUDIT ANCHOR. Write ArCCade.GameSdk.Audit (CycleAuditRow, periodLeafDocument, periodLeaf, VenuePeriodAnchor) and add GameVenue_AnchorPeriod. TEST: build N rows in a script, compute the root in Daml, anchor it, and assert inclusion proofs verify while a forged row does not; assert a duplicate cycleId is rejected. This step is last on purpose: it is off-cycle and can be dropped without touching the two-write cycle.

9. 9. TESTNET DRY RUN (0 CC). Upload and vet arccade-game-sdk on TestNet — this is also the test of whether a live participant accepts DA.Text.sha256 at vetting time. Create a ModeDryRun GameVenue with venueId "dryrun-tw1", issue one entitlement, and run a full Entitlement_Commit / GameStake_Settle cycle against real ledger time. TEST: two transactions, two updateIds, the entitlement recycled with the cooldown, and every contract carrying mode = ModeDryRun.

10. 10. JAVA DIGEST PORT + CI GATE. Port ArCCade.GameSdk.Digest and both adapters to Java, using codePointCount for lengths and integer 1e-10 units end to end (never a double). TEST: the Java suite asserts the same golden vectors as the Daml and Python suites; CI fails the build on any divergence.

11. 11. BACKEND submitCommands + COMMITMENT PATH. Add CantonJsonApiClient#submitCommands and collapse the five existing single-command helpers onto it. Add AmuletLockService#buildLockCommand. Add GameSdkService#commit. TEST (TestNet, needs a funded wallet): one submission carrying AmuletRules_Transfer and Entitlement_Commit produces ONE transaction with one updateId; assert the created LockedAmulet's lock.context equals the GameStake's custodyTag byte-for-byte, and that AmuletRules accepted the ~111-character optContext. This is the highest-risk step in the whole plan and nothing downstream should be built before it passes.

12. 12. SETTLEMENT WORKER. Add GameSdkService#settle and #abort, submitting [GameStake_Settle, LockedAmulet_UnlockV2] in that order with actAs = [operator, venue, player]. TEST: a full live cycle settles in one transaction; the stake returns to the player; the entitlement comes back; a deliberately withheld settlement past lockExpiresAt is recovered by the player alone via LockedAmulet_OwnerExpireLockV2 + GameStake_ExpireUnsettled.

13. 13. PIXEL RACE STAKE-AT-START. Move the stake from endGame to a new session-start path and delete RaceSession, GamePlay, GamePlayResult, SessionResult and their call sites. TEST: the LockedAmulet create event precedes the first play in wall-clock and in ledger order for a real session. Until this ships, no S1 claim may be filed.

14. 14. ENTITLEMENT BACKFILL + LEGACY DRAIN. Run EntitlementBackfillJob, wire issuance into UserOnboardingService, dual-read open stakes, then set legacy-cycle.accept-new=false and drain. TEST: no user is left with zero entitlements and no open stake; legacy claims still settle; TerminalContractSweeper clears the old terminal contracts and the ACS query size falls back under the JSON API limit.

15. 15. REPORTING + ANCHORING JOB. Build per-cycle rows from the transaction TREE stream, publish the entry and outcome documents content-addressed by their digests, compute the Merkle root with the shared reference implementation, publish the report and submit GameVenue_AnchorPeriod, asserting the Daml-computed root matches. TEST: an independent script reconstructs the period from Scan-visible lock events alone, recomputes every digest from the published documents, and reproduces the anchored root.
