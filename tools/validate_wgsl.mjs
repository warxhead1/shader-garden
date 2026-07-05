#!/usr/bin/env node
// tools/validate_wgsl.mjs — validates every WGSL kernel the runtime actually
// ships against `naga` (parse + WGSL validation rules), wrapped exactly the
// way GPURuntime.setShader() wraps it (prelude + COMP-0 channel decls + the
// @sg-uniforms custom-uniform accessor block + epilogue) — a bare kernel
// file alone doesn't define `U`, `mainImage`'s call site, or any
// `@sg-uniforms` accessor, so validating the unwrapped file would either
// false-fail (undefined `U`) or miss real errors the wrap introduces.
//
// Usage: node tools/validate_wgsl.mjs [file.wgsl ...]
//   No args: validates every *.wgsl under site/assets/wgsl/ plus
//   site/assets/garden/scene.wgsl. Exits non-zero if any file fails.
//
// Requires `naga` on PATH or at ~/.cargo/bin/naga (28.0.0 confirmed working).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { wrapWgsl } = await import(join(ROOT, 'site/js/runtime/wrap.js'));

function findNaga() {
  const home = process.env.HOME || '';
  const candidates = ['naga', join(home, '.cargo/bin/naga')];
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* try next */ }
  }
  throw new Error('naga not found on PATH or ~/.cargo/bin/naga');
}

function targets(argv) {
  if (argv.length) return argv;
  const kernelDir = join(ROOT, 'site/assets/wgsl');
  const kernels = globSync('*.wgsl', { cwd: kernelDir }).map((f) => join(kernelDir, f));
  return [...kernels, join(ROOT, 'site/assets/garden/scene.wgsl')];
}

function main() {
  const naga = findNaga();
  const files = targets(process.argv.slice(2));
  const tmp = mkdtempSync(join(tmpdir(), 'sg-wgsl-validate-'));
  let failures = 0;

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const wrapped = wrapWgsl(src, 0);
    const out = join(tmp, basename(file));
    writeFileSync(out, wrapped);
    try {
      execFileSync(naga, [out], { stdio: 'pipe' });
      console.log(`ok    ${basename(file)}`);
    } catch (e) {
      failures++;
      console.log(`FAIL  ${basename(file)}`);
      const msg = (e.stderr || e.stdout || e.message || '').toString().trim();
      console.log(msg.split('\n').map((l) => '        ' + l).join('\n'));
    }
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${files.length - failures}/${files.length} passed naga validation`);
  process.exit(failures ? 1 : 0);
}

main();
