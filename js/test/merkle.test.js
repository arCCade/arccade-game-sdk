/**
 * Merkle ve denetim satiri — dil parite testleri.
 *
 * Buradaki sabitler Daml `Test.GameSdk.VectorsTest` (`merkleVectors`,
 * `auditRowVector`) tarafindan BAGIMSIZ uretilmistir. Denetci kaniti Daml'de
 * degil burada dogrular; iki taraf ayrisirsa kanit sistemi sessizce ise
 * yaramaz hale gelir, o yuzden sabitler kilitlidir.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  merkleEmpty,
  merkleNode,
  merkleProof,
  merkleRoot,
  merkleVerify,
  periodLeaf,
  periodRowVerify,
  textDigest,
} from '../src/digest.js'

const goldenRow = {
  cycleId: 'cycle-golden',
  player: 'auditor-golden-party',
  gameCode: 'pixel-race-v1',
  concurrencyIndex: 0,
  entryDigest: '0000000000000000000000000000000000000000000000000000000000000001',
  outcomeDigest: '0000000000000000000000000000000000000000000000000000000000000002',
  committedUnits: 300000000000n,
  feeUnits: 100000000n,
  returnedUnits: 300000000000n,
  forfeitedUnits: 0n,
  payoutUnits: 0n,
  disposition: 'returned-in-full',
  committedAtMicros: 1700000000000000n,
  settledAtMicros: 1700000003600000n,
  custodyTag: 'arccade-game-sdk:1:cycle-golden:x',
}

const leaves = [1, 2, 3].map((n) => textDigest('leaf-' + n))

test('altin vektor: bos kok Daml ile ayni', () => {
  assert.equal(merkleEmpty(), 'c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0')
})

test('altin vektor: uc yaprakli kok Daml ile ayni', () => {
  assert.equal(merkleRoot(leaves), 'f31cc766e62a52c3c3156e05d53fde76f54fed6067d283dc9a3d8ada9d0ceedf')
})

test('altin vektor: ic dugum Daml ile ayni', () => {
  assert.equal(
    merkleNode(leaves[0], leaves[1]),
    'aa3de7939ca80f5110e8b29ec442d9d770f525dfb63e86ff59e7624ff110e720',
  )
})

test('altin vektor: denetim satirinin yapragi Daml ile ayni', () => {
  assert.equal(periodLeaf(goldenRow), '01e89a905ec52a23012354b602cdf583a7bc6dd92d9c36a19aa0346a1cf26237')
})

test('disposition ETIKET olmali; constructor adi reddedilir', () => {
  // Sessizce farkli bir yaprak uretmek, hatayi denetim anina erteler.
  assert.throws(() => periodLeaf({ ...goldenRow, disposition: 'ReturnedInFull' }), /gecersiz disposition/)
})

test('her boyut ve her indeks icin icerme kaniti dogrulanir', () => {
  for (let n = 1; n <= 9; n++) {
    const ls = Array.from({ length: n }, (_, i) => textDigest('x-' + i))
    const root = merkleRoot(ls)
    for (let ix = 0; ix < n; ix++) {
      assert.ok(merkleVerify(ls[ix], merkleProof(ix, ls), root), `boyut ${n} indeks ${ix}`)
    }
  }
})

test('uydurulmus satir dogrulanmaz', () => {
  const rows = [0, 1, 2, 3, 4].map((n) => ({ ...goldenRow, cycleId: 'c-' + n }))
  const ls = rows.map(periodLeaf)
  const root = merkleRoot(ls)
  assert.ok(periodRowVerify(rows[2], merkleProof(2, ls), root))
  const forged = { ...rows[2], committedUnits: 999900000000n }
  assert.ok(!periodRowVerify(forged, merkleProof(2, ls), root))
})

test('tek kalan yaprak kopyalanmaz, yukseltilir', () => {
  // Kopyalama [a,b,c] ile [a,b,c,c] kumelerine ayni koku verirdi.
  const [a, b, c] = leaves
  assert.notEqual(merkleRoot([a, b, c]), merkleRoot([a, b, c, c]))
})
