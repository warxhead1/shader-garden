#!/usr/bin/env bash
# Shader Garden — the real-GPU gate.
#
# WHY THIS EXISTS LOCALLY AND NOT IN CI: every suite listed here calls
# assertRealGpu()/assertRealWebgl2(), which exist to refuse a software
# adapter. GitHub's runners have no GPU, so CI can only run these with
# SG_ALLOW_SOFTWARE=1 — which is precisely the assertion being switched off.
# CI therefore keeps them as advisory steps and this gate is where they
# actually block. It is the only place the "the badge really said WebGPU and
# the pixels really came off an NVIDIA card" claim is ever proven.
#
# Runs SEQUENTIALLY on purpose. Concurrent real-GPU suites starve each
# other's admission-gate sacrificial worker: measured on this box, the same
# trial source gates OK in ~390ms alone and TLEs at ~1900ms with a second
# live garden on the GPU. Parallelising this gate makes it lie.
set -u
cd "$(dirname "$0")/../tools/test" || exit 1

# Logs go under tools/test/out/ (gitignored), never /tmp: /tmp on this box is
# a tmpfs, so anything written there is resident RAM.
#
# One directory PER RUN, never a fixed path. A fixed path made two different
# kinds of trouble on 2026-08-22: run 2 destroyed run 1's per-suite logs at
# exactly the moment they were needed to compare two different failures, and a
# reader still following the old path replayed run 1's output as if it were
# live — which got reported as the current state of a healthy run. Neither is
# possible once each run owns its own directory. `latest` is a convenience
# symlink; anything that must not be misread should use the printed path.
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
LOGS="out/gate-logs/$RUN_ID"
mkdir -p "$LOGS"
ln -sfn "$RUN_ID" out/gate-logs/latest
echo "gpu-gate: logs -> tools/test/$LOGS"

SUITES=(
  smoke garden garden-movement garden-camera garden-locomotion-parity
  garden-perf garden-uniform-inspector
  comp0 comp1 comp2 comp3
  runtime-host-loss runtime-prepare-shader perf
  webgpu-live webgpu-fallback
  mp-clock mp-solo-parity mp-compile-swap mp-two-browsers
)

if [ -n "${SG_ALLOW_SOFTWARE:-}" ]; then
  echo "gpu-gate: REFUSING to run with SG_ALLOW_SOFTWARE set — that disables the"
  echo "          very assertions this gate exists to enforce. Unset it."
  exit 2
fi

failed=()
for s in "${SUITES[@]}"; do
  printf '%-26s ' "$s"
  start=$(date +%s)
  if timeout 900 node "$s.mjs" > "$LOGS/$s.log" 2>&1; then
    echo "ok ($(( $(date +%s) - start ))s)"
  else
    echo "FAIL ($(( $(date +%s) - start ))s)"
    failed+=("$s")
  fi
done

if [ ${#failed[@]} -ne 0 ]; then
  echo
  echo "gpu-gate: ${#failed[@]} suite(s) failed: ${failed[*]}"
  for s in "${failed[@]}"; do
    echo "--- $s (failing checks) ---"
    grep -E '^FAIL' "$LOGS/$s.log" | head -20
  done
  exit 1
fi
echo
echo "gpu-gate: all ${#SUITES[@]} real-GPU suites passed."
