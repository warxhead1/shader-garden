#!/usr/bin/env python3
"""
bake_garden_attribution.py — bake site/assets/garden/attribution-commits.json.

The hand-curated provenance data (kind: evolved/handmade, sourceKernel, note)
lives in site/assets/garden/attribution.json and is checked in directly —
that's a curation decision, not derived data, so it isn't baked. The ONE
thing a browser genuinely cannot compute for itself is "when was this
component's `@component` line first introduced" — that's a git-log fact.
This script answers it once, at bake time, for every component parsed out
of scene.glsl, and writes a small static map:

  { "<componentId>": { "sha": "<full sha>", "date": "<committer ISO8601>" }, ... }

A component whose `@component <id>` marker was never present standalone in
any historical revision (shouldn't happen for anything currently in the
file, but a fresh component added in the same commit as this bake run and
not yet committed is a real edge case) is simply omitted — attribution.js
treats a missing entry as "no firstCommit fact available", never a fabricated
one.

Usage:  python3 tools/bake_garden_attribution.py
No network, no third-party deps — stdlib + git only.
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.join(HERE, "..")
SCENE_GLSL = os.path.join(REPO_ROOT, "site", "assets", "garden", "scene.glsl")
OUT_PATH = os.path.join(REPO_ROOT, "site", "assets", "garden", "attribution-commits.json")

COMPONENT_RE = re.compile(r'^//\s*@component\s+(\S+)\s+"')


def parse_component_ids(src):
    """Same grammar as parse.js's COMPONENT_RE — just the id, file order."""
    ids = []
    for line in src.splitlines():
        m = COMPONENT_RE.match(line)
        if m:
            ids.append(m.group(1))
    return ids


def first_commit_for(component_id, path):
    """Earliest commit (in this branch's history) whose diff introduces the
    literal `// @component <id> "` marker in `path` — git's -S pickaxe search,
    walked --reverse so the FIRST match (not the most recent) wins. Returns
    None if the marker has no history (shouldn't happen for anything
    parse_component_ids() found in the current file, since that means it's
    present in HEAD — but an uncommitted/staged-only addition would hit this,
    and that's the honest answer: no commit exists for it yet)."""
    marker = "// @component {} \"".format(component_id)
    try:
        out = subprocess.check_output(
            ["git", "log", "--follow", "--reverse", "--format=%H|%cI", "-S" + marker, "--", path],
            cwd=REPO_ROOT, text=True, stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        return None
    line = out.strip().splitlines()[:1]
    if not line:
        return None
    sha, date = line[0].split("|", 1)
    return {"sha": sha, "date": date}


def main():
    if not os.path.exists(SCENE_GLSL):
        print("[bake] {} not found".format(SCENE_GLSL), file=sys.stderr)
        sys.exit(1)
    with open(SCENE_GLSL, "r", encoding="utf-8") as f:
        component_ids = parse_component_ids(f.read())
    if not component_ids:
        print("[bake] WARNING: no @component lines found in {}".format(SCENE_GLSL), file=sys.stderr)

    out = {}
    for cid in component_ids:
        commit = first_commit_for(cid, SCENE_GLSL)
        if commit:
            out[cid] = commit
        else:
            print("[bake] no git history for @component {} — omitted (never fabricated)".format(cid))

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write("\n")
    print("[bake] wrote {} firstCommit entries -> {}".format(len(out), os.path.normpath(OUT_PATH)))


if __name__ == "__main__":
    main()
