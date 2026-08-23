#!/usr/bin/env bash
# Shader Garden — cheap structural checks that run BEFORE the expensive
# real-GPU gate (scripts/gpu-gate.sh) and again in CI.
#
# These are the checks that answer "is this safe to make public, and will the
# CI jobs it depends on actually run?" — questions no test suite asks, because
# they are about the repository rather than about the rendered pixels.
# Seconds to run, so the pre-push hook does them first and fails fast.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root" || exit 1
fails=0
note() { echo "preflight: FAIL — $*" >&2; fails=$((fails + 1)); }

# --- 1. public-repo hygiene -------------------------------------------------
# This repo is public. Everything below is about content that is harmless on
# this box and wrong once it is on github.com.

# Local absolute paths leak the developer's directory layout and username into
# a public tree, and they are also just broken for anyone who clones. Matched
# for ANY user, not just this box's — a contributor's path is no better.
#
# The needle is assembled at runtime on purpose: written as a literal, this
# line would itself be a tracked file containing the pattern, and the check
# would flag its own source. Excluding this file instead would be worse — it
# is a shell script full of paths and exactly where such a leak would hide.
home_needle="/ho""me/[a-z_][a-z0-9_-]*/"
if git grep -lIE -e "$home_needle" -- . >/dev/null 2>&1; then
  note "tracked files contain a local absolute home path:"
  git grep -lIE -e "$home_needle" -- . >&2
fi

# Agent worktrees live at .claude/worktrees/ INSIDE this working tree. They
# hold in-flight branches and session state and must never be committed.
if git ls-files --error-unmatch .claude >/dev/null 2>&1; then
  note ".claude/ is tracked — agent worktrees and session state must stay untracked"
fi

# Credential-shaped filenames. A value-level scan is deliberately NOT done
# here: printing a candidate secret to stdout to prove it exists is itself the
# leak. Names only, and the names never contain the value.
if git ls-files | grep -Ei '(^|/)\.env($|\.)|\.pem$|\.p12$|_rsa$|(^|/)id_(rsa|ed25519)$|credentials?\.json$' >&2; then
  note "credential-shaped file is tracked (listed above)"
fi

# --- 2. the CI jobs themselves ----------------------------------------------
# A workflow that does not parse does not run, and GitHub reports that as a
# vague failure long after the push. Catch it here instead.
# PyYAML is present on this box and on ubuntu-latest, but a missing parser must
# not masquerade as a broken workflow — say so and move on instead.
if python3 -c 'import yaml' 2>/dev/null; then
  for wf in .github/workflows/*.yml; do
    python3 -c "import sys,yaml; yaml.safe_load(open(sys.argv[1]))" "$wf" 2>/dev/null \
      || note "$wf is not valid YAML"
  done
  # Every step that shells out to a harness binary must say WHERE. npm/npx
  # resolve from the node_modules of the current directory, and the only
  # node_modules in this repo is tools/test/. A step that forgets
  # working-directory runs at the repo root, where npx finds nothing and either
  # cancels (--no-install) or silently fetches a different version from the
  # network. This is invisible locally — tools/test/node_modules always exists
  # on a dev box — so CI is the only place it can be caught, and it cost a full
  # day of red builds on 2026-08-22 before anyone read past "npm error".
  python3 - <<'PY' || note "a workflow step runs npm/npx without working-directory"
import glob, sys, yaml
bad = []
for path in sorted(glob.glob(".github/workflows/*.yml")):
    try:
        doc = yaml.safe_load(open(path)) or {}
    except Exception:
        continue  # the parse check above already reported this
    for job_name, job in (doc.get("jobs") or {}).items():
        job_wd = ((job or {}).get("defaults") or {}).get("run", {}).get("working-directory")
        for step in (job or {}).get("steps") or []:
            run = (step or {}).get("run")
            if not run or not isinstance(run, str):
                continue
            if not any(w in run.split() for w in ("npm", "npx")):
                continue
            if step.get("working-directory") or job_wd:
                continue
            bad.append(f"{path}: job {job_name}: step {step.get('name', '<unnamed>')!r}")
if bad:
    print("steps running npm/npx with no working-directory:", file=sys.stderr)
    for b in bad:
        print("  " + b, file=sys.stderr)
    sys.exit(1)
PY
else
  echo "preflight: note — PyYAML unavailable, workflow YAML parse skipped." >&2
fi
python3 -c "import json; json.load(open('tools/test/package.json'))" 2>/dev/null \
  || note "tools/test/package.json is not valid JSON"

# Orphan-suite check. A .mjs suite that no gate and no CI step runs is worse
# than no suite: it looks like coverage in the tree and proves nothing. Every
# suite must be reachable from test.yml (CI) or gpu-gate.sh (local), and
# anything deliberately excluded is named here with its reason.
#   browser  — the shared harness module, not a suite
#   shots    — a screenshot generator; it asserts nothing
# The glob below is deliberately NON-recursive: tools/test/manual/ holds
# operator-driven tools (a playthrough driver, a frame profiler) that assert
# nothing and are never gated. Putting them in a subdirectory exempts them
# structurally, so this list does not have to grow a name per tool and then
# rot when one is renamed.
excluded='^(browser|shots)$'
for f in tools/test/*.mjs; do
  n="$(basename "$f" .mjs)"
  echo "$n" | grep -Eq "$excluded" && continue
  grep -q "node $n\.mjs" .github/workflows/test.yml && continue
  grep -Eq "(^|[[:space:]])$n([[:space:]]|$)" scripts/gpu-gate.sh && continue
  note "tools/test/$n.mjs is run by neither test.yml nor gpu-gate.sh (orphan suite)"
done

# Every suite the local gate names must exist, or the gate silently shrinks.
for n in $(sed -n '/^SUITES=(/,/^)/p' scripts/gpu-gate.sh | grep -v '^SUITES=(\|^)'); do
  [ -f "tools/test/$n.mjs" ] || note "gpu-gate.sh lists a suite with no file: $n.mjs"
done

# --- 3. budgets -------------------------------------------------------------
if ! python3 tools/check_budgets.py >/dev/null 2>&1; then
  python3 tools/check_budgets.py 2>&1 | grep -E '^FAIL' >&2
  note "size budgets are red"
fi

if [ "$fails" -ne 0 ]; then
  echo "preflight: $fails check(s) failed." >&2
  exit 1
fi
echo "preflight: ok (hygiene, workflow config, suite coverage, budgets)."
