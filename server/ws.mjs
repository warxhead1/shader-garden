// Shader Garden — server/ws.mjs
// RFC6455 WebSocket framing, pure functions, zero dependencies. Node ships no
// WebSocket *server* (only the client global added in v22), so this is the
// ~200 lines the spec calls for instead of pulling in `ws`. Every function
// here is deterministic and I/O-free — relay.mjs owns the socket, this file
// only turns bytes into messages and messages into bytes. That split is what
// makes room.mjs's reducer testable without a real network stack.

import { createHash } from 'node:crypto';

// RFC6455 §1.3 — concatenated with the client's Sec-WebSocket-Key, SHA-1'd,
// base64'd. This is not a secret; it exists only to prove the peer speaks
// the WebSocket upgrade dance and isn't, say, an HTTP proxy replaying bytes.
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const MAX_MESSAGE_BYTES = 262144; // spec §2.1 — a single reassembled message cap.

export function acceptKey(secWebSocketKey) {
  return createHash('sha1').update(String(secWebSocketKey) + WS_MAGIC_GUID).digest('base64');
}

// ---- frame encoding (server -> client) ----
// Server frames are never masked (RFC6455 §5.1: masking is client-to-server
// only, to defeat cache-poisoning attacks on shared proxies that don't apply
// to server-originated bytes).

