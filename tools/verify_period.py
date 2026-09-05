#!/usr/bin/env python3
"""Bir donem capasini BAGIMSIZ dogrular — arCCade'e guvenmeden.

NEDEN VAR. Bir capa, ancak arkasindaki satirlar DENETCININ DE OKUDUGU akistan
turetilebiliyorsa kanittir. SDK bunun butun parcalarini tasiyordu — satir
turetme, Merkle agaci, capa belgesi, icerme kaniti — ama bir araci yoktu, ve
INTEGRATION.md 8 bunu acikca soyluyordu: "capa atan bir is, rapor sunucusu ve
icerme kanidi ucu bu depoda YOK; yalnizca onlardan kurulacak parcalar var."
Ucuncu bir taraf o parcalari kendisi birlestirmek zorundaydi. Artik zorunda
degil.

UC SORU, UC KIP. Her biri farkli bir seye guvenmeyi birakir:

  --transactions   Ledger islem agaclarindan satirlari YENIDEN TURETIR ve capayi
                   kurar. arCCade'in yayinladigi hicbir seye guvenilmez; yalnizca
                   akisa ve bu koda.

  --rows           Yayinlanan rapor satirlarini alir ve capayi kurar. arCCade'in
                   satirlarina guvenilir, aritmetigine ve koklerine guvenilmez.

  --leaf           Tek bir dongunun raporda OLDUGUNU kanitlar (icerme kaniti).
                   Butun rapora sahip olmayan biri icindir.

CIKIS KODU 0 YALNIZCA HER SEY TUTUYORSA. Bir dogrulayicinin sessizce basarili
olmasi, dogrulamamasindan daha kotudur.

    python3 tools/verify_period.py --transactions txs.json --anchor anchor.json
    python3 tools/verify_period.py --rows rows.json --anchor anchor.json
    python3 tools/verify_period.py --leaf row.json --proof proof.json --root <hex>
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "python"))

from arccade_game_sdk.audit import anchor_digest, anchor_document, anchor_totals  # noqa: E402
from arccade_game_sdk.cycle_audit import rows_from_transactions, to_leaf_row  # noqa: E402
from arccade_game_sdk.digest import (  # noqa: E402
    merkle_root,
    period_leaf,
    period_row_verify,
)

OK = "OK  "
BAD = "!!  "


def load(path):
    return json.loads(pathlib.Path(path).read_text())


def report(label, got, want):
    same = got == want
    print(f"{OK if same else BAD}{label}")
    if not same:
        print(f"      beklenen: {want}")
        print(f"      hesaplanan: {got}")
    return same


def flatten_transactions(doc):
    """Whatever shape the export arrived in, hand back a flat transaction list.

    A ledger export is a bare list. The repository's own fixture is a `cases`
    array whose entries pair the commit transaction with the closing one, and
    an operator who exports "the period" is as likely to hand over one shape as
    the other. Guessing here beats making the caller reshape a file by hand
    before a verification tool will look at it.
    """
    if isinstance(doc, list):
        return doc
    if not isinstance(doc, dict):
        raise SystemExit("islem dosyasi bir liste ya da nesne olmali")
    if "transactions" in doc:
        return doc["transactions"]
    if "cases" in doc:
        out = []
        for case in doc["cases"]:
            for key in ("commitTransaction", "closingTransaction"):
                if case.get(key):
                    out.append(case[key])
        return out
    raise SystemExit("islem dosyasinda transactions ya da cases alani yok")


def as_units(value):
    """A units field as an integer, whatever the transport made of it.

    THE ROWS CARRY STRINGS. `to_leaf_row` and the digest want them that way —
    a canonical document must not depend on how a language prints a number —
    but `anchor_totals` demands real integers, deliberately, so a caller cannot
    slip a float or a bool past the sums. Both are right; the conversion has to
    happen somewhere and the verifier is the place, because it is the only party
    holding a file that came from outside.
    """
    if isinstance(value, bool):
        raise SystemExit(f"birim alani bool olamaz: {value!r}")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and (value.lstrip("-").isdigit()):
        return int(value)
    raise SystemExit(f"birim alani tamsayi degil: {value!r}")


def rows_as_integers(rows):
    """A copy of the rows with the five unit fields as ints, for the totals."""
    fields = ("committedUnits", "feeUnits", "returnedUnits",
              "forfeitedUnits", "payoutUnits")
    out = []
    for r in rows:
        c = dict(r)
        for f in fields:
            if f in c:
                c[f] = as_units(c[f])
        out.append(c)
    return out


def verify_anchor(rows, anchor, derived_from):
    """Rebuild everything the anchor claims and compare it field by field."""
    ok = True
    leaves = [period_leaf(to_leaf_row(r)) for r in rows]
    root = merkle_root(leaves)

    print(f"    satir sayisi: {len(rows)}  ({derived_from})")
    ok &= report("merkleRootHex", root, anchor["merkleRootHex"])
    ok &= report("cycleCount", len(rows), as_units(anchor["cycleCount"]))

    # THE TOTALS ARE NOT DECORATION. A root can be right while the sums beside
    # it are wrong, and the sums are what a reader actually quotes.
    totals = anchor_totals(rows_as_integers(rows))
    for key in ("committedUnits", "feeUnits", "returnedUnits",
                "forfeitedUnits", "payoutUnits"):
        if key in totals:
            ok &= report(key, int(totals[key]), as_units(anchor[key]))

    # The digest last: it commits to every field above, so a mismatch here after
    # they all matched means a field this tool does not know about moved.
    claimed = anchor.get("anchorDigest")
    computed = anchor_digest(anchor)
    if claimed is None:
        print(f"{OK}anchorDigest hesaplandi: {computed}")
        print("      (capa dosyasi bir digest bildirmedi, karsilastirilmadi)")
    else:
        ok &= report("anchorDigest", computed, claimed)

    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--transactions", help="ledger islem agaclari (LEDGER_EFFECTS)")
    src.add_argument("--rows", help="yayinlanan rapor satirlari")
    src.add_argument("--leaf", help="tek satir; --proof ve --root ile kullanilir")
    ap.add_argument("--anchor", help="zincirdeki VenuePeriodAnchor payload'i")
    ap.add_argument("--proof", help="icerme kaniti adimlari")
    ap.add_argument("--root", help="kanitin dogrulanacagi Merkle koku")
    args = ap.parse_args()

    if args.leaf:
        if not (args.proof and args.root):
            ap.error("--leaf, --proof ve --root ister")
        row = load(args.leaf)
        steps = load(args.proof)
        good = period_row_verify(to_leaf_row(row), steps, args.root)
        print(f"{OK if good else BAD}icerme kaniti")
        if not good:
            print("      Bu satir bu kokun altinda DEGIL. Ya satir raporda yok,")
            print("      ya kanit baska bir satira ait, ya da kok baska bir donemin.")
        return 0 if good else 1

    if not args.anchor:
        ap.error("--transactions ve --rows, --anchor ister")

    anchor = load(args.anchor)
    # The repository's own fixture wraps the anchor with a note; a chain export
    # is the payload alone.
    if isinstance(anchor, dict) and "anchor" in anchor:
        anchor = anchor["anchor"]
    if args.transactions:
        txs = flatten_transactions(load(args.transactions))
        derived = rows_from_transactions(txs)
        rows = derived.rows if hasattr(derived, "rows") else derived[0]
        source = "islem agaclarindan turetildi"
    else:
        rows = load(args.rows)
        if isinstance(rows, dict):
            rows = rows["rows"]
        source = "yayinlanan rapordan okundu"

    ok = verify_anchor(rows, anchor, source)
    print()
    if ok:
        print("DOGRULANDI  capa, arkasindaki satirlarla tutarli.")
        return 0
    print("DOGRULANMADI  yukaridaki !! satirlari nerede ayrildigini gosteriyor.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
