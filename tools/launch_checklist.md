# Launch checklist — v2 blueprint §5 gate

The gate that buys the custom domain. The initial GitHub Pages publish does
NOT wait on this file — §5 gates the domain move, and SUB-6/ED-4/ADM-D/
SEED-3/4 explicitly ship without blocking launch (all landed anyway).

Two kinds of rows: `[x]` = verified with committed, re-runnable evidence;
`[ ]` = needs a human on a real device/engine. Headless coverage here is
chrome-headless-shell + SwiftShader, which is **GL2-only** — nothing below
claims WebGPU executed headless.

## Automated rows (green on the launch commit)

- [x] Stages complete: SUB-0..5, ED-0..3, ADM-A..C, SEED-1..2 (and beyond —
      all 15 v2 items merged).
- [x] Budgets + CI: `python3 tools/check_budgets.py` exit 0; editor bundle
      gz gate; `bake_seed.py` hard-fail ledger check; seed-freeze workflow;
      `embed/contract.html` all 15 clauses headless (`tools/test/seed.mjs`).
- [x] Full suite: smoke, loader, layout, anatomy, admission-sac, seed,
      comp0–3, lineage — all-PASS, one suite per process (see
      `tools/test/browser.mjs` note on pid-derived ports).
- [x] Seed proof: foreign-origin fixture (`tools/test/fixtures/foreign-seed/`)
      plays a baked kernel cross-origin, pauses off-screen (0 GL contexts),
      reduced-motion → poster-only with click-to-play, bogus kernel id →
      poster + `sg-error`. Posterize-after-30s covered by contract clause,
      not re-timed per browser.
- [x] Textarea fallback: editor fully works without
      `site/js/vendor/cm-editor.bundle.js` (ED-2 acceptance, kept green in
      smoke).
- [x] Admission TLE headless (GLSL): real infinite-loop shader → watchdog →
      worker terminated → verdict TLE → page interactive
      (`tools/test/admission-sac.mjs`). WGSL TLE path: watchdog verified via
      hung-promise stub only — real WGSL needs the manual rows below.

## Manual rows — real devices/engines (operator)

Per browser, run rows 1–7 from blueprint §5 (gallery, deep link + badge,
editor typing/recompile/never-black, v1 share link + VF withhold, TLE
time-bomb stays interactive, Shift+A anatomy, SW update N→N+1):

- [ ] Chrome stable, desktop — incl. **WebGPU badge** on
      `#/s/biome-rolling-hills` and one run with WebGPU force-disabled
      (`chrome://flags` or `--disable-features=WebGPU`) to verify GL2
      fallback.
- [ ] Chrome stable, one mid-tier Android device.
- [ ] Firefox stable, desktop.
- [ ] Safari 26, macOS.
- [ ] Safari 26, iOS.
- [ ] First-visit experience (mid-tier Android, cold cache, throttled 4G):
      gallery FCP < 2 s; idle `#/` payload ≤ 56 KiB raw JS/JSON +
      thumbnails; ZERO editor/CodeMirror/admission bytes; no thumb layout
      shift.
- [ ] ≥ 30 fps on the author's desktop for the `#/garden` diorama and the
      worst-flagged heavy kernel (`vault-a2974d11`).
- [ ] Domain-move safety re-check at cutover: site serves identically from
      `/` and the Pages subpath (subpath is live from day one on
      `*.github.io/<repo>/`, so this proves itself pre-domain); old
      `*.github.io` URL stays live post-CNAME.

When every box checks: buy the domain, set CNAME, redeploy, re-run rows 1–7
once on the new origin, announce.
