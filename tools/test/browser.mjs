// Shared bits for the headless harness: browser resolution + static server.
//
// Chrome resolution order: SG_CHROME, PUPPETEER_EXECUTABLE_PATH, newest
// chrome-headless-shell in the puppeteer cache. SwiftShader flags mean the
// GL2 path runs everywhere; the WebGPU path does NOT execute headless — real
// WebGPU rows in the launch checklist are verified on real browsers only.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const puppeteer = require('puppeteer-core');

export const SITE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../site');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chromePath() {
  const env = process.env.SG_CHROME || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env) return env;
  const home = process.env.HOME || '';
  const hits = globSync(`${home}/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell`).sort();
  if (hits.length) return hits[hits.length - 1];
  throw new Error('no headless chrome found — set SG_CHROME or run: npx @puppeteer/browsers install chrome-headless-shell');
}

// Exported so tests can predict the exact port serveSite() would pick by
// default (same pid, same formula) — servesite.mjs uses this to pre-squat it.
export function derivePort(offset = 0) {
  return 8100 + ((process.pid + offset) % 1800);
}

const PROBE_TIMEOUT_MS = 3000, PROBE_INTERVAL_MS = 100, PROBE_FETCH_TIMEOUT_MS = 500;
const SERVE_ATTEMPTS = 3, RETRY_PORT_STEP = 7;

// Polls `url` until something answers or `child` has already exited —
// whichever comes first — for up to `timeoutMs`. Each individual fetch is
// itself bounded (PROBE_FETCH_TIMEOUT_MS) so a wedged connection attempt
// can't eat the whole budget. Resolves the Response on success, or null.
async function waitForLive(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return null; // died already (e.g. EADDRINUSE) — no point polling further
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), PROBE_FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } catch {
      // connection refused (still starting) or our own abort — keep polling
    } finally {
      clearTimeout(abortTimer);
    }
    await sleep(PROBE_INTERVAL_MS);
  }
  return null;
}

// Serves `root` on a pid-derived localhost port; caller must kill() the
// result. Verifies the server is both LIVE and OURS before returning —
// a blind fixed sleep used to hand back a URL that nothing (or someone
// else's leaked orphan) was listening on, which surfaces downstream as a
// confusing nav timeout or a test running against the wrong site tree.
// Liveness: poll a real HTTP request instead of guessing a sleep duration.
// Ownership: a colliding squatter serving a DIFFERENT tree is worse than a
// clean bind failure, so a live response only counts if its /index.html is
// byte-identical in length to root's own — otherwise it's treated the same
// as no response at all, and this retries on a new port rather than trusting
// it. Up to SERVE_ATTEMPTS ports are tried (port, then port+7, port+14, ...)
// before giving up loudly instead of ever returning an unverified URL.
export async function serveSite(root = SITE_ROOT, port = derivePort()) {
  const ownBytes = readFileSync(path.join(root, 'index.html')).length;
  const triedPorts = [];

  for (let attempt = 0; attempt < SERVE_ATTEMPTS; attempt++) {
    const attemptPort = port + RETRY_PORT_STEP * attempt;
    triedPorts.push(attemptPort);
    const server = spawn('python3', ['-m', 'http.server', String(attemptPort), '--bind', '127.0.0.1'],
      { cwd: root, stdio: 'ignore' });
    const base = `http://127.0.0.1:${attemptPort}`;

    const res = await waitForLive(`${base}/index.html`, server, PROBE_TIMEOUT_MS);
    if (res && res.ok) {
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.length === ownBytes) return { server, base };
    }
    // Nothing answered in time, the child died (bind failure), or a
    // squatter answered with someone else's content — this attempt is
    // unusable either way; discard it and try the next port.
    try { server.kill(); } catch { /* already gone */ }
  }

  throw new Error(`serveSite: no verified server for ${root} after ${SERVE_ATTEMPTS} attempts (ports tried: ${triedPorts.join(', ')})`);
}

// A second static root, CORS-open (Access-Control-Allow-Origin: *), on a
// different port than serveSite()'s default — for tests that need TWO
// distinct origins in the same run (e.g. tools/test/seed.mjs's foreign-embed
// fixture: the "garden" origin must serve its module + kernel JSON to a
// page on a genuinely different origin, and both `<script type="module">`
// and `fetch()` enforce CORS cross-origin).
export async function serveSiteCors(root, port = derivePort(500)) {
  const script = `
import http.server, socketserver, sys
port = int(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True
with ReusableTCPServer(('127.0.0.1', port), H) as httpd:
    httpd.serve_forever()
`;
  const server = spawn('python3', ['-c', script, String(port)], { cwd: root, stdio: 'ignore' });
  await sleep(800);
  return { server, base: `http://127.0.0.1:${port}` };
}

export async function launch() {
  return puppeteer.launch({
    executablePath: chromePath(),
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1440, height: 900 },
  });
}

// Transient nav-timeout flake: headless chrome under host load sporadically
// blows the goto timeout on a page that would load fine one second later —
// reproduced across every test file and on unmodified base commits (it's
// infra, not product). Retry a timed-out goto ONCE before letting it fail
// for real; anything that times out twice in a row is a genuine failure.
// All test files route page.goto through this.
export async function gotoSafe(page, url, opts) {
  try {
    return await page.goto(url, opts);
  } catch (e) {
    if (!String(e).includes('Navigation timeout')) throw e;
    console.log(`  [gotoSafe] nav timeout, retrying once: ${url}`);
    return page.goto(url, opts);
  }
}
