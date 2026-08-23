#!/usr/bin/env python3
"""Check budget caps on site JS files and the multiplayer relay."""

import os, glob, sys

FILES = [
    ("site/js/core/bus.js", 120, None),
    # 140 -> 195: SUB-4 (v2 blueprint §6 item 11) — layout.json `placements`
    # activation (syncPanels(), the tryMount() helper it shares with
    # activate(), and the panelActive/panelRegion/panelGen bookkeeping for
    # the provenance panel and any future panel organ). Raised deliberately,
    # this commit.
    ("site/js/core/loader.js", 195, None),
    ("site/js/core/registry.js", 60, None),
    ("site/js/core/layout.js", 150, None),
    # PERF-0 (2026-07-03): +30 LOC for the adaptive-quality ladder — raised
    # 90 -> 120 deliberately, noted in the ED-3+PERF-0 commit message.
    # 120 -> 132: PERF-2 (2026-07-04) — maxDpr passthrough to the webgl2
    # tryWebgl2() helper, plus an EMA over onPerf's ~1Hz ms samples and an
    # opts.onPerf callback so a mount (the garden) can show an honest
    # ms/frame + renderScale HUD.
    # 132 -> 145: GARDEN-1 — rebuild(overrides) lets a caller (the garden
    # organ's editing seam) permanently pin a mount onto a specific backend.
    # Both raises land in the same wave-2 merge. Actual 135/145.
    # 145 -> 180: PERF-3 (2026-07-04) — a circuit breaker on onLost:'rebuild'
    # (MAX_LOSS_REBUILDS/LOSS_WINDOW_MS, the loss-counter state, and the
    # onContextLost handler's tripped/give-up branch) — fixes a cold-boot
    # stall where a context that loses immediately on every rebuild retried
    # forever with nothing to observe it. Lands on top of GARDEN-1's cap in
    # this cherry-pick. Actual 168/180. Raised deliberately.
    # 180 -> 195: wave-4 fallback-fragility fix — a canvas's context type
    # locks in on first getContext() call, so a WebGPU attempt that gets a
    # context but then fails to compile/link left build()'s WebGL2 fallback
    # attempt with nowhere to go (same canvas, second context type, always
    # null) — the site landed on "no GPU" instead of degrading cleanly.
    # build() now swaps in a fresh canvas for the WebGL2 attempt whenever a
    # WebGPU attempt was actually made. Found via real-GPU verification (this
    # repo's headless suite has no navigator.gpu to have caught it either
    # way). Actual 186/195. Raised deliberately.
    # 195 -> 205: scoping the rebuild wipe to the host's OWN canvas needs
    # ownCanvas state threaded through build()/fallback-swap/dispose plus the
    # comment explaining why a shared host element cannot be blanket-wiped.
    # 205 -> 218: PERF-4 gives the adaptive ladder a rung BELOW the resolution
    # floor. Pinned at FLOOR and still under LOW_FPS, it now calls the new
    # optional opts.onQualityStep(-1) instead of giving up, and hands quality
    # back before resolution on the way up. That is a second branch in each
    # arm of ladder() plus the opts contract line. Actual 215/218.
    ("site/js/core/runtime-host.js", 218, None),
    # 60 -> 95: SUB-5 (v2 blueprint work item 14) — the one shared keydown
    # listener overlay organs (anatomy) hang a hotkey on, plus the
    # organ.open.v1 command listener and toggleOverlay()'s mount/cleanup.
    # substrate §9's own budget table already named this boot.js's charter
    # ("organs.json fetch, hotkeys, repo-link/sw glue"); the 60 LOC figure
    # there just predated hotkeys actually landing. Raised deliberately,
    # this commit.
    ("site/js/core/boot.js", 95, None),
    ("site/js/organs/gallery/index.js", 320, None),
    ("site/js/organs/viewer/index.js", 220, None),
    # 240 -> 265: ED-2 (CodeMirror doc-adapter pick + editorKind threading,
    # design doc's own stage-4 estimate is ~250 LOC) merged with ED-3
    # (transport surface wiring: row mount, onRuntimeReady, &line=, share
    # query) — both landed on this file in the same v2 wave.
    # 265 -> 300: ED-4 (v2 blueprint work item 17) — mounts the uniforms
    # inspector + record button, the "Run it" consent wiring (runAnyway(),
    # passed into gateShareLink), and the shader.compiled.v1 onCompiled
    # emission. Raised deliberately, this commit; the organ-total aggregate
    # below is the real ceiling (≤ 1500 LOC per the design's ED-4 accept
    # line) and has ample headroom.
    # 300 -> 460: COMP-2 (v2 §7.3 item 25) — composition-mode wiring
    # (enterCompositionMode/exitCompositionMode/mountCompositionRuntime/
    # recompileActivePass/bootComposition, the multi-pass share button
    # branch, the buffer-tab-aware onChange callback) alongside the
    # untouched single-pass path. The organ-total aggregate below is still
    # the real ceiling; this file's own cap is raised to match its actual
    # size headroom. Raised deliberately, this commit.
    # 460 -> 520: ADM-D (v2 blueprint work item 18) — the "Check shader"
    # toolbar button (on-demand full admit() for editor-self, forceSacrificial),
    # its inline report host, the invalidateCheck() staleness guard wired at
    # every edit/mode-switch/tab-switch site, and the Suggest handler's
    # rewrite to embed the fenced verdict envelope (minus preview_png) and
    # gate on a fresh safe verdict. Actual 506/520. Raised deliberately.
    ("site/js/editor/index.js", 520, None),
    # 120 -> 175: COMP-1 (v2 §7.3 item 24) — composition pass-graph rendering
    # (renderComposition()) alongside the existing single-kernel view, plus a
    # second bus subscription (composition.opened.v1). 120 -> 200: SUB-6 (v2
    # blueprint work item 19) adds the lineage block (parents/oracle/
    # eval_run_id/preadmit/gen_diff rendering) as its own clearly-delimited
    # function + one call site. Both sections are additive (pass graph +
    # lineage block, kept as separate render paths per the merge resolution);
    # cap raised again at merge to cover the combined total. Raised
    # deliberately.
    # 235 -> 260: COMP-3 (v2 §7.3 item 26) — per-node fitness in the pass
    # graph (reuses SUB-6's kernel-roster Map instead of a second fetch) plus
    # a composition-level oracle summary line (bake_compositions.py's
    # `provenance` block) and the async onCompositionOpened() fallback that
    # populates the roster on the bus re-navigation path. Raised
    # deliberately, this commit.
    # 260 -> 280: wave-4 Area D3 — the multi-pass mechanism explainer in
    # renderComposition(), gated on passes.length > 1 (a single-kernel /s/:id
    # view via renderKernel() is a separate path, untouched). Actual 268/280.
    # Raised deliberately, this commit.
    ("site/js/organs/provenance/index.js", 280, None),
    ("site/js/organs/anatomy/index.js", 300, None),
    # wave-4 Area E: the DGC/producer-consumer teaching overlay (Shift+D) —
    # own organ, own budget row, kept out of the garden aggregate (§0.5 of
    # the wave-4 blueprint: none of the tight existing aggregates had room).
    # Renders one card per garden component + one directed-edge SVG (mirrors
    # anatomy's own card/edge substrate) plus the dispatch-order list and the
    # mandatory teaching disclaimer. Actual 145/250. Raised deliberately,
    # this commit.
    ("site/js/organs/dgc-graph/index.js", 250, None),
    # SEED-1 (V2_BLUEPRINT.md item 15): ~450 LOC target / 600 max, excluding
    # the forked runtime (site/js/seed/runtime.js, uncapped here — it's a
    # deliberate byte-for-byte snapshot per ruling C8, not first-party code
    # to trim; its size is covered by the seed@1.js row below instead).
    # 600 -> 720: SEED-2 (V2_BLUEPRINT.md item 16) — courtesy ladder adds
    # MAX_LIVE+LRU eviction, the FPS degradation ladder, four live-retune
    # attributes (speed/t0/mouse/max-dpr), and sg-play/sg-pause emission.
    # 720 -> 900: SEED-3 (V2_BLUEPRINT.md item 20) — src=/href=+unsafe tier,
    # forced-click autoplay + no-rebuild-on-loss for it, sg-admit (+hash
    # helpers), integrity, the attribution chip (DOM+CSS+deep-link
    # resolution). Actual 813/900. Raised deliberately, this commit.
    ("site/js/seed/element.js", 900, None),
    # SEED-2: shared hidden-canvas poster runtime (seed.md §4.4, a
    # thumbs.js lift) — new file, not part of the forked runtime.js.
    ("site/js/seed/poster-runtime.js", 150, None),
    # SEED-3: forked verbatim from site/js/share.js (ruling C8, seed.md
    # §3.2) — decompress for href=, compress for the attribution chip's
    # src= deep link. New file, not part of runtime.js.
    ("site/js/seed/share-codec.js", 90, None),
    # SEED-3 raised this from 28 KiB — see tools/bake_seed.py's own
    # RAW_HARD_BYTES comment for the full rationale (same sign-off as the
    # rest of the budget table, not a silent per-file bump).
    ("site/assets/seed/seed@1.js", None, 40 * 1024),
    # GARDEN-0: organs.json stays inside its 4 KiB assets row.
    ("site/assets/organs.json", None, 4096),
    # COMP-0 (v2 §7.5, item 23): iChannel plumbing + render-to-texture.
    # post-ADM-A baseline was 350/350 LOC each; budget is baseline + 120/130.
    # 470 -> 480: PERF-2 — constructor takes an optional {maxDpr} so a
    # per-mount cap (e.g. the garden's raymarch) can pin tighter than the
    # site-wide DEFAULT_DPR_CAP. Actual 472/480. Raised deliberately.
    # 480 -> 620: MP-4 (multiplayer-spec.md §6.1) — prepareShader() compiles
    # into a side program (KHR_parallel_shader_compile polling on a rAF loop,
    # synchronous-link fallback otherwise) so a remote commit can never blank
    # this client's world (I4); setShader() is refactored on top of it as
    # prepare+immediate-commit, split into _beginPrepare/_finishPrepare/
    # _commitProgram so both entry points share one swap path. Actual
    # 586/620. Raised deliberately, this commit.
    ("site/js/runtime/webgl2.js", 620, None),
    # 480 -> 580: GARDEN-1 (garden-webgpu wave 2) — setUniforms()'s WGSL
    # equivalent (a custom-uniform bank + name registry) and readPixel()
    # (the offscreen probe-readback primitive: a second rgba8unorm pipeline
    # + copyTextureToBuffer/mapAsync path), both needed to run GARDEN-0's
    # scene on this backend at all. Actual 565/580. Raised deliberately,
    # this commit.
    # 580 -> 700: MP-4 (multiplayer-spec.md §6.1) — prepareShader() compiles a
    # side pipeline pair without touching the live one, stamped with a
    # `_prepareSeq` so a slow prepare can't commit stale state over a
    # later-made one's commit; setShader()'s pipeline-building body is
    # factored out into _compilePipeline/_commitPipeline so both entry
    # points share one swap path. Actual 637/700. Raised deliberately, this
    # commit.
    ("site/js/runtime/webgpu.js", 700, None),
    # wrap.js also rolls up into the admission aggregate below (net -30 from
    # runtimes, per the admission budget); this row is the COMP-0 hard cap.
    # 70 -> 115: GARDEN-1 adds the `@sg-uniforms` directive parser
    # (wgCustomUniformNames) + accessor-function generator (genCustomAccessors)
    # that wrapWgsl() now injects — webgpu.js's WGSL side of setUniforms().
    # Actual 108/115. Raised deliberately, this commit.
    # 115 -> 150: the multiplayer bank raise (32 -> 128 slots). The added
    # lines are the derived vec4f count, the loud-overflow throw that
    # replaced a silent .slice(), and the comment explaining why 32 was
    # never a real constraint -- the reasoning is the point, since treating
    # that number as fixed is what produced a wrong spec ruling.
    # Actual 137/150. Raised deliberately, this commit.
    ("site/js/runtime/wrap.js", 150, None),
    # COMP-1 (v2 §7.3 item 24): DAG validation shared by the composition
    # player and admission's SG-S08 rule — kept OUT of the admission
    # aggregate below (its byte budget was already near its COMP-0 cap) since
    # this is genuinely a runtime/ concern, not admission-only.
    ("site/js/runtime/composition-graph.js", 110, 5120),
    # COMP-1: raw-GL2 multi-pass composition player. Bypasses GL2Runtime
    # (also at its COMP-0 cap) with its own compile/link/cache so a
    # composition's N passes can hold N live programs at once, swapped per
    # frame with zero recompiles — see the file's own header for why.
    ("site/js/organs/viewer/composition-player.js", 220, None),
    # COMP-1: the one hand-authored demo composition — "typical" cap from
    # V2_BLUEPRINT.md §7.5 ("composition JSON <= 2 KiB typical").
    ("site/assets/compositions/hills-into-icefield.json", None, 2048),
    # COMP-3 (v2 §7.3 item 26): the one evolved-composition-bridge output,
    # baked by tools/bake_compositions.py from tools/fixtures/
    # composition_ready/ — same "typical" 2 KiB cap as the COMP-1 demo.
    ("site/assets/compositions/phase-into-mountain-peaks.json", None, 2048),
    # Wave-4 §3 (attribution): hand-curated {kind, sourceKernel, note} per
    # garden component/variant — small structured data, same order as
    # organs.json's own 4 KiB row. Actual 747B.
    ("site/assets/garden/attribution.json", None, 4096),
    # Wave-4 §3: baked by tools/bake_garden_attribution.py — one {sha, date}
    # per component, never hand-edited. Actual 912B.
    ("site/assets/garden/attribution-commits.json", None, 8192),
    # Wave-4 §3: the /attribution organ — own cap, kept OUT of the garden
    # aggregate below since it's a standalone route, not garden-mount code
    # (see §0.5's headroom problem for why new surfaces get their own row
    # rather than piling into a tight aggregate). Actual 176/200.
    ("site/js/organs/attribution/index.js", 200, None),
]

