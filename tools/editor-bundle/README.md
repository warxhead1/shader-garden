# tools/editor-bundle

esbuild pipeline that produces the ONE dependency-carrying artifact in this
repo: `site/js/vendor/cm-editor.bundle.js`. Not deployed as source — the
committed chunk is the deploy artifact; the pipeline that made it lives here,
pinned, dev-only. `site/` itself stays plain ES modules.

```
npm install --no-fund --no-audit   # once, pulls @codemirror/* + esbuild per package-lock.json
node build.mjs                     # rebuilds site/js/vendor/cm-editor.bundle.js (+ .map, git-ignored)
```

`build.mjs` fails (exit 1) if the gzipped chunk exceeds the 200 KiB hard cap
and warns above the 150 KiB target (ARCHITECTURE.md § editor bundle budget).
CI (`.github/workflows/deploy.yml`, job `editor-bundle-diff`) reruns this and
fails the PR if the rebuilt chunk differs from the committed one — the
committed bytes are the contract, this directory is how they were made.

## Vendored grammars — license check

`@codemirror/state`, `@codemirror/view`, `@codemirror/language`,
`@codemirror/commands`, `@codemirror/lint` are ordinary pinned npm
`devDependencies` (official CodeMirror packages, MIT, checked via `npm view
<pkg> license` on 2026-07-03 — all report `MIT`).

The two grammar packages are **vendored** (copied into `vendor/`, not npm
`devDependencies`) per the design doc's supply-chain rationale: each is a
single-maintainer package, small enough to review in full, and vendoring
pins the exact bytes `build.mjs` compiles against — no `npm install` re-fetch
of these two on every build, no risk of an upstream publish changing what
ships. `package-lock.json` still pins everything else.

| package | version | registry name | license | checked | evidence |
|---|---|---|---|---|---|
| GLSL grammar | 0.6.0 | `lezer-glsl` | MIT | 2026-07-03 | `npm view lezer-glsl` reports `license: MIT`; package.json `"license": "MIT"`; README states "The code is licensed under an MIT license." (no separate `LICENSE` file ships in the npm tarball — the README statement plus package.json metadata is the full record available) |
| WGSL grammar | 0.3.0 | `@iizukak/codemirror-lang-wgsl` | MIT | 2026-07-03 | `npm view @iizukak/codemirror-lang-wgsl` reports `license: MIT`; `LICENSE` file ships in the tarball (copied to `vendor/codemirror-lang-wgsl/LICENSE.upstream`) |

Both are MIT — compatible with this repo's MIT license, no attribution
obligations beyond keeping the license notice, which the vendored
`*.upstream` files preserve. Upstream `package.json`/`README.md` are copied
alongside `index.js` as `*.upstream` for provenance; only `index.js` is
imported by `facade.js`.

Import graph, verified by inspection: `lezer-glsl`'s `index.js` imports only
`@lezer/lr` and `@lezer/highlight`; `codemirror-lang-wgsl`'s imports only
`@codemirror/language`, `@lezer/highlight`, `@lezer/lr` — neither pulls in
the `codemirror` meta-package (which drags `@codemirror/autocomplete` +
`@codemirror/search`, the excluded surfaces) despite `codemirror-lang-wgsl`
listing it as an upstream `dependency` for its own demo/tests. `@lezer/lr`
and `@lezer/highlight` are transitive — pulled in by `@codemirror/language`
and `@codemirror/view`, not declared directly in `package.json` here.

## Layout

```
facade.js               curated entry point — the only file esbuild treats
                         as a root; exports createEditor/setDiagnostics/glsl/wgsl
build.mjs                esbuild driver + gzip budget gate
vendor/lezer-glsl/              vendored GLSL grammar (index.js is the import)
vendor/codemirror-lang-wgsl/    vendored WGSL grammar (index.js is the import)
```
