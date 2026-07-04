#!/usr/bin/env python3
"""
bake_seed.py — concatenate site/js/seed/{runtime,poster-runtime,share-codec,
element}.js into site/assets/seed/seed@<version>.js (V2_BLUEPRINT.md work
items 15, 16, 20 & 22 / seed.md §3.2).

SEED-4 (V2_BLUEPRINT.md item 22, seed.md §3.1) additions: every bake also
writes `site/assets/seed/seed.js` — the "latest major" alias embed.html's
snippet generator points hosts at instead of spelling out `seed@1.js`
(byte-identical to the floating file today, since major version 1 is the
only major that has ever shipped; the alias is what makes that claim true
by construction, not by two files happening to agree) — and
`verify_ledger()`, a hard-fail check that every pinned `seed@X.Y.Z.js`
already on disk has a `site/embed/releases.json` entry whose `sha384`/
`bytes` match the file's ACTUAL current bytes. `append_release_ledger()`
only ever writes a NEW entry once, at mint time; `verify_ledger()` is the
standing guarantee that the ledger never quietly drifts from the files it
describes — the thing the SEED-4 accept line ("releases.json has sha384
for every pinned file") actually verifies, continuously, not just at mint
time.

The seed's parts are already dependency-free ES modules; this is assembly,
not bundling: strip `import ... from '...'` declarations and the `export`
keyword, concatenate in dependency order (runtime.js first, then
poster-runtime.js which imports it, then share-codec.js — no deps of its
own — then element.js which imports all three), and stamp a version
header. No minifier — we ship readable source, same policy as
bake_kernels.py's kernels.json.

Budgets (seed.md §3.3 / V2_BLUEPRINT.md §4 as revised by SEED-3), HARD fail
on breach:
  raw   <= 40 KiB (warn at 32 KiB)
  gzip  <= 13 KiB  (CompressionStream-equivalent, measured with gzip level 9)

Fork-drift guard (ruling C8): site/js/seed/runtime.js is a deliberate
snapshot of site/js/runtime/wrap.js's GLSL prelude/epilogue, taken once
after the wrap.js extraction landed. This script diffs the two on every bake
and WARNS (does not fail) when they've drifted — seed.md §12 leaves "warn
vs hard-fail" an open question; warn is the conservative default until a
release actually needs the harder rule.

Distribution & versioning (SEED-2, seed.md §3.1): every bake overwrites the
FLOATING `seed@<major>.js` (the URL to recommend — receives fixes). A PINNED
`seed@<major>.<minor>.<patch>.js` is written only the first time a given
SEED_VERSION is baked; if one already exists on disk with DIFFERENT bytes,
the bake FAILS (bump SEED_VERSION for a new release instead of silently
mutating a shipped file — belt-and-suspenders alongside the
seed-freeze.yml CI workflow, which catches the same mistake from the git-diff
side). Each newly-written pinned release appends one entry to
site/embed/releases.json — the machine-readable ledger `embed.html`'s SRI
guidance points at (sha384 + byte count + date per release).

Usage: python3 tools/bake_seed.py
"""

import gzip
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SEED_JS_DIR = os.path.join(HERE, "..", "site", "js", "seed")
WRAP_JS_PATH = os.path.join(HERE, "..", "site", "js", "runtime", "wrap.js")
SEED_ASSET_DIR = os.path.join(HERE, "..", "site", "assets", "seed")
FLOATING_PATH = os.path.join(SEED_ASSET_DIR, "seed@1.js")
ALIAS_PATH = os.path.join(SEED_ASSET_DIR, "seed.js")  # SEED-4: "latest major" alias
RELEASES_PATH = os.path.join(HERE, "..", "site", "embed", "releases.json")
_PINNED_RE = re.compile(r"^seed@(\d+\.\d+\.\d+)\.js$")

SEED_VERSION = "1.3.0"  # SEED-4: battery enhancement + touch attribution (minor bump — append-only)

# SEED-3 (V2_BLUEPRINT.md item 20) raised these from 28/24/9 KiB — the
# unsafe src=/href= tier, sg-admit, integrity, and the attribution chip
# (plus its forked share-codec.js compress/decompress) are genuine new
# surface, not bloat; ARCHITECTURE.md's SEED-2 section already flagged this
# exact tradeoff ("will need to trim comments further or grow the frozen
# KiB budget deliberately"). Raised deliberately, this commit — same
# sign-off as the rest of the budget table, not a silent per-file bump.
RAW_HARD_BYTES = 40 * 1024
RAW_WARN_BYTES = 32 * 1024
GZ_HARD_BYTES = 13 * 1024

