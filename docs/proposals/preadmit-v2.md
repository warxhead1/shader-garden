---
title: shader.preadmit.evaluated.v2 — enum-widening proposal
project: shader-garden
type: proposal
status: draft — for the operator to file in nervous-bus
date: 2026-07-03
owner: nervous-bus repo (this doc is written FROM shader-garden; it does not
  touch nervous-bus — the operator files the actual schema bump there)
related: v2 blueprint ruling C10; admission design §7.3; work item 18 (ADM-D)
---

# shader.preadmit.evaluated.v2 — enum-widening proposal

**This document lives in shader-garden and proposes a change to a schema that
lives in `nervous-bus/schemas/`. Nothing in nervous-bus was edited to produce
this — it is READ ONLY throughout ADM-D's implementation and this doc. The
operator files the real bump there when ready.**

## 1. Why now (Stage-D data, not speculation)

The Shader Garden v2 admission organ (`site/js/organs/admission/`) evaluates
browser shaders — GLSL **and** WGSL — and emits
`garden.admission.evaluated.v1` on the in-page bus. The envelope's `data`
payload is a deliberate structural subset of nervous-bus's
`shader.preadmit.evaluated.v1` (same `shader_id`/`verdict`/`crash_risk`/
`static_findings`/`render_metrics` vocabulary), so a private operator-side
bridge script (~40 lines, not shipped in this repo) can re-emit browser
verdicts into the home FunSearch pipeline without any translation logic —
that was the whole point of choosing the shared vocabulary (admission design
§7.3, ruling C10).

That bridge works today for GLSL. It cannot work for WGSL, because
`shader.preadmit.evaluated.v1`'s `data.language` enum is `["glsl", "slang"]`
(schema line 58-61) — there is no `"wgsl"` value. A WGSL verdict cannot be
re-emitted as v1 at all; it is currently **held** (admission design §7.3):
computed, reported to the user in the browser, but never bridged home.

ADM-D (v2 blueprint work item 18) is the point where this stops being
speculative. The admission organ has shipped through ADM-C: both GLSL and
WGSL sacrificial verdicts are real (GLSL empirically, under headless
SwiftShader; WGSL on real GPU browsers per the launch checklist — WebGPU
never executes headless, so that path is verified by code review + the
`admission-sac.mjs` stubbed-watchdog test, not a live headless render). The
shape of a real WGSL verdict is fully known from the code even though it
cannot be captured headlessly (see §4).

## 2. The proposed change

Add `shader.preadmit.evaluated.v2.json` as a **new, sibling schema file** in
`nervous-bus/schemas/` — v1 is never edited in place (repo rule: "breaking
changes bump the major version, never silent edits"). The only content
change from v1:

```diff
         "language": {
           "type": "string",
           "enum": [
             "glsl",
-            "slang"
+            "slang",
+            "wgsl"
           ]
         },
```

Everything else — `kind`, `verdict`, `crash_risk`, `static_findings`,
`render_metrics` (all twelve keys, unchanged), `source` const
`/autobench/pre_admit`, `additionalProperties: false` on both the envelope
and `data` — stays byte-for-byte identical to v1. This is the narrowest
possible diff: one array gains one string.

### Why this needs a MAJOR bump, not a silent widen

Nervous-bus's own rule is unambiguous: "breaking changes bump the major
version, never silent edits." An enum widening is additive in the schema-
validation sense (every v1-valid document is still v2-valid), but it is
**not** additive in the consumer sense: any downstream consumer that
`switch`es on `data.language` and treats an unrecognized value as an error
(or silently drops it) would **misroute** a `"wgsl"` value if v1 were edited
in place — the exact failure mode a schema is supposed to prevent, not cause.
A new major version forces every consumer to make an explicit choice about
whether it understands `"wgsl"`, rather than discovering it by accident.
This is the same reasoning admission.md §7.3 gave when the browser admission
design was first written; ADM-D is where it's finally backed by a working
bridge on one side (GLSL, real) and a fully-specified-but-blocked side (WGSL).

## 3. Browser-only keys — named explicitly, NOT added to the schema

The admission organ's own `AdmissionReport` (its emitted `data` payload) is a
**superset** of `shader.preadmit.evaluated.v1`'s `data` shape: it carries
extra fields the browser context needs that make no sense for the home
FunSearch pipeline's `/autobench/pre_admit` producer. These are, by name
(admission design §4.2/§7.3, unchanged since ADM-A):

- `surface` — `'editor-self' | 'share-link' | 'suggestion' | 'embed'`; which
  browser UI surface triggered the evaluation. Meaningless off-browser.
- `backend` — `'webgpu' | 'webgl2' | 'none'`; which browser rendering backend
  ran the sacrificial compile. The home pipeline has no browser backend.
- `stages` — `{ static_ms, compile_ms?, frames_ms? }`; browser-side timing
  breakdown. The home pipeline has its own timing model.
- `compile_log` — verbatim `getCompilationInfo()`/GL info-log text. Browser-
  engine-specific (tint/naga/WGSL::Compiler vs the home pipeline's own
  compiler), not portable.
- `preview_png` — a `data:` URL of the 64×64 sacrificial readback. Already
  explicitly excluded from the Suggest-flow fenced block (§9, ADM-D) for
  URL-length reasons; excluded from the schema for the same "browser
  rendering artifact, not evaluation data" reason.

**These five keys are deliberately NOT added to `shader.preadmit.evaluated.v2`'s
`data.properties`.** `additionalProperties: false` on `data` stays exactly as
it is in v1. This is the point of the proposal, not an oversight: the schema
describes the ecosystem-portable evaluation vocabulary; the browser-only
keys are admission's own extension for its own UI (the report renderer,
`organs/admission/report.js`, reads `backend`/`stages`/`compile_log`/
`preview_png` directly), stripped by the bridge before anything crosses onto
the bus as a `shader.preadmit.evaluated.v2` event. Naming them here means a
future schema author doesn't rediscover the same "should `compile_log` be in
the schema?" question from scratch — the answer is no, and this is why.

