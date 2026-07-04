#!/usr/bin/env node
// Shader Garden — tools/editor-bundle/build.mjs
// Builds facade.js into ONE ESM chunk: site/js/vendor/cm-editor.bundle.js
// (+ .map, git-ignored). Deterministic given the pinned lockfile — run twice,
// diff to nothing; deploy.yml's editor-bundle-diff job relies on that to
// catch drift between the committed chunk and what vendor/ + package-lock.json
// actually produce.
//
// Usage: node build.mjs   (first: npm install --no-fund --no-audit)
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTFILE = path.join(HERE, '..', '..', 'site', 'js', 'vendor', 'cm-editor.bundle.js');

// Hard cap enforced here, not just documented (ARCHITECTURE.md § editor
// bundle budget) — design doc §3: split a grammar into a lazy chunk before
// the cap ever moves.
const TARGET_GZ = 150 * 1024;
const CAP_GZ = 200 * 1024;

await build({
  entryPoints: [path.join(HERE, 'facade.js')],
  outfile: OUTFILE,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  sourcemap: true,
  legalComments: 'none', // no upstream-license comment blocks in output — recorded once in README.md instead, keeps byte-diffing stable across esbuild versions
});

const raw = statSync(OUTFILE).size;
const gz = gzipSync(readFileSync(OUTFILE)).length;

console.log(`cm-editor.bundle.js: ${raw} bytes raw, ${gz} bytes gz (target ${TARGET_GZ}, cap ${CAP_GZ})`);

if (gz > CAP_GZ) {
  console.error(`FAIL: ${gz} bytes gz exceeds the ${CAP_GZ}-byte hard cap.`);
  process.exit(1);
}
if (gz > TARGET_GZ) {
  console.warn(`WARN: ${gz} bytes gz exceeds the ${TARGET_GZ}-byte target.`);
}
