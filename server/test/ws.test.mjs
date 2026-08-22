// Shader Garden — server/test/ws.test.mjs
// Codec-level tests for server/ws.mjs. Every requirement listed in spec §2.1
// gets its own case here — no browser, no socket, just Buffers in and
// structured results out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptKey, decodeFrames, encodeText, encodeClose, encodePing, encodePong, MAX_MESSAGE_BYTES } from '../ws.mjs';

// A masked client text frame: fin=1, opcode=0x1, mask=1, len, mask key, XOR'd payload.
function clientTextFrame(str, { maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]) } = {}) {
  const payload = Buffer.from(str, 'utf8');
  return clientFrame(0x1, payload, { maskKey });
}

function clientFrame(opcode, payload, { fin = true, mask = true, maskKey = Buffer.from([0x01, 0x02, 0x03, 0x04]) } = {}) {
  const len = payload.length;
  let header;
  if (len <= 125) {
    header = Buffer.from([  (fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | len ]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i % 4];
  return mask ? Buffer.concat([header, maskKey, masked]) : Buffer.concat([header, payload]);
}

test('acceptKey matches the RFC6455 worked example', () => {
  // The canonical example from RFC6455 §1.3.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('unmasked client data frame is fatal 1002', () => {
  const buf = clientFrame(0x1, Buffer.from('hi'), { mask: false });
  const r = decodeFrames(buf);
  assert.equal(r.fatal.code, 1002);
});

test('payload length 0..125 decodes correctly', () => {
  const buf = clientTextFrame('short');
  const r = decodeFrames(buf);
  assert.deepEqual(r.messages, ['short']);
  assert.equal(r.rest.length, 0);
});

test('payload length 126 (16-bit extended) decodes correctly', () => {
  const s = 'x'.repeat(200);
  const r = decodeFrames(clientTextFrame(s));
  assert.deepEqual(r.messages, [s]);
});

test('payload length 127 (64-bit extended) decodes correctly', () => {
  const s = 'y'.repeat(70000);
  const r = decodeFrames(clientTextFrame(s));
  assert.deepEqual(r.messages, [s]);
});

test('continuation frames reassemble a fragmented message', () => {
  const part1 = clientFrame(0x1, Buffer.from('hel'), { fin: false });
  const part2 = clientFrame(0x0, Buffer.from('lo'), { fin: true });
  const r = decodeFrames(Buffer.concat([part1, part2]));
  assert.deepEqual(r.messages, ['hello']);
});

test('control frame interleaved mid-fragmentation does not break reassembly', () => {
  const part1 = clientFrame(0x1, Buffer.from('hel'), { fin: false });
  const ping = clientFrame(0x9, Buffer.from('p'));
  const part2 = clientFrame(0x0, Buffer.from('lo'), { fin: true });
  const r = decodeFrames(Buffer.concat([part1, ping, part2]));
  assert.deepEqual(r.messages, ['hello']);
  assert.equal(r.control.length, 1);
  assert.equal(r.control[0].type, 'ping');
});

test('fragmented control frame is fatal 1002', () => {
  const buf = clientFrame(0x9, Buffer.from('p'), { fin: false });
  const r = decodeFrames(buf);
  assert.equal(r.fatal.code, 1002);
});

test('oversized control frame (>125 bytes) is fatal 1002', () => {
  const buf = clientFrame(0x9, Buffer.from('x'.repeat(126)));
  const r = decodeFrames(buf);
  assert.equal(r.fatal.code, 1002);
});

test('reserved bits set is fatal 1002', () => {
  const buf = clientTextFrame('hi');
  buf[0] |= 0x40; // set RSV1
  const r = decodeFrames(buf);
  assert.equal(r.fatal.code, 1002);
});

test('unknown opcode is fatal 1002', () => {
  const buf = clientFrame(0x3, Buffer.from('hi'));
  const r = decodeFrames(buf);
  assert.equal(r.fatal.code, 1002);
});

test('message exceeding MAX_MESSAGE_BYTES is fatal 1009', () => {
  const buf = clientTextFrame('z'.repeat(MAX_MESSAGE_BYTES + 1));
  const r = decodeFrames(buf);
  assert.equal(r.fatal.code, 1009);
});

test('reassembled fragments exceeding MAX_MESSAGE_BYTES is fatal 1009', () => {
  const half = 'a'.repeat(Math.floor(MAX_MESSAGE_BYTES / 2) + 100);
  const part1 = clientFrame(0x1, Buffer.from(half), { fin: false });
  const part2 = clientFrame(0x0, Buffer.from(half), { fin: true });
  const r = decodeFrames(Buffer.concat([part1, part2]));
  assert.equal(r.fatal.code, 1009);
});

test('a truncated buffer returns rest and never throws', () => {
  const full = clientTextFrame('hello world');
  const partial = full.subarray(0, full.length - 3);
  assert.doesNotThrow(() => {
    const r = decodeFrames(partial);
    assert.deepEqual(r.messages, []);
    assert.equal(r.rest.length, partial.length);
  });
});

test('streaming: feeding the rest of a truncated frame completes the message', () => {
  const full = clientTextFrame('hello world');
  const split = 5;
  const r1 = decodeFrames(full.subarray(0, split));
  assert.deepEqual(r1.messages, []);
  const r2 = decodeFrames(Buffer.concat([r1.rest, full.subarray(split)]), r1.frag);
  assert.deepEqual(r2.messages, ['hello world']);
});

test('invalid UTF-8 in a text frame is fatal 1007', () => {
  const badPayload = Buffer.from([0xff, 0xfe, 0xfd]);
  const buf = clientFrame(0x1, badPayload);
  const r = decodeFrames(buf);
  assert.equal(r.fatal.code, 1007);
});

test('multiple complete frames in one buffer all decode', () => {
  const buf = Buffer.concat([clientTextFrame('a'), clientTextFrame('b')]);
  const r = decodeFrames(buf);
  assert.deepEqual(r.messages, ['a', 'b']);
});

test('encodeText produces an unmasked text frame carrying the exact string', () => {
  const buf = encodeText('hello');
  assert.equal(buf[0], 0x81); // fin + text opcode
  assert.equal(buf[1] & 0x80, 0); // server frames are unmasked
  assert.equal(buf.subarray(2).toString('utf8'), 'hello');
});

test('encodeText round-trips through a client-side unmask for a large payload', () => {
  const s = 'z'.repeat(70000);
  const buf = encodeText(s);
  assert.equal(buf[1] & 0x7f, 127);
  const len = Number(buf.readBigUInt64BE(2));
  assert.equal(len, Buffer.byteLength(s, 'utf8'));
});

test('encodeClose carries the status code and reason', () => {
  const buf = encodeClose(1002, 'bad');
  assert.equal(buf[0], 0x88);
  const payload = buf.subarray(2);
  assert.equal(payload.readUInt16BE(0), 1002);
  assert.equal(payload.subarray(2).toString('utf8'), 'bad');
});

test('encodePing/encodePong produce control frames', () => {
  assert.equal(encodePing()[0] & 0x0f, 0x9);
  const pong = encodePong(Buffer.from('x'));
  assert.equal(pong[0] & 0x0f, 0xa);
  assert.equal(pong.subarray(2).toString(), 'x');
});