## 4. Evidence: a real GLSL envelope, captured and validated

ADM-D added `tools/test/check_preadmit_v1_compat.py` (python3 + `jsonschema`,
run from `tools/test/smoke.mjs`'s test (t) against nervous-bus's real schema
file, read-only) and wired it to a **real** captured envelope — not a
hand-typed fixture. `tools/test/smoke.mjs` clicks the editor's new "Check
shader" button on the default GLSL starter under headless SwiftShader, reads
the actual `garden.admission.evaluated.v1` envelope off the in-page bus, and
writes it to `tools/test/out/admission-verdict-glsl.json`. The bridge
conversion (strip the five keys in §3, correct `source`/`type` to the
bridge's own emission identity) is then re-implemented in
`check_preadmit_v1_compat.py` and validated with
`jsonschema.Draft202012Validator` against the real
`nervous-bus/schemas/shader.preadmit.evaluated.v1.json` (sibling checkout;
`$NBUS_ROOT` overrides).

Captured envelope (`garden.admission.evaluated.v1`, real sacrificial run,
2026-07-03):

```json
{
  "specversion": "1.0",
  "id": "01KWN56XZE9KYR3X9JA947PWTA",
  "source": "/garden/admission",
  "type": "garden.admission.evaluated.v1",
  "datacontenttype": "application/json",
  "time": "2026-07-03T23:32:21.102Z",
  "data": {
    "shader_id": "01KWN56XYGP562ES6GASH30GRC",
    "language": "glsl",
    "kind": "fragment",
    "surface": "editor-self",
    "backend": "webgl2",
    "static_findings": [],
    "stages": { "static_ms": 0.1, "compile_ms": 0.5, "frames_ms": 4.6 },
    "verdict": "OK",
    "crash_risk": "none",
    "safe": true,
    "render_metrics": {
      "render_time_ms": 4.6,
      "brightness_mean": 0.2666162009803922,
      "contrast_ratio": 2.7068414019507783,
      "color_diversity": 0.24609375
    },
    "preview_png": "data:image/png;base64,iVBORw0KG…"
  }
}
```

After stripping `surface`/`backend`/`stages`/`compile_log`(absent)/
`preview_png` and correcting `source`/`type` to the bridge's own identity,
the remaining `data` is:

```json
{
  "shader_id": "01KWN56XYGP562ES6GASH30GRC",
  "language": "glsl",
  "kind": "fragment",
  "static_findings": [],
  "verdict": "OK",
  "crash_risk": "none",
  "safe": true,
  "render_metrics": {
    "render_time_ms": 4.6,
    "brightness_mean": 0.2666162009803922,
    "contrast_ratio": 2.7068414019507783,
    "color_diversity": 0.24609375
  }
}
```

Run:

```
$ python3 tools/test/check_preadmit_v1_compat.py tools/test/out/admission-verdict-glsl.json
OK: glsl garden.admission.evaluated.v1 envelope validates against shader.preadmit.evaluated.v1 after stripping surface, backend, stages, compile_log, preview_png
```

`smoke.mjs` also runs a negative control (adding an un-stripped browser-only
key back in) to prove the checker can actually fail — `additionalProperties:
false` correctly rejects it. This is a real jsonschema validation, not a
script that always prints `OK`.

### A representative WGSL shape (code-derived, not headless-captured)

WebGPU never executes under headless Chrome (SwiftShader is GL2-only — see
ARCHITECTURE.md's "Headless-test reality" note), so a WGSL verdict cannot be
captured the same way in CI. Its shape is nonetheless fully determined by
`organs/admission/index.js`'s `runWorker()`/`admit()` code path — the SAME
function that produces the GLSL envelope above, branching only on `backend`.
A representative WGSL `OK` verdict, reconstructed from that code (not run,
clearly labeled as such):

```json
{
  "shader_id": "01EXAMPLE0000000000000000",
  "language": "wgsl",
  "kind": "fragment",
  "static_findings": [],
  "verdict": "OK",
  "crash_risk": "none",
  "safe": true,
  "render_metrics": {
    "render_time_ms": 3.1,
    "brightness_mean": 0.31,
    "contrast_ratio": 2.4,
    "color_diversity": 0.19
  }
}
```

This is schema-identical to the GLSL case except `"language": "wgsl"` — it
is REJECTED by v1 (`'wgsl' is not one of ['glsl', 'slang']`) and would be
ACCEPTED by the proposed v2 with no other change. That single-field diff is
the entire proposal in miniature.

## 5. Known gap surfaced by this work (NOT part of this proposal's ask)

While preparing the evidence above, composed (multi-pass, COMP-2) GLSL
admission was also checked for honesty's sake, since "a glsl envelope
validates against v1" should not quietly mean "a glsl **single-pass**
envelope." `organs/admission/index.js`'s `admitComposition()` sets
`kind: 'composition'` on its report — a value **not** in v1's `kind` enum
(`fragment | sdf | compute`, schema line 63-69). Confirmed empirically:

```
$ python3 -c "... data['kind']='composition' ... validate(...)"
INVALID: 'composition' is not one of ['fragment', 'sdf', 'compute']
```

So a composed GLSL verdict does **not** bridge today, independent of the
language enum. This is a real gap, but it is a different question (the
`kind` enum, not `language`) than the one C10 scoped this proposal to, and
composition admission is itself a COMP-2 feature layered on top of the v2
blueprint's original admission design (which explicitly named
"admitting compute/multi-pass shaders" a non-goal, §2). Flagging it here so
it isn't silently rediscovered later: a follow-up proposal (`kind` gains
`"composition"`, or the bridge maps `composition → fragment` with a note)
is needed before composed verdicts can reach the home pipeline. Out of scope
for ADM-D's accept line, which is satisfied by the single-pass case above.

