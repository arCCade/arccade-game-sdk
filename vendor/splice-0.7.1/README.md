# Vendored Splice token-standard DARs

These are the CIP-0056 token-standard interface DARs, copied verbatim from the
Splice 0.7.1 release. They are here so that a clone of this repository builds
with no setup, no network, and no assumption about where a Splice release lives
on the host -- and so that the DAR this repo produces is byte-reproducible
against the bytes that were vetted.

    source      splice-node-0.7.1 / dars/
    licence     Apache-2.0 (see LICENSE in this directory)
    upstream    https://github.com/hyperledger-labs/splice

Only the interfaces this package actually depends on are vendored, not the whole
release. Do not edit them; to move to a new Splice version, replace the
directory wholesale and rebuild, so the version in the path always names the
release the bytes came from.