AGGREGATES = [
    # 18432 -> 23040 bytes: SUB-4 adds core/layout.js (a whole new core
    # subsystem substrate.md didn't exist yet to size in) plus loader.js's
    # panel-placement activation. LOC stays inside the original 610 hard cap
    # (582 today) — only the raw-byte figure needed room; this repo's
    # comment-heavy style runs well above the ~30 bytes/LOC the original 18
    # KiB assumed. Raised deliberately, this commit.
    # 610 -> 660 LOC / 23040 -> 26624 bytes: SUB-5 (v2 blueprint work item
    # 14) raised for boot.js's hotkey/overlay wiring (incl. the navToken-style
    # `gen` counter that closes the mid-mount staleness gap for overlay
    # organs) and layout.js's `snapshot()` export for Anatomy's layout
    # inspector. COMP-1 (v2 §7.3 item 24) landed concurrently and adds
    # registry.js's loadCompositions() (best-effort assets/compositions/
    # resolution, same shape as the WGSL manifest fetch already there).
    # Combined at merge: actual 681 LOC / 26809 bytes; caps raised to
    # 700 LOC / 27648 bytes for headroom. Raised deliberately, this merge.
    # Wave-2 merge: PERF-2 (EMA/onPerf/maxDpr) + GARDEN-1 (rebuild
    # overrides) land in runtime-host.js together — each fit the old caps
    # alone, the union doesn't. Actual 699 LOC / 27924 bytes; raised to
    # 730 / 29184 for headroom. Raised deliberately, this merge.
    # 730 -> 750 LOC / 29184 -> 30720 bytes: PERF-3's onLost:'rebuild'
    # circuit breaker (see runtime-host.js's own cap comment) cherry-picked
    # on top of the wave-2 union above. Actual 729 LOC / 29934 bytes.
    # Raised deliberately.
    # 750 -> 765 LOC / 30720 -> 31744 bytes: wave-4's fresh-canvas fallback
    # fix (see runtime-host.js's own cap comment). Actual 745 LOC / 30827
    # bytes. Raised deliberately.
    # 765/31744 -> 780/32512: carries the runtime-host.js PERF-4 raise above
    # (the ladder's quality rung). The aggregate exists so a per-file bump
    # cannot quietly grow the core as a whole, so it moves WITH that row
    # rather than being loosened on its own. Actual 771 LOC / 32373 bytes.
    ("site/js/core/*.js", 780, 32512),
    # 31744 -> 35840 bytes: ADM-C (V2_BLUEPRINT.md item 13) adds the GLSL
    # sacrificial worker path (sac-worker.js) and the full report.js UI
    # (badge hover legend, findings, preview, timing strip, copy button) —
    # the LOC total (804/1020) has ample headroom, but this repo's
    # comment-heavy style runs well above the ~30 bytes/LOC the original
    # 31 KiB figure assumed (same mismatch SUB-4 hit on the core aggregate).
    # COMP-1's static.js changes (SG-S08 composition-graph re-export +
    # import) landed concurrently and pushed the combined total to
    # 825 LOC / 36105 bytes at merge; byte cap bumped again to 36864 for
    # headroom, LOC cap unchanged (well under). Raised deliberately.
    # 1020 -> 1150 LOC / 36864 -> 51200 bytes: COMP-2 (v2 §7.3 item 25) adds
    # sac-worker.js's op:'run-composition' (one worker spawn plays the WHOLE
    # composed graph so N buffer passes don't blow the composed admission
    # budget the way N separate admit() calls would) and index.js's
    # admitComposition()/runCompositionWorker() (SG-S08 + per-pass SG-Sxx +
    # the composed sacrificial watchdog). Actual at merge: 1093 LOC / 49426
    # bytes; caps raised for headroom. Raised deliberately, this commit.
    # 51200 -> 53248 bytes: GARDEN-1's wrap.js growth (see its own row above)
    # rolls up into this aggregate; LOC stays under the existing cap.
    # Actual 1137 LOC / 51763 bytes. Raised deliberately, this commit.
    # 1150 -> 1210 LOC / 53248 -> 55296 bytes: carries wrap.js's own raise above
    # (the 32 -> 128 uniform-bank change). The admission files in this
    # aggregate are untouched by that work; only wrap.js moved.
    # Actual 1166 LOC / 53693 bytes. Raised deliberately, this commit.
    ("site/js/organs/admission/*.js|site/js/runtime/wrap.js", 1210, 55296),
    # GARDEN-0 (v2 §8.29): the whole organ, one cap — parse/probe/panel/index.
    # 700 -> 1150: GARDEN-IDE "depth" wave — component tray + keyboard nav
    # (tray.js), the static connections analyzer (connections.js, has its own
    # node-only unit test outside this budget), per-component cost chips via
    # an explicit stub-and-time Measure action (measure.js), and terrain
    # stage/variant fetching (variants.js) + the probe panel's stage selector
    # and in-panel connections block. Four genuinely new surfaces landed
    # together, not bloat on the existing single-probe path (that path's own
    # tests in garden.mjs stay green — see the commit this shipped with).
    # Actual at merge: 1099/1150. Raised deliberately, this commit.
    # Wave-2 merge: the IDE spine (above), PERF-2's quality selector/HUD,
    # and GARDEN-1's dual-source mount + async probe land in this organ
    # together — each fit alone, the union doesn't. Actual 1253/1300.
    # 1300 -> 1400: wave-3 core (work items C/A/B landed together — connection-
    # pill hover, settle-hover probe + first-visit hint, and the modify-flow
    # toast/edited-chip/hierarchy fixes; D touched only scene.glsl/scene.wgsl,
    # budget-free, and F touched boot.js/dom.js, outside this row). Actual
    # 1358/1400. Raised deliberately, this commit.
    # 1400 -> 1570: wave-3 item E, the player controller — index.js's shared
    # move-vector rAF integrator (held-key state, the idle-exiting loop,
    # play-radius clamp, cleanup wiring) plus the new joystick.js (mobile
    # touch nub, gated on matchMedia('(pointer: coarse)'), feeding the same
    # vector). Actual 1521/1570. Raised deliberately, this commit.
    # 1570 -> 1650: wave-4 §A+B — index.js grows the shared move-vector
    # integrator with charYaw/gaitDist (bounded turn-rate + distance
    # accumulator) and adds the camera-mode state machine (select + keyboard
    # 1/2/3 + blend ramp + localStorage), all in the same file the player
    # controller already lives in. Actual 1611/1650. Raised deliberately,
    # this commit.
    # 1650 -> 1740: wave-4 Area D merged on top of §A+B — the new
    # uniform-inspector.js (live uniform-bank panel, 10 Hz poll,
    # engine/tunable grouping) plus index.js's topbar toggle button +
    # mount/cleanup wiring. Each slice was budgeted honestly from its own
    # worktree (A+B: 1611, D-alone: 1612 over the same 1521 base); this row
    # is the merged union. Actual 1702/1740. Raised deliberately, this merge.
    # 1740 -> 1860: wave-4 §3 (attribution) merged on top — the new
    # attribution.js (fetch+cache, ~70 LOC), panel.js's Origin block
    # (setOrigin + anchor, ~40 LOC), and index.js's wiring (attribution.js
    # import, the topbar link, the per-probe fetch+render call, ~15 LOC);
    # 1643/1650 from its own worktree over the same 1521 base. This row is
    # now all three wave-4 slices' union. Actual 1824/1860. Raised
    # deliberately, this merge.
    # 1860 -> 2950: the multiplayer wave (docs/multiplayer-spec.md). Pre-MP
    # this row sat at 1824/1860 — 36 LOC of headroom, so it could not absorb
    # a whole new subsystem. MP adds 995 LOC: three new client modules
    # (net.js 446, timesync.js 111, roster.js 80) and index.js's room wiring
    # (684 -> 992, all of it behind `if (room)`). Rather than let a single
    # slack aggregate hide future growth in any one of them, each MP module
    # AND index.js now carries its own row below — this aggregate stays the
    # organ-wide ceiling, those rows are the per-module guards. Actual
    # 2819/2950. Raised deliberately, this merge.
    # 2950 -> 3010: carries the MP-6 client work below (name input + rename,
    # role-aware HUD, panel clearing on the round edge, tray.collapse()). The
    # aggregate moves WITH the per-file row so a single file cannot grow the
    # organ silently. Actual 2955/3010 at the time of writing.
    ("site/js/organs/garden/*.js", 3010, None),
    # Per-module MP guards (see the aggregate comment above). index.js had no
    # row of its own before and grew 45% in one wave; it gets one now so the
    # next growth has to be argued for rather than absorbed. Actual 992/1050.
    # 1050 -> 1065: PERF-4's client half — an autoSgQuality level for Auto
    # (previously pinned at 2) plus the onQualityStep callback the host's new
    # rung calls, which is what actually delivers the cheaper terrain fbm to a
    # machine that cannot hold framerate. Actual 1061/1065.
    # 1065 -> 1135: MP-6's client half. The name input and its rename wiring
    # (a room where everyone is `wanderer` is not a game for friends), the
    # role-aware game line — it read "seek!" to hiders and seekers alike, and
    # is where Sculptor's Tag has to be taught — names on the scoreboard in
    # place of raw ids, and clearing the reading panels on the round edge.
    ("site/js/organs/garden/index.js", 1135, None),
    # net.js: connectRoom() + the frozen module surface in spec §8.1
    # (lease, draft, commit, tag, clock arming) plus relay discovery. 446/480.
    ("site/js/organs/garden/net.js", 480, None),
    # timesync.js: min-RTT offset estimator, spec §3. 111/130.
    ("site/js/organs/garden/timesync.js", 130, None),
    # roster.js: peer slot allocation for the flattened uniform bank. 80/100.
    ("site/js/organs/garden/roster.js", 100, None),
    # The relay (spec §2). Dependency-free Node, not shipped to the site, but
    # budgeted for the same reason the site is: room.mjs is a PURE reducer and
    # stays that way — growth here is the signal that I/O or timers leaked in.
    # Actuals at the MP merge: 305 / 376 / 246.
    ("server/relay.mjs", 350, None),
    # 420 -> 450: MP-6. Sculptor's Tag (docs/the-commons-design.md §0) needs
    # grantRoleLease/releaseRoleLease plus the seeking-phase guards in
    # lease.request and tick(); ending the round on the last tag needs the
    # live-hider count; and `rename` exists because a room where everyone is
    # called `wanderer` is unplayable. Actual 440/450.
    ("server/room.mjs", 450, None),
    ("server/ws.mjs", 290, None),
    # ED-4 (v2 blueprint work item 17, accept line "editor organ total <=
    # 1500 LOC"): the whole first-party editor organ — index/pipeline/
    # admission-gate/diagnostics-list/doc-adapters/modes/surfaces. Excludes
    # site/js/vendor/cm-editor.bundle.js (committed build artifact, its own
    # gz-cap gate in tools/editor-bundle/build.mjs) and site/js/runtime/*
    # (separate rows above/below — the design's "editor organ" charter is
    # first-party js/editor/ code only). Actual at ED-4: well under the cap.
    # 1500 -> 1560: COMP-2 (v2 §7.3 item 25, accept line "editor total still
    # <= 1500 LOC or the row is bumped with justification") adds buffers.js
    # (tab-bar state/UI, 194 LOC), composition-runtime.js (the live
    # multi-pass GL2 renderer, 184 LOC), multipass-share.js (the v=2 share
    # codec, 33 LOC), plus index.js's composition-mode wiring — a genuinely
    # new render/admission surface, not bloat on the existing single-pass
    # path (which stays byte-for-byte itself; see comp2.mjs's DOM-shape
    # assertion). Actual at merge: 1527 LOC; cap raised to 1560 for headroom.
    # Raised deliberately, this commit.
    # 1560 -> 1620: ADM-D (v2 blueprint work item 18) — see index.js's own
    # cap comment above for the itemized delta. Actual 1582/1620.
    ("site/js/editor/*.js|site/js/editor/modes/*.js|site/js/editor/surfaces/*.js", 1620, None),
]

