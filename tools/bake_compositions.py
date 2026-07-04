#!/usr/bin/env python3
"""
bake_compositions.py — COMP-3: the evolved-compositions bridge
(v2 blueprint work item 26, https://.../V2_BLUEPRINT.md §7.3).

Consumes `kernel.composition.ready.v1`-shaped artifacts — the nervous-bus
composition oracle event; authoritative schema (READ ONLY from this repo):
  ~/projects/nervous-bus/schemas/kernel.composition.ready.v1.json
— and, for every artifact that validates AND reports `ready: true` AND whose
two run ids resolve against the current `site/assets/kernels.json`, bakes:

  1. `site/assets/compositions/<id>.json` — a COMP-1-shaped composition
     manifest (`id`/`title`/`description`/`domain`/`passes`, byte-identical
     shape to the hand-authored `hills-into-icefield` demo) PLUS an additive
     `provenance` block carrying the oracle's own fitness numbers, so the
     provenance panel shows REAL per-node fitness instead of recomputing one.
  2. `site/assets/compositions/index.json` updated — id appended, existing
     entries (e.g. `hills-into-icefield`) never dropped.
  3. A `channel-source` tag on the reaction-side kernel inside
     `site/assets/kernels.json` (idempotent — added once, never duplicated),
     marking it as usable as an iChannel-bound texture source: the gallery's
     "channel sources" filter and per-card badge both read this tag.

No live nervous-autobench run emits `kernel.composition.ready.v1` yet — that
event is a *nervous-autobench-side* bead (tracked separately; this repo may
not touch nervous-bus or nervous-autobench per the v2 worktree contract).
This script instead reads FIXTURE artifacts from `tools/fixtures/
composition_ready/*.json` — the exact shape a real bus consumer would
receive, minus the transport. See this repo's COMP-3 report for exactly what
nervous-autobench's emitter needs to produce for `--fixtures` to become
`nervous obs bus` / a redis-mirror tail in a future iteration.

RESOLUTION CONVENTION (this bridge's own design choice — NOT part of the
nervous-bus schema, which leaves `terrain_run_id`/`reaction_run_id` free-form
"identifier for the … run/result source"): this script requires
`data.terrain_run_id` and `data.reaction_run_id` to be exact `id` values from
`site/assets/kernels.json`. Real autobench-side runs have no visibility into
shader-garden's curated kernel ids today, so a real emitter almost certainly
CANNOT satisfy this directly — seeing that gap precisely is the point of
shipping the bridge against a fixture before the autobench bead is scoped;
see the report for the two resolution strategies weighed for that bead.

Schema validation is hand-rolled (mirrors kernel.composition.ready.v1.json's
required/const/additionalProperties constraints) rather than importing
`jsonschema` — stdlib only, same no-third-party-deps convention as
bake_kernels.py. A fixture that fails validation, isn't `ready`, or whose run
ids don't resolve is skipped and logged, never silently baked.

Usage:  python3 tools/bake_compositions.py [--fixtures DIR] [--dry-run]
        --fixtures overrides the default tools/fixtures/composition_ready/
        --dry-run  validates + resolves + prints what WOULD be baked, writes
                   nothing (used by tools/test/comp3.mjs to test the bridge's
                   validation/resolution logic without mutating checked-in
                   assets on every test run)
"""

import argparse
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FIXTURES = os.path.join(HERE, "fixtures", "composition_ready")
KERNELS_PATH = os.path.join(HERE, "..", "site", "assets", "kernels.json")
COMPOSITIONS_DIR = os.path.join(HERE, "..", "site", "assets", "compositions")
INDEX_PATH = os.path.join(COMPOSITIONS_DIR, "index.json")

