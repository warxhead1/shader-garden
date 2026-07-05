// browser.mjs's serveSite() bind-failure hardening.
//
// Bug this guards: serveSite() used to spawn a server, sleep a fixed 800ms,
// and hand back the URL unconditionally — no check that anything was
// actually listening, and no check that whatever answered was OUR content.
// A port squatted by a leaked orphan from an earlier crashed run (this
// project's own test suites leak these on a crash — see ARCHITECTURE.md)
// produced either a silent connection-refused/nav-timeout downstream, or
// worse, a test silently running against a stale, unrelated site tree.
//
// Covers:
//   (a) a normal serveSite() call binds, verifies liveness for real, and
//       serves the correct root (byte-identical index.html).
//   (b) if the exact port serveSite() would pick is already squatted by an
//       unrelated server, serveSite() must not trust it — it lands on a
//       different port and still serves the correct root, rather than
//       returning a URL serving someone else's tree.
// Prints "all-PASS" and exits 0 only if every check passed.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveSite, derivePort, SITE_ROOT, sleep } from './browser.mjs';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failed = true;
  return ok;
}

const onDiskIndex = readFileSync(path.join(SITE_ROOT, 'index.html'), 'utf8');
const spawned = []; // everything this test starts, killed on every exit path below

try {
  // (a) the ordinary path: nothing squatting, first port tried should win.
  {
    const { server, base } = await serveSite();
    spawned.push(server);
    const res = await fetch(`${base}/index.html`);
    const body = await res.text();
    check('(a) normal serveSite() responds ok', res.ok, 'status=' + res.status);
    check('(a) serves the real site index.html', body === onDiskIndex, 'got ' + body.length + ' bytes, want ' + onDiskIndex.length);
  }

  // (b) squat a port and ask serveSite() for that EXACT port explicitly —
  // a deterministic collision, regardless of what test (a) above already
  // touched (an offset shared with test (a)'s own default port would risk a
  // spurious TIME_WAIT false-negative: the squatter's own bind racing the
  // OS's release of a port serveSite() JUST closed one paragraph up). The
  // real-world trigger is an implicit default-port collision with a leaked
  // orphan, but serveSite() runs the identical retry logic whether `port`
  // was passed explicitly or defaulted, so this exercises the same path.
  {
    const squatDir = mkdtempSync(path.join(tmpdir(), 'sg-servesite-squat-'));
    writeFileSync(path.join(squatDir, 'index.html'), '<html>squatter — not the real site, deliberately a different length</html>');
    const squatPort = derivePort(9001); // an offset test (a) never touched
    const squatter = spawn('python3', ['-m', 'http.server', String(squatPort), '--bind', '127.0.0.1'],
      { cwd: squatDir, stdio: 'ignore' });
    spawned.push(squatter);
    await sleep(400); // let the squatter actually bind before racing it

    const { server, base } = await serveSite(SITE_ROOT, squatPort);
    spawned.push(server);
    const landedPort = Number(new URL(base).port);
    check('(b) did not trust the squatted port', landedPort !== squatPort, 'squatPort=' + squatPort + ' landedPort=' + landedPort);

    const res = await fetch(`${base}/index.html`);
    const body = await res.text();
    check('(b) still serves the real site despite the squatter', res.ok && body === onDiskIndex, 'status=' + res.status);

    rmSync(squatDir, { recursive: true, force: true });
  }
} finally {
  for (const p of spawned) { try { p.kill(); } catch { /* already gone */ } }
}

console.log(failed ? '\nFAILURES ABOVE' : '\nall-PASS');
process.exit(failed ? 1 : 0);
