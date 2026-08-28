#!/usr/bin/env python3
"""Built DAR'in paket kimligi, yayinlanan kimlikle ayni mi?

Bu kontrol M1'in "reproducible DAR build" iddiasinin TA KENDISIDIR. Bayt bayt
yeniden uretilemeyen bir derleme, agin vet ettigi seyle karsilastirilamaz;
o zaman "vetted" yalnizca bir kayittir, dogrulanabilir bir olgu degil.
"""
import json, sys, zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
version = next(l.split(":", 1)[1].strip()
               for l in (root / "daml.yaml").read_text().splitlines()
               if l.startswith("version:"))
published = json.loads((root / "test-vectors" / "package-ids.json").read_text())["ids"]

dar = root / ".daml" / "dist" / f"arccade-game-sdk-{version}.dar"
if not dar.exists():
    sys.exit(f"DAR yok: {dar} — once `daml build`")

prefix = f"arccade-game-sdk-{version}-"
name = next(n for n in zipfile.ZipFile(dar).namelist()
            if n.endswith(".dalf") and n.startswith(prefix))
built = name.split("-")[-1].removesuffix(".dalf")

want = published.get(version)
if want is None:
    sys.exit(f"{version} test-vectors/package-ids.json icinde YOK.\n"
             f"  Derlenen: {built}\n"
             f"  Yeni bir surumse kimligi oraya ekleyin; eklemeden vet ETMEYIN.")
if built != want:
    sys.exit(f"PAKET KIMLIGI DEGISTI — surum {version}\n"
             f"  beklenen: {want}\n"
             f"  derlenen: {built}\n"
             f"  Ayni surum numarasi altinda farkli bir paket, aga yuklenirse\n"
             f"  vet edilemez ve upgrade zinciri kirilir. Ya degisikligi geri alin\n"
             f"  ya da surumu yukseltin.")
print(f"OK  {version} -> {built}")