# ---------------------------------------------------------------------------
# Hand-rolled kernel.composition.ready.v1 structural validation. Mirrors
# nervous-bus/schemas/kernel.composition.ready.v1.json field-for-field; kept
# in sync by hand since this repo does not depend on nervous-bus at runtime
# or in CI (see this repo's CLAUDE.md: nervous-bus schemas are READ ONLY
# reference, never a code dependency of shader-garden).
# ---------------------------------------------------------------------------
REQUIRED_TOP = ["specversion", "id", "source", "type", "datacontenttype", "time", "data"]
REQUIRED_DATA = ["terrain_fitness", "reaction_fitness", "composition_fitness", "gate_threshold", "ready"]
OPTIONAL_DATA = {"terrain_domain", "reaction_domain", "terrain_run_id", "reaction_run_id"}
ALLOWED_DATA_KEYS = set(REQUIRED_DATA) | OPTIONAL_DATA
_RE_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_event(doc):
    """Return (ok, errors) — errors is a list of human-readable prose."""
    errors = []
    if not isinstance(doc, dict):
        return False, ["document is not a JSON object"]

    for k in REQUIRED_TOP:
        if k not in doc:
            errors.append(f"missing required field {k!r}")

    if doc.get("specversion") != "1.0":
        errors.append(f'specversion must be "1.0", got {doc.get("specversion")!r}')
    if doc.get("source") != "/autobench/composition_oracle":
        errors.append(f'source must be "/autobench/composition_oracle", got {doc.get("source")!r}')
    if doc.get("type") != "kernel.composition.ready.v1":
        errors.append(f'type must be "kernel.composition.ready.v1", got {doc.get("type")!r}')
    if doc.get("datacontenttype") != "application/json":
        errors.append(f'datacontenttype must be "application/json", got {doc.get("datacontenttype")!r}')
    if "id" in doc and not isinstance(doc["id"], str):
        errors.append("id must be a string")
    if "time" in doc and (not isinstance(doc["time"], str) or not _RE_DATETIME.match(doc["time"])):
        errors.append(f'time must be an RFC3339 date-time string, got {doc.get("time")!r}')

    data = doc.get("data")
    if "data" in doc:
        if not isinstance(data, dict):
            errors.append("data must be an object")
        else:
            for k in REQUIRED_DATA:
                if k not in data:
                    errors.append(f"data missing required field {k!r}")
            for k in data:
                if k not in ALLOWED_DATA_KEYS:
                    errors.append(f"data has field {k!r} not allowed by schema (additionalProperties: false)")
            for k in ("terrain_fitness", "reaction_fitness", "gate_threshold"):
                if k in data and not _is_number(data[k]):
                    errors.append(f"data.{k} must be a number")
            if "composition_fitness" in data and data["composition_fitness"] is not None and not _is_number(data["composition_fitness"]):
                errors.append("data.composition_fitness must be a number or null")
            if "ready" in data and not isinstance(data["ready"], bool):
                errors.append("data.ready must be a boolean")
            for k in ("terrain_domain", "reaction_domain", "terrain_run_id", "reaction_run_id"):
                if k in data and not isinstance(data[k], str):
                    errors.append(f"data.{k} must be a string")

    return (len(errors) == 0, errors)


# ---------------------------------------------------------------------------
# Bake
# ---------------------------------------------------------------------------
def load_kernels():
    with open(KERNELS_PATH, encoding="utf-8") as f:
        doc = json.load(f)
    kernels = doc.get("kernels", [])
    return doc, {k["id"]: k for k in kernels}


def load_index():
    if not os.path.exists(INDEX_PATH):
        return {"compositions": []}
    with open(INDEX_PATH, encoding="utf-8") as f:
        return json.load(f)


