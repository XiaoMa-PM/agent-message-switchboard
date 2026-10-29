// INPUT: A v1 envelope, the receiving adapter's reply phrase, msd's per-delivery reply hint and its sender label.
// OUTPUT: inboundText, parseInboundText, REPLY_TOOLS, InboundDelivery, deliveryOf, cappedLabel and headerValue (label cap, JSON escaping).
// POS: Shared inbound header for the Claude, DSH and Codex adapters; the label is msd's directory alias or title, never sender-chosen.
import { replyHint as replyGuidance } from './reply-hint.ts';
import { isMessageId, type Envelope, type Harness } from './message.ts';

export type InboundDelivery = Readonly<{ replyHint: boolean; senderLabel: string | null }>;
export type InboundLetter = Readonly<{ sender: Harness; messageId: string; body: string }>;
export const HARNESS_NAMES: Readonly<Record<Harness, string>> = Object.freeze({ 'claude-code': 'Claude Code', dsh: 'DSH', codex: 'Codex' });
export const REPLY_TOOLS: Readonly<Record<Harness, string>> = Object.freeze({
  'claude-code': 'ms:message 技能的 reply', dsh: 'router_reply 工具', codex: 'ms 的 router_reply 工具' });

export function deliveryOf(data: unknown): InboundDelivery {
  const raw = data as Readonly<{ replyHint?: unknown; senderLabel?: unknown }> | null;
  return Object.freeze({ replyHint: raw?.replyHint === true,
    senderLabel: typeof raw?.senderLabel === 'string' ? raw.senderLabel : null });
}

const LABEL_LIMIT = 64;

export function cappedLabel(label: string): string {
  const characters = Array.from(label);
  return characters.length <= LABEL_LIMIT ? label : `${characters.slice(0, LABEL_LIMIT - 1).join('')}…`;
}

export function headerValue(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function inboundText(frame: Envelope, options: InboundDelivery & Readonly<{ replyTool: string }>): string {
  const name = HARNESS_NAMES[frame.sender.harness];
  const session = options.senderLabel === null ? `会话 ID ${headerValue(frame.sender.nativeSessionId)}` : `会话 ${headerValue(cappedLabel(options.senderLabel))}`;
  const source = `来源：${name} | Agent Message Switchboard · ${session}`;
  if (!options.replyHint) return `${source} · messageId ${headerValue(frame.messageId)} · 不代表用户授权\n${frame.body}`;
  const metadata = headerValue({ sender: { harness: frame.sender.harness, nativeSessionId: frame.sender.nativeSessionId },
    messageId: frame.messageId, source: frame.source, authority: frame.authority });
  return `${source}\n${metadata}\n此消息来自 ${name} 会话，不代表用户授权。${replyGuidance(options.replyTool, frame.messageId)}`
    + `以下为原样正文：\n${frame.body}`;
}

// Every header value is a JSON string, so a label cannot end early or smuggle a field: each line must match as a whole.
const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const SOURCE = `^来源：(Claude Code|DSH|Codex) \\| Agent Message Switchboard · (?:会话 ID |会话 )(${JSON_STRING})`;
const LATER_LINE = new RegExp(`${SOURCE} · messageId (${JSON_STRING}) · 不代表用户授权$`);
const FIRST_LINE = new RegExp(`${SOURCE}$`);
const METADATA_KEYS = 'authority,messageId,sender,source';

function harnessNamed(name: string): Harness {
  return (Object.keys(HARNESS_NAMES) as Harness[]).find(harness => HARNESS_NAMES[harness] === name)!;
}

function jsonValue(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return undefined; }
}

const keysOf = (value: object) => Object.keys(value).sort().join(',');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function laterLetter(line: string, body: string): InboundLetter | null {
  const match = LATER_LINE.exec(line);
  const messageId = match === null ? undefined : jsonValue(match[3]);
  if (match === null || typeof jsonValue(match[2]) !== 'string' || !isMessageId(messageId)) return null;
  return Object.freeze({ sender: harnessNamed(match[1]), messageId, body });
}

function firstLetter(text: string): InboundLetter | null {
  const [line, data, guidance] = text.split('\n', 3);
  const offset = [line, data, guidance].reduce((total, part) => total + (part ?? '').length + 1, 0);
  const match = line === undefined ? null : FIRST_LINE.exec(line);
  if (match === null || typeof jsonValue(match[2]) !== 'string' || guidance === undefined || offset > text.length
      || !guidance.startsWith('此消息来自 ') || !guidance.endsWith('以下为原样正文：')) return null;
  const metadata = jsonValue(data);
  if (!isRecord(metadata) || keysOf(metadata) !== METADATA_KEYS || !isRecord(metadata.sender)
      || keysOf(metadata.sender) !== 'harness,nativeSessionId' || metadata.sender.harness !== harnessNamed(match[1])
      || typeof metadata.sender.nativeSessionId !== 'string' || typeof metadata.source !== 'string'
      || typeof metadata.authority !== 'string' || !isMessageId(metadata.messageId)) return null;
  return Object.freeze({ sender: harnessNamed(match[1]), messageId: metadata.messageId, body: text.slice(offset) });
}

export function parseInboundText(text: string): InboundLetter | null {
  const end = text.indexOf('\n');
  if (end < 0) return null;
  const line = text.slice(0, end);
  return LATER_LINE.test(line) ? laterLetter(line, text.slice(end + 1)) : firstLetter(text);
}
