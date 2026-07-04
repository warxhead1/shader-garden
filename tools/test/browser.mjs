// Shared bits for the headless harness: browser resolution + static server.
//
// Chrome resolution order: SG_CHROME, PUPPETEER_EXECUTABLE_PATH, newest
// chrome-headless-shell in the puppeteer cache. SwiftShader flags mean the
// GL2 path runs everywhere; the WebGPU path does NOT execute headless — real
// WebGPU rows in the launch checklist are verified on real browsers only.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
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

function derivePort(offset = 0) {
  return 8100 + ((process.pid + offset) % 1800);
}

// Serves site/ on a pid-derived localhost port; caller must kill() the result.
export async function serveSite(root = SITE_ROOT, port = derivePort()) {
  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
    { cwd: root, stdio: 'ignore' });
  await sleep(800);
  return { server, base: `http://127.0.0.1:${port}` };
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
