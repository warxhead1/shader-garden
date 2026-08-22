// Shader Garden — mp-protocol.mjs
// Spec §10, `mp-protocol.mjs` row. This suite has two jobs:
//
//   1. Run the 41 existing node:test cases in server/test/*.test.mjs as a
//      first-class battery step, printing the house PASS/FAIL line shape
//      the other tools/test/*.mjs suites print (see loader.mjs/anatomy.mjs).
//      Those 41 cases already prove: lease grant/deny-out-of-ring/expiry/
//      holder-leaves, stale-epoch reject, pose token bucket, and every
//      framing case in spec §2.1 — this file does not re-implement them.
//   2. Add the one genuinely missing case: join-snapshot completeness for a
//      LATE joiner arriving after a commit has already landed. room.test.mjs
//      only asserts welcome.edits is `{}` for the very first joiner; nobody
//      exercises the "late joiner sees committed bodies" path spec §5.3
//      calls out ("so a late joiner builds+compiles once").
//
// HARD REQUIREMENT (spec §10, spec §0.5 C5): invoke server/test as an
// EXPANDED GLOB of file paths, never `node --test server/test/` (bare
// directory). On Node 26.7.0 (this box) the bare-directory form require()s
// the path instead of discovering tests — reproduced outside this repo, so
// it is a runtime behaviour change, not a repo issue. We expand the glob in
// JS ourselves (node:fs globSync) and pass explicit file paths to the child
// so nothing here depends on shell globbing.
//
// Usage: node tools/test/mp-protocol.mjs   (from tools/test/ or repo root —
// REPO_ROOT below is resolved relative to import.meta.url exactly like
// browser.mjs's SITE_ROOT, so both invocation paths work identically.)

import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import path from 'node:path';
import { createRoom, reduce, PROTOCOL } from '../../server/room.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

/* ---------- 1) run server/test/*.test.mjs as a battery step ---------- */
{
  const files = globSync('server/test/*.test.mjs', { cwd: REPO_ROOT }).sort();
  check('(1) server/test/*.test.mjs glob found the existing suites', files.length > 0, `${files.length} files`);

  // Explicit file paths passed to the child — never a bare directory, and
  // never shell globbing (spawnSync with an argv array, no shell: true).
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: REPO_ROOT,
    stdio: 'inherit', // forward the child's stdout/stderr straight through
  });

  check('(1) node --test server/test/*.test.mjs exits 0', result.status === 0, `exit=${result.status}`);
}

/* ---------- 2) join-snapshot completeness for a late joiner ---------- */
// Not covered by server/test/room.test.mjs: a member who joins AFTER a
// commit has landed must see that committed body in their own `welcome`,
// not just an empty edits map. This is what makes a late joiner able to
// build+compile once (spec §5.3) instead of starting from pristine bodies
// and waiting for a `commit` broadcast that already happened before they
// connected.
// Deliberately plain check()s, not node:test — node:test's own test()
// registrations run their bodies on a DEFERRED tick (after the module's
// synchronous top-level code finishes, confirmed by hand: a test() body
// logs after code that textually follows it), so mixing test() into a file
// that also wants to print a synchronous final summary line races the
// summary against the assertions. check() runs everything inline instead.
function hello(room, from, name, nowMs) {
  return reduce(room, { from, msg: { t: 'hello', protocol: PROTOCOL, room: room.id, name }, nowMs });
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

{
  let room = createRoom('r1', 0);
  room = hello(room, 'a', 'A', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'commit', componentId: 3, body: 'float z=3.0;', baseEpoch: 0 }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'commit', componentId: 5, body: 'float w=5.0;', baseEpoch: 1 }, nowMs: 0 }).room;

  const r = hello(room, 'b', 'B', 1);
  const welcome = r.sends.find((s) => s.to === 'b').msg;
  check('(2) late-joiner welcome is a welcome at the post-commit epoch', welcome.t === 'welcome' && welcome.epoch === 2);
  check('(2) late-joiner welcome.edits carries every previously-committed body',
    deepEqual(welcome.edits, { 3: 'float z=3.0;', 5: 'float w=5.0;' }), JSON.stringify(welcome.edits));
}

{
  let room = createRoom('r1', 0);
  room = hello(room, 'a', 'A', 0).room;
  room = reduce(room, { from: 'a', msg: { t: 'ring', inRing: true }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'lease.request' }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'commit', componentId: 3, body: 'float z=3.0;', baseEpoch: 0 }, nowMs: 0 }).room;
  room = reduce(room, { from: 'a', msg: { t: 'commit', componentId: 3, body: null, baseEpoch: 1 }, nowMs: 0 }).room;

  const r = hello(room, 'b', 'B', 1);
  const welcome = r.sends.find((s) => s.to === 'b').msg;
  check('(2) late-joiner welcome reflects a pristine-marker commit as absent',
    deepEqual(welcome.edits, {}), JSON.stringify(welcome.edits));
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exitCode = failed ? 1 : 0;
