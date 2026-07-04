// Shader Garden — core/bus.js
// In-page CloudEvents-lite pub/sub. Microtask-deferred FIFO delivery — a
// handler never runs inside the stack frame that called emit(), so an emit
// during DOM construction can never re-enter a half-built organ (the same
// bug class v1's seq-token guards exist to avoid). Source is bound once per
// caller via bindSource() — a convention that prevents accidental
// mislabeling, not a security boundary: bindSource is an open export, so
// any page code can bind any source. Enforcement is deliberately v3.
//
// Envelope shape mirrors nervous-bus (schemas/shader.preadmit.evaluated.v1.json):
// specversion, id, source, type, datacontenttype, time, data.

const RING_MAX = 256;
const ring = [];
const listeners = new Map(); // type -> Set<fn>
const taps = new Set();

let queue = [];
let draining = false;
let inTapDispatch = false;

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid() {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  const rnd = new Uint8Array(10);
  crypto.getRandomValues(rnd);
  let rand = '';
  let bits = 0;
  let acc = 0;
  for (const byte of rnd) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += B32[(acc >>> bits) & 31];
    }
  }
  return time + rand;
}

function dispatch(envelope) {
  inTapDispatch = true;
  for (const fn of taps) {
    try { fn(envelope); } catch (e) { console.error('[bus] tap handler', e); }
  }
  inTapDispatch = false;
  const set = listeners.get(envelope.type);
  if (!set) return;
  for (const fn of set) {
    try { fn(envelope); } catch (e) { console.error('[bus] handler', e); }
  }
}

function drain() {
  draining = false;
  const batch = queue;
  queue = [];
  for (const envelope of batch) dispatch(envelope);
}

function schedule() {
  if (draining) return;
  draining = true;
  queueMicrotask(drain);
}

function emitAs(source, type, data) {
  if (inTapDispatch) throw new Error('bus: emit() is not allowed inside a tap handler');
  const envelope = {
    specversion: '1.0',
    id: ulid(),
    source,
    type,
    datacontenttype: 'application/json',
    time: new Date().toISOString(),
    data,
  };
  ring.push(envelope);
  if (ring.length > RING_MAX) ring.shift();
  queue.push(envelope);
  schedule();
  return envelope;
}

export function on(type, fn) {
  let set = listeners.get(type);
  if (!set) listeners.set(type, set = new Set());
  set.add(fn);
  return () => set.delete(fn);
}

export function tap(fn) {
  taps.add(fn);
  return () => taps.delete(fn);
}

export function recent() {
  return ring.slice();
}

// Every emitter gets a source bound once, at registration — an organ never
// picks its own label per-emit (the loader calls this at mount time; core
// modules bind themselves, e.g. bindSource('/garden/core')). This guards
// against accidental cross-organ mislabeling only: the export is open, so
// it is not an anti-spoofing boundary.
export function bindSource(source) {
  return Object.freeze({
    emit: (type, data) => emitAs(source, type, data),
    on,
    tap,
    recent,
  });
}