# Matches whole-line `import ... from '...';` module declarations only —
# never touches `import.meta.url`, which is an expression, not a statement,
# and must survive concatenation unchanged (it becomes the baked file's own
# URL, which is how the seed finds its sibling per-kernel JSON assets).
_RE_IMPORT_LINE = re.compile(r"^\s*import\s+.*\bfrom\s+['\"][^'\"]+['\"];\s*$", re.M)
_RE_EXPORT_KEYWORD = re.compile(r"^(\s*)export\s+(?=(class|function|const|let)\b)", re.M)


def strip_module_syntax(src: str) -> str:
    src = _RE_IMPORT_LINE.sub("", src)
    src = _RE_EXPORT_KEYWORD.sub(r"\1", src)
    return src


def read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def extract_template(src: str, name: str):
    """Pull `const NAME = `...`;` template-literal body out of a JS source."""
    m = re.search(re.escape(name) + r"\s*=\s*`(.*?)`", src, re.S)
    return m.group(1) if m else None


def check_fork_drift():
    if not os.path.exists(WRAP_JS_PATH):
        print("[bake_seed] SKIP fork-drift check (runtime/wrap.js not found)")
        return
    wrap_src = read(WRAP_JS_PATH)
    runtime_src = read(os.path.join(SEED_JS_DIR, "runtime.js"))
    upstream_prelude = extract_template(wrap_src, "GLSL_PRELUDE")
    upstream_epilogue = extract_template(wrap_src, "GLSL_EPILOGUE")
    forked_prelude = extract_template(runtime_src, "GLSL_PRELUDE")
    forked_epilogue = extract_template(runtime_src, "GLSL_EPILOGUE")
    drift = []
    if upstream_prelude is not None and upstream_prelude != forked_prelude:
        drift.append("GLSL_PRELUDE")
    if upstream_epilogue is not None and upstream_epilogue != forked_epilogue:
        drift.append("GLSL_EPILOGUE")
    if drift:
        print(
            "[bake_seed] WARN fork drift vs site/js/runtime/wrap.js: "
            + ", ".join(drift)
            + " — seed/runtime.js is a deliberate C8 snapshot; if the site's"
            " wrapper changed on purpose, decide whether to re-snapshot the"
            " seed fork for this release (seed.md §12)."
        )
    else:
        print("[bake_seed] OK no fork drift vs site/js/runtime/wrap.js")


def sha384_b64(data: bytes) -> str:
    return "sha384-" + __import__("base64").b64encode(hashlib.sha384(data).digest()).decode("ascii")


