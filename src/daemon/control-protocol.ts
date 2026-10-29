// INPUT: Decoded control-socket JSON values and thrown internal errors.
// OUTPUT: Validated v1 requests, response/event frames and the fixed public error-code set.
// POS: msd control wire contract; no dispatch, socket ownership or authentication.
import { encodeIpcFrame } from '../bridge/ipc-frame.ts';

export type ControlRequest = Readonly<{ id: string; method: string; params: Readonly<Record<string, unknown>> }>;

export const CONTROL_ERRORS: ReadonlySet<string> = new Set(['INVALID_REQUEST', 'UNKNOWN_METHOD', 'INVALID_HARNESS',
  'INVALID_CONFIG', 'ALREADY_ATTACHED', 'NOT_REGISTERED', 'UNKNOWN_SESSION', 'ALIAS_TAKEN', 'TARGET_OFFLINE',
  'USE_NATIVE_TOOLS', 'UNKNOWN_LINK', 'UNKNOWN_MESSAGE', 'NOT_RECIPIENT', 'MESSAGE_ID_CONFLICT',
  'LINK_PAUSED', 'BODY_TOO_LARGE', 'BODY_HAS_REPLY_MODE', 'UNKNOWN_DELIVERY', 'NOT_A_LETTER', 'LETTER_NOT_VERIFIED', 'LETTER_ALREADY_NOTIFIED',
  'CONFIG_WRITE_FAILED', 'STATE_WRITE_FAILED', 'INTERNAL_ERROR']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function requestId(value: unknown): string | null {
  return plain(value) && typeof value.id === 'string' && UUID.test(value.id) ? value.id : null;
}

export function parseControlRequest(value: unknown): ControlRequest {
  if (!plain(value) || value.schemaVersion !== 1 || requestId(value) === null || typeof value.method !== 'string'
      || !value.method || !plain(value.params) || Object.keys(value).length !== 4
      || !['schemaVersion', 'id', 'method', 'params'].every(name => Object.hasOwn(value, name))) {
    throw new Error('INVALID_REQUEST');
  }
  return Object.freeze({ id: value.id as string, method: value.method, params: Object.freeze({ ...value.params }) });
}

export function errorCode(error: unknown): string {
  return error instanceof Error && CONTROL_ERRORS.has(error.message) ? error.message : 'INTERNAL_ERROR';
}

export function successFrame(id: string, result: unknown): Buffer {
  return encodeIpcFrame({ schemaVersion: 1, id, ok: true, result });
}

export function errorFrame(id: string | null, error: unknown): Buffer {
  return encodeIpcFrame({ schemaVersion: 1, id, ok: false, error: errorCode(error) });
}

export function eventFrame(event: string, data: unknown): Buffer {
  return encodeIpcFrame({ schemaVersion: 1, event, data });
}

export function exactParams(params: Readonly<Record<string, unknown>>, required: readonly string[],
  optional: readonly string[] = []): void {
  if (!required.every(name => Object.hasOwn(params, name))
      || Object.keys(params).some(name => !required.includes(name) && !optional.includes(name))) {
    throw new Error('INVALID_REQUEST');
  }
}