function encodeHeader(opcode, payloadLen) {
  const fin = 0x80;
  if (payloadLen <= 125) {
    const h = Buffer.alloc(2);
    h[0] = fin | opcode;
    h[1] = payloadLen; // MASK bit 0 — unmasked
    return h;
  }
  if (payloadLen <= 0xffff) {
    const h = Buffer.alloc(4);
    h[0] = fin | opcode;
    h[1] = 126;
    h.writeUInt16BE(payloadLen, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = fin | opcode;
  h[1] = 127;
  // writeBigUInt64BE — payloads here are bounded far below 2^53, but the
  // wire format is a true 64-bit length, so we write it honestly.
  h.writeBigUInt64BE(BigInt(payloadLen), 2);
  return h;
}

function encodeFrame(opcode, payload) {
  const header = encodeHeader(opcode, payload.length);
  return Buffer.concat([header, payload]);
}

export function encodeText(str) {
  return encodeFrame(0x1, Buffer.from(str, 'utf8'));
}

export function encodeClose(code, reason) {
  // Close payload is a 2-byte big-endian status code followed by an optional
  // UTF-8 reason. Both are optional per RFC6455 §5.5.1 but we always send a
  // code so the client's onclose handler has something to branch on.
  const reasonBuf = Buffer.from(reason || '', 'utf8');
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return encodeFrame(0x8, payload);
}

export function encodePing() {
  return encodeFrame(0x9, Buffer.alloc(0));
}

export function encodePong(payload) {
  return encodeFrame(0xa, payload || Buffer.alloc(0));
}

// ---- frame decoding (client -> server) ----
//
// decodeFrames is STREAMING: it is fed whatever bytes have arrived so far
// (possibly a partial frame, possibly several frames back-to-back) and it
// must never throw on a truncated buffer — TCP does not deliver frames
// atomically, so "not enough bytes yet" is a completely normal call, not an
// error. It returns the leftover unconsumed bytes as `rest` so the caller
// can re-feed them once more data arrives.
//
// Fragmented messages (opcode 0 continuation frames) are reassembled across
// calls using the `frag` accumulator the caller threads back in. Control
// frames (ping/pong/close) are allowed to interleave MID-fragmentation per
// RFC6455 §5.4 — a client may need to ping while streaming a huge message —
// so control frames are collected separately and never touch `frag`.

function utf8IsValid(buf) {
  // Buffer's utf8 decoder replaces invalid sequences with U+FFFD rather than
  // throwing, so we can't just try/catch. Round-trip through TextDecoder in
  // fatal mode instead — this is the standard way to detect malformed UTF-8
  // in Node without hand-rolling a byte-sequence validator.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Buffer} buf accumulated bytes not yet consumed
 * @param {{opcode:number, chunks:Buffer[]}|null} frag in-progress fragmented message, or null
 * @returns {{messages:string[], control:Array, rest:Buffer, frag:object|null, fatal?:{code:number,reason:string}}}
 */
export function decodeFrames(buf, frag = null) {
  const messages = [];
  const control = [];
  let offset = 0;

  while (true) {
    if (buf.length - offset < 2) break; // need at least the base header

    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let cursor = offset + 2;

    if (rsv !== 0) {
      // No extensions are negotiated (we don't advertise permessage-deflate
      // or anything else), so a set RSV bit is either a buggy client or an
      // attempt to smuggle something the protocol doesn't define.
      return { messages, control, rest: Buffer.alloc(0), frag, fatal: { code: 1002, reason: 'reserved bits set' } };
    }
    const knownOpcodes = new Set([0x0, 0x1, 0x2, 0x8, 0x9, 0xa]);
    if (!knownOpcodes.has(opcode)) {
      return { messages, control, rest: Buffer.alloc(0), frag, fatal: { code: 1002, reason: 'unknown opcode' } };
    }

    if (payloadLen === 126) {
      if (buf.length - cursor < 2) break;
      payloadLen = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (buf.length - cursor < 8) break;
      const big = buf.readBigUInt64BE(cursor);
      cursor += 8;
      // Reject anything that would not fit in a JS number safely; real
      // payloads are capped at MAX_MESSAGE_BYTES far below this anyway, so a
      // huge declared length is only ever a hostile or corrupt frame.
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { messages, control, rest: Buffer.alloc(0), frag, fatal: { code: 1009, reason: 'declared length too large' } };
      }
      payloadLen = Number(big);
    }

    const isControl = opcode >= 0x8;
    if (isControl && (!fin || payloadLen > 125)) {
      // RFC6455 §5.5: control frames MUST NOT be fragmented and MUST be
      // <= 125 bytes. A violation here is not "handle it gracefully" —
      // it means the peer's framer is broken enough that we can't trust
      // anything else it sends either.
      return { messages, control, rest: Buffer.alloc(0), frag, fatal: { code: 1002, reason: 'invalid control frame' } };
    }

    if (!masked) {
      // Client->server frames MUST be masked (RFC6455 §5.1). An unmasked
      // frame from a client is either a broken client or someone talking
      // raw TCP at us pretending to be WebSocket — either way, fatal.
      return { messages, control, rest: Buffer.alloc(0), frag, fatal: { code: 1002, reason: 'unmasked client frame' } };
    }

    const maskKeyLen = 4;
    if (buf.length - cursor < maskKeyLen + payloadLen) break; // frame not fully arrived yet

    // Message-level cap applies to the REASSEMBLED total, not a single
    // frame — a client could otherwise send unlimited 262143-byte
    // continuation frames forever. Check both the single frame and, for
    // fragments, the running total in `frag`.
    const runningTotal = (frag ? frag.chunks.reduce((n, c) => n + c.length, 0) : 0) + payloadLen;
    if (payloadLen > MAX_MESSAGE_BYTES || runningTotal > MAX_MESSAGE_BYTES) {
      return { messages, control, rest: Buffer.alloc(0), frag, fatal: { code: 1009, reason: 'message too large' } };
    }

    const maskKey = buf.subarray(cursor, cursor + maskKeyLen);
    cursor += maskKeyLen;
    const maskedPayload = buf.subarray(cursor, cursor + payloadLen);
    cursor += payloadLen;

    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = maskedPayload[i] ^ maskKey[i & 3];

    offset = cursor;

    if (isControl) {
      if (opcode === 0x8) control.push({ type: 'close', payload });
      else if (opcode === 0x9) control.push({ type: 'ping', payload });
      else if (opcode === 0xa) control.push({ type: 'pong', payload });
      continue; // control frames never touch `frag` — they can interleave freely
    }

    if (opcode === 0x0) {
      // Continuation frame — must have an in-progress fragmented message.
      if (!frag) {
        return { messages, control, rest: Buffer.alloc(0), frag, fatal: { code: 1002, reason: 'continuation with no start' } };
      }
      frag.chunks.push(payload);
      if (fin) {
        const full = Buffer.concat(frag.chunks);
        if (frag.opcode === 0x1) {
          if (!utf8IsValid(full)) {
            return { messages, control, rest: Buffer.alloc(0), frag: null, fatal: { code: 1007, reason: 'invalid utf-8' } };
          }
          messages.push(full.toString('utf8'));
        }
        // opcode 0x2 (binary) reassembly is accepted at the framing level
        // but the protocol (room.mjs) only ever speaks JSON text frames, so
        // binary messages are simply dropped here — never a fatal, since
        // that would let a stray binary frame from a misbehaving client
        // take the whole connection down.
        frag = null;
      }
      continue;
    }

    // New message start (text or binary opcode).
    if (frag) {
      // A new non-continuation data frame while a fragmented message is
      // still open is a framing violation (RFC6455 §5.4).
      return { messages, control, rest: Buffer.alloc(0), frag, fatal: { code: 1002, reason: 'new message during fragmentation' } };
    }
    if (fin) {
      if (opcode === 0x1) {
        if (!utf8IsValid(payload)) {
          return { messages, control, rest: Buffer.alloc(0), frag: null, fatal: { code: 1007, reason: 'invalid utf-8' } };
        }
        messages.push(payload.toString('utf8'));
      }
      // unfragmented binary (0x2): dropped, see above.
    } else {
      frag = { opcode, chunks: [payload] };
    }
  }

  return { messages, control, rest: buf.subarray(offset), frag };
}
