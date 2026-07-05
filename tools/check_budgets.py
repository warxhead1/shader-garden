#!/usr/bin/env python3
"""Check budget caps on site JS files."""

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
    # 120 -> 135: GARDEN-1 — rebuild(overrides) lets a caller (the garden
    # organ's editing seam) permanently pin a mount onto a specific backend
    # instead of only ever re-running the original opts. Actual 129/135.
    # Raised deliberately, this commit.
    ("site/js/core/runtime-host.js", 135, None),
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
    ("site/js/organs/provenance/index.js", 260, None),
    ("site/js/organs/anatomy/index.js", 300, None),
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
    ("site/js/runtime/webgl2.js", 470, None),
    # 480 -> 580: GARDEN-1 (garden-webgpu wave 2) — setUniforms()'s WGSL
    # equivalent (a custom-uniform bank + name registry) and readPixel()
    # (the offscreen probe-readback primitive: a second rgba8unorm pipeline
    # + copyTextureToBuffer/mapAsync path), both needed to run GARDEN-0's
    # scene on this backend at all. Actual 565/580. Raised deliberately,
    # this commit.
    ("site/js/runtime/webgpu.js", 580, None),
    # wrap.js also rolls up into the admission aggregate below (net -30 from
    # runtimes, per the admission budget); this row is the COMP-0 hard cap.
    # 70 -> 115: GARDEN-1 adds the `@sg-uniforms` directive parser
    # (wgCustomUniformNames) + accessor-function generator (genCustomAccessors)
    # that wrapWgsl() now injects — webgpu.js's WGSL side of setUniforms().
    # Actual 108/115. Raised deliberately, this commit.
    ("site/js/runtime/wrap.js", 115, None),
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
    ("site/js/core/*.js", 700, 27648),
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
    ("site/js/organs/admission/*.js|site/js/runtime/wrap.js", 1150, 53248),
    # GARDEN-0 (v2 §8.29): the whole organ, one cap — parse/probe/panel/index.
    ("site/js/organs/garden/*.js", 700, None),
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
