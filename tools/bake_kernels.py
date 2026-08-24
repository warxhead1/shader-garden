#!/usr/bin/env python3
"""
bake_kernels.py — bake site/assets/kernels.json for Shader Garden.

Sources:
  1. Shader vault API  (GET http://127.0.0.1:9104/api/portal/vault/shaders)
     Curated: best-per-run gyroids (max 3 overall), best scherk per run (max 2),
     the phase/latent/sph/rolling_hills/sdf FunSearch picks, torus-knot fast48
     reference, gyroid + cloud references, and the handmade Milk Crate.
  2. FunSearch-evolved terrain demo GLSL (shadertoy_evolved.glsl), split into
     5 standalone single-biome kernels + 1 combined Allen-Cahn ice demo.

Every kernel is normalized to user-level code (no #version / precision /
iResolution-family uniform declarations / void main()) and validated by
wrapping it EXACTLY as the ARCHITECTURE.md GLSL wrapper and running
glslangValidator. Kernels that fail validation are dropped (with the log
printed). stdlib + urllib only; no third-party deps.

The default sources are the author's local evolution archive: the vault URL
(http://127.0.0.1:9104) and the shadertoy_evolved.glsl path are where the
author's FunSearch runs land. Anyone else points SG_VAULT_URL / SG_EVOLVED_GLSL
at their own sources. Either way, the baked kernels.json checked into the repo
is the canonical output.

Usage:  python3 tools/bake_kernels.py [--perf tools/test/out/perf.json]
        --perf merges tools/test/perf.mjs's timings into each kernel's "cost"
        field (avg_ms rounded, "heavy" when perf.mjs flagged it) by id;
        kernels absent from the perf run ship with no "cost" field.
Env:    SG_VAULT_URL, SG_EVOLVED_GLSL override the source locations.

SUB-6 (v2 blueprint work item 19): every kernel also carries a `lineage`
block (parents / oracle / eval_run_id / preadmit / gen_diff) built ONLY from
data this script already fetches — the vault API's raw generation history
and each kernel's own fitness/run_id. Facts the vault has no field for at
all (oracle id, admission verdict) are always emitted as `null` rather than
guessed; see ARCHITECTURE.md's "kernels.json lineage" section for the full
field-by-field provenance of what's real vs. genuinely absent.
"""

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "..", "site", "assets", "kernels.json")
SEED_DIR = os.path.join(HERE, "..", "site", "assets", "seed")

VAULT_URL = os.environ.get(
    "SG_VAULT_URL", "http://127.0.0.1:9104/api/portal/vault/shaders"
)
EVOLVED_GLSL = os.environ.get(
    "SG_EVOLVED_GLSL",
    os.path.expanduser("~/projects/nervous-bus/tools/shadertoy_evolved.glsl"),
)
GLSLANG = os.environ.get("SG_GLSLANG", "glslangValidator")

# ---------------------------------------------------------------------------
# ARCHITECTURE.md GLSL wrapper (must match the runtime EXACTLY)
# ---------------------------------------------------------------------------
WRAPPER_HEAD = """#version 300 es
precision highp float;
precision highp int;
uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int   iFrame;
uniform vec4  iMouse;
out vec4 sg_fragColor;
"""
WRAPPER_TAIL = """
void main() { vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy); sg_fragColor = vec4(c.rgb, 1.0); }
"""


# ---------------------------------------------------------------------------
# Normalization: baked "glsl" must contain ONLY user-level code
# ---------------------------------------------------------------------------
_RE_VERSION = re.compile(r"^[ \t]*#version[^\n]*\n?", re.M)
_RE_PRECISION = re.compile(r"^[ \t]*precision\s+(?:lowp|mediump|highp)\s+\w+\s*;[^\n]*\n?", re.M)
_RE_UNIFORM = re.compile(
    r"^[ \t]*uniform\s+\w+\s+(?:iResolution|iTime|iTimeDelta|iFrame|iMouse)\s*;[^\n]*\n?",
    re.M,
)
_RE_MAIN = re.compile(r"void\s+main\s*\(\s*(?:void)?\s*\)\s*\{")


def _strip_main(src: str) -> str:
    """Remove any existing void main() definition (brace-matched)."""
    m = _RE_MAIN.search(src)
    if not m:
        return src
    depth = 1
    i = m.end()
    while i < len(src) and depth > 0:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
        i += 1
    return src[: m.start()] + src[i:]


