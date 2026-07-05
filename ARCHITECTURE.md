# Architecture

Shader Garden is deliberately small: a static, dependency-free PWA. No bundler,
no framework, no npm — plain ES modules served as-is. The one sanctioned
exception is `tools/editor-bundle/` (§ Editor bundle below): a pinned,
dev-only esbuild step that produces ONE committed artifact,
`site/js/vendor/cm-editor.bundle.js` — the served site still runs from a
buildless checkout with zero toolchain, chunk present or not. `tools/test/`
is the other pinned dev-only dependency (a headless-browser harness, never
shipped). Everything below is a contract; if you change one side, change the
other.

## Layout

```
site/
  index.html            hash-routed SPA shell — one region per organ
                        (#region-gallery, #region-viewer, #region-editor,
                        #region-garden), one shown at a time, plus one layout
                        region (#region-side) that docks "panel" organs
                        (v2 substrate SUB-4 — see § Layout as data), plus one
                        overlay region (#region-overlay) that hosts "overlay"
                        organs (v2 substrate SUB-5 — see § Anatomy mode)
  js/core/boot.js       entry point: page-chrome glue (repo links, explore-btn
                        scroll) that has nowhere else to live, then hands
                        assets/organs.json to core/loader.js. All that's left
                        of the old app.js after the v2 substrate SUB-3 organ
                        split moved gallery/viewer out. Also owns the one
                        shared keydown listener that opens "overlay" organs
                        by their manifest hotkey or the `organ.open.v1`
                        command event (SUB-5 — see § Anatomy mode); overlay
                        organs own no route and no layout placement, so this
                        activation deliberately does NOT live in loader.js.
  js/core/loader.js     route -> organ activation, driven by assets/organs.json:
                        hash parsing, route-pattern matching, navToken/superseded-
                        mount cleanup, region show/hide, organ.opened/closed/failed.v1.
                        As of SUB-4 it also drives non-route "panel" organs via
                        assets/layout.json's `placements` (§ Layout as data).
                        Precached (boot.js imports it eagerly). Every organ is a
                        real `import()` now — no `locals` escape hatch (removed
                        in SUB-3; gallery/viewer used it pre-split).
  js/core/bus.js        in-page CloudEvents-lite pub/sub (dark launch — no consumers yet)
  js/core/registry.js   kernel data loading (kernels.json + wgsl manifest)
  js/core/layout.js     layout-as-data (v2 substrate SUB-4): fetches
                        assets/layout.json, merges the localStorage diff over
                        it, exposes placementsFor()/regionEl() to the loader
                        and the `ctx.layout` mount key to every organ. See
                        § Layout as data. `snapshot()` + `resetLayout()`
                        (SUB-5) back Anatomy's layout inspector.
  js/core/runtime-host.js  runtimeHost(host, opts): canvas -> backend pick ->
                        compile -> start -> context-loss policy (v2 substrate
                        SUB-3, P1/P6), plus the PERF-0 adaptive-fps ladder
                        (see § Adaptive quality). Replaces the hand-rolled
                        hero + viewer runtime lifecycle copies. webgpu.js is
                        itself dynamic-`import()`ed inside runtime-host.js,
                        only on an actual WGSL attempt — the hero
                        (webgl2-only) never fetches it. Lazy: only
                        gallery/viewer import runtime-host.js; never
                        precached by sw.js.
  assets/organs.json    organ manifest: id/entry/routes/emits/consumes/caps/payload
                        per organ (gallery, viewer, editor, garden, provenance,
                        anatomy). Precached — boot.js fetches it eagerly at boot
                        to drive the loader AND (SUB-5) its own overlay-hotkey
                        wiring. Deleting an organ's entry here (e.g. anatomy's)
                        removes that organ entirely — nothing else references it.
  assets/layout.json    default regions/placements/prefs (v2 substrate SUB-4,
                        schema is regions/placements/prefs ONLY — no top-level
                        editor-mode keys, ruling C2). Precached — core/layout.js
                        fetches it eagerly to drive panel placement before the
                        first route(). See § Layout as data.
  js/organs/gallery/index.js  "/" organ: mount(ctx) — hero (via runtime-host.js,
                        WebGL2-only, release-on-lost) + gallery grid. Lazy:
                        dynamic-import()ed by core/loader.js only when "/" is
                        visited (v2 substrate SUB-3); never precached by sw.js.
  js/organs/gallery/thumbs.js  lazy gallery thumbnails (one shared GL context,
                        never per-card; module-scope cache, kept verbatim from v1)
  js/organs/viewer/index.js  "/s/:id" organ: mount(ctx) — kernel resolution,
                        chrome, WGSL fetch; backend ladder + lifecycle delegated
                        to core/runtime-host.js. Lazy, never precached by sw.js.
  js/organs/provenance/index.js  "panel" organ (v2 substrate SUB-4): kernel
                        metadata + license, docked in #region-side by
                        assets/layout.json's placements on `/s/:id`. Not a
                        route — has no organs.json `routes` entry. Lazy,
                        never precached by sw.js. See § Layout as data.
                        Also renders the SUB-6 lineage block (parents/oracle/
                        eval_run_id/preadmit/gen_diff) as its own
                        clearly-delimited function — see § "kernels.json
                        lineage" below.
  js/organs/anatomy/index.js  "overlay" organ (v2 substrate SUB-5): organ
                        graph + event log + layout inspector, opened by
                        Shift+A. Not a route or a placement — has no
                        organs.json `routes` entry, activated by core/boot.js's
                        hotkey listener instead of core/loader.js. Lazy, never
                        precached by sw.js. See § Anatomy mode.
  js/organs/garden/index.js  "/garden" organ (GARDEN-0): mounts the probe-able
                        showcase scene through core/runtime-host.js (GL2-only,
                        prefer: 'webgl2'), wires click-to-probe and reapplies
                        @tune values after a context-loss rebuild. Lazy, never
                        precached by sw.js. See § "The Garden" below.
  js/organs/garden/parse.js  parses assets/garden/scene.glsl's @component/
                        @tune/@end annotations into component + tune metadata
                        — the only place that convention's grammar is defined
  js/organs/garden/probe.js  probeAt(runtime, x, y): renders one uProbe-on
                        frame, reads the clicked pixel back, decodes the
                        component id, restores the normal frame — all
                        synchronous, so the probe frame is never visible
  js/organs/garden/panel.js  builds the probe panel DOM: name, blurb, exact
                        source chunk, live @tune sliders, open-in-editor link
  assets/garden/scene.glsl  the GARDEN-0 scene source — annotated GLSL,
                        fetched by the garden organ like any other asset.
                        Unbudgeted (kept tight by convention, not a check).
  js/editor/index.js    #/edit organ: mount(ctx) — DOM, mode switch, lifecycle. Lazy:
                        dynamic-import()ed by core/loader.js only when the route is
                        visited (v2 substrate stage 1); never precached by sw.js.
  js/editor/pipeline.js debounced recompile, compile-seq staleness guard
  js/editor/modes/      glsl.js/wgsl.js mode descriptors + registry; each mode's
                        language() lazily asks bundle-loader.js for its
                        LanguageSupport (null when the vendor chunk is absent)
  js/editor/doc-adapter.js  picks the CodeMirror adapter or the textarea
                        fallback (ED-2 § Editor bundle) — the only file that decides
  js/editor/doc-adapter-codemirror.js  CM6 adapter: view lifecycle, ED-1
                        messages[] -> CM diagnostic (doc-offset) conversion
  js/editor/bundle-loader.js  memoized dynamic import() of the vendor chunk,
                        resolves null (never throws) on a fresh buildless
                        checkout or a broken deploy
  js/editor/surfaces/transport.js  pause/step/scrub, resolution scale,
                        screenshot (ED-3) — reads/writes the active runtime's
                        clock, holds no state of its own
  js/editor/surfaces/uniforms.js  ED-4 read-only uniforms inspector: source
                        usage-scan + 10 Hz clock readout, iMouse freeze toggle
  js/editor/surfaces/record.js  ED-4 canvas.captureStream + MediaRecorder ->
                        .webm, 10s cap, feature-detects and degrades to a
                        disabled button when unsupported (§ Inspection +
                        recording (ED-4))
  js/editor/doc-adapter-textarea.js  textarea source input (Tab indent) — the
                        permanent fallback, same facade as the CM adapter;
                        focusLine() also drives the &line= share param (ED-3)
  js/editor/diagnostics-list.js  clickable compiler-diagnostic line list —
                        the textarea fallback's diagnostic surface (CM gets
                        squiggles instead, via doc-adapter-codemirror.js)
  js/editor/admission-gate.js  share-link admission gate: static tier +
                        scrim, run before a foreign #/edit?src= source autoruns
  js/vendor/cm-editor.bundle.js  committed esbuild artifact (§ Editor bundle).
                        Lazy, dynamic-import()ed by doc-adapter.js only when
                        #/edit is visited; never precached by sw.js — same
                        idle-costs-zero rule as every other organ asset.
  js/organs/admission/index.js  admit()/policyFor()/recentAdmissions() — the
                        admission pipeline's one entry point (function call,
                        not the bus — see § Admission). Lazy: only the
                        editor organ imports it, never precached by sw.js.
  js/organs/admission/static.js  SG-Sxx static screen (pure JS, no wasm)
  js/organs/admission/sac-worker.js  sacrificial compile+run in a dedicated
                        module worker, killable unconditionally from
                        index.js's watchdog: WGSL headless-texture WebGPU
                        (ADM-B), GLSL OffscreenCanvas WebGL2 (ADM-C — real
                        and headless-testable under SwiftShader, unlike
                        WGSL). Fetched only when a share-link/suggestion/
                        embed actually needs the sacrificial tier.
  js/organs/admission/report.js  ADM-C full admission report UI (§9):
                        badge + hover legend, findings, verbatim log,
                        preview, timing strip, Copy verdict JSON. Replaces
                        ADM-A's minimal badge box as admission-gate.js's scrim.
  js/share.js            deflate+base64url share links, GitHub issue prefill.
                        Precached: boot.js imports it eagerly (githubRepoUrl).
  js/runtime/wrap.js    shared GLSL/WGSL prelude+epilogue — the exact wrap
                        both runtimes AND the admission sacrificial worker
                        compile against (ruling C8: byte-identical). Lazy:
                        only runtime-host.js (via webgl2.js/webgpu.js) and
                        the editor import it; never precached by sw.js.
  js/runtime/webgl2.js  GL2Runtime — wraps Shadertoy-style GLSL
  js/runtime/webgpu.js  GPURuntime — wraps mainImage-style WGSL
  js/runtime/uniforms.js shared clock + Shadertoy iMouse semantics
  assets/kernels.json   the baked garden (see schema below)
  assets/wgsl/          hand-ported WGSL showcase kernels + manifest.json
  sw.js                 offline shell, stale-while-revalidate kernel data
tools/
  bake_kernels.py       offline: curates kernel sources → kernels.json (validates
                        every kernel with glslangValidator before it ships;
                        --perf merges tools/test/perf.mjs timings into "cost")
  bake_compositions.py  COMP-3: the evolved-compositions bridge — consumes
                        kernel.composition.ready.v1-shaped fixtures (tools/
                        fixtures/composition_ready/*.json), bakes assets/
                        compositions/<id>.json + index.json, and tags the
                        channel-source kernel in kernels.json (§ "Compositions
                        (COMP-1, COMP-3)" below)
  fixtures/composition_ready/  kernel.composition.ready.v1 fixture artifacts
                        bake_compositions.py reads — no live nervous-autobench
                        run emits this event yet, see § below
  editor-bundle/        pinned esbuild pipeline, dev-only — builds
                        site/js/vendor/cm-editor.bundle.js (§ Editor bundle)
  test/perf.mjs         headless per-kernel render-cost harness (PERF-1) —
                        forced-sync GL2Runtime.renderOnce() timing, writes
                        tools/test/out/perf.json; report-only (no exit-code gate)
```

All URLs in `site/` are relative — the app runs identically at a domain root or
under a GitHub Pages subpath.

## Routing

`js/core/loader.js` is the one router. `assets/organs.json` lists the organs
(`{ id, entry, title?, routes, emits, consumes, caps, payload }`); `routes` are
hash-less patterns — literal segments plus one `:param` (`/`, `/s/:id`,
`/edit`, `/garden` today, no regex, no wildcards) — matched in manifest order. An unknown
route rewrites the hash to `#/`. Each organ owns a region in `index.html`
(`#region-<id>`), shown/hidden by the loader on activation; `body`'s
`data-route` tracks the active organ id.

Every organ (gallery, viewer, editor) is a real lazy organ as of v2 substrate
SUB-3: `organs.json`'s `entry` is dynamic-`import()`ed only once its route is
visited, so any single-route visit fetches 0 bytes of the other two organs
(P3). `mount(ctx)` gets the same frozen context regardless of organ: `root`
(its region), `params` (route params merged into the query `URLSearchParams`
— `ctx.params.get('id')` for the viewer), `bus` (source-bound per organ id,
so an organ never labels its own emits — a convention against accidental
mislabeling, not an anti-spoofing boundary, since `bindSource` is an open
export; enforcement is deliberately v3), `registry` (`{ load }`), `layout`
(`{ prefs, setPref }` — v2 substrate SUB-4, see § Layout as data), `manifest`
(its own organs.json entry), and `alive()` (`() => token === navToken` for
this activation — see rule 3 below).

