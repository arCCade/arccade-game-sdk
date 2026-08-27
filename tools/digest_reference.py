#!/usr/bin/env python3
"""arccade-sdk-digest-v1/sha256 — bagimsiz referans implementasyonu.

Bu dosyanin amaci ucuncu tarafin arCCade'e guvenmeden dogrulama yapabilmesidir.
Daml tarafi (ArCCade.GameSdk.Digest) ve Java backend portu, buradaki degerlerin
AYNISINI uretmek zorundadir; uc implementasyondan biri saparsa CI kirilmalidir.

Dogrulamanin en dis katmani kutuphane bile gerektirmez: yayinlanan kanonik
belgeye kabuktan

    sha256sum <belge>

calistirmak, zincir uzerindeki digest'i vermelidir.
"""

import hashlib
from decimal import Decimal


# ---------------------------------------------------------------- kodlama

def canon(tag: str, value: str) -> str:
    """<tag>:<uzunluk>:<deger> — uzunluk UNICODE KOD NOKTASI cinsinden.

    Python'da len(str) zaten kod noktasi sayar. Java'da codePointCount
    kullanilmali; String.length() UTF-16 birimi sayar ve BMP disi karakterlerde
    sapar.
    """
    return f"{tag}:{len(value)}:{value}"


def canon_text(s: str) -> str:
    return canon("t", s)


def canon_int(i: int) -> str:
    return canon("i", str(i))


def amount_units(d: Decimal) -> int:
    """Tutar -> tamsayi 1e-10 birimi, gidis-donus guvenligiyle."""
    scaled = d * Decimal(10) ** 10
    u = int(scaled.to_integral_value(rounding="ROUND_DOWN"))
    if Decimal(u) / (Decimal(10) ** 10) != d:
        raise ValueError(f"tutar 1e-10 birimine kayipsiz cevrilemedi: {d}")
    return u


def canon_decimal(d) -> str:
    return canon("d", str(amount_units(Decimal(str(d)))))


def canon_bool(b: bool) -> str:
    return canon("b", "true" if b else "false")


def canon_time_micros(micros: int) -> str:
    """Zaman her zaman epoch'tan beri TAMSAYI MIKROSANIYE; ISO metni degil."""
    return canon("m", str(micros))


def canon_party(p: str) -> str:
    return canon("p", p)


def canon_optional(f, x) -> str:
    return canon("o", "") if x is None else canon("o", f(x))


def canon_list(items) -> str:
    items = list(items)
    return canon("l", f"{len(items)}:" + "|".join(items))


def canon_fields(kvs) -> str:
    body = "".join(f"{canon('k', k)}={v};" for k, v in sorted(kvs, key=lambda kv: kv[0]))
    return canon("r", body)


SCHEME_PREFIX = "arccade-sdk-digest-v1"


def canon_document(schema: str, version: int, kvs) -> str:
    return SCHEME_PREFIX + "|" + canon_text(schema) + canon_int(version) + canon_fields(kvs)


def text_digest(t: str) -> str:
    """Kanonik metnin HAM BAYTLARININ sha256'si.

    Daml tarafinda sha256 bir HEX DIZESI bekledigi icin metin once toHex ile
    baytlara cevrilir; sonuc buradakiyle ayni olur.
    """
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def document_digest(schema: str, version: int, kvs) -> str:
    return text_digest(canon_document(schema, version, kvs))


# ------------------------------------------------------------- adaptorler

def tw_price_point(symbol: str, price, source: str, as_of_micros: int) -> str:
    return canon_fields([
        ("as-of", canon_time_micros(as_of_micros)),
        ("price", canon_decimal(price)),
        ("source", canon_text(source)),
        ("symbol", canon_text(symbol)),
    ])


def tw_allocation(symbol: str, pct) -> str:
    return canon_fields([
        ("allocation-percent", canon_decimal(pct)),
        ("symbol", canon_text(symbol)),
    ])


def tw_entry_document(cycle_id, tier, virtual_balance, allocations, entry_prices) -> str:
    return canon_document("arccade-trade-wars-entry", 1, [
        ("allocations", canon_list(tw_allocation(*a) for a in allocations)),
        ("cycle-id", canon_text(cycle_id)),
        ("entry-prices", canon_list(tw_price_point(*p) for p in entry_prices)),
        ("game-code", canon_text("trade-wars-v4")),
        ("tier", canon_text(tier)),
        ("virtual-balance", canon_decimal(virtual_balance)),
    ])


