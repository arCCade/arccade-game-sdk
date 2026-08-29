"""The asset layer — fungible types and unique instances.

Every game object fits one of two models:

  FUNGIBLE  by type. "500 gold", "3 potions". Copies are identical.
  UNIQUE    by instance. "this sword, with its +9 roll". Each instance is its own
            instrument and the amount is always 1.

WHERE STATS LIVE: NOT ON THE CHAIN. A sword's attack, art and description are in
the application's own database — writing them on-chain would break the SDK's
architectural rule that value-less data is never written. What IS bound on-chain
is the DIGEST of the attribute document, so a player can verify the +9 they
bought, the application cannot quietly drop it to +3 afterwards, and a
third-party marketplace can check without trusting anyone's database.
"""

from __future__ import annotations

import hashlib
import re
from decimal import Decimal
from typing import Any, Iterable, Mapping, Sequence

from .digest import canon_document, canon_int, canon_text, text_digest
from .tenant import assert_valid_tenant_id

__all__ = [
    "FUNGIBLE", "UNIQUE", "INSTANCE_SEPARATOR",
    "assert_valid_local_id", "fungible_instrument", "unique_instrument",
    "parse_asset", "is_unique", "assert_amount_valid_for_asset",
    "asset_attribute_document", "asset_attribute_digest", "derive_instance_id",
]

FUNGIBLE = "fungible"
UNIQUE = "unique"

# The mark separating a unique instance from its type id.
INSTANCE_SEPARATOR = "#"

_LOCAL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,94}[a-z0-9]$")
_INSTANCE_ID_RE = re.compile(r"^[a-z0-9-]{4,64}$")


def assert_valid_local_id(local_id: str) -> str:
    if not isinstance(local_id, str) or not _LOCAL_ID_RE.match(local_id):
        raise ValueError(
            "gecersiz varlik kimligi (2-96 karakter, [a-z0-9._-], tire/nokta "
            f"ile baslayip bitemez): {local_id!r}"
        )
    return local_id


def fungible_instrument(registry_party: str, tenant_id: str, local_id: str) -> dict:
    """``<tenantId>/<localId>`` — e.g. ``mygame/gold``."""
    assert_valid_tenant_id(tenant_id)
    assert_valid_local_id(local_id)
    return {"admin": registry_party, "id": f"{tenant_id}/{local_id}"}


def unique_instrument(registry_party: str, tenant_id: str, local_id: str,
                      instance_id: str) -> dict:
    """``<tenantId>/<localId>#<instanceId>`` — e.g. ``mygame/sword-of-dawn#4a91c8f2``.

    ``instanceId`` is a stable id the application produces; the same instance
    must always get the same value (a reprint is not the same asset).
    """
    assert_valid_tenant_id(tenant_id)
    assert_valid_local_id(local_id)
    if not isinstance(instance_id, str) or not _INSTANCE_ID_RE.match(instance_id):
        raise ValueError(f"gecersiz ornek kimligi (4-64 karakter, [a-z0-9-]): {instance_id!r}")
    return {"admin": registry_party, "id": f"{tenant_id}/{local_id}{INSTANCE_SEPARATOR}{instance_id}"}


def parse_asset(instrument_id: Mapping[str, Any]) -> dict:
    """Splits an instrument id into its components."""
    raw = instrument_id["id"]
    slash = raw.find("/")
    if slash < 0:
        # Namespace-less: ecosystem-wide assets such as CC.
        return {"tenantId": None, "localId": raw, "instanceId": None, "assetClass": FUNGIBLE}
    tenant_id = raw[:slash]
    rest = raw[slash + 1:]
    hash_at = rest.find(INSTANCE_SEPARATOR)
    if hash_at < 0:
        return {"tenantId": tenant_id, "localId": rest, "instanceId": None, "assetClass": FUNGIBLE}
    return {
        "tenantId": tenant_id,
        "localId": rest[:hash_at],
        "instanceId": rest[hash_at + 1:],
        "assetClass": UNIQUE,
    }


def is_unique(instrument_id: Mapping[str, Any]) -> bool:
    return parse_asset(instrument_id)["assetClass"] == UNIQUE


def assert_amount_valid_for_asset(instrument_id: Mapping[str, Any], amount: Any) -> Any:
    """A unique asset's amount is ALWAYS 1.

    "Three of this particular sword" is meaningless, and passing silently leads
    to oddities that look like double spending.
    """
    value = amount if isinstance(amount, Decimal) else Decimal(str(amount))
    if is_unique(instrument_id) and value != 1:
        raise ValueError(
            f"benzersiz varligin miktari 1 olmali ({instrument_id['id']} icin {amount} verildi)"
        )
    if not value > 0:
        raise ValueError(f"varlik miktari pozitif olmali: {amount}")
    return amount


def _attribute_pairs(attributes: Any) -> list:
    if isinstance(attributes, Mapping):
        return list(attributes.items())
    return [(k, v) for k, v in attributes]


def asset_attribute_document(instrument_id: Mapping[str, Any], attributes: Any,
                             schema_version: int = 1) -> str:
    """The asset's CANONICAL ATTRIBUTE DOCUMENT.

    Only INTEGER and TEXT attributes are bound. A float is refused: pass a
    decimal as text, so the bytes are what the application wrote rather than
    what a binary float happened to round to.
    """
    kvs = [("instrument", canon_text(instrument_id["id"]))]
    for k, v in _attribute_pairs(attributes):
        if isinstance(v, bool) or isinstance(v, float):
            raise TypeError(
                f"ozellik degeri tamsayi ya da metin olmali ({k}: "
                f"{type(v).__name__}) — ondalik icin metin kullanin"
            )
        if isinstance(v, int):
            kvs.append((k, canon_int(v)))
        elif isinstance(v, str):
            kvs.append((k, canon_text(v)))
        else:
            raise TypeError(
                f"ozellik degeri tamsayi ya da metin olmali ({k}: "
                f"{type(v).__name__}) — ondalik icin metin kullanin"
            )
    return canon_document("arccade-asset-attributes", schema_version, kvs)


def asset_attribute_digest(instrument_id: Mapping[str, Any], attributes: Any,
                           schema_version: int = 1) -> str:
    return text_digest(asset_attribute_document(instrument_id, attributes, schema_version))


def derive_instance_id(tenant_id: str, local_id: str, attributes: Any, salt: str = "") -> str:
    """Derives an instance id FROM ITS ATTRIBUTES.

    Two mints with the same attributes then get the same id, so an application
    that accidentally mints the same asset twice notices. Optional: use your own
    scheme if you have one.
    """
    doc = asset_attribute_document({"id": f"{tenant_id}/{local_id}"}, attributes)
    return hashlib.sha256((doc + "|" + salt).encode("utf-8")).hexdigest()[:32]