def build_composition(event_id, x_id, data, terrain, reaction):
    """Compose a COMP-1-shaped manifest, extended with `provenance`."""
    comp_id = x_id or f"{reaction['id']}-into-{terrain['id']}"
    title = f"{reaction['title']} → {terrain['title']} (evolved composition)"
    description = (
        f"COMP-3 evolved composition, baked from a kernel.composition.ready.v1 "
        f"artifact ({event_id}). Pass 1 renders \"{reaction['title']}\" "
        f"(fitness {reaction.get('fitness')}) into an offscreen buffer as a "
        f"channel source; pass 2 renders \"{terrain['title']}\" "
        f"(fitness {terrain.get('fitness')}) to the screen with that buffer "
        f"bound as iChannel0. Composition oracle scored the pair "
        f"{data['composition_fitness']} against a {data['gate_threshold']} gate "
        f"(ready={'true' if data['ready'] else 'false'})."
    )
    return {
        "id": comp_id,
        "title": title,
        "description": description,
        "domain": "composite",
        "passes": [
            {"kernel": reaction["id"], "target": "bufferA"},
            {"kernel": terrain["id"], "target": "screen", "channels": ["bufferA"]},
        ],
        "provenance": {
            "oracle": "/autobench/composition_oracle",
            "event_id": event_id,
            "terrain_domain": data.get("terrain_domain"),
            "reaction_domain": data.get("reaction_domain"),
            "terrain_fitness": data["terrain_fitness"],
            "reaction_fitness": data["reaction_fitness"],
            "composition_fitness": data["composition_fitness"],
            "gate_threshold": data["gate_threshold"],
            "ready": data["ready"],
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fixtures", default=DEFAULT_FIXTURES, metavar="DIR",
                         help="directory of kernel.composition.ready.v1 fixture JSON files")
    parser.add_argument("--dry-run", action="store_true", help="validate + resolve only, write nothing")
    args = parser.parse_args()

    fixture_paths = sorted(glob.glob(os.path.join(args.fixtures, "*.json")))
    if not fixture_paths:
        print(f"[bake_compositions] no fixtures found under {args.fixtures} — nothing to do")
        return

    kernels_doc, kernels_by_id = load_kernels()
    baked = []
    channel_source_ids = set()

    for path in fixture_paths:
        name = os.path.basename(path)
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)

        ok, errors = validate_event(doc)
        if not ok:
            print(f"[bake_compositions] SKIP {name}: fails kernel.composition.ready.v1 validation:")
            for e in errors:
                print(f"    {e}")
            continue

        data = doc["data"]
        if not data.get("ready"):
            print(f"[bake_compositions] SKIP {name}: ready=false (composition_fitness "
                  f"{data.get('composition_fitness')} did not clear gate_threshold "
                  f"{data.get('gate_threshold')})")
            continue

        terrain_id = data.get("terrain_run_id")
        reaction_id = data.get("reaction_run_id")
        terrain = kernels_by_id.get(terrain_id)
        reaction = kernels_by_id.get(reaction_id)
        if terrain is None or reaction is None:
            missing = [x for x, k in ((terrain_id, terrain), (reaction_id, reaction)) if k is None]
            print(f"[bake_compositions] SKIP {name}: run id(s) {missing} do not resolve against "
                  f"the current kernels.json (RESOLUTION CONVENTION: terrain_run_id/reaction_run_id "
                  f"must equal a kernels.json kernel id — see this script's own header)")
            continue

        x_id = doc.get("x_shader_garden_composition_id")
        comp = build_composition(doc["id"], x_id, data, terrain, reaction)
        baked.append(comp)
        channel_source_ids.add(reaction["id"])
        print(f"[bake_compositions] {name} -> {comp['id']} "
              f"(terrain={terrain['id']} fit={terrain.get('fitness')}, "
              f"reaction={reaction['id']} fit={reaction.get('fitness')}, "
              f"composition_fitness={data['composition_fitness']})")

    if not baked:
        print("[bake_compositions] no composition-ready fixtures baked (all skipped — see above)")
        return

    if args.dry_run:
        print(f"[bake_compositions] --dry-run: would bake {len(baked)} composition(s), tag "
              f"{len(channel_source_ids)} kernel(s) channel-source — writing nothing")
        return

    os.makedirs(COMPOSITIONS_DIR, exist_ok=True)
    for comp in baked:
        out_path = os.path.join(COMPOSITIONS_DIR, comp["id"] + ".json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(comp, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"[bake_compositions] wrote {os.path.relpath(out_path, os.path.join(HERE, '..'))}")

    idx = load_index()
    existing = list(idx.get("compositions", []))
    for comp in baked:
        if comp["id"] not in existing:
            existing.append(comp["id"])
    idx["compositions"] = existing
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(idx, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"[bake_compositions] wrote {os.path.relpath(INDEX_PATH, os.path.join(HERE, '..'))} "
          f"({len(existing)} composition(s) listed)")

    changed = False
    for k in kernels_doc.get("kernels", []):
        if k["id"] in channel_source_ids:
            tags = k.setdefault("tags", [])
            if "channel-source" not in tags:
                tags.append("channel-source")
                changed = True
    if changed:
        with open(KERNELS_PATH, "w", encoding="utf-8") as f:
            json.dump(kernels_doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"[bake_compositions] tagged {sorted(channel_source_ids)} channel-source in kernels.json")
    else:
        print("[bake_compositions] channel-source tags already present — kernels.json unchanged")


if __name__ == "__main__":
    main()