def pr_entry_document(cycle_id, tier, max_games, seed_commit) -> str:
    return canon_document("arccade-pixel-race-entry", 1, [
        ("cycle-id", canon_text(cycle_id)),
        ("game-code", canon_text("pixel-race-v1")),
        ("max-games-per-session", canon_int(max_games)),
        ("rng-seed-commit", canon_text(seed_commit)),
        ("tier", canon_text(tier)),
    ])


# ----------------------------------------------------------- altin vektor

TW_SAMPLE = dict(
    cycle_id="tw-sample-1",
    tier="silver",
    virtual_balance="10000.0",
    allocations=[("BTC", "60.0"), ("ETH", "40.0")],
    entry_prices=[
        ("BTC", "60000.0", "binance", 1_000_000),
        ("ETH", "3000.0", "binance", 1_000_000),
    ],
)

PR_SAMPLE = dict(
    cycle_id="pr-sample-1",
    tier="bronze",
    max_games=3,
    seed_commit="0" * 64,
)

# Daml tarafindan uretilen degerler (Test.GameSdk.VectorsTest:documentTexts).
# ---------------------------------------------------------------------------
# Merkle — donem capasinin dogrulama tarafi
# ---------------------------------------------------------------------------
#
# Kok zincirde hesaplanir; denetci burada dogrular. Daml ile bayt bayt ayni
# olmak zorunda: altin vektorler asagida kilitli.


def merkle_empty() -> str:
    return document_digest("arccade.merkle-empty", 1, [])


def merkle_node(l: str, r: str) -> str:
    return document_digest("arccade.merkle-node", 1, [("l", canon_text(l)), ("r", canon_text(r))])


def merkle_pair_up(level):
    """Tek kalan dugum KOPYALANMAZ, yukseltilir (bkz. CVE-2012-2459)."""
    out = []
    for i in range(0, len(level), 2):
        out.append(merkle_node(level[i], level[i + 1]) if i + 1 < len(level) else level[i])
    return out


def merkle_root(leaves) -> str:
    if not leaves:
        return merkle_empty()
    level = list(leaves)
    while len(level) > 1:
        level = merkle_pair_up(level)
    return level[0]


def merkle_proof(ix: int, leaves):
    """`[(sibling_on_left, sibling)]`."""
    if ix < 0 or ix >= len(leaves):
        return []
    steps, level, i = [], list(leaves), ix
    while len(level) > 1:
        sib = i + 1 if i % 2 == 0 else i - 1
        if sib < len(level):          # yukseltilmis dugumun kardesi yok
            steps.append((i % 2 == 1, level[sib]))
        level = merkle_pair_up(level)
        i //= 2
    return steps


def merkle_verify(leaf: str, steps, root: str) -> bool:
    acc = leaf
    for on_left, sibling in steps:
        acc = merkle_node(sibling, acc) if on_left else merkle_node(acc, sibling)
    return acc == root


DISPOSITIONS = (
    "returned-in-full",
    "returned-with-forfeit",
    "forfeited-in-full",
    "aborted",
    "expired-unsettled",
)


def period_leaf_document(row: dict) -> str:
    """Disposition ETIKETTIR, constructor adi degil — sessiz sapmayi onler."""
    if row["disposition"] not in DISPOSITIONS:
        raise ValueError(f"gecersiz disposition: {row['disposition']!r}")
    return canon_document("arccade.cycle-audit-row", 1, [
        ("cycleId", canon_text(row["cycleId"])),
        ("player", canon_party(row["player"])),
        ("gameCode", canon_text(row["gameCode"])),
        ("concurrencyIndex", canon_int(row["concurrencyIndex"])),
        ("entryDigest", canon_text(row["entryDigest"])),
        ("outcomeDigest", canon_text(row["outcomeDigest"])),
        ("committedUnits", canon_int(row["committedUnits"])),
        ("feeUnits", canon_int(row["feeUnits"])),
        ("returnedUnits", canon_int(row["returnedUnits"])),
        ("forfeitedUnits", canon_int(row["forfeitedUnits"])),
        ("payoutUnits", canon_int(row["payoutUnits"])),
        ("disposition", canon_text(row["disposition"])),
        ("committedAtMicros", canon_int(row["committedAtMicros"])),
        ("settledAtMicros", canon_int(row["settledAtMicros"])),
        ("custodyTag", canon_text(row["custodyTag"])),
    ])


