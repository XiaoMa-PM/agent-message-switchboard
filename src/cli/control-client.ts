// INPUT: msd control socket path, method name, params and client timeout/id options.
// OUTPUT: callControl → the daemon's `result` for one length-prefixed request, or a fixed CliError.
// POS: The CLI's only control-API transport; one connection per request, no retries or caching.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createIpcDecoder, encodeIpcFrame } from '../bridge/ipc-frame.ts';
import { CliError } from './errors.ts';

export type ControlOptions = Readonly<{ timeoutMs: number; newId?: () => string }>;

const RESPONSE_KEYS_OK = ['id', 'ok', 'result', 'schemaVersion'];
const RESPONSE_KEYS_ERROR = ['error', 'id', 'ok', 'schemaVersion'];
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function protocolInvalid(): CliError { return new CliError('DAEMON_PROTOCOL_INVALID'); }

function sameKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function readResponse(value: unknown, id: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw protocolInvalid();
  const response = value as Record<string, unknown>;
  if (response.schemaVersion !== 1 || response.id !== id) throw protocolInvalid();
  if (response.ok === true && sameKeys(response, RESPONSE_KEYS_OK)) return response.result;
  if (response.ok === false && sameKeys(response, RESPONSE_KEYS_ERROR)
    && typeof response.error === 'string' && ERROR_CODE.test(response.error)) {
    throw new CliError('DAEMON_ERROR', response.error);
  }
  throw protocolInvalid();
}

function connectionError(error: NodeJS.ErrnoException): CliError {
  const absent = ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'ENOTDIR', 'EACCES'];
  return absent.includes(error.code ?? '') ? new CliError('DAEMON_UNAVAILABLE') : protocolInvalid();
}

export function callControl(
  socketPath: string, method: string, params: Record<string, unknown>, options: ControlOptions,
): Promise<unknown> {
  const id = (options.newId ?? randomUUID)();
  const frame = encodeIpcFrame({ schemaVersion: 1, id, method, params });
  return new Promise((resolve, reject) => {
    const decoder = createIpcDecoder();
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (error: CliError | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new CliError('DAEMON_TIMEOUT')), options.timeoutMs);
    socket.on('connect', () => socket.write(frame));
    socket.on('error', error => finish(connectionError(error)));
    socket.on('end', () => finish(protocolInvalid()));
    socket.on('data', chunk => {
      let values: unknown[];
      try { values = decoder.push(chunk); } catch { finish(protocolInvalid()); return; }
      if (values.length === 0) return;
      try { finish(null, readResponse(values[0], id)); } catch (error) { finish(error as CliError); }
    });
  });
}
