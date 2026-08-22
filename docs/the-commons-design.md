# The Commons — design decisions from prior art

Companion to `multiplayer-spec.md`. That file says what to build; this one says
what it should FEEL like, and why. Every claim here traces to a researched
source, listed at the bottom.

Nothing in this document invalidates the frozen spec. It is all additive —
Wave 1 builds the machine, this is what we hang on it.

---

## 0. The finding that changes the design

**Hide-and-seek is the weaker idea, and we should not lead with it.**

Hide-and-seek treats live world-editing as a *hazard* — someone recompiles and
your hiding spot vanishes mid-round, which is why the original pitch worried
about locking at all. But editing the world is the one thing this engine does
that nothing else can. A mode that has to defend against its own differentiator
is the wrong mode.

### "Sculptor's Tag" — the flagship

The seeker holds the baton and **edits the world to flush people out.** They
don't walk around looking; they carve, raise, fog, and dissolve the geometry
other players are hiding in. Hiders can't fight the edit, only relocate.

Why this is right:
- It makes the unique mechanic the **verb**, not the accident.
- Zero new netcode. The commit→recompile pipeline the spec already defines
  *is* the mechanic.
- It reuses the whole round structure already specced. The only change is:
  during `seeking`, the lease is **assigned by role** rather than taken at the
  lectern (`lease.holder := seekerId`). The lectern stays the lobby-mode baton.

Precedent that this works: **Everybody Edits** built a whole browser-multiplayer
genre on real-time shared level editing, and its community treats deleting the
platform someone is standing on as *part of the game* rather than a failure
state — the mitigation that emerged organically was permissioned rooms, not
disabling editing. Halo Forge went the same way: minor map tweaks grew into an
entire user-generated-modes ecosystem once players had real edit power.

Plain hide-and-seek stays as the tutorial mode. It teaches movement and
occlusion in one round, with no editing to explain.

---

## 1. The baton is a commit lock, not an edit lock

**The single best UX correction from the research.** Unreal's Multi-User Editing
never blocks *local* interaction — a held lock only stops you pushing. You can
keep working; you just can't save until it frees.

So: non-holders are **not** read-only. Everyone can edit their own local copy of
any component, freely, always. The lease gates exactly one thing: `commit`.

The editor gets two tabs:

| Tab | Contents |
|---|---|
| **Watching \<name\>** | the holder's live buffer, read-only, updating as they type |
| **My draft** | your own sandbox — edit anything, compile locally, commit only if you hold the lease |

This turns waiting from dead time into rehearsal, and it costs almost nothing:
`editedBodies` is already per-client, and `prepareShader()` already compiles
without disturbing what's on screen. Roblox Team Create is the cautionary
counter-example — its lock is communicated as literal text appended to the
script tab name, which developers complain reads as clutter rather than
information.

**Why we keep a lock at all.** Figma's whole thesis is that removing turn-taking
is what makes multiplayer feel good, and their model (last-write-wins per
property) is real prior art against us. We are choosing the lock for a
**correctness** reason, not a UX-convention one: two people editing one GLSL
file produce a source that compiles into one world for everybody, so a merge
conflict isn't a messy diff — it's a black screen for all N players. That is a
different justification than "this is how creative tools do it," and worth
stating plainly, because most creative tools explicitly don't.

## 2. Presence without projecting anything

We refuse to duplicate the in-shader camera in JS, so we cannot place a label at
a player's screen position. Everything below sidesteps projection entirely:

- **Stable per-player hue**, used in three places at once: the roster row, the
  body tint in-shader, and the editor text colour. Figma, Live Share and Unreal
  all do exactly this and it is the cheapest presence signal that exists.
  *(Note for the review pass: the relay currently derives hue from
  `members.size`, which repeats a hue after someone leaves and someone joins.
  Needs a monotonic counter.)*
- **The lectern's glow IS presence, rendered natively.** It's a light source at
  a world position in a scene we already raymarch — so "who holds the baton" is
  *content*, not UI, and needs no camera knowledge.
