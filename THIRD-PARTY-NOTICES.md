# Third-party notices

Shader Garden is MIT licensed (see `LICENSE`) and the shaders in it are the
repo's own work — hand-authored, or discovered by this project's own FunSearch
runs. This file records the exception: short snippets of shader code that came
from the wider graphics community and are reproduced here.

It exists because "we wrote it" and "no line of it came from anywhere" are
different claims, and only the first one is true.

---

## 1. `sdBox` / `sdPrism` — Inigo Quilez

**Where:** the `Record-Store Milk Crate` kernel (`vault-d2fbd4e9`), served from
`site/assets/kernels.json` and `site/assets/wgsl/vault-d2fbd4e9.wgsl`.

```glsl
float sdBox(vec3 p, vec3 b){
    vec3 q = abs(p) - b;
    return length(max(q,0.0)) + min(max(q.x,max(q.y,q.z)),0.0);
}
```

This is Inigo Quilez's canonical box distance function, reproduced verbatim from
his 3D distance-functions article (<https://iquilezles.org/articles/distfunctions/>).
`sdPrism` immediately below it is the same construction in two dimensions.

Quilez publishes the code in those articles under the MIT license. The code is
therefore usable here; what was missing was this notice, which MIT requires.

## 2. `hash21` — The Art of Code

**Where:** the same kernel.

```glsl
float hash21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
```

The `123.34 / 456.21 / 45.32` constants make the lineage unmistakable: this is
the hash popularised by Martijn Steinrucken's *The Art of Code* tutorials. No
formal license accompanies tutorial code of this kind, and a four-line hash is
below most thresholds of copyrightability — it is credited here anyway, because
recognisable code should carry its provenance whether or not a license compels
it.

## 3. `fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453)` — folk idiom

**Where:** 18 files, including every `biome-*` kernel and `garden/scene.glsl`.

The sine-hash. Its earliest widely-cited appearance is again Quilez's value-noise
work, but it has been reproduced, with these exact constants, in thousands of
shaders for over a decade and now circulates as an idiom rather than as anyone's
code. Recorded for completeness; no attribution is claimed to be owed.

---

## What "shadertoy" means in this repo, and what it does not

Kernel metadata used to carry `origin: "shadertoy_evolved"`. That string was
misleading and has been renamed to `funsearch_evolved`. Nothing in this
repository is derived from a shader published on Shadertoy.

The name came from the upstream file the biome kernels were baked out of,
`shadertoy_evolved.glsl`, whose own header reads *"FunSearch-Evolved Terrain
Demo — Shadertoy **Edition** … paste this entire file into shadertoy.com"*. It
was Shadertoy **format** — GLSL with a `mainImage(out vec4, in vec2)` entry
point and `iTime`/`iResolution`/`iMouse` uniforms — not Shadertoy **source**.
The site's attribution panel had always rendered it correctly as "FunSearch-
evolved (this repo's own runs)"; the raw metadata string had not.

The Shadertoy uniform contract itself (`iResolution`, `iTime`, `iTimeDelta`,
`iFrame`, `iMouse`, `iChannel0..3`) is an interface convention that both runtimes
implement. Implementing a published interface is not derivation from the works
that use it.

---

## How this list was produced, and what it cannot tell you

All 61 shader sources in the tree — 4,503 lines of `.glsl`/`.wgsl`, plus every
body embedded in `kernels.json` and `site/assets/seed/*.json`, ~362 KB — were
scanned for the fingerprints of copied shader code: Ashima/Gustavson simplex
noise (`mod289`, `permute`, `taylorInvSqrt`, `snoise`), Dave Hoskins'
hash-without-sine constants, the `12.9898/78.233` rand, `hg_sdf`/Mercury macros,
`smin`/`opSmooth*`, Shadertoy `/view/` ids, foreign license headers, and any
third-party author named in a comment. Everything found is listed above; every
other category came back empty.

**The limit, stated plainly:** this method detects known idioms and missing
attribution. It cannot diff the corpus against Shadertoy's, so it could not
detect a shader copied from an obscure source with its comments stripped. What
it does establish is that the structure and metadata of every kernel are
consistent with the pipeline they claim to come from, and that no trace of a
copied file is present.

If you believe something here is yours, open an issue — it will be credited or
removed.