def _brace_balance(src: str) -> int:
    return src.count("{") - src.count("}")


def normalize_glsl(src: str) -> str:
    src = src.replace("\r\n", "\n")
    src = _RE_VERSION.sub("", src)
    src = _RE_PRECISION.sub("", src)
    src = _RE_UNIFORM.sub("", src)
    src = _strip_main(src)
    # Some vault entries carry Python str.format artifacts ({{ / }}).
    # Collapse them only when the result stays brace-balanced.
    if "{{" in src or "}}" in src:
        candidate = src.replace("{{", "{").replace("}}", "}")
        if _brace_balance(candidate) == _brace_balance(src):
            src = candidate
    src = re.sub(r"\n{3,}", "\n\n", src)
    return src.strip() + "\n"


# ---------------------------------------------------------------------------
# Validation gate
# ---------------------------------------------------------------------------
def validate_glsl(user_src: str):
    """Wrap exactly like the runtime and compile with glslangValidator."""
    full = WRAPPER_HEAD + user_src + WRAPPER_TAIL
    with tempfile.NamedTemporaryFile(
        "w", suffix=".frag", delete=False, encoding="utf-8"
    ) as f:
        f.write(full)
        path = f.name
    try:
        proc = subprocess.run(
            [GLSLANG, path], capture_output=True, text=True, timeout=30
        )
        log = (proc.stdout + proc.stderr).strip()
        return proc.returncode == 0, log
    finally:
        os.unlink(path)


# ---------------------------------------------------------------------------
# Source 1: vault API
# ---------------------------------------------------------------------------
_RE_T_EVOLVED = re.compile(
    r"\[([a-z_]+)\]\s+fitness=([\d.]+)\s+gen=(\d+)\s+run=(\S+)"
)
_RE_T_FUNSEARCH = re.compile(
    r"\[([a-z_]+)\]\s+gen(\d+)\s+—\s+FunSearch fit=([\d.]+)"
)
_RE_T_REFERENCE = re.compile(r"\[([a-z_]+)\]\s+reference\s+—\s+(.+)")

FAMILY_DOMAIN = {
    "gyroid": "sdf",
    "scherk_first": "sdf",
    "torus_knot": "sdf",
    "cloud": "sdf",
    "sdf": "sdf",
    "phase": "phase",
    "latent": "latent",
    "sph": "sph",
    "rolling_hills": "terrain",
}

FAMILY_PRETTY = {
    "gyroid": "Gyroid",
    "scherk_first": "Scherk Surface",
    "sdf": "Torus Knot SDF",
    "phase": "Allen-Cahn Phase Map",
    "latent": "Latent-Heat Phase Map",
    "sph": "SPH Kernel Curve",
    "rolling_hills": "Rolling Hills",
}

FAMILY_DESC = {
    "gyroid": "FunSearch-evolved twisted gyroid SDF, raymarched with orbit camera.",
    "scherk_first": "FunSearch-evolved Scherk minimal-surface SDF, raymarched.",
    "phase": "FunSearch-evolved Allen-Cahn reaction term mapped over (phi, temp) space.",
    "latent": "FunSearch-evolved latent-heat Allen-Cahn kernel with oscillating curvature term.",
    "sph": "FunSearch-evolved SPH smoothing kernel W(r,h) plotted with compact-support cutoff.",
    "rolling_hills": "FunSearch-evolved rolling-hills heightfield, quintic FBM with shear.",
    "sdf": "FunSearch-evolved arc-length-aware torus-knot SDF (600-sample two-pass).",
}


def parse_vault_title(title: str):
    """Return dict(family, fitness, generation, run_id, kind) or None."""
    m = _RE_T_EVOLVED.match(title)
    if m:
        return {
            "family": m.group(1),
            "fitness": float(m.group(2)),
            "generation": int(m.group(3)),
            "run_id": m.group(4),
            "kind": "evolved",
        }
    m = _RE_T_FUNSEARCH.match(title)
    if m:
        return {
            "family": m.group(1),
            "fitness": float(m.group(3)),
            "generation": int(m.group(2)),
            "run_id": None,
            "kind": "evolved",
        }
    m = _RE_T_REFERENCE.match(title)
    if m:
        return {
            "family": m.group(1),
            "fitness": None,
            "generation": None,
            "run_id": None,
            "kind": "reference",
            "note": m.group(2).strip(),
        }
    return None


