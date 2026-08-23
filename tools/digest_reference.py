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

    print(f"  {'OK ' if ok else 'SAPMA'} parite")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
