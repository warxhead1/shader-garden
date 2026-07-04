// Shader Garden — share.js
// Compressed share links (CompressionStream deflate-raw -> base64url),
// GitHub suggestion URLs, clipboard + toast helpers.
// NOTE: REPO is substituted at deploy time (literal placeholder string).

const REPO = 'OWNER_REPO_PLACEHOLDER';

/* ---------------- base64url ---------------- */

function bytesToB64url(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- compress / decompress ---------------- */

export async function compress(str) {
  const stream = new Blob([str]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return bytesToB64url(new Uint8Array(buf));
}

// Hard cap on decompressed share-link size. deflate expands up to ~1032:1, so
// an unbounded read is a decompression bomb (a sub-MB hash fragment could
// materialize hundreds of MB and OOM the tab). 256 KiB is far above any real
// shader source.
const MAX_DECOMPRESSED_BYTES = 256 * 1024;

export async function decompress(b64url) {
  const stream = new Blob([b64urlToBytes(b64url)]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DECOMPRESSED_BYTES) {
      await reader.cancel();
      throw new Error('shared source exceeds ' + MAX_DECOMPRESSED_BYTES + ' bytes');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(out);
}

/* ---------------- URLs ---------------- */

// Hash fragment for a shared editor session. b64 is already URL-safe.
function editorShareHash(b64, lang) {
  return '#/edit?src=' + b64 + '&lang=' + encodeURIComponent(lang);
}

// Absolute URL to the current deployment (works under any Pages subpath).
export function absoluteShareUrl(b64, lang) {
  return location.href.split('#')[0] + editorShareHash(b64, lang);
}

export function githubRepoUrl() {
  return 'https://github.com/' + REPO;
}

export function githubIssueUrl(title, body) {
  return (
    'https://github.com/' + REPO + '/issues/new' +
    '?title=' + encodeURIComponent(title) +
    '&body=' + encodeURIComponent(body)
  );
}

/* ---------------- clipboard + toast ---------------- */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback: hidden textarea (older permission contexts).
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ADM-D: operator-mode ring-buffer export (organs/anatomy). A plain
// Blob+<a download> — no backend exists, this IS the "upload" (nervous-bus
// `nervous publish` happens at home, off the exported file).
export function downloadJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

let toastTimer = null;
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