Three rules guard against a stale activation doing visible or expensive work
after it's been superseded, covered by `tools/test/loader.mjs`:

1. **navToken guard.** Every navigation bumps a token; if a newer navigation
   lands while an organ's entry is still resolving (a slow `import()`), the
   stale activation never calls `mount()` at all. `route()` bumps the token
   for unmatched routes too, before the `#/` redirect — an in-flight stale
   activation is superseded immediately rather than waiting for the
   redirect's own `hashchange` to get around to it.
2. **superseded-mount cleanup.** If a mount's `cleanup` resolves after being
   superseded, the loader disposes it immediately instead of installing it —
   a rapid nav-away can never leak a runtime or leave orphaned DOM behind.
3. **`ctx.alive()` — mid-mount staleness.** Rules 1 and 2 only re-check
   `navToken` at two points: after `await import()` and after
   `await mountFn(ctx)` resolves. A nav-away while `mount()` is suspended on
   its OWN internal await (a slow `registry.load()`, a share-link admission
   gate, a runtime `create()`) is invisible to the loader until that
   `await` finishes and the whole `mount()` call returns — by which point an
   organ that pressed ahead regardless could have already built a live
   WebGL2/WebGPU canvas into a region nobody's looking at (empirically
   observed: a stale editor mount resumed ~1.2 s later and inserted a live
   canvas; Chrome hard-caps ~16 contexts page-wide). `ctx.alive()` closes
   that gap: organs with an expensive mid-mount await call it immediately
   after and bail to a no-op cleanup when stale, instead of continuing to
   build DOM or a runtime. Deliberately additive, not an `AbortSignal`
   redesign — organs opt in at their own expensive await points; `mount()`
   is not restructured. Guarded today: the editor (`registry.load`,
   `gateShareLink`, runtime `create`), the garden organ (`scene.glsl`
   fetch), and the viewer (`registry.load`).