def get_lines(p):
    """Line count, or None if file doesn't exist."""
    return open(p, 'rb').read().count(b'\n') if os.path.exists(p) and os.path.isfile(p) else None

def get_bytes(p):
    """Byte count, or None if file doesn't exist."""
    return os.path.getsize(p) if os.path.exists(p) else None

def check_file(p, max_loc, max_bytes):
    if get_lines(p) is None:
        print(f"SKIP {p} (not yet built)")
        return True
    l, s = get_lines(p), get_bytes(p)
    if (max_loc and l > max_loc) or (max_bytes and s > max_bytes):
        parts = []
        if max_loc:
            parts.append(f"loc={l}/{max_loc}")
        if max_bytes:
            parts.append(f"bytes={s}/{max_bytes}")
        print(f"FAIL {p} {' '.join(parts)}")
        return False
    print(f"OK {p}")
    return True

def check_agg(pattern, max_loc, max_bytes):
    files = []
    for p in pattern.split('|'):
        files.extend(glob.glob(p.strip()))
    if not files:
        print(f"SKIP {pattern} (not yet built)")
        return True
    files = sorted(set(files))
    tl = sum(get_lines(f) or 0 for f in files)
    ts = sum(get_bytes(f) or 0 for f in files)
    if (max_loc and tl > max_loc) or (max_bytes and ts > max_bytes):
        parts = []
        if max_loc:
            parts.append(f"loc={tl}/{max_loc}")
        if max_bytes:
            parts.append(f"bytes={ts}/{max_bytes}")
        print(f"FAIL {pattern} {' '.join(parts)}")
        return False
    msg = f"OK {pattern} (loc={tl}"
    if max_bytes:
        msg += f", bytes={ts}"
    msg += ")"
    print(msg)
    return True

def main():
    ok = all(check_file(p, ml, mb) for p, ml, mb in FILES)
    ok = ok and all(check_agg(pat, ml, mb) for pat, ml, mb in AGGREGATES)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
