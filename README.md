# Shader Garden

**A living gallery of machine-evolved GPU kernels, rendered live in your browser.**

Shader Garden is a dependency-free static PWA that showcases shaders *grown* by a
[FunSearch](https://deepmind.google/discover/blog/funsearch-making-new-discoveries-in-mathematical-sciences-using-large-language-models/)-style
evolutionary search rather than written by hand. The evolved kernels in the gallery
are the survivors of many generations of mutation, selection, and automated fitness
scoring; alongside them sit a few hand-written reference pieces — the oracles the
evolved ones were graded against, plus one handmade demo.
The site renders them in real time via **WebGPU** where available, falling back to
**WebGL2** everywhere else — no build step, no framework, no npm. Just ES modules.

This is the public face of a personal GPU research stack: a Vulkan voxel engine,
an evolutionary kernel bench, and an event bus that wires them together. The
kernels here were grown on that rig; the garden is where they get planted where
anyone can walk through them. It is also the first step of a longer project —
bringing the engine itself to the browser on WebGPU.

## How the kernels are grown

Kernels are evolved offline with an island-model evolutionary loop:

- **Island-model evolution** — multiple isolated populations mutate candidate
  shader programs in parallel; periodic migration between islands keeps diversity
  up and prevents premature convergence on a local optimum.
- **Oracle fitness, not vibes** — each domain has a deterministic scoring oracle.
  The domains shipped so far:
  - **SDFs** — *eikonal validity*: a proper signed distance field satisfies
    `|∇f| ≈ 1`; candidates are sampled and penalized for gradient-magnitude drift.
  - **Terrain** — *heightfield statistics*: elevation distributions, fractal
    dimension, and drainage continuity against reference landscapes.
  - **Phase / latent-heat / SPH** — *physics coherence*: conservation and
    continuity checks on the evolved field (no teleporting mass, no
    discontinuous potentials, compact support where the physics demands it).
- Winning kernels are baked into `site/assets/kernels.json` with their fitness
  score and, where the run recorded it, generation and run-id lineage — all of
  which the gallery displays.

Each gallery entry is a Shadertoy-style `mainImage` kernel. A handful of showcase
pieces additionally ship hand-ported WGSL for the WebGPU path.

**[The Garden](site/assets/garden/scene.glsl)** (`#/garden`) puts one evolved
terrain kernel into a raymarched diorama alongside a bouncing SDF character —
click anything (sky, ground, the figure) to see its exact source, nudge its
live tunable sliders, and jump straight into the editor at that line.

## Run it locally

No toolchain required:

```bash
cd site
python3 -m http.server 8000
# open http://localhost:8000
```

The service worker deliberately skips caching on `localhost`/`127.0.0.1`, so you
always see fresh files while developing.

## Contribute a shader

1. Hit **Open the editor** on the landing page (`#/edit`) and write or paste a
   `mainImage`-style GLSL kernel.
2. Hit **Share** — the editor compresses your source into a shareable link.
3. Click **Suggest for gallery**, which opens a prefilled GitHub issue containing
   your share link. If it renders well and fits a domain, it gets baked into the
   gallery.

## Project layout

```
site/            the deployable static app (this is what GitHub Pages serves)
  js/runtime/    WebGPU + WebGL2 runtimes and the shared uniform clock
  assets/        baked kernels.json + WGSL ports
tools/           offline baking scripts (not deployed)
```

The module contracts (uniform conventions, runtime interfaces, the kernel
schema, service-worker rules) live in [ARCHITECTURE.md](ARCHITECTURE.md).
See [DEPLOY.md](DEPLOY.md) for hosting, custom-domain, and PWA install notes.

## License

[MIT](LICENSE).

The shaders are the project's own — hand-authored, or discovered by this
repo's own FunSearch runs. Three snippet-scale borrowings from the wider
graphics community (Inigo Quilez's `sdBox`, The Art of Code's `hash21`, and
the ubiquitous sine-hash) are credited in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), which also records how the
corpus was audited and what that audit can and cannot establish. Nothing here
is derived from a shader published on Shadertoy; that file explains why the
metadata used to imply otherwise.