The loader emits `organ.opened.v1` / `organ.closed.v1` on every successful
activation/deactivation and `organ.failed.v1` (plus a `centerNotice`
fallback in the organ's region) when `import()` or `mount()` rejects — an
organ crashing never white-screens the whole site.

## Layout as data

`js/core/layout.js` (v2 substrate SUB-4) fetches `assets/layout.json` once
and merges a `localStorage["sg.layout.v1"]` diff over it — the shipped file
is the schema-versioned default; the diff carries only what a user (or
Anatomy's future layout inspector) changed. A corrupt/unparseable diff is
discarded silently; the default wins, never bricking the site over a bad
layout blob.

Schema is `{ version, regions, placements, prefs }` — **regions, placements,
and prefs ONLY**. There is no top-level `editorModes`/`defaultMode` key: the
editor's mode roster lives at `prefs.editor_modes` / `prefs.editor_default_mode`,
same as any other organ-scoped layout fact (ruling C2 — a non-route "panel"
organ or an organ's own preference is not special enough to earn a top-level
schema key).

```json
{
  "version": 1,
  "regions": { "side": { "el": "#region-side" } },
  "placements": [
    { "organ": "provenance", "region": "side", "when": ["/s/:id"] }
  ],
  "prefs": { "editor_modes": ["glsl", "wgsl"], "editor_default_mode": "glsl" }
}
```

- `regions` name DOM mount points for **panel** organs — not route regions
  (those stay `#region-<organ-id>`, owned by `organs.json`/the router). v2
  ships one: `side` (`#region-side` in `index.html`), a `position: fixed`
  layer that is the containing block for `.meta-panel`'s absolute
  positioning, exactly as `#region-viewer` was before the panel moved out of
  it. Hidden whenever no panel currently occupies it.
- `placements` say which panel organ docks in which region, gated by a
  `when` route-pattern list (same tiny grammar as the router: literal
  segments + one `:param`, no regex). `core/loader.js`'s `syncPanels()`
  mounts/unmounts panels on every navigation by diffing the placements the
  new path satisfies against the ones currently mounted — **removing a
  placement means that organ's entry is never `import()`ed**, so idle-costs-
  zero (P3) covers panels too. A panel is NOT torn down across a
  same-placement re-navigation (`/s/a` -> `/s/b` both want `provenance`) —
  its own `ctx.params` goes stale in that case, which is why panels
  (provenance included) resolve their current subject via `kernel.opened.v1`
  rather than re-reading `ctx.params` after the first mount.
- `prefs` are small per-organ facts that v1 lost on reload (P10) — e.g. the
  provenance panel's collapsed state. Every organ's `ctx.layout` is
  `{ prefs, setPref(key, value) }`: `prefs` is the live merged object (a
  `setPref()` from one organ is visible to any other already-mounted organ
  holding the same `ctx.layout` without a remount); `setPref()` persists the
  changed key into the localStorage diff and updates the in-memory snapshot.

Panel activation reuses the same `import()` -> `mount(ctx)` -> stale-check
discipline as route activation (`loader.js`'s shared `tryMount()` helper),
with a per-organ generation counter standing in for `navToken` (a panel can
be superseded by a rapid placement change independent of route navigation).

## Anatomy mode (v2 substrate SUB-5)

`js/organs/anatomy/index.js` — `payload: "overlay"`, `consumes: ["*"]`,
`hotkey: "KeyA+Shift"` in `assets/organs.json`. It is an ordinary organ:
deleting its `organs.json` entry removes the whole feature, which is the
proof the substrate did not special-case it (substrate §8.2).

**Activation lives in `core/boot.js`, not `core/loader.js`.** Overlay organs
own no route and no layout placement, so the loader never touches them.
`boot.js` filters `organs.json` for `payload:"overlay"` entries with a
`hotkey`, and:
- binds **one shared `keydown` listener** for the whole page — the entire
  always-on cost of Anatomy (plus its own organs.json entry and the bus ring
  buffer, which already exist for the bus's own sake). It is guarded against
  `document.activeElement` being an `INPUT`/`TEXTAREA`/`isContentEditable`
  node (the last one also catches CodeMirror's `.cm-content`), so the editor
  never loses a keystroke to chrome.
- also listens for the one sanctioned command event, `organ.open.v1`
  (substrate §4.4) — the anatomy module's own Esc handler and its close
  button both just re-emit that command with their own id, so `boot.js`'s
  `open` variable stays the single source of truth for what's mounted
  regardless of which path closed it.

On first match, `boot.js` dynamic-`import()`s the organ's entry into
`#region-overlay` (a dedicated fixed full-viewport div in `index.html`,
outside the loader's `region-<organ-id>` convention on purpose — the
loader's `showRegion()` would otherwise fight over it on every navigation)
and calls `mount(ctx)` with the same five-key `ctx` shape every organ gets
(substrate §3.2); a second press of the hotkey (or `organ.open.v1` again)
calls the returned `cleanup()` and re-hides the region. Nothing is fetched
until the first activation — verified in `tools/test/anatomy.mjs` by
asserting zero requests for `js/organs/anatomy/` before Shift+A and exactly
one after.

**What it renders**, all plain DOM + one inline `<svg>`:
1. **Organ graph.** One card per `organs.json` entry (id, payload, caps,
   routes, declared emits/consumes, state `cold`/`loaded`/`loaded+mounted`
   from `organ.opened/closed.v1` history). Edges are drawn from every
   declared `emits -> consumes` intersection (a `"*"` consumer matches every
   emitted type) and start **dashed** — the manifest's unproven claim. An
   edge is redrawn solid and briefly lit the first time a live envelope of
   that exact type actually crosses from that exact source, backfilled from
   `bus.recent()` so a late-opened Anatomy still sees traffic it missed.
   This is the manifest-lie audit made visible: a dashed edge after normal
   use is either a bug (fix the manifest or the code) or a legitimately rare
   path (e.g. `runtime.lost.v1` needs an actual context loss to fire).
   *Audit performed for this change: `organs.json`'s declared emits/consumes
   were cross-checked against every `bus.emit`/`bus.on` call site in the
   tree — all declared types are genuinely reachable from the declaring
   organ's own code (viewer/garden's `backend.selected.v1`/`runtime.lost.v1`
   route through `runtime-host.js`'s shared `emit()`, gated on `opts.bus`
   being passed — gallery's hero deliberately does not pass it, matching its
   `emits: []`). No manifest lies found; nothing needed fixing.*
2. **Event log.** `bus.recent()` then a live `bus.tap()`; each row is
   time/type/source, click-to-expand `data` via `textContent` (never
   `innerHTML`); a filter input matches type/source substrings. Capped at
   the bus's own 256-ring, so the log never outgrows it while open.
3. **Layout inspector.** `core/layout.js`'s new `snapshot()` export (the
   full merged `{regions,placements,prefs}`, read-only — every other organ
   only ever sees the `prefs` slice via `ctx.layout`) rendered as editable
   raw JSON; "Apply prefs" calls `ctx.layout.setPref()` per key on valid
   parse. "Reset layout" calls the existing `resetLayout()` then reloads the
   page — a full reload is the honest way to un-stick every already-mounted
   organ's own `ctx.layout.prefs` object reference, the same "never brick,
   just restart clean" rule as a corrupt localStorage diff (§ Layout as
   data).

## The uniform contract

Kernels are Shadertoy-style. GLSL kernels define
`void mainImage(out vec4 fragColor, in vec2 fragCoord)` and may read
`iResolution` (vec3), `iTime`, `iTimeDelta` (float), `iFrame` (int), `iMouse`
(vec4, Shadertoy click semantics). The runtime supplies the preamble — kernels
must not declare `#version`, precision, those uniforms, or `main()`:

```glsl
#version 300 es
precision highp float;
precision highp int;
uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int   iFrame;
uniform vec4  iMouse;
out vec4 sg_fragColor;
// kernel source here
void main() { vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy); sg_fragColor = vec4(c.rgb, 1.0); }
```

WGSL kernels define `fn mainImage(fragCoord: vec2f) -> vec4f` and read the
runtime-provided uniform block (again: no bindings, no entry points of your own):

```wgsl
struct SGUniforms { res: vec4f, mouse: vec4f, time: f32, dt: f32, frame: f32, _pad: f32 }
@group(0) @binding(0) var<uniform> U: SGUniforms;
```

`fragCoord` in WGSL is delivered in GL convention (pixels, y-up from the bottom)
so a ported kernel renders identically on both backends.

### Channels (COMP-0)

`runtime/wrap.js`'s `wrapGlsl`/`wrapWgsl` take an optional `channels` count
(0-4, the composition's declared iChannel count). **Channel declarations are
emitted ONLY when `channels > 0`** (ruling C11) — every existing zero-arg
call site (every single-pass kernel shipped today) gets byte-identical
output to pre-COMP-0; a wrap snapshot test in `tools/test/comp0.mjs` pins
this. When `channels` is declared:

```glsl
uniform sampler2D iChannel0;   // ... through iChannel{channels-1}
```
```wgsl
@group(0) @binding(1) var sg_samp: sampler;              // one shared sampler
@group(0) @binding(2) var iChannel0: texture_2d<f32>;    // ... through binding(1+channels)
```

A kernel using channels declares them as extra ordinary uniforms/bindings —
no new mainImage signature. Compiler-message line remap adds the channel
decl's line count (GLSL: `channels`; WGSL: `wrap.js`'s `wgChanLines(channels)`)
on top of `GLSL_PRELUDE_LINES`/`WGSL_PRELUDE_LINES`.

Both runtimes gain render-to-texture primitives so one kernel's output can
feed another as an iChannel source:

- `createTarget(w, h, {feedback})` — an offscreen texture target.
  `feedback: true` allocates a ping-pong pair and `renderTo()` alternates
  between them: **self-feedback is the only legal cycle** (ruling C12);
  arbitrary composition graphs are validated at COMP-1 (DAG check + the
  admission static tier's SG-S08), not here.
- `renderTo(target, timeSeconds)` — `renderOnce`'s off-screen sibling: draws
  one frame into `target` instead of the canvas.
- `setChannels(sources)` — binds up to 4 texture sources (GL2: `WebGLTexture`
  via `targetTexture(target)`; WebGPU: `GPUTextureView` via `targetView(target)`)
  as iChannel0.. for subsequent frames; the count must match the `channels`
  passed to the active `setShader()` call.
- `disposeTarget(target)` — releases a target's GPU objects.

**WebGL textures/programs do not cross GL contexts** — a composed pipeline's
passes share one runtime instance (one canvas, one context), calling
`setShader()` once per pass to swap the active program between `renderTo()`
calls. COMP-1's composition player owns per-pass scheduling; COMP-0 only
ships the primitives it calls.

## Runtime interfaces

Both runtimes present the same surface, so callers swap them freely:

```js
// webgl2.js
new GL2Runtime(canvas, {maxDpr?}) // throws when WebGL2 unavailable; maxDpr overrides
                                 // the site-wide DEFAULT_DPR_CAP for this instance (PERF-2)
rt.setShader(glslSrc, channels) // -> { ok, log, messages }; channels (0-4, COMP-0) declares
                                 // iChannel0.. (C11: omitted entirely when 0); a failed compile
                                 // keeps the previous program running
rt.start() / rt.stop() / rt.dispose()
rt.renderOnce(timeSeconds)      // single frame (thumbnail pump uses the GL2 runtime)
rt.getClock()                   // the shared clock: { time, dt, frame, mouse, running, seek(t), step(dt?) }
rt.seek(t) / rt.step(dt?)       // scrub / manual single-frame advance while stopped, then redraw (ED-3)
rt.setRenderScale(s)            // multiplier on the DPR-capped buffer size, clamped [0.25, 2] (PERF-0)
rt.setUniforms({name: n})       // named float uniforms beyond the fixed five — GARDEN-0's
                                 // @tune sliders + probe toggle; merges, persists across
                                 // setShader(), unknown names silently ignored. Both backends
                                 // (WGSL side: wrap.js's `@sg-uniforms` directive + a fixed
                                 // 32-float bank — see § "The Garden" below)
rt.setChannels([tex, ...])      // COMP-0: bind up to 4 WebGLTextures as iChannel0..
rt.createTarget(w, h, {feedback}) // COMP-0: offscreen render target; feedback:true ping-pongs
rt.renderTo(target, t)          // COMP-0: renderOnce's off-screen sibling
rt.targetTexture(target)        // COMP-0: target's current-frame WebGLTexture (bind via setChannels)
rt.disposeTarget(target)        // COMP-0: release a target's GL objects
rt.canvas                       // the backing <canvas> (transport screenshot capture, ED-4 recorder)
rt.freezeMouse() / rt.unfreezeMouse() // ED-4: detach/reattach iMouse tracking — the
                                 // uniforms inspector's freeze toggle; idempotent either way
rt.onPerf = ({fps, ms}) => {}   // ~1 Hz
rt.onFps = (fps) => {}          // deprecated back-compat — fires alongside onPerf, never on its own
rt.onContextLost = (ev) => {}   // callers rebuild or degrade — the runtime only stops

// webgpu.js
await GPURuntime.create(canvas) // -> GPURuntime | null (null = unsupported; never throws for that)
await rt.setShader(wgslSrc, channels) // -> { ok, log, messages } via getCompilationInfo; same
                                 // `channels` contract as webgl2.js; serialized against overlap
rt.setChannels([view, ...])     // COMP-0: bind up to 4 GPUTextureViews as iChannel0..
rt.createTarget(w, h, {feedback}) // COMP-0: offscreen texture target; feedback:true ping-pongs
await rt.renderTo(target, t)    // COMP-0: renderOnce's off-screen sibling
rt.targetView(target)           // COMP-0: target's current-frame GPUTextureView
rt.disposeTarget(target)        // COMP-0: release a target's GPU textures
// getClock/seek/step/setRenderScale/canvas/onPerf/onFps — same surface as webgl2.js
```

A composed pipeline shares one runtime instance across its passes (WebGL
resources don't cross contexts) — see § "Channels (COMP-0)" above.

The failure-keeps-previous-program rule is what makes live recompile in the
editor pleasant: you can type through a broken intermediate state without the
canvas ever going black.

### Compiler diagnostics

Both runtimes wrap `userSrc` with `runtime/wrap.js`'s `wrapGlsl`/`wrapWgsl`
(the exact prelude/epilogue strings, hoisted out of the runtimes so the
admission sacrificial tier can compile the byte-for-byte same artifact — see
§ Admission), so raw compiler line numbers are in wrapped coordinates — the
runtime owns the wrapper, so the runtime owns the remap. `setShader`'s
`messages[]` is `{ line, col?, severity: 'error'|'warning'|'info', text,
wholeDoc? }`, already in **user-source** coordinates: `wrap.js`'s
`GLSL_PRELUDE_LINES`/`WGSL_PRELUDE_LINES` are computed from the actual
prelude strings (never hardcoded) and subtracted from the compiler's line,
then clamped to `[1, userLineCount]`. GLSL logs are parsed with an ANGLE
regex and a Mesa regex; WGSL messages come structured from
`getCompilationInfo`. Anything the parser can't place — an unparseable GLSL
log, a GL link-stage failure, or a WebGPU pipeline-creation error — becomes a
single `wholeDoc: true` diagnostic at line 1 instead of a guess. The textarea
fallback (`editor/diagnostics-list.js`) renders `messages[]` as a clickable
line list; CodeMirror (`editor/doc-adapter-codemirror.js`) renders the same
data as squiggles via `@codemirror/lint`'s `setDiagnostics` push API — see
§ Editor bundle.

Every completed compile (`pipeline.js`'s `recompile()`) also emits
`shader.compiled.v1` on `ctx.bus` (ED-4) — `{ shader_id?, language, ok,
log_excerpt, duration_ms, backend }`, source `/garden/editor`. This is the
editor-side half of the substrate's event table entry (the viewer already
emitted its half); `assets/organs.json`'s editor manifest declares it in
`emits` so Anatomy's dashed-edge audit renders the edge solid instead of a
manifest lie. `shader_id` is the `?k=` kernel id when present, `undefined`
for a from-scratch or share-link session (the schema field is optional).

## Editor bundle

`#/edit` upgrades to CodeMirror 6 when `site/js/vendor/cm-editor.bundle.js`
exists; a fresh buildless checkout or a broken deploy falls back to a plain
`<textarea>` (`editor/doc-adapter-textarea.js`) with identical behavior
(Tab-indent, share links, admission gating) minus highlighting and squiggles.
`editor/doc-adapter.js` is the only file that decides which one mounts —
`import('../vendor/cm-editor.bundle.js')` inside a try/catch, memoized by
`editor/bundle-loader.js`. Both adapters implement the same facade: `el`
(appendable DOM node), `getValue`/`setValue`, `focus`/`focusLine`,
`setLanguage(mode)`, `setDiagnostics(messages)`, `destroy`. `editor/index.js`
and `editor/diagnostics-list.js` never import a CM type directly.

The vendor chunk is built by `tools/editor-bundle/` (esbuild, pinned
`package.json` + `package-lock.json`) from `facade.js` — a curated entry
point exporting `createEditor`/`setDiagnostics`/`glsl`/`wgsl`, not raw CM
re-exports. It bundles `@codemirror/{state,view,language,commands,lint}`
plus two vendored (not npm-installed) grammar packages under
`tools/editor-bundle/vendor/` — `lezer-glsl` and
`@iizukak/codemirror-lang-wgsl`, both MIT (license check recorded in
`tools/editor-bundle/README.md`) — pinned as committed source rather than a
`devDependency` so the two smallest, single-maintainer packages in the
supply chain can't drift under the pinned lockfile.
`@codemirror/autocomplete` and `@codemirror/search` are deliberately excluded
(weakest value-per-KiB; v3+ if ever). A `MatchDecorator` view plugin tags the
Shadertoy contract identifiers (`iResolution`, `iTime`, `iTimeDelta`,
`iFrame`, `iMouse`, `mainImage`, WGSL's `U`) as builtins — grammar-agnostic,
so it survives either grammar going stale.

**Committed, not CI-built** — `node tools/editor-bundle/build.mjs` is a
manual gate, like the kernel bake: the served site stays "push `site/` to
Pages," zero toolchain, chunk present or not. Two invariants keep the
committed bytes honest:
- **Determinism.** esbuild given the same pinned lockfile produces a
  byte-identical chunk on every run (`build.mjs` doesn't minify with a
  timestamp/random seed, and `legalComments: 'none'` keeps upstream license
  comments out of the diffed output).
- **CI drift guard.** `.github/workflows/deploy.yml`'s `editor-bundle-diff`
  job rebuilds the chunk from `tools/editor-bundle/` and fails if it differs
  from what's committed — a PR that edits `vendor/` or bumps
  `package-lock.json` without regenerating the chunk cannot reach `main`.

**Budget, enforced in `build.mjs`:** the gzipped chunk has a **200 KiB hard
cap** (build fails above it) and a **150 KiB target**. It costs nothing
outside `#/edit` (never precached by `sw.js`, matching every other organ
asset's idle-costs-zero rule) and nothing to a checkout that never runs
`tools/editor-bundle/`'s build step.

### Adaptive quality (PERF-0)

Both runtimes size their drawing buffer as
`clientSize × min(devicePixelRatio, 1.5) × renderScale`. The `1.5` default DPR
cap replaces the old unconditional `2` — full native DPR now costs a real,
explicit choice (`setRenderScale(s)`, clamped `[0.25, 2]`), not the default.
`core/runtime-host.js` (gallery hero, viewer) additionally owns a sustained-fps
ladder on top of `renderScale`: **fps < 24 for ~3s** steps `renderScale *=
0.75` (floor `0.5`); **fps > 50 for ~5s** steps it back up (`/= 0.75`, ceiling
`1` — the ladder never opts a mount into full DPR on its own). A sample inside
`[24, 50]` resets both sustain timers (hysteresis — no oscillation at the
boundary). Calling the runtime-host handle's own `setRenderScale()` (a
user-facing control) disables the ladder for that mount permanently — an
explicit choice always wins over the guess. The editor doesn't go through
`runtime-host.js` (it owns `mode.createRuntime` directly), so its resolution
control (`editor/surfaces/transport.js`) calls `runtime.setRenderScale()`
straight through with no ladder — the author drives it by hand.

The backend badge (`badge-backend` + `badge-fps`, wired by `dom.js`'s
`wirePerf`) always renders `<fps> fps · <scale>x`, e.g. `31 fps · 0.75x` — the
honesty pillar: whatever quality level is actually rendering, the badge says
so, ladder-driven or user-chosen.

### Per-mount DPR cap + an honest ms/frame HUD (PERF-2)

PERF-0's `1.5` DPR cap is site-wide; a fullscreen raymarch is a different
animal from a thumbnail-sized kernel, so `GL2Runtime`'s constructor now takes
an optional `{maxDpr}` (defaults to the module's `DEFAULT_DPR_CAP`), plumbed
through `runtimeHost(host, opts)`'s own `opts.maxDpr` -> its internal
`tryWebgl2()` helper. The garden (`organs/garden/index.js`) is the one mount
that overrides it: `GARDEN_MAX_DPR = 1` (CSS-pixel density, no DPR multiplier
at all) — an 88-step, 4-distance-field-per-step raymarch at native DPR on a
HiDPI/4K display is exactly the "quite shite fps" complaint that motivated
this whole track: `1.5` still means 2.25x the pixel count of `1`.

`runtimeHost()` also grew an `opts.onPerf` callback, fired from the same
~1 Hz `onPerf` tap `wirePerf`'s fps badge already uses. It carries an EMA
(`emaMs = emaMs*0.8 + perf.ms*0.2`) alongside the raw `{fps, ms}` and the
ladder's current `renderScale` — a smoother number than the raw per-second
average, for a compact always-on readout (`badge-perf`, e.g. `12.4 ms ·
0.75x`) next to the garden's existing fps badge. Same honesty rule as
PERF-0's badge: it always reflects whatever is actually rendering.

### Garden quality selector (PERF-2)

The garden topbar gained a quality `<select>` (Auto/Low/Medium/High,
persisted to `localStorage['sg.garden.quality']`). **Auto** is exactly
PERF-0's pre-existing adaptive ladder — unset, it behaves byte-identically to
every garden render before this feature shipped. **Low/Medium/High** each
pin two things at once: a fixed `renderScale` (`0.5`/`0.75`/`1` — calling
`setRenderScale()` disables the ladder for that mount per its own contract,
so switching back to Auto goes through `rh.rebuild()` instead of trying to
resurrect ladder state runtime-host already tore down) and a shader-side
`SG_QUALITY` uniform (`0`/`1`/`2`) applied via the runtime's existing custom-
uniform channel — no new plumbing, no recompile. `scene.glsl`'s `SG_QUALITY`
scales `sg_march`'s step count (88/66/44) and `sg_cloud_fbm`'s octave count
(3/2/1) via an early `break` inside each function's still-fixed-bound loop —
High hits the exact same loop bounds every pre-PERF-2 render used, so nothing
changes when the uniform goes unused. The garden organ sets this uniform
explicitly on every build (including a context-loss rebuild, where a fresh
`GL2Runtime` starts with no custom uniforms at all), so "never set" never
actually reaches a live frame.

### Terrain-ceiling march skip + garden perf harness (PERF-2)

Independent of the quality selector, `sg_march` gained an exact (not
approximated) early-out: once a ray is strictly ascending (`rd.y > 0`) and
already above the highest point the current `TERRAIN_SCALE` can ever
produce, the terrain heightfield — a 5-octave noise call, the single most
expensive thing in the march, evaluated unconditionally every step — is
analytically unreachable for the rest of that ray, so it's skipped rather
than computed and discarded. Verified pixel-identical (0/921600 bytes
differing) against the pre-optimization scene at five fixed `iTime` samples.
`tools/test/garden-perf.mjs` is the dedicated forced-sync harness for this
scene (perf.mjs only covers baked `kernels.json` entries, and the garden
isn't one) — same SwiftShader-headless ordinal caveat as perf.mjs applies;
it measures each `SG_QUALITY` level, not the terrain skip in isolation.

### onLost:'rebuild' circuit breaker (PERF-3)

`runtimeHost()`'s automatic-rebuild policy (`onLost:'rebuild'`, the default —
see § "Adaptive quality" above) had no bound: a freshly (re)built WebGL2
context that itself loses immediately drove `onContextLost` straight back
into another `build()` with nothing to stop it. Empirically reproducible
against a cold `#/garden` boot on this project's own headless SwiftShader
setup — a completely isolated `#/garden`-only page load reproduces
`WebGL: CONTEXT_LOST_WEBGL` on essentially every fresh context, no
cross-organ interference required. On a machine busy enough that WebGL2
context setup itself gets slow, "lose, rebuild, lose again" could compound
into an effectively unbounded stall with no exception, no rejection, and
nothing left to observe it — confirmed directly: with the breaker removed,
a deterministic repro (force `WEBGL_lose_context` on every canvas the
instant it's created) drove over 2,300 rebuild attempts in 8 seconds with
no sign of stopping.

`MAX_LOSS_REBUILDS` (5) caps consecutive losses inside a `LOSS_WINDOW_MS`
(5000) sliding window; tripping it disposes the runtime and settles into a
stable failed state (`backend: null`, `ok: false`, an explanatory `log`)
instead of retrying forever. The window resets on its own once real time
passes without another loss, so sparse genuine driver hiccups over a long
session never approach the cap — only a rapid burst does. `onLost:'release'`
and a caller-supplied `onLost` function are unaffected (each already runs
exactly once per loss); only the plain-string `'rebuild'` policy retries
automatically, so only it needed bounding.
`tools/test/runtime-host-loss.mjs` is the regression test — same
`WEBGL_lose_context` technique, asserting the breaker trips within a bounded
number of attempts rather than coercing real driver flakiness.

### Transport controls (ED-3)

`editor/surfaces/transport.js` adds pause/step/scrub, resolution scale, and a
screenshot button to `#/edit`, wired directly to the active runtime — it holds
no clock state of its own, so a mode switch just re-syncs to whatever runtime
replaced the old one (`onRuntimeReady`). The clock (`runtime/uniforms.js`)
gains `seek(t)` (absolute jump, frame count untouched — a scrub isn't "an
advance") and `step(dt = 1/60)` (manual single-frame advance while stopped —
what the "Step" button drives, and what makes `iFrame` provably advance by
exactly one). Screenshot: `renderOnce()` draws synchronously for WebGL2; for
WebGPU the frame is submitted to the queue before the function's first
`await`, so calling `canvas.toBlob()` right after `renderOnce()` — without
awaiting `onSubmittedWorkDone()` — captures the just-submitted frame in the
same task. This is the documented fallback from the ED-3 design doc; it was
not re-verified against `onSubmittedWorkDone()`-gated capture in a real
browser (this repo's headless test harness has no `navigator.gpu`).

Share links gain additive, optional `t` (seconds), `paused` (`1`), and
`scale` params — `#/edit?...&t=30&paused=1&scale=0.75`. Older deployments that
only read `src`/`lang`/`k` ignore them harmlessly. `#/edit` also accepts
`&line=<n>` (1-based, clamps to the last line) to focus a source line on
load — the mechanism GARDEN-0's probe panel opens into.

### Inspection + recording (ED-4)

`editor/surfaces/uniforms.js` is a **read-only** uniforms inspector docked
top-right of the canvas pane: a regex usage-scan of the current source
against the five contract identifiers (GLSL: `iResolution`/`iTime`/
`iTimeDelta`/`iFrame`/`iMouse`; WGSL: `U.res`/`U.time`/`U.dt`/`U.frame`/
`U.mouse`) decides which rows render, so the panel shows exactly what the
shader actually reads — never the full fixed five. The scan re-runs after
every debounced compile (`pipeline.js`'s `onCompiled` hook), and a 10 Hz
`setInterval` reads live values straight off `runtime.getClock()` — no
polling when the panel is empty (`box.hidden`). A **Freeze iMouse** toggle
calls the runtime's `freezeMouse()`/`unfreezeMouse()` (detach/reattach the
pointer listeners `runtime/uniforms.js`'s `attachMouse` installed) so an
author can hold a pose while tuning the rest of the shader. No value editing
in v2 — that's the deferred custom-uniform system (§9 of the editor design).

`editor/surfaces/record.js` adds a **Record** button next to Screenshot:
`canvas.captureStream(30)` + `MediaRecorder` at the best available webm
codec (vp9 > vp8 > bare `video/webm`, feature-detected via
`MediaRecorder.isTypeSupported`), 10 s hard cap, no settings UI. A second
click (button reads `Stop (Ns)` with a live countdown) stops early; either
path downloads a `shader-garden.webm` via a temp `<a download>`, same
pattern as the screenshot button. Un-cut per blueprint ruling C13 (record
was flagged "first to cut" in the original design; the A1 amendment removed
that flag — export was the single highest-ranked demand-evidence gap). If
`captureStream`/`MediaRecorder`/a webm mime type is unavailable, the button
renders **disabled** with a `title` explaining why, instead of failing
silently on click — verified headlessly by deleting `window.MediaRecorder`
before the module loads (`tools/test/smoke.mjs` (o)). The **real** path is
also verified headlessly, empirically: chrome-headless-shell under
SwiftShader does support `captureStream`+`MediaRecorder` against a live
WebGL2 canvas (confirmed by probing it directly before writing this code —
unlike `navigator.gpu`, this is not a WebGPU-only capability), so
`smoke.mjs` (n) records a real ~1.3 s clip off the editor's own canvas and
asserts a non-empty `video/webm` blob (intercepted at the
`URL.createObjectURL` boundary, since headless has no download directory to
inspect).

A mode switch tears down the canvas mid-recording (`disposeRuntime()` calls
`recorder.destroy()` first) — an in-flight recording never survives a
context swap it can't produce meaningful frames for.

## The Garden (GARDEN-0)

`#/garden` is a single raymarched GLSL scene (`assets/garden/scene.glsl`)
made of named, probe-able components — a tengine-probe homage, and the one
route in the site meant to teach by letting you click on what you're
curious about. GL2-only by design (`prefer: 'webgl2'` in the organ's
`runtimeHost()` call) — a WGSL port is future work, not a v2 requirement.

### Annotation convention

`scene.glsl` is plain Shadertoy-style GLSL (same `mainImage`/`iResolution`/
`iTime`/... contract as every other kernel) with one addition: a comment
convention that `js/organs/garden/parse.js` reads at load time.

```glsl
// @component <id> "<display name>" "<one-line blurb for budding developers>"
...glsl...
// @end
```

Marks a chunk of source as one probe-able component. `<id>` is a lowercase
slug (`terrain`, `character`, ...); component **numeric** ids — the ones
actually encoded in a probe frame's pixel — are assigned by file order
(first `@component` seen is id 1, and so on). `scene.glsl`'s own
`COMP_SKY`/`COMP_TERRAIN`/`COMP_CHARACTER`/`COMP_SHADOW` constants must stay
in that same order; nothing enforces this at build time (there is no build
step), so keeping the numbers in file order is a hand-honored invariant, not
a generated one — `tools/test/smoke.mjs`'s three-different-panel check is
the regression oracle for it.

```glsl
// @tune <NAME> <min> <max> <default> "<label>"
uniform float <NAME>;
```

Declared inside a `@component` block, immediately above the `uniform float`
it drives. `parse.js` collects these into that component's `tunes[]`; the
probe panel renders them as range sliders. Moving a slider calls
`runtime.setUniforms({ [NAME]: value })` directly — no recompile, no
`setShader()` round-trip. Tune values are seeded from their declared
defaults at mount and re-applied in `runtimeHost`'s `onChange` callback, so
a context-loss rebuild (a fresh `GL2Runtime`, fresh uniform state) doesn't
silently reset a slider the visitor already moved.

### Probe protocol

On click (a pointerup within a small pixel radius of the matching
pointerdown — anything farther is treated as the orbit-drag gesture, both
reading the same canvas), `js/organs/garden/probe.js` does, synchronously:

1. `runtime.setUniforms({ uProbe: 1 })`.
2. `runtime.renderOnce(clock.time)` — `mainImage` takes an early-return
   branch that writes the hit component's numeric id into the red channel
   (`compId / 255.0`, exact at 8-bit precision for the handful of ids in
   play) instead of shading the pixel.
3. `gl.readPixels()` the clicked pixel off the same canvas context
   (`canvas.getContext('webgl2')` returns the existing context, not a new
   one — no extra plumbing needed to reach the drawing buffer).
4. `runtime.setUniforms({ uProbe: 0 })` and a second `renderOnce()` to
   restore the normal frame before the browser's next paint.

All four steps run in one JS task with no `await` between them, so the
id-encoded frame is never actually presented — the canvas only ever shows
normally-shaded frames.

The panel that opens shows the component's display name, its blurb, the
exact source chunk `parse.js` extracted between its `@component`/`@end`
markers, its live `@tune` sliders, and an "open in editor" link that
compresses the **whole** `scene.glsl` (via `share.js`'s `compress()`, once
per mount) into `#/edit?src=<b64>&lang=glsl&line=<component start line>` —
riding the `&line=` mechanism ED-3 added to the editor.

### Bus contract

The garden organ emits exactly one event of its own, `garden.probe.opened.v1`
(`{ component: <slug>, route: '/garden' }`), plus the same
`backend.selected.v1`/`runtime.lost.v1` every `runtimeHost()`-mounted organ
gets for free. Nothing chattier — no per-frame telemetry, no slider-drag
events.

## Admission

Third-party shader source (currently: a `#/edit?src=` share link — anything
that didn't ship in `assets/kernels.json` or come from the local user's own
typing) is screened before it's allowed to autorun on a visible runtime.
`js/organs/admission/index.js` exports the pipeline's one entry point:

```js
admit(source, { language, surface, shaderId?, budgetMs?, onProgress? }) // -> Promise<AdmissionReport>, resolves ALWAYS
policyFor(surface) // -> { staticTier, sacrificial, autorunOn: Verdict[] }
recentAdmissions() // -> last (up to 100) garden.admission.evaluated.v1 envelopes — ADM-D's operator-mode export (Anatomy) reads this
```

No bus request/reply — `admit()` is a plain async function call, and it is
the ONLY emitter of `garden.admission.evaluated.v1` (source
`/garden/admission`) on `core/bus.js`. ADM-A landed the static tier
(`organs/admission/static.js`, the SG-Sxx rule set): a hard-reject
(SG-S01..S07, wrapper-subversion and contract violations) reports `VF`
before any GPU is touched.

ADM-B adds the sacrificial tier for surfaces where `policyFor(surface)
.sacrificial` is true (`share-link`/`suggestion`/`embed` — `editor-self`
stays static-only, G5: idle costs zero, and it's the user's own GPU):

- **WGSL** spawns `organs/admission/sac-worker.js`, a dedicated **module**
  worker (a deliberate departure from admission.md's "classic worker"
  framing — ruling C8 requires the sacrificial compile to import
  `runtime/wrap.js`, an ES module shared with the visible runtimes, so the
  compile is byte-for-byte identical; a classic worker can only
  `importScripts()`, which would force a duplicated prelude — exactly the
  drift C8 exists to prevent. Dedicated-worker WebGPU only ships on engines
  that also support module workers, so nothing is lost). The worker
  requests its own adapter/device, compiles into a headless 64×64
  `rgba8unorm` texture (32×32 when `SG-S20` unbounded-loop fired), renders
  3 frames at t=0.0/1.5/5.0, and reads back the t=1.5 frame — no
  `OffscreenCanvas` needed for WebGPU. `index.js` owns the watchdog on the
  main thread and never trusts the worker to self-report a hang: context
  1000 ms / compile 2500 ms / frame 800 ms (400 ms halved) with no
  heartbeat inside the deadline → `worker.terminate()` → verdict `TLE`. The
  full verdict precedence is reachable: `CE` (compile/pipeline validation
  error, carries the verbatim `getCompilationInfo`/error-scope log),
  `RE` (worker fatal or `device.lost`), `MLE` (an `out-of-memory` error
  scope around resource creation), `WA` (frame rendered but the t=1.5
  readback is degenerate — near-black or a single quantized color), `OK`
  otherwise. If the worker itself has no usable WebGPU (`navigator.gpu`
  absent, or no adapter) it reports back to the orchestrator instead of
  failing, and `index.js` falls through to the compile-only ladder below
  (admission design §6.1).
- **GLSL** (ADM-C) spawns the same `sac-worker.js`, this time opening an
  `OffscreenCanvas` `webgl2` context — WebGL2-in-worker is baseline, so
  unlike WGSL this path runs for real under headless SwiftShader. It
  compiles+links the wrapped fragment shader against a fixed fullscreen-
  triangle vertex shader (kept byte-identical to `webgl2.js`'s `VERT_SRC`
  by hand — boilerplate, not user source, so ruling C8's drift concern
  doesn't apply), sets the five uniforms per frame, and reads back frame 1
  (t=1.5) via `readPixels` — row-flipped to match the WGSL path's
  orientation before `index.js` computes metrics. `readPixels` is the one
  point a pathologically slow shader actually blocks the worker's own
  thread; the orchestrator's frame-deadline watchdog lives on the main
  thread and never depends on that call returning, so `worker.terminate()`
  still resolves the page's `admit()` promise on schedule regardless.
  `gl.getError() === OUT_OF_MEMORY` after the frame loop is the best-effort
  GL2 substitute for WebGPU's `out-of-memory` error scope (GL2 has no
  scope-based equivalent). If the worker lacks `OffscreenCanvas`/WebGL2
  entirely, or any WGSL run finds no worker WebGPU, both fall through to
  the **window-side compile-only ladder**: a real compile against a
  throwaway, unattached context — `<canvas webgl2>` for GLSL, a second
  `GPUDevice` for WGSL. No frame/readback phase there, so the verdict caps
  at `OK`/`CE` with finding `SG-S30` (frames unverified). A compile error
  still carries the verbatim log either way.

Degenerate output (near-black, near-white, or a single quantized color —
`color_diversity <= 1/256` catches both uniform extremes) reports `WA`,
`safe:true`, and appends finding `SG-S40: degenerate-output` so the report
names why. True NaN cannot survive either backend's 8-bit
unorm/`UNSIGNED_BYTE` readback (implementation-defined finite conversion
on write), so it is documented as manifesting through the same
near-uniform signature rather than as a distinct check.

`js/organs/admission/report.js` (ADM-C) renders the full report (design
§9) — verdict badge with a hover legend spelling out the vocabulary,
findings as a plain list, the verbatim compile/worker log, the 64×64
preview upscaled `pixelated`, a static/compile/frames timing strip, and a
"Copy verdict JSON" button. `js/editor/admission-gate.js` runs the full
pipeline against every `#/edit?src=` source before the editor's first
autorun and uses this report as the scrim: on a verdict outside
`policyFor('share-link').autorunOn` (currently `['OK', 'WA']`), the source
still loads into the editor (learning is never gated) but the runtime does
not compile it, until either (a) the user's own first edit clears the scrim
and the session becomes an ordinary editor-self session, or (b) — ED-4 —
the user clicks the report's **"Run it"** button, which runs the exact
admitted source as-is (`index.js`'s `runAnyway()`, passed through
`gateShareLink`'s third parameter into `report.js`'s `onRun`). `report.js`
only renders "Run it" when `report.safe && !admitted` — under the live
policy table `autorunOn` is exactly the safe-verdict set (`OK`/`WA`), so a
real share link never actually lands in that state today; the wiring exists
so it activates automatically if that policy ever narrows (e.g. a future
surface distinguishing "safe" from "worth an explicit look first"), without
another editor-side change. `tools/test/smoke.mjs` (p) proves the wiring end
-to-end by stubbing `organs/admission/index.js` over the wire to force the
state, rather than only asserting `report.js`'s pre-existing button renders
in isolation.

Editor-self typing is never gated: `editor/pipeline.js` runs the same
`checkStatic()` on every compile and folds its findings into
`setDiagnostics` as advisory-only entries — same rule set, two severities,
per the one-static-tier rule (no duplicate SG-Sxx checks anywhere else in
the tree). `policyFor('editor-self').sacrificial` stays `false` for that
per-keystroke path (G5 — idle costs zero, nothing auto-invokes the
sacrificial tier on a keystroke); ADM-D's "Check shader" button (§ below) is
the one deliberate exception, an explicit user click, never automatic.

**Headless-test reality.** WebGPU never executes headlessly (Chrome
SwiftShader is GL2-only), so the WGSL sacrificial worker's real compile/
render/watchdog behavior against an actual GPU cannot be exercised by
`tools/test/*.mjs` — only real-browser verification (the launch checklist's
browser matrix) covers it. WGSL's TLE path is proven via a stubbed worker
that never heartbeats, reachable only via a private test-only `admit()`
option (`tools/test/admission-sac.mjs`). **GLSL is different: WebGL2-in-
worker runs for real under headless SwiftShader**, so its whole verdict
model is empirically exercised end-to-end — CE (real compile error), OK
(real clean render + metrics), WA (a genuinely all-black kernel), and TLE.
The GLSL TLE case uses a *real* runtime-infinite loop, not a stub: ANGLE's
shader translator rejects a literal `while(true){}` with no reachable
`break` as a **compile error** ("Infinite loop detected in the shader") —
empirically confirmed, not assumed — so the test instead uses a loop with
a `break` that is syntactically present but never taken at runtime
(`while(true){ x+=k; if (x<0.0) break; }` where `x` only increases). This
also slips past `static.js`'s own `SG-S20` regex (which only excuses a
`break`-shaped loop from the "unbounded" finding by presence, not
reachability — a known, `§12`-deferred limitation, not a surprise) — good,
because it means the TLE test exercises the watchdog itself, not the
static screen's imperfect safety net. Confirmed empirically: the
orchestrator's `admit()` promise resolves `TLE` on the main thread on
schedule (bounded by the frame deadline) regardless of whether the
worker's underlying native GL call ever returns, because the watchdog's
`setTimeout` lives on the main thread and never awaits the worker.
`admission-sac.mjs` runs this specific case in its own short-lived browser
instance with a hard process-kill fallback after `close()`, since a
genuinely hung GPU-process command can outlive graceful browser teardown.

### Suggestion + "Check shader" + operator export (ADM-D)

`js/editor/index.js` gains a **"Check shader"** toolbar button: an explicit,
on-demand call to `admit(source, { surface: 'editor-self', forceSacrificial:
true, ... })`. `forceSacrificial` is the one opt-in override to
`policyFor('editor-self').sacrificial` (which otherwise stays `false` for
every OTHER caller, per G5) — nothing on the typing path ever sets it; only
this button's click handler does. The full `AdmissionReport` renders inline
via `organs/admission/report.js` into a `.check-report-host` element below
the code pane — **never a scrim**, because this is a tool the user reaches
for, not a gate on anything they're doing. The result is cached as
`{source, lang, report}`; any subsequent edit, mode switch, or buffer-tab
switch invalidates it (`invalidateCheck()`), matching the share-link scrim's
own "first edit reclassifies the session" pattern (§ above) in reverse.

**"Suggest for gallery" is disabled by default** and stays disabled until
the cached check both (a) exists and (b) matches the CURRENT source/language
exactly and (c) has `safe: true` (`verdict ∈ {OK, WA}`). Clicking it embeds
the cached verdict as a fenced ```` ```json ```` block in the GitHub issue
body it opens (`share.js:githubIssueUrl`), alongside the existing live-link/
language/description fields — the block is the full CloudEvents-lite
envelope (`garden.admission.evaluated.v1`) **minus `preview_png`** (a data:
URL would make the prefilled issue URL absurdly long; the live link already
lets a reviewer see the shader rendered). The home pipeline parses verdicts
straight out of issue bodies — this is the entire "upload," no backend
required (admission design §7.3/§8).

`tools/test/smoke.mjs`'s ADM-D section (r)/(s) proves this end-to-end under
real headless GLSL sacrificial admission (not a stub): Suggest starts
disabled, a clean starter's "Check shader" run enables it, the opened issue
URL's `body` param contains a parseable fenced block with `safe: true` and
no `preview_png` key, and the next keystroke re-disables Suggest. A hostile
SG-S02 source can still be typed freely (never blocked) but its on-demand
check reports `VF`/unsafe, and Suggest stays disabled.

**Operator-mode ring export.** `organs/admission/index.js`'s
`recentAdmissions()` (last up to 100 `garden.admission.evaluated.v1`
envelopes, a ring separate from `core/bus.js`'s own 256-entry ring) is read
by a new control in the Anatomy overlay (`organs/anatomy/index.js`),
rendered only when the real query string carries `?operator=1` (survives
hash routing — a URL flag on the author's own machine, admission design
§7.3). Clicking "Export admission ring (JSON)" dynamically imports the
admission module (module singleton — if the editor already ran any
admissions this session, the SAME ring is read; if not, the ring is
correctly empty) and downloads it via `share.js`'s new `downloadJson()`
helper (`Blob` + `URL.createObjectURL` + `<a download>`). Zero cost for
everyone else: the control doesn't exist in the DOM without the flag, and
nothing imports admission's ~21 KB module until this exact button is
clicked. `tools/test/smoke.mjs` (u)/(v) prove both directions: the control
renders and a real click produces a JSON array containing the session's
admission envelopes under `?operator=1`; it is entirely absent without it.

**The `shader.preadmit.evaluated.v2` proposal** (C10's schema-bump owner,
nervous-bus repo) is written at `docs/proposals/preadmit-v2.md` in THIS
repo — nervous-bus is read-only throughout ADM-D, never edited. The proposal
widens `data.language`'s enum to add `"wgsl"` (a major bump per nervous-bus's
own "breaking changes bump the major version" rule — an unhandled enum value
is exactly the failure a version bump exists to force consumers to notice),
names the five browser-only `AdmissionReport` keys that must NOT be added to
the schema (`surface`, `backend`, `stages`, `compile_log`, `preview_png`),
and backs the "a glsl envelope validates against v1 after stripping them"
claim with `tools/test/check_preadmit_v1_compat.py` — python3 `jsonschema`
against the REAL schema file at
`nervous-bus/schemas/shader.preadmit.evaluated.v1.json` (sibling checkout,
`$NBUS_ROOT` overrides; missing checkout degrades to an honest SKIP),
validating a REAL captured envelope (from smoke.mjs's own headless GLSL run,
not a hand-typed fixture), plus a negative control proving the check can
actually fail. The proposal also names a real gap found while preparing this
evidence: COMP-2's `admitComposition()` sets `kind: 'composition'`, which is
not in v1's `kind` enum — composed GLSL verdicts do not bridge today,
independent of the language question this proposal scopes to. Flagged, not
solved, in the proposal document.

## kernels.json

```json
{ "generated": "<RFC3339>", "kernels": [ {
    "id": "biome-rolling-hills",
    "title": "Rolling Hills — evolved biome",
    "description": "one line",
    "domain": "sdf | noise | terrain | phase | latent | sph | demo",
    "fitness": 0.9994, "generation": 32, "run_id": null,
    "author": "funsearch-autobench", "origin": "vault | shadertoy_evolved | handmade",
    "language": "glsl", "glsl": "<mainImage source>",
    "tags": ["evolved", "terrain"], "featured": true,
    "cost": { "avg_ms": 3, "heavy": true },
    "lineage": { "parents": [], "oracle": null, "eval_run_id": null, "preadmit": null, "gen_diff": null }
} ] }
```

`assets/wgsl/manifest.json` maps kernel ids to WGSL ports. The viewer uses
WebGPU when a port exists *and* `GPURuntime.create()` succeeds; the badge in the
corner always tells you which backend is actually rendering.

The bake is a gate, not a copy: every kernel is wrapped with the exact runtime
preamble and compiled with `glslangValidator` offline. If it doesn't compile
there, it doesn't ship.

`cost` is optional — present only when `bake_kernels.py --perf` was run
against a `tools/test/perf.mjs` report. `avg_ms` is the average forced-sync
render cost per frame at 640x360 (rounded); `heavy` is present (`true`) only
when that kernel's avg_ms exceeded 2x the run's median — omitted otherwise.
It's a ranking signal from whatever GPU ran the harness (SwiftShader in CI),
not an absolute fps guarantee for a user's real hardware. Not yet surfaced in
the viewer/gallery UI.

## Compositions (COMP-1, COMP-3)

`assets/compositions/<id>.json` — hand-authored (COMP-1's `hills-into-icefield`
demo) or baked from autobench artifacts (COMP-3's `bake_compositions.py`) —
describes a multi-pass render graph over existing gallery kernels:

```json
{
  "id": "hills-into-icefield",
  "title": "…",
  "description": "…",
  "domain": "composite",
  "passes": [
    { "kernel": "biome-rolling-hills", "target": "bufferA" },
    { "kernel": "phase-allen-cahn-demo", "target": "screen", "channels": ["bufferA"] }
  ]
}
```

`passes[].kernel` is an id from `kernels.json` — a composition never carries
its own shader source, only references. `target` is either `"screen"`
(exactly one pass must target it — the visible output) or an arbitrary buffer
name; `channels` lists target names bound as `iChannel0..` (COMP-0's contract)
in order. `feedback: true` marks a pass that also reads its own `target` —
ruling C12's one legal cycle (self-feedback, double-buffered); any other
cycle is illegal.

`assets/compositions/index.json` (`{ "compositions": ["<id>", ...] }`) lists
which per-id files exist — `core/registry.js`'s `loadCompositions()` fetches
it and then each listed `<id>.json`, resolving to `data.compositions: []` on
any failure (missing index, missing file, malformed doc). **Deleting the
whole `assets/compositions/` directory is a supported, tested configuration**
— the gallery renders kernel-only, the `#/s/:id` route simply never resolves
a composition id, and nothing else changes.

**DAG validation (ruling C12, SG-S08).** `runtime/composition-graph.js`'s
`validateComposition(passes)` builds the pass dependency graph from `channels`
references, verifies exactly one `screen` target, that every self-read is
declared `feedback: true` and every `feedback: true` pass IS a self-read, and
rejects any cycle other than a single pass's self-loop — returning a
topological pass order on success. This is the SAME algorithm the admission
static tier's **SG-S08** rule (`organs/admission/static.js`'s
`checkCompositionGraph()`) runs — one DAG check, two call sites, following
ruling C5's "one rule set" precedent. It lives in `runtime/`, not
`organs/admission/`, purely for budget reasons: the admission organ's byte
budget was already near its COMP-0 cap, and gallery/viewer must never pull in
admission bytes for an ordinary kernel visit.

**Playback.** The viewer (`organs/viewer/index.js`) resolves `#/s/:id` against
kernels first, then compositions — same route, same region. A composition
match dynamic-imports `organs/viewer/composition-player.js`, which plays the
graph on **raw WebGL2** (not `GL2Runtime` — a composition needs N compiled
programs alive simultaneously, swapped per pass every frame with zero
recompiles, which doesn't fit `GL2Runtime`'s one-`_program` design, and that
file has no budget headroom left to grow one in). Each pass gets its own
offscreen `RGBA8` texture+framebuffer (`feedback: true` gets a ping-pong
pair, identical convention to `GL2Runtime.createTarget`/`renderTo`); the
`screen` pass draws to the canvas. WebGPU composition playback is not
implemented in COMP-1 — headless never runs WebGPU regardless, and a
multi-pass WebGPU player is its own future item, not a squeeze-in here; the
composition route always shows a WebGL2 badge.

**Provenance.** The viewer emits `composition.opened.v1`
(`{ shader_id, title, description, passes, route }`) instead of
`kernel.opened.v1` for a composition resolution. `organs/provenance/index.js`
subscribes to both: `kernel.opened.v1` renders the existing single-kernel
metadata panel; `composition.opened.v1` renders the pass graph as an ordered
list, one node per pass, each linking to `#/s/<kernel>` — following a link
lands on that kernel's own single-kernel view, showing **that kernel's own
lineage** through the same panel (there is no second, recursive graph — the
accept criterion "each node deep-linking … with its own lineage" is this
existing render path, reached normally).

**Gallery.** `organs/gallery/index.js` renders one card per composition
alongside kernel cards, tagged with a `composition` chip and a
"`N` passes" badge; its thumbnail is a `thumbs.js` render of the
composition's own `screen`-pass kernel alone (a true composited thumbnail is
future work — showing the screen pass in isolation is honest about what's
displayed, not a placeholder).

### The evolved-compositions bridge (COMP-3)

`tools/bake_compositions.py` consumes `kernel.composition.ready.v1`-shaped
artifacts — the nervous-bus composition oracle event (READ-ONLY reference
schema: `nervous-bus/schemas/kernel.composition.ready.v1.json`; this repo
never depends on nervous-bus at runtime or in CI) — and, for every artifact
that structurally validates, reports `ready: true`, and whose two run ids
resolve against the current `kernels.json`, bakes a composition manifest,
updates `assets/compositions/index.json`, and tags the reaction-side kernel
`channel-source` in `kernels.json`.

**No live nervous-autobench run emits this event yet.** The bridge instead
reads fixture artifacts from `tools/fixtures/composition_ready/*.json` — the
exact shape a real bus consumer would receive, minus the transport. One
fixture ships today (`phase-into-mountain-peaks.json`), baking
`assets/compositions/phase-into-mountain-peaks.json`: `vault-91e87215`
("Allen-Cahn Phase Map — evolved gen 16", the SAME reaction-diffusion kernel
`FAMILY_DESC` in `bake_kernels.py` already describes as a "reaction term")
feeds `biome-mountain-peaks` ("Mountain Peaks — evolved biome") as
`iChannel0` — both are real, already-evolved kernels already shipping in
`kernels.json`; nothing about their GLSL was authored for this bridge. As
with COMP-1's demo, the screen-pass kernel does not itself sample `iChannel0`
in its body yet — that's COMP-2 territory (per-pass admission + editor buffer
tabs); this composition is "genuinely evolved" in the sense that matters at
this stage: it is backed by real oracle fitness data, not an arbitrarily
paired plumbing test.

**RESOLUTION CONVENTION (this bridge's own design choice, not part of the
nervous-bus schema).** The schema leaves `data.terrain_run_id` /
`data.reaction_run_id` free-form ("identifier for the … run/result source").
`bake_compositions.py` requires them to be exact `kernels.json` kernel `id`
values. A real nervous-autobench emitter has no visibility into
shader-garden's curated ids today and almost certainly cannot satisfy this
directly — see the nervous-autobench bead this PR's report names for the two
resolution strategies weighed (autobench-native ids + a `bake_kernels.py`-
style fitness/domain cross-reference backfill, vs. shader-garden exposing a
lookup autobench queries before emitting).

**`provenance` block.** Every COMP-3-baked composition carries an additive
`provenance` object alongside `passes` (COMP-1's hand-authored demo has none
— `null`-safe throughout):

```json
"provenance": {
  "oracle": "/autobench/composition_oracle",
  "event_id": "01JZFIXTURE0COMP3PHASEMTN0",
  "terrain_domain": "terrain", "reaction_domain": "phase",
  "terrain_fitness": 0.9998, "reaction_fitness": 1.0,
  "composition_fitness": 0.9421, "gate_threshold": 0.85, "ready": true
}
```

**Provenance panel: per-node fitness.** `organs/provenance/index.js`'s pass
graph looks up each pass's member kernel in the SAME roster Map SUB-6's
lineage block already builds and renders that kernel's own `fitness` next to
its node (`.meta-graph-fitness`) — a straight lookup, never recomputed, and
NOT gated on a `provenance` block existing (COMP-1's demo composition gets
this too, since both its member kernels carry real `fitness`). When
`provenance.composition_fitness` is present, a composition-level oracle
summary line (`.meta-oracle`) also renders above the graph.

**Gallery: the channel-source / composition filter.** `#gallery-filters`
(three buttons: All / Compositions / Channel sources) filters already-
rendered cards via `dataset.kind` (`'kernel'` | `'composition'`) and
`dataset.channelSource` (set when a kernel's `tags` includes
`channel-source`) — a plain DOM show/hide, no re-fetch. A channel-source
kernel's own card also carries a `channel source` badge in its normal grid
position under "All".

### Editor buffer tabs + per-pass admission (COMP-2)

`#/edit` grows Image + up to 4 buffer tabs (`A`–`D`) + a Common include —
GLSL only (no WGSL multi-pass player exists anywhere in this tree, same
scope line COMP-1's composition player already draws). **Must-not-break
(§7.1): buffers are invisible until the user reaches for them.** With zero
buffers, `editor/buffers.js`'s `.buffer-bar` renders nothing but a single
low-key "+ Buffer" control — no `.buffer-tabs`/`.buffer-channels` row exists,
and every other DOM node the single-pass path builds (toolbar, canvas pane,
code pane) is byte-for-byte what it was pre-COMP-2. `tools/test/comp2.mjs`
(1) asserts this structurally (child classlists, not literal pixels, per the
work item's own acceptance wording) — the "+ Buffer" control itself is a
deliberate, documented exception: a feature with no way to reach it isn't
"invisible until reached for," it's absent.

**One CM/textarea document, many stored sources.** `editor/buffers.js` owns
all the source text (`common`, the Image pass, each buffer) plus each pass's
`channelSlots` (4 iChannel dropdowns, values are other buffer ids — `screen`
is never a valid selection, same SG-S08 rule COMP-1 established); a buffer
selecting itself as a channel auto-derives `feedback: true` (C12's one legal
cycle), so the UI cannot construct the invalid states SG-S08 checks for by
construction. `editor/index.js` still owns the single mounted doc adapter —
switching tabs saves the outgoing tab's live text into `buffers.js` and loads
the incoming tab's stored text, exactly the same "one runtime per canvas"
discipline the language toggle already uses.

**Live multi-pass rendering.** `editor/composition-runtime.js` is a sibling
of `organs/viewer/composition-player.js` (same ping-pong/target/raw-WebGL2
conventions) but LIVE-EDITABLE: `recompilePass(id, fullSource, channelSlots)`
hot-swaps one pass's program in place. A body-text edit of the active tab (or
Common, which every pass's `fullSource` embeds) debounces into a
`recompilePass()` call; a STRUCTURAL edit (add/remove a buffer, rewire a
channel) fully remounts the runtime instead — cheap enough at this scale, and
it sidesteps ever running the fixed render `order` against a stale target
map. `editor/index.js` hides the transport/uniforms-inspector/recorder
surfaces while composition mode is active (a documented scope line — those
three are single-runtime-shaped this cycle, not wired to the composed
graph); the mode toggle (GLSL/WGSL) is locked while any buffer exists.

**Admission.** `organs/admission/index.js`'s `admitComposition(passes, opts)`
mirrors `admit()`: SG-S08 (`checkCompositionGraph`, shared with COMP-1) first,
then the SG-Sxx static tier **per pass** (findings prefixed `[<passId>]`,
never blocking on `editor-self` — composed admission only ever runs on the
`share-link` surface, same as the single-pass gate; the user's own buffer
typing is never gated), then **one** sacrificial-worker invocation
(`sac-worker.js`'s `op:'run-composition'`) that plays the WHOLE graph through
a single OffscreenCanvas WebGL2 context — one worker spawn, one watchdog
window per composite frame, matching the single-pass budget model instead of
blowing it with N separate `admit()` calls. **Any pass's CE/RE/TLE/MLE
verdicts the WHOLE composition** — a hung buffer blocks that composite
frame's `drawArrays`/`readPixels` exactly like a hung single-pass shader
blocks its own, and the SAME main-thread, worker-independent watchdog
terminates it (§ Admission's `runGlsl` discussion applies verbatim; only the
per-frame body changed, not the watchdog). Composed budget: **≤ 1.5× the
single-pass 1.5 s happy path** (§7.5) — one hard wall-clock ceiling
(`TOTAL_BUDGET_MS_COMPOSITION`, 6 s) scaled the same way. `tools/test/comp2.mjs`
(3) proves the TLE/RE propagation empirically with a real per-pass hang (the
identical `while(true){x+=k; if(x<0.0) break;}` non-provably-terminating
shape `admission-sac.mjs` uses for the single-pass case, for the same ANGLE-
compile-time-rejection reason documented there) and confirms the page stays
interactive and a later `admit()` still works.

**Share links (`&v=2`, additive).** The frozen v1 format
(`#/edit?src=<b64>&lang=<mode>`) is untouched; a multi-pass link adds
`&v=2` per editor-organ.md §8's own sanctioned mechanism ("if the encoding of
`src` ever changes, a `v=2` param is introduced; absence of `v` means v1
semantics forever"). `editor/multipass-share.js` reuses `share.js`'s exact
`compress`/`decompress` (same deflate-raw transport, same 256 KiB
`MAX_DECOMPRESSED_BYTES` cap) — the payload is JSON
(`{common, image:{src,channels}, buffers:[{id,src,channels}]}`) instead of a
bare string. A v1 link (no `v` param) never reaches this code path — decoded
exactly as before. `tools/test/comp2.mjs` (4) round-trips a composition
byte-for-byte and confirms a real navigation to the minted link boots
straight into composition mode, admits, and renders without a scrim (a clean
composition's verdict is `OK`, inside `policyFor('share-link').autorunOn`).

**Known scope lines (not bugs, documented once here):** composition mode has
no context-loss rebuild (single-pass mode's `onContextLost` handler isn't
wired to `composition-runtime.js`); the FPS badge stays blank in composition
mode (no `onPerf` surface on the composed renderer); `&t=/&paused=/&scale=`
share params are read only on single-pass links; "Suggest for gallery" always
submits whatever the currently-focused tab shows, not the whole composition
(a full composition-suggestion flow is future work, not a COMP-2 accept
line) — this is unchanged by ADM-D's Suggest-gating (§ Admission above): the
gate checks the same "currently-focused tab" source a "Check shader" run was
performed against. None of these affect the four COMP-2 accept criteria.

### kernels.json lineage (SUB-6)

Every kernel carries a `lineage` block bake_kernels.py derives ONLY from
data it already fetches — the vault API's raw generation history
(`fetch_vault()`'s response, indexed by `_index_evolved_by_family_run()`
BEFORE curation drops most generations) and each kernel's own
fitness/generation/run_id. No new data source, no fabricated genealogy.
Facts the vault has no field for at all are always `null` rather than
guessed:

```json
"lineage": {
  "parents": ["vault-3194c636"],
  "oracle": null,
  "eval_run_id": "01KT8CC4",
  "preadmit": null,
  "gen_diff": { "prev_generation": 0, "fitness_delta": 0.0441,
                "lines_added": 12, "lines_removed": 4, "similarity": 0.822 }
}
```

- **`parents`** — earlier-generation vault snapshots from the SAME
  family+run, even when `curate_vault()`'s own curation (best-per-run /
  top-N) dropped that earlier generation from the final kernels.json
  roster. Ids follow the same `vault-<8 hex>` shape as every other kernel
  id, so the provenance panel can test membership directly against the
  baked roster. **Most parents will NOT resolve** — curation keeps one
  survivor per run, so its immediate ancestor is almost never also in
  kernels.json — and render as plain text instead of a `#/s/` link. That's
  the expected common case on real data today, not a bug: see
  `tools/bake_kernels.py`'s own `[bake] lineage: …` log lines for the
  actual matches on the last run.
- **`oracle` / `preadmit`** — always `null`. The vault API
  (`/api/portal/vault/shaders`) carries no oracle identifier and no
  admission verdict for ANY entry (its schema is `author, backend_config,
  code, created_at, id, language, title, updated_at` — nothing else); the
  admission organ only ever evaluates third-party/foreign source (share
  links, embeds), never the curated gallery. Documented gaps, not
  omissions.
- **`eval_run_id`** — alias of the FunSearch run id (same value as the
  kernel's own top-level `run_id`). `null` when the vault's OWN title
  format for that entry never carried a run at all — the singleton
  `[family] genN — FunSearch fit=X` title format
  (`phase`/`latent`/`sph`/`rolling_hills`/`sdf`) has no `run=` field,
  period; this is a real gap in the vault's own data, not something
  bake_kernels.py failed to parse.
- **`gen_diff`** — line-level diff (`difflib.SequenceMatcher` over the raw,
  unnormalized vault code) between this kernel and its nearest
  earlier-generation parent, plus the fitness delta. `null` when no earlier
  generation exists in the vault fetch (every singleton pick) or the
  "parent" isn't a genuine same-shape code ancestor (the biome backfill
  below never populates this — see why there).

**Biome kernel backfill.** The five `biome-*` kernels and the combined
`phase-allen-cahn-demo` come from a static local file
(`tools/shadertoy_evolved.glsl`), not the vault, so they carry no run
history of their own. `_biome_backfill()` cross-references each one's
hardcoded `fitness` against the SAME vault fetch by family name + fitness
match (tolerance `LINEAGE_FITNESS_EPS = 5e-4`):
- `biome-rolling-hills` (fitness 0.9994) matches the vault's own
  `[rolling_hills] gen32` entry → backfills `generation: 32`.
- `phase-allen-cahn-demo` (fitness 1.0) matches `[phase] gen16` — the SAME
  evolved Allen-Cahn kernel the combined demo credits in its own header
  comment → backfills `generation: 16`.
- `mountain_peaks`, `volcanic_plateau`, `eroded_badlands`, and
  `river_valley` have **no corresponding vault family at all**. The vault
  genuinely never recorded per-generation history for those four biomes —
  their `generation` stays `null` and their `lineage` is all-null. This is
  a real gap in the source data, not a bake_kernels.py bug.

A fitness match backfills `generation`/`run_id`/`eval_run_id` only —
`parents` and `gen_diff` stay empty/null for every biome-family kernel,
because the vault's raw code for that entry is a bare function snippet, not
the same document shape as the biome's fully-assembled kernel; diffing the
two would compare apples to oranges rather than report a real ancestor.

The provenance panel (`js/organs/provenance/index.js`) renders whatever
subset of `lineage` is non-null and shows nothing at all when it's
entirely null — partial lineage never throws, by construction.

## Seed embed (`<shader-seed>`)

`<shader-seed kernel="biome-rolling-hills">` plus one `<script type="module"
src=".../assets/seed/seed@1.js">` plays an admitted kernel on any third-party
page — zero build step on the host side, zero backend. This is the ONE
frozen contract in the system (full spec: the v2 design doc's seed.md §2).
SEED-1 (work item 15) shipped the `kernel=`-only skeleton; SEED-2 (work item
16) added the courtesy ladder: `MAX_LIVE` concurrency cap + LRU posterize,
the FPS degradation ladder, the shared poster-runtime, the
`speed`/`t0`/`mouse`/`max-dpr` live-retune attributes, `sg-play`/`sg-pause`,
and the executable conformance page. SEED-3 (work item 20) adds the
`src=`/`href=`+`unsafe` foreign-source tier, `sg-admit`, `integrity`, and
the attribution chip. SEED-4 (work item 22, this section) is polish + docs:
the `embed.html` snippet generator, the SRI publishing-flow's standing
ledger-verification guarantee, a battery enhancement, touch attribution, and
the `seed.js` major-version alias. **Nothing on the main site imports or
depends on this subsystem** — the gallery/editor are unaware it exists; the
viewer organ is the ONE exception (its "Copy embed code" button, SEED-3);
`embed.html` is a standalone doc page, not a route any organ links to.

**Files:**

```
site/js/seed/element.js       <shader-seed> custom element (SEED-1/2/3/4)
site/js/seed/runtime.js       forked GL2 runtime (see "Why a fork", below)
site/js/seed/poster-runtime.js shared hidden-canvas poster runtime (SEED-2, seed.md §4.4)
site/js/seed/share-codec.js   forked compress/decompress + b64url (SEED-3, ruling C8)
site/assets/seed/<id>.json    one per admitted kernel, emitted by bake_kernels.py
site/assets/seed/seed@1.js    FLOATING baked artifact — the URL a host's
                               <script> tag points at, regenerated every bake
site/assets/seed/seed.js      SEED-4: "latest major" alias — same bytes as
                               seed@1.js by construction, every bake
site/assets/seed/seed@<x>.<y>.<z>.js  PINNED point release — immutable once
                               shipped (see "Versioning & seed-freeze" below)
site/embed/contract.html      executable conformance page (seed.md §2.5)
site/embed/releases.json      machine-readable release ledger (sha384/bytes/date)
site/embed/embed.html         SEED-4: human docs — kernel picker, snippet
                               generator (floating or SRI-pinned), a live
                               preview, the attribute reference table, and
                               CSP notes (seed.md §3.1/§9)
```

**SEED-1 scope (kernel= tier only), unchanged this stage:** `kernel`,
`garden`, `poster`, `autoplay` (`visible`|`click`|`off`) attributes; the
poster chain; lazy start via a shared `IntersectionObserver`
(`rootMargin:'200px'`); `document.visibilitychange` pause/resume;
`prefers-reduced-motion` → static poster with click-to-play; one silent
context-loss rebuild attempt, second loss posterizes permanently;
`sg-ready`/`sg-error`/`sg-poster` events.

**SEED-2 additions (this stage):**
- **`MAX_LIVE=4` + LRU posterize** (seed.md §4.3): a module-level
  `playingSeeds` Set caps concurrent live contexts page-wide. Each seed
  stamps `_lastEnterTime` on (re)intersection; a 5th seed wanting to play
  evicts whichever currently-playing seed has been on-screen longest without
  a fresh intersection (`sg-pause{reason:'budget'}` → snapshot → dispose,
  cited verbatim from seed.md §4.3).
- **FPS degradation ladder**: `SeedRuntime.onFps` samples ~1 Hz; 5
  consecutive samples `<24fps` halves the render-scale DPR (`setDprScale`);
  5 more consecutive samples `<12fps` *after* that posterizes
  (`sg-pause{reason:'fps'}` then `sg-poster{reason:'budget'}` — the only
  transition that fires both events, since the poster event's frozen reason
  enum lacks `'fps'` but the play/pause enum has it).
- **Shared poster runtime** (`poster-runtime.js`, a thumbs.js lift): ONE
  hidden, parked canvas + ONE `SeedRuntime` for every still-frame render.
  The cold-start non-autoplay path and reduced-motion/`t0`-retune stills all
  compile+render through this shared context instead of each element
  spinning up (and immediately tearing down) its own — `_showPosterFrame`
  always renders at `t0`; `_posterize` (off-screen timer, MAX_LIVE eviction,
  FPS ladder, manual `posterize()`) snapshots the *live* canvas's current
  frame instead, deliberately not `t0`. Disposed after 10s idle.
- **Live-retune attributes**: `speed` (clock multiplier; `0` pins the clock
  to `t0`), `mouse` (`"x,y,z,w"`, pins `iMouse` for non-interactive kernels),
  `max-dpr` (clamped `[0.5,2]`) all retune the already-compiled runtime in
  place — no rebuild, no second `sg-ready`. `t0` retunes only a settled
  still (a currently *playing* seed's clock is left alone on a `t0`
  mutation — a live jump is a startling glitch the frozen contract never
  promised either way; a judgment call, not a spec requirement).
- **`sg-play`/`sg-pause` events**, reasons `visible`/`hidden`/`gesture`/
  `api`/`budget`/`fps` per seed.md §2.3.
- **`fps` getter** now returns the real last ~1 Hz sample (SEED-1 stubbed 0).

**SEED-3 additions (this stage, seed.md §5/§6/§7):**
- **`src=`/`href=` + `unsafe` foreign-source tier.** `src=` is raw GLSL
  `mainImage` text; `href=` is a garden share URL
  (`#/edit?src=<b64url>&lang=glsl`, share.js's format, decoded via the
  forked `share-codec.js`). Neither runs without the deliberately-ugly
  `unsafe` attribute present — without it, the seed refuses outright: poster
  + `sg-error{code:'unadmitted'}`, no fetch/decompress/compile attempt at
  all. `kernel=` still wins priority if more than one is set.
- **Forced-click autoplay for unsafe source.** `_shouldAutoplay()` returns
  `false` unconditionally for the unsafe tier regardless of the `autoplay`
  attribute — "no drive-by GPU load" (seed.md §5.2). A poster click, an
  attribution-chip click while parked, or an explicit `play()` call all
  still work (they route around `_shouldAutoplay()` entirely).
- **No-rebuild-on-context-loss for unsafe source.** `_onContextLost()` gates
  the existing one-silent-rebuild policy on `!wasUnsafe` — a baked kernel
  still gets one rebuild attempt before permanent posterize; unsafe source
  gets NONE, ever (a TDR-triggering kernel must not re-TDR on a rebuild
  cycle). Verified empirically in `tools/test/seed.mjs` clause (f) via a
  real `WEBGL_lose_context` call.
- **`sg-admit`** (ruling C7): a bare `shader.preadmit.evaluated.v1`-
  compatible data block (`shader_id` = sha256-b64url of the resolved GLSL
  text, `language:'glsl'`, `kind:'fragment'`, `safe`, `verdict:'OK'|'CE'|
  'RE'`, `crash_risk`, `static_findings:[]` always, optional
  `render_metrics.fps_1s`) fired as a DOM `CustomEvent` — no bus code in the
  seed, per the seed's own non-goals. Fires once per LIVE compile attempt of
  unsafe source only: `CE` immediately on a failed compile, `OK`/`safe:true`
  once the live runtime survives ~60 frames (checked on the existing ~1 Hz
  `onFps` sampler), `RE`/`crash_risk:'context_loss'` on a context loss.
  Never fires for baked kernels (pre-admitted by the bake) or for the cold
  poster-only compile (a single still frame isn't a "survived 60 frames"
  claim).
- **`integrity="sha256-<b64>"`**: hashes the RESOLVED GLSL text (works
  identically across all three source tiers) with `crypto.subtle.digest`
  before compiling; a mismatch is poster + `sg-error{code:'integrity'}`, no
  compile attempt. A malformed attribute value fails open (doesn't block).
- **Attribution chip**: a `🌱 shader garden` link in the shadow root
  (`::part(attribution)`), `attribution="hover"|"always"|"off"` (default
  `hover`), deep-linking to `<site>/#/s/<id>` for `kernel=` or a freshly
  `#/edit?src=…&lang=glsl` share link for unsafe source (`href=` relays its
  own value verbatim; `src=` is compressed on the fly via the same forked
  codec). While parked on a poster waiting for a gesture
  (`autoplay="click"`/reduced-motion), a chip click doubles as that gesture
  instead of navigating. The chip's site-root resolution (`../../` from the
  `garden` base) is a documented judgment call — see the code comment on
  `siteRootFrom()` — not a graded contract clause.
- **Viewer "Copy embed code"** (`organs/viewer/index.js`): a topbar button
  next to "Copy link" that copies `<script type="module"
  src=".../assets/seed/seed@1.js"></script>` + `<shader-seed
  kernel="<id>">` for the currently-viewed kernel — the ONE place outside
  `js/seed/` that references the seed subsystem at all. Composition routes
  don't get the button (the seed has no multipass support).

**SEED-4 additions (this stage, seed.md §3.1/§4.3/§6, V2_BLUEPRINT.md work
item 22 — polish + docs, post-launch acceptable):**
- **`embed.html` snippet generator** (`site/embed/embed.html`): a standalone
  doc page, dependency-free, that fetches `../assets/kernels.json` (kernel
  picker) and `./releases.json` (the SRI ledger) and generates a copy-paste
  snippet for either the FLOATING URL (`seed@1.js`/`seed.js`, no integrity —
  auto-fixes in place) or the latest PINNED release
  (`seed@<x>.<y>.<z>.js` + `integrity="sha384-…" crossorigin="anonymous"`).
  A live `<shader-seed>` preview on the page itself renders whichever
  snippet is currently selected — the same element the textarea's text
  would produce, built from one shared `currentAttrs()` so the two can never
  drift. Also carries the attribute reference table and the CSP notes
  (seed.md §9), inlined so a host never has to leave the page. Zero
  dependency on the SPA core — the gallery/editor still don't know this
  page exists.
- **SRI publishing-flow verification** (`tools/bake_seed.py`'s
  `verify_ledger()`): every pinned `seed@X.Y.Z.js` already on disk must have
  a `releases.json` entry whose `sha384`/`bytes` match the file's ACTUAL
  current bytes — checked on EVERY bake, not just when a new version is
  minted, so the ledger `embed.html` reads from can never quietly drift from
  the files it describes. Hard-fails the bake on any gap or mismatch.
  `tools/test/seed.mjs` pins the same invariant independently (Node-side,
  reading the files and recomputing sha384 itself) so a hand-edited
  `releases.json` can't slip past the test suite either.
- **Battery enhancement** (seed.md §4.3): feature-detected
  `navigator.getBattery` [assumed — Chromium-only], zero cost everywhere the
  API is absent (the flag it sets, `batteryLowDischarging`, simply never
  flips true). While discharging below 20%, `_shouldAutoplay()` treats
  `autoplay="visible"` (the default) as if it were `"click"` — prefer
  posterize-earlier (never spin up live GPU work uninvited) over draining a
  low battery for a courtesy animation. A click/`play()` still bypasses it,
  identically to the existing `unsafe`/reduced-motion gates.
- **Touch attribution** (seed.md §6): the attribution chip is normally
  hover-only (`opacity:0` outside `:hover`/`:focus-visible`), which a
  touch-only pointer can never satisfy. A `touchstart` listener on the
  shadow root (fires only for touch input — no feature check needed, zero
  cost for mouse/trackpad) reveals the chip for 3s so a touch user can see
  the deep link exists before tapping it; a tap that lands directly on the
  (already-clickable, opacity notwithstanding) chip still navigates
  immediately either way. `attribution="always"`/`"off"` are unaffected.
- **`seed.js` alias** (`tools/bake_seed.py`): every bake writes
  `site/assets/seed/seed.js` with the SAME bytes as the floating
  `seed@1.js` — the "latest major" URL seed.md §3.1 describes, made true by
  construction (one write producing both files) rather than by two files
  happening to agree. `check_seed_freeze.py` already named `seed.js` as an
  exempt floating file before this file existed.

**Still deferred**: the `interactive` pointer→iMouse pipeline (a real
semantic addition — scroll-jacking risk — not a courtesy tweak; not part of
SEED-4's scope).

**Why a fork, not an import (ruling C8).** `site/js/seed/runtime.js` does NOT
import `site/js/runtime/{webgl2,uniforms,wrap}.js` — it carries its own copy
of the GLSL prelude/epilogue and the GL2Runtime class, trimmed of what an
embed never needs (custom `setUniforms()`, compiler-diagnostic line remap,
pointer→iMouse wiring). The seed's contract is frozen for the life of major
version 1; the site's live runtime is not. `tools/bake_seed.py` diffs the
forked `GLSL_PRELUDE`/`GLSL_EPILOGUE` strings against the current
`site/js/runtime/wrap.js` on every bake and **warns** (does not fail) on
drift.

**Kernel JSON resolution.** A seed's `garden` attribute defaults to
`new URL('.', import.meta.url)` — the directory containing the seed script
itself. The kernel JSON URL is `<garden>/<id>.json`. Because the canonical
bake writes `seed@1.js` and every `<id>.json` into the same
`site/assets/seed/` directory, the zero-config default already resolves
correctly for the hosted deployment.

**Build: concatenation, not bundling.** `tools/bake_seed.py` strips
`import ... from '...'` declarations and the `export` keyword from
`runtime.js`, `poster-runtime.js`, `share-codec.js`, and `element.js`,
concatenates them (that dependency order — element.js imports the other
three, poster-runtime.js imports runtime.js, share-codec.js has no deps of
its own) into one module scope, and writes `site/assets/seed/seed@1.js`.
No minifier — readable, unminified source ships. Budgets (hard-fail,
matching `tools/check_budgets.py`):

| Item | Budget |
|---|---|
| `seed@1.js` raw | ≤ 40 KiB hard-fail, 32 KiB warn (raised from 28/24 KiB by SEED-3) |
| `seed@1.js` gzip (level 9) | ≤ 13 KiB hard-fail (raised from 9 KiB by SEED-3) |
| `element.js` LOC (excludes the forked `runtime.js`) | ~450 target / 900 max (raised from 720 by SEED-3's unsafe tier + sg-admit + integrity + attribution chip) |
| `poster-runtime.js` LOC | ≤ 150 |
| `share-codec.js` LOC | ≤ 90 (SEED-3, new file) |
| per-kernel JSON (`assets/seed/<id>.json`) | ≤ 64 KiB typical, warn > 128 KiB |

SEED-2 landed at raw≈27.5 KiB / gzip≈8.5 KiB, already above the then-24 KiB
warn line and flagged in this doc as needing exactly this tradeoff for
SEED-3. SEED-3 lands at raw≈37.3 KiB / gzip≈11.7 KiB — inside the raised
hard cap with real headroom (≈9%/≈12%) but still above the raised 32 KiB
warn line (see the bake's own `[bake_seed] WARN` line, an accepted,
precedented state — SEED-2 shipped the same way). The raise is a
blueprint-level number (V2_BLUEPRINT.md §4), not a per-file convenience
cap — bump it again only with the same sign-off, not silently in SEED-4.
SEED-4's battery enhancement + touch attribution land at raw≈38.9 KiB /
gzip≈12.3 KiB (`element.js` 865/900 LOC) — inside the SEED-3 caps with real
if narrowing headroom (≈3%/≈6%); this stage deliberately did NOT need to
raise them again, so the caps above are still the SEED-3 numbers.

**Versioning & seed-freeze (SEED-2, seed.md §3.1).** Every bake overwrites
the FLOATING `seed@1.js`. A PINNED `seed@<major>.<minor>.<patch>.js` is
written once per `SEED_VERSION` and is then immutable: re-baking the same
version with different bytes **fails the bake**; a new version bumps
`SEED_VERSION` and ships a new pinned file. `.github/workflows/seed-freeze.yml`
enforces the same rule from the git-diff side on every PR touching
`site/assets/seed/**`, calling `tools/check_seed_freeze.py`, which classifies
a `git diff --name-status` for Modified/Deleted/Renamed pinned files (newly
Added ones are a legitimate new release). The script's own logic is
unit-tested with `python3 tools/check_seed_freeze.py --selftest` — no git
history required. Each newly-pinned release appends one entry to
`site/embed/releases.json` (`{version, file, sha384, bytes, date}`), the
ledger `embed.html`'s SRI guidance points at (SEED-4). `verify_ledger()`
(also SEED-4, same script) re-checks EVERY entry against the actual file
bytes on disk on every bake, not just the newly-minted one — the ledger
can't drift out from under the docs page that reads it.

**Per-kernel JSON** (`site/assets/seed/<id>.json`, emitted by
`bake_kernels.py`'s `emit_seed_assets()` in the same run that writes
`kernels.json` — one validation gate, two artifacts; a kernel dropped by
`glslangValidator` appears in neither):

```json
{
  "v": 1, "id": "biome-rolling-hills", "title": "Rolling Hills — evolved biome",
  "language": "glsl", "glsl": "<mainImage source>",
  "author": "funsearch-autobench", "origin": "shadertoy_evolved",
  "admitted": { "gate": "glslangValidator", "baked": "<RFC3339>" }
}
```

Stale JSON for a kernel that's since been dropped or renamed is deleted on
the next bake, so a stale embed 404s honestly instead of serving retired
source.

**Conformance page** (`site/embed/contract.html`, seed.md §2.5): renders one
`<shader-seed>` per contract clause and asserts events/DOM with inline
script — default autoplay, `autoplay="click"`/`"off"`, live-attribute
retuning (never rebuilds), the `speed="0"` clock freeze (asserted on the
runtime clock directly, not by pixel-diffing the canvas — a raymarched
kernel's visible delta over a short window depends on camera framing and is
flaky under headless SwiftShader contention with several concurrent
contexts; the clock is the actual thing `speed` controls and is
deterministic), the imperative API + every event reason, an `sg-error` path,
`MAX_LIVE=4` + LRU eviction with 6 real seeds (SEED-2, clauses A-H), and
(SEED-3, clauses I-O) `src=` without `unsafe` refusing outright, `src=`/
`href=`+`unsafe` forced-click + `sg-admit` OK/CE verdicts,
`integrity` match/mismatch, and the attribution chip's deep link +
`attribution="off"`. Sets
`window.__conformanceDone`/`__conformanceFailed`/`__conformanceResults` for
headless polling; also renders human-readable PASS/FAIL text if opened
directly in a browser.

**Test coverage:** `tools/test/seed.mjs` (headless, `browser.mjs` helpers)
serves the site on one origin and a static fixture
(`tools/test/fixtures/foreign-seed/`) on a second, CORS-enabled origin
(`browser.mjs`'s `serveSiteCors`) to prove the embed actually works
cross-origin: exactly one module + one kernel JSON fetched, fetch dedup
across same-kernel seeds, zero WebGL2 contexts while off-screen (instrumented
via `HTMLCanvasElement.prototype.getContext`, with a same-page control
proving the instrumentation isn't a false negative), poster-only + zero rAF
frames under `prefers-reduced-motion` (with click-to-play still working),
the not-found failure path resolving to the poster box, driving
`embed/contract.html` headless and asserting every clause passed (SEED-2/3),
and (SEED-3) two more real-browser checks contract.html can't reach on its
own: (f) a REAL `WEBGL_lose_context` call on a playing unsafe seed never
triggers a rebuild — `sg-ready`'s count is snapshotted right before the loss
(not assumed to start at a fixed value: whether a click lands before or
after the element's own no-autoplay poster-settle path is a real,
pre-existing SEED-1/2 timing race unrelated to context loss, so the fired
count going in can legitimately be 1 or 2) and asserted UNCHANGED by the
loss itself; `backend` stays disposed, state never returns to `playing`
(falls back to a stated code-verified check if the extension is unavailable
headless, which it is not under this repo's SwiftShader setup); (g) the
viewer's "Copy embed code" button's clipboard
text, replayed VERBATIM on a fresh blank page via a monkey-patched
`navigator.clipboard.writeText`, reaches `playing` — proving the copied
snippet is a genuinely working embed, not just plausible markup. SEED-4
adds four more checks in the same file: (h) `embed.html`'s snippet
generator — the floating snippet AND the SRI-pinned snippet each drive a
live, actually-`playing` preview on the page itself, each snippet's exact
copied text replays to `playing` on a fresh blank page (same bar as (g)),
and a corrupted `integrity=` hash genuinely blocks the module
(`customElements.get('shader-seed')` stays undefined) — proving `integrity=`
is real browser-enforced SRI, not decoration the generator merely prints
(the literal accept line: "embed.html generates a snippet that passes the
conformance page"); (i) every pinned `seed@X.Y.Z.js` on disk has a
`releases.json` entry whose sha384/bytes match its actual current bytes,
recomputed independently in Node (no dependency on `bake_seed.py`'s own
`verify_ledger()` agreeing with itself); (j) with `navigator.getBattery`
mocked to report discharging below 20% — the ONLY page in this file that
mocks it, everywhere else exercises the real "API absent" path — a
default-autoplay seed never leaves `poster` on its own, and a click still
plays it; (k) a synthetic `touchstart` reveals the (otherwise hover-only)
attribution chip immediately and it fades back within ~3s.

## Service worker

Precached app shell (cache-first), stale-while-revalidate for `kernels.json`
and WGSL ports. As of v2 substrate SUB-4, precache is the core chain that
runs on every route (`core/{boot,bus,loader,registry,layout}.js`,
`assets/{organs,layout}.json`, `js/share.js` — boot.js imports it eagerly)
plus static shell assets. Every organ (`js/organs/gallery/*`,
`js/organs/viewer/*`, `js/organs/provenance/*`, `js/organs/admission/*`,
`js/editor/*`), `core/runtime-host.js`, `js/runtime/*`, and
`js/vendor/cm-editor.bundle.js` are lazy and intentionally absent from the
precache (idle-costs-zero) — a route that never needs a GPU canvas never
fetches a runtime, a visit that never opens `#/edit` never fetches the
editor bundle, and a visit that never resolves a `provenance` placement
never fetches that panel either; the SW's `fetch` handler falls through to a
plain network request (uncached, same as any other lazy organ file) rather
than caching it on first use. Two more guards worth knowing:

- Cache names are prefixed `shader-garden-` and activation deletes only that
  prefix — GitHub Pages project sites share one origin, and clobbering a
  sibling app's caches is a rude bug.
- The cache version is stamped with the commit SHA at deploy time
  (`SW_BUILD_PLACEHOLDER` in `sw.js`, substituted by the deploy workflow), so
  every deploy invalidates cleanly without anyone remembering to bump a string.

On `localhost`/`127.0.0.1` the worker refuses to cache at all, and
`sw-register.js` refuses to register it — development always sees fresh files.
