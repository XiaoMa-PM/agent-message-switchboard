// INPUT: Synthetic JSON values and fragmented length-prefixed byte streams.
// OUTPUT: IPC size, UTF-8, JSON and permanently closed decoder regressions.
// POS: Pure framing boundary tests; no socket, host, model or credentials.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_FRAME_BYTES, encodeIpcFrame, createIpcDecoder } from '../../src/bridge/ipc-frame.ts';

function rawFrame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.byteLength);
  return Buffer.concat([header, payload]);
}

function decode(frame: Uint8Array): unknown[] {
  const decoder = createIpcDecoder();
  const result = decoder.push(frame);
  decoder.end();
  return result;
}

test('frame prefix counts exact UTF-8 JSON bytes and preserves shell text', () => {
  const value = { body: ' \n中文😀 $HOME $(touch canary) `echo marker`\\\"\u2028\u2029 ', empty: '' };
  const frame = encodeIpcFrame(value);
  assert.equal(MAX_FRAME_BYTES, 1048576);
  assert.ok(frame.length >= 4);
  assert.equal(frame.readUInt32BE(0), Buffer.byteLength(JSON.stringify(value)));
  assert.deepEqual(decode(frame), [value]);
});

test('JSON primitives, null, arrays and shared noncyclic data roundtrip', () => {
  const shared = { text: 'original' };
  for (const value of [null, true, false, 0, 1.5, '', ['a', null], { a: shared, b: shared }]) {
    assert.deepEqual(decode(encodeIpcFrame(value)), [value]);
  }
});

test('every split across prefix and multibyte payload is accepted', () => {
  const value = { body: '中文😀\nsecond line' };
  const frame = encodeIpcFrame(value);
  for (let split = 0; split <= frame.length; split += 1) {
    const decoder = createIpcDecoder();
    assert.deepEqual([...decoder.push(frame.subarray(0, split)), ...decoder.push(frame.subarray(split))], [value]);
    decoder.end();
  }
});

test('one-byte chunks and concatenated frames preserve submission order', () => {
  const values = [{ body: '甲😀' }, { body: '乙\n' }, null];
  const stream = Buffer.concat(values.map(encodeIpcFrame));
  const decoder = createIpcDecoder();
  const observed = [...stream].flatMap(byte => decoder.push(Uint8Array.of(byte)));
  assert.deepEqual(observed, values);
  decoder.end();
  assert.deepEqual(decode(stream), values);
});

test('1 MiB includes the prefix and one byte beyond the limit is rejected', () => {
  const value = 'a'.repeat(MAX_FRAME_BYTES - 6);
  const frame = encodeIpcFrame(value);
  assert.equal(frame.length, MAX_FRAME_BYTES);
  assert.deepEqual(decode(frame), [value]);
  assert.throws(() => encodeIpcFrame(value + 'a'), /^Error: IPC_FRAME_TOO_LARGE$/);
});

test('invalid length is rejected from the prefix alone and failure is permanent', () => {
  for (const length of [0, MAX_FRAME_BYTES - 3, 0xffffffff]) {
    const decoder = createIpcDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    assert.deepEqual(decoder.push(header.subarray(0, 3)), []);
    assert.throws(() => decoder.push(header.subarray(3)), /IPC_FRAME_(INVALID|TOO_LARGE)/);
    assert.throws(() => decoder.push(encodeIpcFrame(null)), /^Error: IPC_DECODER_FAILED$/);
    assert.throws(() => decoder.end(), /^Error: IPC_DECODER_FAILED$/);
  }
});

test('unfinished prefix or payload is EOF failure with no partial result', () => {
  const frame = encodeIpcFrame({ body: 'text' });
  for (const cut of [1, 2, 3, 4, frame.length - 1]) {
    const decoder = createIpcDecoder();
    assert.deepEqual(decoder.push(frame.subarray(0, cut)), []);
    assert.throws(() => decoder.end(), /^Error: IPC_FRAME_EOF$/);
    assert.throws(() => decoder.push(frame), /^Error: IPC_DECODER_FAILED$/);
  }
});

test('malformed UTF-8, JSON, BOM and numeric overflow fail without raw data', () => {
  const invalid = [Buffer.from([0xc3, 0x28]), Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from('{"private-body":'), Buffer.from('true false'), Buffer.from('1e400'),
    Buffer.from('\ufeffnull')];
  for (const bytes of invalid) {
    const decoder = createIpcDecoder();
    assert.throws(() => decoder.push(rawFrame(bytes)), /^Error: IPC_FRAME_INVALID$/);
    assert.throws(() => decoder.push(encodeIpcFrame(null)), /^Error: IPC_DECODER_FAILED$/);
  }
});

test('duplicate JSON keys use standard final-key parsing semantics', () => {
  assert.deepEqual(decode(rawFrame(Buffer.from('{"value":1,"value":2}'))), [{ value: 2 }]);
});

test('encoding rejects values JSON would erase or silently transform', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('private getter'); } });
  const values = [undefined, () => {}, Symbol('secret'), 1n, NaN, Infinity,
    { value: undefined }, [undefined], Array(1), new Date(), new Map(), cycle, getter,
    { [Symbol('secret')]: 'value' }, { toJSON: () => 'replacement' }];
  for (const value of values) assert.throws(() => encodeIpcFrame(value), /^Error: IPC_FRAME_INVALID$/);
});

test('array prototype serialization hooks cannot replace JSON data', () => {
  const value = Object.setPrototypeOf(['original'], { toJSON: () => 'replacement' });
  assert.throws(() => encodeIpcFrame(value), /^Error: IPC_FRAME_INVALID$/);
});

test('invalid byte input permanently fails the decoder', () => {
  const decoder = createIpcDecoder();
  assert.throws(() => decoder.push([] as unknown as Uint8Array), /^Error: IPC_FRAME_INVALID$/);
  assert.throws(() => decoder.push(encodeIpcFrame(null)), /^Error: IPC_DECODER_FAILED$/);
});

test('completed and empty decoders close permanently', () => {
  for (const populated of [false, true]) {
    const decoder = createIpcDecoder();
    if (populated) assert.deepEqual(decoder.push(encodeIpcFrame('done')), ['done']);
    decoder.end();
    assert.throws(() => decoder.push(Buffer.alloc(0)), /^Error: IPC_DECODER_CLOSED$/);
    assert.throws(() => decoder.end(), /^Error: IPC_DECODER_CLOSED$/);
  }
});

test('an invalid frame poisons a batch without returning earlier batch results', () => {
  const decoder = createIpcDecoder();
  assert.throws(() => decoder.push(Buffer.concat([encodeIpcFrame('valid'), rawFrame(Buffer.from('invalid'))])),
    /^Error: IPC_FRAME_INVALID$/);
  assert.throws(() => decoder.push(encodeIpcFrame('later')), /^Error: IPC_DECODER_FAILED$/);
});