def period_leaf(row: dict) -> str:
    return text_digest(period_leaf_document(row))


def period_row_verify(row: dict, steps, root: str) -> bool:
    """Denetcinin kullanmasi gereken uc: yapragi SATIRDAN hesaplar."""
    return merkle_verify(period_leaf(row), steps, root)


GOLDEN_ROW = {
    "cycleId": "cycle-golden",
    "player": "auditor-golden-party",
    "gameCode": "pixel-race-v1",
    "concurrencyIndex": 0,
    "entryDigest": "0" * 63 + "1",
    "outcomeDigest": "0" * 63 + "2",
    "committedUnits": 300000000000,
    "feeUnits": 100000000,
    "returnedUnits": 300000000000,
    "forfeitedUnits": 0,
    "payoutUnits": 0,
    "disposition": "returned-in-full",
    "committedAtMicros": 1700000000000000,
    "settledAtMicros": 1700000003600000,
    "custodyTag": "arccade-game-sdk:1:cycle-golden:x",
}

EXPECTED_MERKLE_EMPTY = "c950347c02be45f67730e2de280fafe0834b97822d98c01717a350e7ab5f61b0"
EXPECTED_MERKLE_ROOT3 = "f31cc766e62a52c3c3156e05d53fde76f54fed6067d283dc9a3d8ada9d0ceedf"
EXPECTED_MERKLE_NODE = "aa3de7939ca80f5110e8b29ec442d9d770f525dfb63e86ff59e7624ff110e720"
EXPECTED_ROW_LEAF = "01e89a905ec52a23012354b602cdf583a7bc6dd92d9c36a19aa0346a1cf26237"


EXPECTED_TW_DIGEST = "5669632b0fecad52d4c7e31afffb710e13f97b7b2b7c5f2606f5d4c84c594852"
EXPECTED_PR_DIGEST = "0b2349e05633cf279ca0ee1d3f5efd8b2308f3e2ee947a32f5c3397e456d0204"


def main() -> int:
    tw_doc = tw_entry_document(**TW_SAMPLE)
    pr_doc = pr_entry_document(**PR_SAMPLE)
    tw = text_digest(tw_doc)
    pr = text_digest(pr_doc)

    ok = True
    for label, got, want in (("trade-wars", tw, EXPECTED_TW_DIGEST),
                             ("pixel-race", pr, EXPECTED_PR_DIGEST)):
        status = "OK " if got == want else "SAPMA"
        if got != want:
            ok = False
        print(f"  {status} {label}: {got}")
        if got != want:
            print(f"        beklenen: {want}")

    leaves = [text_digest(f"leaf-{n}") for n in (1, 2, 3)]
    for label, got, want in (
        ("merkle bos kok", merkle_empty(), EXPECTED_MERKLE_EMPTY),
        ("merkle kok(3)", merkle_root(leaves), EXPECTED_MERKLE_ROOT3),
        ("merkle ic dugum", merkle_node(leaves[0], leaves[1]), EXPECTED_MERKLE_NODE),
        ("denetim satiri yapragi", period_leaf(GOLDEN_ROW), EXPECTED_ROW_LEAF),
    ):
        status = "OK " if got == want else "SAPMA"
        if got != want:
            ok = False
        print(f"  {status} {label}: {got}")
        if got != want:
            print(f"        beklenen: {want}")

    # Kanit sistemi: her boyutta her indeks dogrulanmali, uydurma dogrulanmamali.
    for n in range(1, 10):
        ls = [text_digest(f"x-{i}") for i in range(n)]
        root = merkle_root(ls)
        for ix in range(n):
            if not merkle_verify(ls[ix], merkle_proof(ix, ls), root):
                ok = False
                print(f"  SAPMA icerme kaniti: boyut {n} indeks {ix}")
    forged = dict(GOLDEN_ROW, committedUnits=999900000000)
    rows = [dict(GOLDEN_ROW, cycleId=f"c-{i}") for i in range(5)]
    ls = [period_leaf(r) for r in rows]
    if not period_row_verify(rows[2], merkle_proof(2, ls), merkle_root(ls)):
        ok = False
        print("  SAPMA gercek satir dogrulanmadi")
    if period_row_verify(forged, merkle_proof(2, ls), merkle_root(ls)):
        ok = False
        print("  SAPMA UYDURULMUS SATIR DOGRULANDI")

    print(f"  {'OK ' if ok else 'SAPMA'} parite")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
