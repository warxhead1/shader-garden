#!/usr/bin/env python3
"""
tools/check_seed_freeze.py — the seed-freeze workflow's logic
(V2_BLUEPRINT.md item 16 / seed.md §3.1): a shipped, pinned
`seed@<major>.<minor>.<patch>.js` is an immutable repo artifact once merged
(GitHub Pages "immutable" is a repo policy, not a server feature). This
script fails if a diff modifies, deletes, or renames a pinned file that
already existed on the base ref. Floating files (`seed@<major>.js`,
`seed.js`) are expected to change every release and are exempt — only the
three-part semver pinned name is frozen.

Usage:
  python3 tools/check_seed_freeze.py --base origin/main --head HEAD
  python3 tools/check_seed_freeze.py --selftest   # logic unit test, no git
"""

import argparse
import re
import subprocess
import sys

PINNED_RE = re.compile(r"^site/assets/seed/seed@\d+\.\d+\.\d+\.js$")


def classify_diff(name_status_lines):
    """
    `name_status_lines`: iterable of `git diff --name-status` lines
    (`M\tpath`, `A\tpath`, `D\tpath`, or `R100\told\tnew`). Returns
    (status, path) violations: pinned files Modified, Deleted, or Renamed
    away from their pinned name. Newly Added pinned files are NOT
    violations — that's how a new release ships.
    """
    violations = []
    for line in name_status_lines:
        line = line.rstrip("\n")
        if not line:
            continue
        parts = line.split("\t")
        status = parts[0]
        code = status[0]
        if code == "R" and len(parts) == 3:
            old_path = parts[1]
            if PINNED_RE.match(old_path):
                violations.append((status, old_path))
        elif code in ("M", "D") and len(parts) == 2:
            path = parts[1]
            if PINNED_RE.match(path):
                violations.append((status, path))
    return violations


def git_diff(base, head):
    out = subprocess.run(
        ["git", "diff", "--name-status", base, head],
        capture_output=True, text=True, check=True,
    )
    return out.stdout.splitlines()


def run_selftest():
    cases = [
        (["A\tsite/assets/seed/seed@1.1.0.js"], False, "new pinned release is fine"),
        (["M\tsite/assets/seed/seed@1.0.0.js"], True, "editing a shipped pinned file must fail"),
        (["D\tsite/assets/seed/seed@1.0.0.js"], True, "deleting a shipped pinned file must fail"),
        (["M\tsite/assets/seed/seed@1.js"], False, "floating seed@1.js may change every release"),
        (["M\tsite/js/seed/element.js"], False, "source files are untouched by this check"),
        (
            ["R100\tsite/assets/seed/seed@1.0.0.js\tsite/assets/seed/seed@1.0.1.js"],
            True,
            "renaming a pinned file is a violation",
        ),
        (
            ["A\tsite/assets/seed/seed@1.1.0.js", "M\tsite/js/seed/element.js"],
            False,
            "an unrelated source edit alongside a new release is fine",
        ),
    ]
    ok = True
    for lines, want_violation, label in cases:
        got = len(classify_diff(lines)) > 0
        passed = got == want_violation
        print(f"{'PASS' if passed else 'FAIL'} {label} (violation={got}, want={want_violation})")
        ok = ok and passed
    print("all-PASS" if ok else "\nFAILURES ABOVE")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="origin/main")
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--selftest", action="store_true", help="run the logic's own unit tests, no git needed")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(run_selftest())

    lines = git_diff(args.base, args.head)
    violations = classify_diff(lines)
    if violations:
        print("[seed-freeze] FAIL — shipped pinned seed file(s) modified, deleted, or renamed:")
        for status, path in violations:
            print(f"  {status}\t{path}")
        print(
            "[seed-freeze] pinned seed@<x>.<y>.<z>.js files are immutable once merged "
            "(seed.md §3.1). Bump SEED_VERSION in tools/bake_seed.py and ship a new "
            "pinned release instead of editing an existing one."
        )
        sys.exit(1)
    print("[seed-freeze] OK — no pinned seed files modified, deleted, or renamed")
    sys.exit(0)


if __name__ == "__main__":
    main()
