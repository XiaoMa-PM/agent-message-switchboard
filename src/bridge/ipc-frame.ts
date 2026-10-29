// INPUT: JSON-representable data and fragmented 4-byte-prefixed IPC bytes.
// OUTPUT: Bounded encoded frames and a permanently closed-on-failure decoder.
// POS: Pure bridge framing boundary; no authentication or socket ownership.
export const MAX_FRAME_BYTES = 1048576;
const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - 4;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function children(value: object): unknown[] {
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array && prototype !== Array.prototype) throw new Error('IPC_FRAME_INVALID');
  if (!array && prototype !== Object.prototype && prototype !== null) throw new Error('IPC_FRAME_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter(key => !array || key !== 'length');
  if (array && keys.length !== value.length) throw new Error('IPC_FRAME_INVALID');
  return keys.map((key, index) => {
    if (typeof key !== 'string' || (array && key !== String(index))) throw new Error('IPC_FRAME_INVALID');
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('IPC_FRAME_INVALID');
    return descriptor.value;
  });
}

function validateJson(value: unknown): void {
  const active = new Set<object>();
  const pending: Array<{ value: unknown; exit: boolean }> = [{ value, exit: false }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.exit) { active.delete(item.value as object); continue; }
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'number' && Number.isFinite(item.value)) continue;
    if (typeof item.value !== 'object' || active.has(item.value)) throw new Error('IPC_FRAME_INVALID');
    active.add(item.value);
    pending.push({ value: item.value, exit: true });
    for (const child of children(item.value)) pending.push({ value: child, exit: false });
  }
}

export function encodeIpcFrame(value: unknown): Buffer {
  let json: string;
  try { validateJson(value); json = JSON.stringify(value); }
  catch { throw new Error('IPC_FRAME_INVALID'); }
  const length = Buffer.byteLength(json);
  if (length > MAX_PAYLOAD_BYTES) throw new Error('IPC_FRAME_TOO_LARGE');
  const frame = Buffer.alloc(length + 4);
  frame.writeUInt32BE(length);
  frame.write(json, 4, length, 'utf8');
  return frame;
}

class IpcDecoder {
  #header = Buffer.alloc(4);
  #headerBytes = 0;
  #payload: Buffer | null = null;
  #payloadBytes = 0;
  #failed = false;
  #closed = false;

  #ready(): void {
    if (this.#failed) throw new Error('IPC_DECODER_FAILED');
    if (this.#closed) throw new Error('IPC_DECODER_CLOSED');
  }

  #fail(code: string): never {
    this.#failed = true;
    this.#payload = null;
    throw new Error(code);
  }

  #readHeader(chunk: Uint8Array, offset: number): number {
    const count = Math.min(4 - this.#headerBytes, chunk.byteLength - offset);
    this.#header.set(chunk.subarray(offset, offset + count), this.#headerBytes);
    this.#headerBytes += count;
    if (this.#headerBytes === 4) {
      const length = this.#header.readUInt32BE();
      if (length === 0) this.#fail('IPC_FRAME_INVALID');
      if (length > MAX_PAYLOAD_BYTES) this.#fail('IPC_FRAME_TOO_LARGE');
      this.#payload = Buffer.alloc(length);
      this.#payloadBytes = 0;
    }
    return offset + count;
  }

  #readPayload(chunk: Uint8Array, offset: number, result: unknown[]): number {
    const payload = this.#payload!;
    const count = Math.min(payload.byteLength - this.#payloadBytes, chunk.byteLength - offset);
    payload.set(chunk.subarray(offset, offset + count), this.#payloadBytes);
    this.#payloadBytes += count;
    if (this.#payloadBytes === payload.byteLength) {
      try {
        const value: unknown = JSON.parse(utf8.decode(payload));
        validateJson(value);
        result.push(value);
      } catch { this.#fail('IPC_FRAME_INVALID'); }
      this.#payload = null;
      this.#headerBytes = 0;
    }
    return offset + count;
  }

  push(chunk: Uint8Array): unknown[] {
    this.#ready();
    if (!(chunk instanceof Uint8Array)) this.#fail('IPC_FRAME_INVALID');
    const result: unknown[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      offset = this.#payload === null ? this.#readHeader(chunk, offset) : this.#readPayload(chunk, offset, result);
    }
    return result;
  }

  end(): void {
    this.#ready();
    if (this.#headerBytes !== 0 || this.#payload !== null) this.#fail('IPC_FRAME_EOF');
    this.#closed = true;
  }
}

export function createIpcDecoder(): Readonly<{ push: (chunk: Uint8Array) => unknown[]; end: () => void }> {
  const decoder = new IpcDecoder();
  return Object.freeze({ push: (chunk: Uint8Array) => decoder.push(chunk), end: () => decoder.end() });
}
