# Manual tools

Operator-driven, never gated. These assert nothing — they exist to *look* at
the product rather than to prove a property about it, so preflight's
orphan-suite check deliberately does not see this directory (its glob is
`tools/test/*.mjs`, non-recursive).

Anything in here that grows real assertions belongs one level up, wired into
`.github/workflows/test.yml` or `scripts/gpu-gate.sh` like every other suite.

| tool | what it does |
|---|---|
| `play-session.mjs` | Drives two real browsers through one room: join, start a round, move with real key events, capture what a player sees at each phase. Screenshots land in the path set at the top of the file. |
| `profile-garden.mjs` | Splits the live garden's frame cost into JS self-time vs everything else, and reports backend, DPR and backing-store size. `SG_NO_WEBGPU=1` hides `navigator.gpu` to A/B the WebGL2 fallback on an identical mount. |

## The measurement trap

Run these on a real compositor, not Xvfb, before believing any timing they
print. Xvfb has no GPU compositor, so every presented frame is a CPU copy and
the numbers are dominated by that copy rather than by the product:

| | WebGPU frame time |
|---|---|
| Xvfb | ~46 ms |
| real compositor (`wayland-1`) | **16.2 ms — vsync-locked 60fps at native res** |

`browser.mjs`'s `resolveDisplay()` picks a spare compositor automatically and
excludes the user's own session. Do not reach for `env -u WAYLAND_DISPLAY` to
"simulate CI" — that inverts the guard into targeting the user's desktop. Use
`SG_FORCE_XVFB=1`, which is what it is for.