- **A countdown ring on the lectern itself** for the 20 s lease, shifting colour
  in the last ~3 s. Nobody in the prior art has this because no other tool has a
  timed auto-expiring lock — Perforce's famous failure is locks that never
  expire at all. An in-world ring means the holder feels the pressure without
  reading a HUD.
- **Roster panel** with hue chips and a lease/role badge — Figma's avatar strip,
  Unreal's Connected Clients panel. Screen-space chrome, no projection.
- **Default-follow on join.** Live Share snaps a joiner's view to the host by
  default, and that single behaviour answers "what do I do" before anyone has to
  explain anything. A fresh joiner's camera should frame the lectern.
- **A one-shot "look at this" ping** from the holder — Live Share's Focus
  Request. Solves presence and onboarding with one message.

## 3. What the demoscene already proved

**Bonzomatic** (public domain) is the tool behind Shader Showdown, and its
network fork independently arrived at our architecture:

- It broadcasts **full source snapshots** on an interval plus on compile — not
  per-keystroke diffs, not a CRDT. Late joiners just get the latest snapshot;
  packet loss is self-healing. This is our `commit` + `draft` design, already
  validated by a decade of live use.
- It has **`SyncTimeWithSender`** — the shader time uniform is kept in lockstep
  between performer and spectators. Independent confirmation that shared time
  (our MP-1) is the load-bearing first slice, not a detail.
- On a failed compile it **keeps rendering the last good frame** and shows the
  error in an overlay. That is precisely invariant I4. Bonzomatic's rule is
  "don't crash the show," and it is right.

**Shader Showdown's competition format** ports almost directly to a showdown
mode: bracket elimination, timed rounds, a fixed set of provided textures per
round as a shared constraint, audience vote at the end, and — the detail worth
stealing — **the timer pauses for everyone if one machine has a technical
fault**, because visible failure is part of the show and shouldn't cost you the
match.

And the philosophical cover for the read-only mirror, from TOPLAP's manifesto:
*"Obscurantism is dangerous. Show us your screens."* Watching someone code is
not for the compiler-literate — it's the same as watching a guitarist's hands.

## 4. Game feel

