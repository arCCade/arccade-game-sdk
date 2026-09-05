#!/usr/bin/env python3
"""Her istemcinin MAJOR.MINOR'u Daml paketininkiyle ayni mi?

Bu kural INTEGRATION.md 7'de YAZIYORDU ve yalnizca yaziyordu:

    "Istemcinin MAJOR.MINOR'u Daml paketini izler; PATCH izlemez. Surüklenmeye
     izin vermek, istemcinin ledger'in reddedecegi bir digest hesaplamaya
     baslamasinin yoludur — bu bir kez zaten oldu, 1.1.0 istemcisi 1.5.0 ledger
     paketine karsi, ve fark edilmedi cunku tek tuketici yerel bir `file:`
     bagimliligiydi."

Bir kez daha oldu. Daml paketi 1.6.0'a cikti, uc istemci 1.5.x'te kaldi ve bunu
kimse fark etmedi cunku kurali kontrol eden bir sey yoktu. Bu betik o seydir.

PATCH BILEREK SERBEST. Istemci bir hatayi duzeltip 1.6.1 olabilir; anlasma
degismedigi surece bu dogrudur. Kontrol edilen sey ANLASMA, yani MAJOR.MINOR.

Bir kayit yayinlandiktan sonra geri alinamaz: PyPI ve Maven Central'a yanlis
surumle cikmak, bu surüklenmeyi kalici hale getirir. Bu yüzden kontrol yayin
akisinin onunde durur.

    python3 tools/check_client_versions.py
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def read(path, pattern, what):
    text = (ROOT / path).read_text()
    m = re.search(pattern, text, re.M)
    if not m:
        fail(f"{path}: {what} okunamadi")
    return m.group(1)


def minor(version):
    parts = version.split(".")
    if len(parts) < 2:
        fail(f"surum MAJOR.MINOR.PATCH degil: {version}")
    return ".".join(parts[:2])


daml = read("daml.yaml", r"^version:\s*(\S+)", "surum")

clients = {
    "javascript": json.loads((ROOT / "js/package.json").read_text())["version"],
    "python": read("python/pyproject.toml", r'^\s*version\s*=\s*"([^"]+)"', "surum"),
    # The project's OWN version: the first <version> that follows its artifactId,
    # not a dependency's.
    "java": read(
        "java/pom.xml",
        r"<artifactId>game-sdk</artifactId>\s*<version>([^<]+)</version>",
        "surum",
    ),
    # A second Python copy, and it drifts silently because nothing imports it to
    # compare: `pip show` reads pyproject, `arccade_game_sdk.__version__` reads
    # this one, and the two can disagree for a whole release.
    "python-__init__": read(
        "python/arccade_game_sdk/__init__.py", r'^__version__\s*=\s*"([^"]+)"', "surum"
    ),
}

want = minor(daml)
bad = {name: v for name, v in clients.items() if minor(v) != want}

for name, v in clients.items():
    mark = "  " if name not in bad else "!!"
    print(f"{mark} {name:<16} {v:<10} (MAJOR.MINOR {minor(v)})")
print(f"   {'daml':<16} {daml:<10} (MAJOR.MINOR {want})")

if bad:
    print("", file=sys.stderr)
    fail(
        "SURUM SURUKLENMESI. Yukaridakilerin MAJOR.MINOR'u Daml paketininkiyle "
        f"({want}) ayni olmali.\n"
        "Anlasma degistiyse istemcileri yukseltin; degismediyse Daml surumu "
        "neden hareket etti, once o cevaplanmali.\n"
        "Bkz. docs/INTEGRATION.md 7."
    )

print(f"\nOK  uc istemci de {want}.x")
