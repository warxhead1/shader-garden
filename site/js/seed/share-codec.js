// seed/share-codec.js — FORKED verbatim from site/js/share.js's b64url +
// compress/decompress (ruling C8, seed.md §3.2). decompress resolves an
// href= share link; compress mints the attribution chip's deep link for src=.
const MAX_DECOMPRESSED_BYTES = 256 * 1024; // deflate-raw ~1032:1 expansion; bomb cap

export function bytesToB64url(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
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

export async function compress(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return bytesToB64url(new Uint8Array(buf));
}

export async function decompress(b64url) {
  const stream = new Blob([b64urlToBytes(b64url)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
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