def vault_kernel_id(shader_id: str) -> str:
    return "vault-" + shader_id[-8:]


def fetch_vault():
    req = urllib.request.Request(VAULT_URL, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["shaders"]


# ---------------------------------------------------------------------------
# SUB-6: lineage (parents / oracle / eval_run_id / preadmit / gen_diff)
#
# Built entirely from data this script already has in hand — the raw vault
# fetch (fetch_vault()) and each kernel's own fitness/generation/run_id.
# No new source, no fabricated genealogy: a "parent" is only ever a real
# earlier-generation vault snapshot of the SAME family+run; a field the
# vault has no equivalent for at all (oracle id, admission verdict) is
# always `null`, never guessed. See ARCHITECTURE.md's "kernels.json
# lineage" section for the full rationale.
# ---------------------------------------------------------------------------
LINEAGE_FITNESS_EPS = 5e-4  # biome<->vault fitness cross-reference tolerance


def _empty_lineage(run_id=None):
    return {"parents": [], "oracle": None, "eval_run_id": run_id, "preadmit": None, "gen_diff": None}


def _index_evolved_by_family_run(shaders):
    """(family, run_id) -> [{generation, fitness, shader_id, code}, ...] asc.

    Indexes EVERY generation the vault ever stored for a family+run — not
    just the ones curate_vault() ultimately promotes into kernels.json.
    curate_vault()'s best-per-run/top-N rules collapse most runs to a single
    survivor; the collapsed siblings are still real ancestors for gen_diff
    and `parents` purposes, so this index is built once, up front, from the
    unfiltered vault response.
    """
    idx = {}
    for s in shaders:
        meta = parse_vault_title(s.get("title", ""))
        if not meta or meta.get("kind") != "evolved":
            continue
        key = (meta["family"], meta.get("run_id"))
        idx.setdefault(key, []).append(
            {
                "generation": meta["generation"],
                "fitness": meta["fitness"],
                "shader_id": s.get("shader_id") or s["id"],
                "code": s.get("code", ""),
            }
        )
    for entries in idx.values():
        entries.sort(key=lambda e: e["generation"])
    return idx


def _code_diff_stats(parent_code: str, current_code: str) -> dict:
    """Line-level diff between two raw (unnormalized) vault code blobs."""
    a = parent_code.splitlines()
    b = current_code.splitlines()
    sm = difflib.SequenceMatcher(None, a, b)
    added = removed = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return {"lines_added": added, "lines_removed": removed, "similarity": round(sm.ratio(), 3)}


def _build_lineage(family, run_id, generation, fitness, code, self_shader_id, idx):
    """Lineage for a kernel baked straight from a vault entry (evolved or
    reference). `generation is None` (references, and the handmade kernel)
    short-circuits to the empty block — references have no evolutionary
    history to report."""
    lineage = _empty_lineage(run_id)
    if generation is None:
        return lineage
    entries = idx.get((family, run_id), [])
    earlier = [e for e in entries if e["shader_id"] != self_shader_id and e["generation"] < generation]
    if not earlier:
        return lineage
    parent = max(earlier, key=lambda e: e["generation"])
    lineage["parents"] = [vault_kernel_id(parent["shader_id"])]
    fitness_delta = None
    if fitness is not None and parent["fitness"] is not None:
        fitness_delta = round(fitness - parent["fitness"], 4)
    lineage["gen_diff"] = {
        "prev_generation": parent["generation"],
        "fitness_delta": fitness_delta,
        **_code_diff_stats(parent["code"], code),
    }
    return lineage


def _match_vault_by_fitness(family, fitness, idx):
    """Find the vault's own record for a `family`, by fitness match, across
    ANY run — used to backfill generation/run_id/eval_run_id onto kernels
    baked from the static shadertoy_evolved.glsl file (which carries no
    run/generation metadata of its own). Family name AND a tight fitness
    tolerance both have to agree before this cross-references two entries —
    fitness alone would risk a false-positive collision across unrelated
    families."""
    best = None
    if fitness is None:
        return None
    for (fam, run), entries in idx.items():
        if fam != family:
            continue
        for e in entries:
            if e["fitness"] is not None and abs(e["fitness"] - fitness) <= LINEAGE_FITNESS_EPS:
                if best is None or e["generation"] > best["generation"]:
                    best = dict(e, run_id=run)
    return best


def curate_vault(shaders, evolved_idx):
    """Apply the curation rules; return a list of kernel dicts (unvalidated).

    `evolved_idx` is `_index_evolved_by_family_run(shaders)` — passed in
    (rather than recomputed here) so main() can build it once from the
    unfiltered vault response and reuse it for the biome backfill too.
    """
    kernels = []
    gyroid_evolved = []
    scherk_evolved = []

    for s in shaders:
        lang = s.get("language", "glsl")
        if lang != "glsl":  # excludes glsl-multipass per contract
            print(f"  skip (language={lang}): {s['title']}")
            continue
        title = s["title"]
        sid = s.get("shader_id") or s["id"]
        meta = parse_vault_title(title)

        # Handmade showcase
        if title == "Record-Store Milk Crate":
            kernels.append(
                {
                    "id": vault_kernel_id(sid),
                    "title": "Record-Store Milk Crate",
                    "description": "Handmade SDF raymarch of a record-store milk crate — drag to orbit.",
                    "domain": "demo",
                    "fitness": None,
                    "generation": None,
                    "run_id": None,
                    "author": s.get("author", "warxhead"),
                    "origin": "handmade",
                    "language": "glsl",
                    "glsl": normalize_glsl(s["code"]),
                    "tags": ["handmade", "sdf", "raymarch"],
                    "featured": True,
                    "lineage": _empty_lineage(),  # handmade — no evolutionary history to report
                }
            )
            continue

        if meta is None:
            print(f"  skip (unrecognized title): {title}")
            continue

        fam = meta["family"]

        if meta["kind"] == "evolved":
            if fam == "gyroid":
                gyroid_evolved.append((s, meta))
                continue
            if fam == "scherk_first":
                scherk_evolved.append((s, meta))
                continue
            # Singleton FunSearch picks: phase, latent, sph, rolling_hills, sdf
            if fam in ("phase", "latent", "sph", "rolling_hills", "sdf"):
                kernels.append(_vault_evolved_kernel(s, meta, evolved_idx))
                continue
            print(f"  skip (uncurated evolved family {fam}): {title}")
            continue

        # References
        if fam == "torus_knot":
            if "fast48" not in meta.get("note", ""):
                print(f"  skip (torus_knot collapsed to fast48): {title}")
                continue
            kernels.append(_vault_reference_kernel(s, meta, "Torus Knot — reference (fast48)",
                                                   "Exact parametric (2,3) torus-knot distance, 48-sample fast variant."))
            continue
        if fam == "gyroid":
            kernels.append(_vault_reference_kernel(s, meta, "Gyroid — reference",
                                                   "Eikonal-valid gyroid SDF reference oracle."))
            continue
        if fam == "cloud":
            kernels.append(_vault_reference_kernel(s, meta, "Cloud Blobs — reference",
                                                   "Min-union sphere blobs reference oracle."))
            continue
        print(f"  skip (uncurated reference family {fam}): {title}")

    # Gyroid: highest fitness per run, then top 3 overall
    best_per_run = {}
    for s, meta in gyroid_evolved:
        run = meta["run_id"]
        if run not in best_per_run or meta["fitness"] > best_per_run[run][1]["fitness"]:
            best_per_run[run] = (s, meta)
    top3 = sorted(best_per_run.values(), key=lambda x: -x[1]["fitness"])[:3]
    for s, meta in top3:
        kernels.append(_vault_evolved_kernel(s, meta, evolved_idx))
    dropped = len(gyroid_evolved) - len(top3)
    if dropped:
        print(f"  gyroid curation: kept {len(top3)} of {len(gyroid_evolved)} evolved entries")

    # Scherk: best per run, max 2
    best_per_run = {}
    for s, meta in scherk_evolved:
        run = meta["run_id"]
        if run not in best_per_run or meta["fitness"] > best_per_run[run][1]["fitness"]:
            best_per_run[run] = (s, meta)
    top2 = sorted(best_per_run.values(), key=lambda x: -x[1]["fitness"])[:2]
    for s, meta in top2:
        kernels.append(_vault_evolved_kernel(s, meta, evolved_idx))
    dropped = len(scherk_evolved) - len(top2)
    if dropped:
        print(f"  scherk curation: kept {len(top2)} of {len(scherk_evolved)} evolved entries")

    return kernels


def _vault_evolved_kernel(s, meta, evolved_idx):
    fam = meta["family"]
    sid = s.get("shader_id") or s["id"]
    return {
        "id": vault_kernel_id(sid),
        "title": f"{FAMILY_PRETTY[fam]} — evolved gen {meta['generation']}",
        "description": FAMILY_DESC[fam],
        "domain": FAMILY_DOMAIN[fam],
        "fitness": meta["fitness"],
        "generation": meta["generation"],
        "run_id": meta["run_id"],
        "author": "funsearch-autobench",
        "origin": "vault",
        "language": "glsl",
        "glsl": normalize_glsl(s["code"]),
        "tags": ["evolved", fam.replace("_", "-")],
        "featured": False,
        "lineage": _build_lineage(fam, meta["run_id"], meta["generation"], meta["fitness"], s.get("code", ""), sid, evolved_idx),
    }


def _vault_reference_kernel(s, meta, title, desc):
    fam = meta["family"]
    sid = s.get("shader_id") or s["id"]
    return {
        "id": vault_kernel_id(sid),
        "title": title,
        "description": desc,
        "domain": FAMILY_DOMAIN[fam],
        "fitness": None,
        "generation": None,
        "run_id": None,
        "author": s.get("author", "warxhead"),
        "origin": "vault",
        "language": "glsl",
        "glsl": normalize_glsl(s["code"]),
        "tags": ["reference", fam.replace("_", "-")],
        "featured": False,
        "lineage": _empty_lineage(),  # a fixed reference oracle, not an evolutionary run
    }


# ---------------------------------------------------------------------------
# Source 2: shadertoy_evolved.glsl → 5 single-biome kernels + combined demo
# ---------------------------------------------------------------------------
_DASH = re.compile(r"^// -{20,}$")


def parse_sections(text: str):
    """Split shadertoy_evolved.glsl into sections keyed by header title."""
    lines = text.split("\n")
    sections = {}
    i, n = 0, len(lines)
    while i < n:
        if _DASH.match(lines[i]) and i + 1 < n and lines[i + 1].startswith("// "):
            title = lines[i + 1][3:].strip()
            j = i + 2
            while j < n and lines[j].startswith("//"):
                j += 1  # description comment lines + closing dashed rule
            start = j
            while j < n and not _DASH.match(lines[j]):
                j += 1
            body = "\n".join(lines[start:j]).strip()
            if body:
                sections[title] = body
            i = j
        else:
            i += 1
    return sections


def get_section(sections, prefix):
    for title, body in sections.items():
        if title.startswith(prefix):
            return body
    raise KeyError(f"section starting with {prefix!r} not found in evolved GLSL")


LAVA_BLOCK = """
    // Lava at low elevation
    float lava = smoothstep(100.0, 60.0, height);
    vec3 lava_col = mix(vec3(0.9, 0.4, 0.0), vec3(1.0, 0.8, 0.0),
                        0.5 + 0.5 * sin(time * 1.2 + xz.x * 0.01 + xz.y * 0.01));
    col = mix(col, lava_col, lava * 0.8);
"""

# Per-biome base-color branch bodies (lifted from biome_base_color in the
# source file, hardwired per kernel).
BIOMES = [
    {
        "id": "biome-mountain-peaks",
        "section": "Biome 0",
        "fn": "biome_mountain",
        "family": "mountain_peaks",  # SUB-6: vault has no matching family — see ARCHITECTURE.md
        "fitness": 0.9998,
        "title": "Mountain Peaks — evolved biome",
        "description": "FunSearch-evolved 9-octave ridged Perlin with domain warp, flown over as a raymarched heightfield.",
        "lava": False,
        "color": """    // Mountain: grey granite + dark ridge
    vec3 col = mix(vec3(0.45, 0.40, 0.35), vec3(0.65, 0.60, 0.55), height_01);
    col = mix(col, vec3(0.30, 0.28, 0.25), smoothstep(0.3, 0.8, slope));
    return col;""",
    },
    {
        "id": "biome-volcanic-plateau",
        "section": "Biome 1",
        "fn": "biome_volcanic",
        "family": "volcanic_plateau",  # SUB-6: vault has no matching family — see ARCHITECTURE.md
        "fitness": 0.9876,
        "title": "Volcanic Plateau — evolved biome",
        "description": "FunSearch-evolved ridged FBM with rotated octaves and warp; lava pools glow at low elevation.",
        "lava": True,
        "color": """    // Volcanic: dark basalt, orange lava low
    vec3 col = mix(vec3(0.80, 0.35, 0.10), vec3(0.18, 0.15, 0.14), height_01);
    col = mix(col, vec3(0.12, 0.10, 0.09), smoothstep(0.4, 0.9, slope));
    return col;""",
    },
    {
        "id": "biome-eroded-badlands",
        "section": "Biome 2",
        "fn": "biome_badlands",
        "family": "eroded_badlands",  # SUB-6: vault has no matching family — see ARCHITECTURE.md
        "fitness": 0.9807,
        "title": "Eroded Badlands — evolved biome",
        "description": "FunSearch-evolved domain-warped turbulence with ochre sediment banding.",
        "lava": False,
        "color": """    // Badlands: ochre/tan banding
    float band = fract(height_01 * 8.0);
    vec3 col = mix(vec3(0.78, 0.52, 0.28), vec3(0.62, 0.40, 0.22), band);
    col = mix(col, vec3(0.55, 0.45, 0.35), smoothstep(0.5, 0.9, slope));
    return col;""",
    },
    {
        "id": "biome-river-valley",
        "section": "Biome 3",
        "fn": "biome_valley",
        "family": "river_valley",  # SUB-6: vault has no matching family — see ARCHITECTURE.md
        "fitness": 0.9997,
        "title": "River Valley — evolved biome",
        "description": "FunSearch-evolved 6-octave offset FBM carving green meadows and river channels.",
        "lava": False,
        "color": """    // Valley: green meadow + river blue low
    vec3 col = mix(vec3(0.12, 0.38, 0.18), vec3(0.30, 0.55, 0.22), height_01);
    col = mix(col, vec3(0.22, 0.50, 0.42), smoothstep(0.9, 1.0, 1.0 - height_01));
    return col;""",
    },
    {
        "id": "biome-rolling-hills",
        "section": "Biome 4",
        "fn": "biome_hills",
        "family": "rolling_hills",  # SUB-6: matches the vault's own [rolling_hills] entry
        "fitness": 0.9994,
        "title": "Rolling Hills — evolved biome",
        "description": "FunSearch-evolved quintic FBM with shear producing soft grassy hills.",
        "lava": False,
        "color": """    // Hills: grass + dark soil on slopes
    vec3 col = mix(vec3(0.45, 0.62, 0.22), vec3(0.28, 0.42, 0.18), height_01);
    col = mix(col, vec3(0.30, 0.24, 0.18), smoothstep(0.4, 0.7, slope));
    return col;""",
    },
]


def build_biome_kernel(biome, sections, evolved_idx):
    biome_code = get_section(sections, biome["section"])
    phase_code = get_section(sections, "Allen-Cahn phase kernel")
    normal_code = get_section(sections, "Normal")
    march_code = get_section(sections, "Heightfield raymarcher")
    lighting_code = get_section(sections, "Lighting")
    main_code = get_section(sections, "Main entry point")

    lava = LAVA_BLOCK if biome["lava"] else ""
    glsl = f"""// {biome['title']}  (FunSearch fitness={biome['fitness']})
// Single-biome extraction of the evolved 5-biome terrain demo.
// iMouse: click upper half to freeze time / scrub the camera.

{biome_code}

{phase_code}

const float INV_SCALE  = 1.0 / 512.0;
const float HEIGHT_MIN = 40.0;
const float HEIGHT_MAX = 420.0;
const float HEIGHT_RNG = HEIGHT_MAX - HEIGHT_MIN;

float terrain_height(vec2 xz) {{
    return HEIGHT_MIN + {biome['fn']}(xz * INV_SCALE) * HEIGHT_RNG;
}}

{normal_code}

{march_code}

vec3 biome_base_color(float height_01, float slope) {{
{biome['color']}
}}

vec3 material_color(vec2 xz, float height, vec3 N, float time) {{
    float height_01 = (height - HEIGHT_MIN) / HEIGHT_RNG;
    float slope     = 1.0 - clamp(N.y, 0.0, 1.0);

    vec3 col = biome_base_color(height_01, slope);

    // Water at low elevation
    float water = smoothstep(65.0, 55.0, height);
    col = mix(col, vec3(0.08, 0.20, 0.38), water);
{lava}
    // Snow + ice from the Allen-Cahn phase kernel
    float temp    = 0.4 + 0.3 * sin(time * 0.25);
    float phi     = clamp(0.5 + 5.0 * phase_reaction(0.5, temp), 0.0, 1.0);
    float ice_amt = phi * smoothstep(80.0, 160.0, height);
    float snow = smoothstep(320.0, 370.0, height) * smoothstep(0.55, 0.35, slope);
    vec3 snow_col = vec3(0.92, 0.94, 0.98);
    vec3 ice_col  = mix(vec3(0.70, 0.85, 0.95), snow_col, 0.4);
    col = mix(col, ice_col,  ice_amt * (1.0 - snow));
    col = mix(col, snow_col, snow);

    return col;
}}

{lighting_code}

{main_code}
"""
    generation, run_id, lineage = _biome_backfill(biome["family"], biome["fitness"], evolved_idx)
    return {
        "id": biome["id"],
        "title": biome["title"],
        "description": biome["description"],
        "domain": "terrain",
        "fitness": biome["fitness"],
        "generation": generation,
        "run_id": run_id,
        "author": "funsearch-autobench",
        "origin": "funsearch_evolved",
        "language": "glsl",
        "glsl": normalize_glsl(glsl),
        "tags": ["evolved", "terrain", "biome"],
        "featured": True,
        "lineage": lineage,
    }


def _biome_backfill(family, fitness, evolved_idx):
    """SUB-6: cross-reference a shadertoy_evolved.glsl kernel's hardcoded
    `fitness` against the vault fetch by family+fitness match to recover
    `generation`/`run_id` — the local static file carries neither. Returns
    (generation, run_id, lineage). Only backfills generation/run_id/
    eval_run_id: `parents`/`gen_diff` stay empty because the vault's raw
    code for that entry is a bare function snippet, not the same document
    shape as the assembled biome kernel — diffing the two would not be a
    meaningful comparison. When no family+fitness match exists at all (the
    vault genuinely never recorded this biome's evolution), everything
    stays null — reported explicitly in the bake log."""
    match = _match_vault_by_fitness(family, fitness, evolved_idx)
    if match is None:
        print(f"  lineage: no vault match for family={family!r} fitness={fitness} — generation/run_id stay null")
        return None, None, _empty_lineage()
    print(f"  lineage: backfilled family={family!r} fitness={fitness} -> generation={match['generation']} (vault run_id={match['run_id']!r})")
    return match["generation"], match["run_id"], _empty_lineage(match["run_id"])


def build_evolved_kernels(evolved_idx):
    with open(EVOLVED_GLSL, encoding="utf-8") as f:
        text = f.read()
    sections = parse_sections(text)

    kernels = [build_biome_kernel(b, sections, evolved_idx) for b in BIOMES]

    # Combined 5-biome + Allen-Cahn ice demo: the source file is already a
    # complete single-pass mainImage shader — bake it whole. Its fitness=1.0
    # is the SAME Allen-Cahn phase kernel evolution the vault's own [phase]
    # entry records (SUB-6 backfill applies here too).
    demo_generation, demo_run_id, demo_lineage = _biome_backfill("phase", 1.0, evolved_idx)
    kernels.append(
        {
            "id": "phase-allen-cahn-demo",
            "title": "Allen-Cahn Ice — 5-biome flight",
            "description": "Camera flight across all five evolved biomes with Allen-Cahn phase-kernel ice/snow dynamics (single-pass).",
            "domain": "phase",
            "fitness": 1.0,
            "generation": demo_generation,
            "run_id": demo_run_id,
            "author": "funsearch-autobench",
            "origin": "funsearch_evolved",
            "language": "glsl",
            "glsl": normalize_glsl(text),
            "tags": ["evolved", "phase", "terrain", "demo"],
            "featured": False,
            "lineage": demo_lineage,
        }
    )
    return kernels


# ---------------------------------------------------------------------------
# --perf: merge tools/test/perf.mjs timings into a "cost" field per kernel
# ---------------------------------------------------------------------------
def apply_perf(kernels, perf_path):
    with open(perf_path, encoding="utf-8") as f:
        perf = json.load(f)
    by_id = {r["id"]: r for r in perf["results"] if r.get("avg_ms") is not None}
    applied = 0
    for k in kernels:
        r = by_id.get(k["id"])
        if r is None:
            continue
        cost = {"avg_ms": round(r["avg_ms"])}
        if r.get("heavy"):
            cost["heavy"] = True
        k["cost"] = cost
        applied += 1
    print(f"[bake] --perf: applied cost to {applied}/{len(kernels)} kernels from {perf_path}")


# ---------------------------------------------------------------------------
# Seed assets: one site/assets/seed/<id>.json per admitted kernel (seed.md
# §5.1). Same gate as kernels.json — a kernel dropped by glslangValidator
# appears in neither artifact. Stale JSON for a kernel that's since been
# dropped/renamed is removed so the seed's fetch 404s honestly instead of
# serving retired source.
# ---------------------------------------------------------------------------
SEED_WARN_BYTES = 128 * 1024

def emit_seed_assets(validated, baked_ts):
    os.makedirs(SEED_DIR, exist_ok=True)
    keep = set()
    for k in validated:
        doc = {
            "v": 1,
            "id": k["id"],
            "title": k["title"],
            "language": k["language"],
            "glsl": k["glsl"],
            "author": k["author"],
            "origin": k["origin"],
            "admitted": {"gate": "glslangValidator", "baked": baked_ts},
        }
        path = os.path.join(SEED_DIR, k["id"] + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        keep.add(k["id"] + ".json")
        size = os.path.getsize(path)
        if size > SEED_WARN_BYTES:
            print(f"[bake] WARN seed asset {k['id']}.json is {size}B (warn > {SEED_WARN_BYTES}B)")

    removed = 0
    for name in os.listdir(SEED_DIR):
        if name.endswith(".json") and name not in keep:
            os.unlink(os.path.join(SEED_DIR, name))
            removed += 1
    print(f"[bake] wrote {len(keep)} seed assets -> {os.path.normpath(SEED_DIR)}" + (f" ({removed} stale removed)" if removed else ""))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--perf", metavar="PATH", help="tools/test/out/perf.json to merge cost fields from")
    args = parser.parse_args()

    print(f"[bake] fetching vault: {VAULT_URL}")
    shaders = fetch_vault()
    print(f"[bake] vault returned {len(shaders)} shaders")
    # SUB-6: indexed once from the UNFILTERED vault response, before
    # curate_vault()'s best-per-run/top-N rules drop most generations —
    # lineage/gen_diff and the biome fitness backfill both need the full
    # per-generation history, not just the survivors.
    evolved_idx = _index_evolved_by_family_run(shaders)
    vault_kernels = curate_vault(shaders, evolved_idx)
    print(f"[bake] curated {len(vault_kernels)} vault kernels")

    print(f"[bake] splitting evolved GLSL: {EVOLVED_GLSL}")
    evolved_kernels = build_evolved_kernels(evolved_idx)
    print(f"[bake] built {len(evolved_kernels)} kernels from shadertoy_evolved.glsl")

    candidates = evolved_kernels + vault_kernels

    # Uniqueness guard on deterministic ids
    seen = set()
    for k in candidates:
        if k["id"] in seen:
            print(f"[bake] FATAL: duplicate kernel id {k['id']}", file=sys.stderr)
            sys.exit(1)
        seen.add(k["id"])

    # Validation gate: every kernel must compile under the runtime wrapper
    validated = []
    for k in candidates:
        ok, log = validate_glsl(k["glsl"])
        if ok:
            validated.append(k)
        else:
            print(f"[bake] DROPPED {k['id']} ({k['title']}) — glslangValidator failed:")
            for line in log.splitlines():
                print(f"    {line}")

    # Deterministic ordering: featured first, then domain, then id
    validated.sort(key=lambda k: (not k["featured"], k["domain"], k["id"]))

    if args.perf:
        apply_perf(validated, args.perf)

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"generated": generated, "kernels": validated}
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"[bake] wrote {len(validated)} kernels -> {os.path.normpath(OUT_PATH)}")

    emit_seed_assets(validated, generated)

    print("\nFinal roster:")
    print(f"{'id':<24} {'domain':<8} {'fitness':<8} {'feat':<5} title")
    for k in validated:
        fit = f"{k['fitness']:.4f}" if k["fitness"] is not None else "-"
        print(f"{k['id']:<24} {k['domain']:<8} {fit:<8} {str(k['featured']):<5} {k['title']}")


if __name__ == "__main__":
    main()
