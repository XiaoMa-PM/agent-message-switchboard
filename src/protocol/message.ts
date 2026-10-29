// INPUT: Unknown JSON-compatible endpoint, request, and envelope values.
// OUTPUT: Validated immutable v1 snapshots, explicit push evidence with peer authority, and the messageId format for new requests.
// POS: Cross-Harness wire contract; no native transport or authorization engine.
export type Harness = 'dsh' | 'claude-code' | 'codex';
export type Endpoint = Readonly<{ schemaVersion: 1; endpointId: string; harness: Harness;
  storageNamespace: string; nativeSessionId: string; hostInstanceId: string; routeGeneration: string }>;
export type SendRequest = Readonly<{ schemaVersion: 1; messageId: string; linkId: string; body: string }>;
export type ReplyRequest = Readonly<{ schemaVersion: 1; messageId: string; inReplyTo: string; body: string }>;
export type Envelope = Readonly<{ schemaVersion: 1; messageId: string; linkId: string;
  sender: Endpoint; recipient: Endpoint; replyTo: Endpoint; inReplyTo: string | null;
  body: string; sequence: number; sentAt: string; source: 'peer'; authority: 'none' }>;
export type PushOutcome = Readonly<{ state: 'dispatched' | 'delivery-unknown'; transport: 'written' | null }>;
export type Receipt = Readonly<PushOutcome & { messageId: string; envelope: Envelope }>;

// New daily send/reply requests name messages (messageId, inReplyTo) in this shape: the id lands verbatim in the inbound
// reply guidance. Generated ids are UUIDs; persisted records keep whatever they were written with.
export const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MESSAGE_ID_RULE = '1–128 个字符，只含字母、数字和 ._:- 四种符号，且以字母或数字开头';
export function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value);
}

const endpointKeys = ['schemaVersion', 'endpointId', 'harness', 'storageNamespace',
  'nativeSessionId', 'hostInstanceId', 'routeGeneration'];

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_OBJECT');
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error('UNSUPPORTED_SCHEMA');
  if (Object.keys(raw).length !== keys.length || !keys.every(key => Object.hasOwn(raw, key))) {
    throw new Error('INVALID_FIELDS');
  }
  return raw;
}

function text(value: unknown, identifier = false): string {
  if (typeof value !== 'string' || (identifier && !value.trim())) throw new Error('INVALID_TEXT');
  return value;
}

export function parseEndpoint(value: unknown): Endpoint {
  const raw = record(value, endpointKeys);
  const harness = raw.harness;
  if (harness !== 'dsh' && harness !== 'claude-code' && harness !== 'codex') throw new Error('INVALID_HARNESS');
  return Object.freeze({ schemaVersion: 1, harness, endpointId: text(raw.endpointId, true),
    storageNamespace: text(raw.storageNamespace, true), nativeSessionId: text(raw.nativeSessionId, true),
    hostInstanceId: text(raw.hostInstanceId, true), routeGeneration: text(raw.routeGeneration, true) });
}

export function parseSend(value: unknown): SendRequest {
  const raw = record(value, ['schemaVersion', 'messageId', 'linkId', 'body']);
  return Object.freeze({ schemaVersion: 1, messageId: text(raw.messageId, true),
    linkId: text(raw.linkId, true), body: text(raw.body) });
}

export function parseReply(value: unknown): ReplyRequest {
  const raw = record(value, ['schemaVersion', 'messageId', 'inReplyTo', 'body']);
  return Object.freeze({ schemaVersion: 1, messageId: text(raw.messageId, true),
    inReplyTo: text(raw.inReplyTo, true), body: text(raw.body) });
}

export function parseEnvelope(value: unknown): Envelope {
  const raw = record(value, ['schemaVersion', 'messageId', 'linkId', 'sender', 'recipient',
    'replyTo', 'inReplyTo', 'body', 'sequence', 'sentAt', 'source', 'authority']);
  if (raw.source !== 'peer' || raw.authority !== 'none') throw new Error('INVALID_AUTHORITY');
  if (typeof raw.sequence !== 'number' || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1) {
    throw new Error('INVALID_SEQUENCE');
  }
  const sentAt = text(raw.sentAt, true);
  const date = new Date(sentAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== sentAt) throw new Error('INVALID_TIME');
  const sender = parseEndpoint(raw.sender);
  const recipient = parseEndpoint(raw.recipient);
  const replyTo = parseEndpoint(raw.replyTo);
  if (JSON.stringify(replyTo) !== JSON.stringify(sender) || sender.harness === recipient.harness) {
    throw new Error('INVALID_ROUTE');
  }
  return Object.freeze({ schemaVersion: 1, messageId: text(raw.messageId, true),
    linkId: text(raw.linkId, true), sender, recipient, replyTo,
    inReplyTo: raw.inReplyTo === null ? null : text(raw.inReplyTo, true), body: text(raw.body),
    sequence: raw.sequence, sentAt, source: 'peer', authority: 'none' });
}

export function parsePushOutcome(value: unknown): PushOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PUSH_OUTCOME');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, 'state') || !Object.hasOwn(raw, 'transport')
      || (raw.state !== 'dispatched' && raw.state !== 'delivery-unknown')
      || (raw.transport !== null && raw.transport !== 'written')
      || (raw.state === 'dispatched' && raw.transport === 'written')) throw new Error('INVALID_PUSH_OUTCOME');
  return Object.freeze({ state: raw.state, transport: raw.transport });
}