- **Forced flare** (Prop Hunt's taunt, ported to a game with no voice chat).
  Every ~20–25 s a hider emits a light pulse and a chime at their position;
  flaring *voluntarily* resets the timer, so you can spend it while
  repositioning. This is the fix for the core problem of the genre: hiding well
  is boring. Midnight Ghost Hunt does the same thing by making stillness
  *itself* detectable.
- **Banded proximity, magnitude only, never direction.** Dead by Daylight's
  terror radius works because it tells you *how close*, not *which way*. Use
  3–4 discrete bands (a raw linear map reads as noise), driven by a
  seeker-to-nearest-hider distance that is nearly free to compute.
- **Caught players get a ghost cam and one legitimate power**: a single silent
  marker, placeable anywhere, visible only to players still hidden. Prop Hunt
  communities have to *ban* spectators from radioing hider positions — the
  temptation is proven, so channel it into a mechanic instead of policing it.
  This is the highest-leverage fix for downtime; Fall Guys' retrospectives call
  passive spectating out as a real design flaw.
- **Scale seek time to the lobby**, `60 + 10 × hiders_remaining` seconds. Among
  Us deliberately flexes round length with population; Gang Beasts' fixed
  5–7 min rounds are cited as the counter-example, where an early elimination
  means a long dead stretch. Our flat 120 s is too long for a 3-player round.
  The 30 s blind hide phase is fine as specced.

## 5. Making it legible

Ranked by readability per GPU-millisecond in an 88-step march:

1. **Ambient occlusion** — iq's normal-march estimator, ~5 extra distance
   evaluations, no extra rays. The single biggest win for reading interior
   geometry.
2. **Distance fog** — we already have `SG_FOG_DIST`. Needs only colour and the
   march's hit distance, and it is what stops a sponge interior reading as a
   confusing grey maze.
3. **Hemispherical sky ambient** (tinted light from above, dotted with the
   normal) — reads far better than flat ambient for near-zero cost.
4. **Triplanar texturing on the sponge** — unusually cheap here because Menger
   faces are axis-aligned, so there is no UV distortion to fight at all.
5. Soft shadows last: one extra ray, real cost, real benefit — but only after
   the above.

**Making a player read at distance inside a busy fractal:** hue tint (have it)
+ **rim light in that hue** + a bloom-fed glow with a fixed alpha floor so it
partially survives occlusion. Skip outline shaders — they read as "selected
unit" UI, the wrong register.

**Camera inside geometry:** our bounded ray-origin escape loop is the right
call and is *stronger* than the standard fix, because it also handles secondary
rays (shadow/AO) that originate mid-wall. Fractal explorers don't discuss this
because their cameras are exterior/orbital, never embedded.

**Movement:** Mandelbulber and Mandelbulb3D independently scale step size by
local distance-to-surface, which is how you avoid "too fast in the open, twitchy
near detail". Don't apply it to walk speed — that feels like sliding on ice —
but do apply it to look sensitivity and any free-look camera. Keep FOV moderate
(60–70°); wide FOV exaggerates parallax against self-similar geometry and is a
likelier nausea trigger than speed.

## 6. Collision: the objection, answered properly

The research pushed back hard, and fairly: a Menger sponge distance estimator is
~15 lines of *mathematically fixed* code. Porting it to JS is not the same as
duplicating drift-prone scene content, so "we refuse to duplicate the SDF" is
weaker than it sounded.

The pushback is right about the general case and wrong about ours, for a reason
the original argument didn't state: **the entire premise of this project is that
players rewrite the shader at runtime.** A JS proxy of the sponge is correct
right up until the first person edits the sponge component — which is not an
edge case here, it is the product. Drift isn't a maintenance risk, it's a
gameplay guarantee.

Claybook confirms SDF collision is genuinely *better* than triangle collision
(you always know signed distance even from inside, so tunneling resolves by
pushing along the gradient) — but it did it with a custom GPGPU compute solver
in native code, which has no WebGL2 path at all. A WebGPU compute probe is real
but pays a GPU→CPU readback of at least a frame's latency, so it isn't free
either.

**Decision: no collision stands.** Hiding is pure visual occlusion — the seeker
cannot see you because the raymarch does not reach you. That is still
hide-and-seek and it is honest.

**The path that would actually work later** — and it fits this codebase's
existing conventions exactly — is a **declared collision proxy**. The shader
annotates its own colliders next to the `@component`/`@tune` markers already
parsed:

```glsl
// @collide box 0 1.9 0 2.2
```

JS reads the proxy from the same parsed source it already reads `@tune` from, so
it *cannot* drift: edit the sponge, edit its declared bound, and the collision
follows. That is the right shape. It is future work, not Wave 1.

---

## Sources

Bonzomatic (github.com/Gargaj/Bonzomatic, public domain) and its network fork
totetmatt/Bonzomatic-network; the Bonzomatic wiki's live-coding compo setup
guide; livecode.demozoo.org's Shader Showdown archive. Hydra
(github.com/hydra-synth/hydra); Flok (munshkr/flok, GPLv3); Estuary
(dktr0/estuary) and its ICLC 2017 paper; Troop (Qirky/Troop) via the TOPLAP
blog. TOPLAP ManifestoDraft. Figma's "Multiplayer editing in Figma"; Unreal
Multi-User Editing docs; Roblox devforum thread 2232934; VS Code Live Share
follow/focus docs; Perforce KB 3114; Croquet. Sebastian Aaltonen's GDC 2018
"GPU-Based Clay Simulation and Ray-Tracing Tech in Claybook"; Alex Evans,
"Learning From Failure" (SIGGRAPH 2015); iquilezles.org (AO, fog, soft shadows,
domain repetition); Mandelbulber manual; Marble Marcher
(HackerPoet/MarbleMarcher); lettier's 3D Game Shaders For Beginners (rim
lighting). Prop Hunt taunt/auto-taunt (Steam Workshop 468149739); Midnight Ghost
Hunt previews (PC Gamer, Gaming Trend); Dead by Daylight wiki (Terror Radius);
Among Us round-length analyses; Fall Guys spectator retrospectives; Everybody
Edits (Hardcore Gaming 101); Hypixel Build Battle.