## 6. What this proposal does NOT do

- Does not touch `nervous-bus/schemas/shader.preadmit.evaluated.v1.json` —
  read-only throughout, verified by the fact that `git status` in that repo
  shows no changes from this work.
- Does not create `shader.preadmit.evaluated.v2.json` in nervous-bus — that
  file does not exist yet; this document is the proposal for creating it,
  filed by the operator through the normal nervous-bus schema-first process
  (`schemas/<type>.v<n>.json`, `tools/schema_coverage_allowlist.txt` if
  applicable, PR review).
- Does not add browser-only keys to any schema (§3).
- Does not address the `kind: "composition"` gap (§5) — named, not solved.
- Does not change anything about how GLSL bridges today — that path is
  unaffected and keeps working under v1.

## 7. Suggested nervous-bus-side checklist (for the operator)

1. Copy `shader.preadmit.evaluated.v1.json` to
   `shader.preadmit.evaluated.v2.json`, apply the one-line enum diff in §2.
2. Bump `$id` and `title` to `v2` in the new file (following the existing
   `v1 v1` title convention already in the v1 file).
3. Write/port the ~40-line operator bridge script to target v2 for `wgsl`
   language envelopes (glsl keeps working against either v1 or v2 — v2 is a
   strict superset for `language`).
4. Consider whether `kind` needs the same treatment (§5) before or alongside
   this bump, or as a deliberate follow-up — operator's call, not this repo's.