def append_release_ledger(version: str, rel_path: str, raw_bytes: int, digest: str):
    releases = []
    if os.path.exists(RELEASES_PATH):
        try:
            releases = json.loads(read(RELEASES_PATH))
        except (json.JSONDecodeError, OSError):
            releases = []
    if any(r.get("version") == version for r in releases):
        return  # already ledgered (idempotent re-bake of the same version)
    releases.append({
        "version": version,
        "file": rel_path,
        "sha384": digest,
        "bytes": raw_bytes,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    os.makedirs(os.path.dirname(RELEASES_PATH), exist_ok=True)
    with open(RELEASES_PATH, "w", encoding="utf-8") as f:
        json.dump(releases, f, indent=2)
        f.write("\n")
    print(f"[bake_seed] appended {version} to {os.path.normpath(RELEASES_PATH)}")


def verify_ledger() -> bool:
    """SEED-4 SRI publishing flow: every pinned seed@X.Y.Z.js file ON DISK
    right now must have a site/embed/releases.json entry whose sha384/bytes
    match its ACTUAL current bytes — the standing invariant embed.html's SRI
    guidance depends on (a stale or hand-edited ledger would hand out a hash
    the browser's own SRI check then rejects). Runs on every bake, not just
    when a new version is minted. Hard-fails on any drift or gap."""
    if not os.path.isdir(SEED_ASSET_DIR):
        print("[bake_seed] SKIP ledger verification (no seed asset dir yet)")
        return True
    releases = []
    if os.path.exists(RELEASES_PATH):
        try:
            releases = json.loads(read(RELEASES_PATH))
        except (json.JSONDecodeError, OSError):
            releases = []
    by_file = {r.get("file"): r for r in releases}
    ok = True
    checked = 0
    for name in sorted(os.listdir(SEED_ASSET_DIR)):
        if not _PINNED_RE.match(name):
            continue
        checked += 1
        rel_path = "assets/seed/" + name
        with open(os.path.join(SEED_ASSET_DIR, name), "rb") as f:
            data = f.read()
        digest = sha384_b64(data)
        entry = by_file.get(rel_path)
        if entry is None:
            print(f"[bake_seed] FAIL {rel_path} has no releases.json entry — SRI ledger is incomplete")
            ok = False
            continue
        if entry.get("sha384") != digest:
            print(f"[bake_seed] FAIL {rel_path} sha384 in releases.json does not match the file's actual bytes (ledger drift)")
            ok = False
        if entry.get("bytes") != len(data):
            print(f"[bake_seed] FAIL {rel_path} byte count in releases.json does not match the file's actual size (ledger drift)")
            ok = False
    if ok:
        print(f"[bake_seed] OK releases.json ledger matches all {checked} pinned seed file(s) on disk")
    return ok


def main():
    runtime_src = strip_module_syntax(read(os.path.join(SEED_JS_DIR, "runtime.js")))
    poster_src = strip_module_syntax(read(os.path.join(SEED_JS_DIR, "poster-runtime.js")))
    share_codec_src = strip_module_syntax(read(os.path.join(SEED_JS_DIR, "share-codec.js")))
    element_src = strip_module_syntax(read(os.path.join(SEED_JS_DIR, "element.js")))

    header = (
        f"// Shader Garden — seed@{SEED_VERSION} — GENERATED by tools/bake_seed.py "
        "from site/js/seed/{runtime,poster-runtime,share-codec,element}.js. DO NOT EDIT.\n"
        f"const SEED_VERSION = '{SEED_VERSION}';\n"
    )
    out = (
        header
        + runtime_src.strip() + "\n\n"
        + poster_src.strip() + "\n\n"
        + share_codec_src.strip() + "\n\n"
        + element_src.strip() + "\n"
    )
    out_bytes = out.encode("utf-8")

    os.makedirs(SEED_ASSET_DIR, exist_ok=True)
    with open(FLOATING_PATH, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"[bake_seed] wrote {os.path.normpath(FLOATING_PATH)} (floating)")

    # SEED-4: seed.js is the "latest major" alias (seed.md §3.1) — same bytes
    # as the floating file by construction, every bake, for as long as major
    # version 1 is the only major shipped.
    with open(ALIAS_PATH, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"[bake_seed] wrote {os.path.normpath(ALIAS_PATH)} (latest-major alias)")

    # Pinned point release: written once per SEED_VERSION, then immutable.
    # seed-freeze.yml enforces this from the git-diff side on shipped PRs;
    # this is the same rule enforced locally at bake time.
    pinned_path = os.path.join(SEED_ASSET_DIR, f"seed@{SEED_VERSION}.js")
    failed = False
    if os.path.exists(pinned_path):
        existing = read(pinned_path)
        if existing != out:
            print(
                f"[bake_seed] FAIL {os.path.normpath(pinned_path)} already exists with "
                "DIFFERENT content — pinned releases are immutable. Bump SEED_VERSION "
                "for a new release instead of editing this one (seed.md §3.1)."
            )
            failed = True
        else:
            print(f"[bake_seed] OK {os.path.normpath(pinned_path)} unchanged (immutable)")
    else:
        with open(pinned_path, "w", encoding="utf-8") as f:
            f.write(out)
        digest = sha384_b64(out_bytes)
        rel_path = "assets/seed/" + os.path.basename(pinned_path)
        print(f"[bake_seed] wrote NEW pinned release {os.path.normpath(pinned_path)}")
        append_release_ledger(SEED_VERSION, rel_path, len(out_bytes), digest)

    raw_bytes = len(out_bytes)
    gz_bytes = len(gzip.compress(out_bytes, compresslevel=9))

    print(f"[bake_seed] raw={raw_bytes}B (hard<= {RAW_HARD_BYTES}, warn<= {RAW_WARN_BYTES})")
    print(f"[bake_seed] gzip={gz_bytes}B (hard<= {GZ_HARD_BYTES})")

    check_fork_drift()

    if not verify_ledger():
        failed = True

    if raw_bytes > RAW_HARD_BYTES:
        print(f"[bake_seed] FAIL raw size {raw_bytes} exceeds hard budget {RAW_HARD_BYTES}")
        failed = True
    elif raw_bytes > RAW_WARN_BYTES:
        print(f"[bake_seed] WARN raw size {raw_bytes} exceeds warn budget {RAW_WARN_BYTES}")
    if gz_bytes > GZ_HARD_BYTES:
        print(f"[bake_seed] FAIL gzip size {gz_bytes} exceeds hard budget {GZ_HARD_BYTES}")
        failed = True

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
