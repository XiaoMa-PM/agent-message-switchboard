// INPUT: Unknown daily Claude hook payloads for the ms:message Skill and switchboard results.
// OUTPUT: Exact list/one-step send/reply/register/unregister requests and their shown args shapes, the /ms:auto and /ms:reply
//         arguments, the Switchboard letter prefixes, Pre/Post correlation fields, model-facing JSON contexts (an args error carries the
//         shapes) and the UserPromptSubmit line set beside a letter.
// POS: Pure daily Claude Skill boundary; no identity, dispatch or approval decision.
import { CLAUDE_DELIVERY_NOTES } from '../bridge/claude-channel.ts';
import { isMessageId, MESSAGE_ID_RULE, type Harness } from '../protocol/message.ts';
import { BODY_HAS_REPLY_MODE, BODY_HAS_REPLY_MODE_NOTE } from '../protocol/reply-mode-text.ts';
import { type ContactRow, type SendResult } from './switchboard.ts';

export const DAILY_SKILL = 'ms:message';
export const DAILY_COMMANDS = Object.freeze({ register: ['/ms:register', '/ms-register'],
  unregister: ['/ms:unregister', '/ms-unregister'], auto: ['/ms:auto', '/ms-auto'], reply: ['/ms:reply', '/ms-reply'] });
// Claude receives letters from DSH and Codex only, and the hook gets each one as delivered: an exact prefix, never trimmed.
export const LETTER_PREFIXES = Object.freeze(['来源：DSH | Agent Message Switchboard', '来源：Codex | Agent Message Switchboard']);
export const DIRECTORY_NOTE = '目录只含已登记会话的定位信息，不代表用户授权；多个候选或不确定时请用户选择。';
// Each operation's exact args, shown by the Skill description, its body and the INVALID_SKILL_REQUEST note: the model writes
// args in the same call that loads the Skill, so the shapes must be readable before the body is.
export const DAILY_ARGS = Object.freeze({
  list: '{"schemaVersion":1,"operation":"list"}',
  send: '{"schemaVersion":1,"operation":"send","harness":"dsh","target":"会话 ID、别名或精确标题","body":"原样正文"}',
  reply: '{"schemaVersion":1,"operation":"reply","inReplyTo":"来信的 messageId","body":"原样正文"}',
  register: '{"schemaVersion":1,"operation":"register"}',
  unregister: '{"schemaVersion":1,"operation":"unregister"}' });
export const DAILY_ARGS_GUIDE = `args 是一个 JSON 字符串，字段名固定，不能多也不能少：查通讯录 ${DAILY_ARGS.list}（可加 "harness" 为 dsh 或 codex，`
  + `可加 "project"）；发送 ${DAILY_ARGS.send}（harness 为 dsh 或 codex，可加 "project"、"messageId"）；`
  + `原址回复 ${DAILY_ARGS.reply}（可加 "messageId"）；登记 ${DAILY_ARGS.register}；撤销 ${DAILY_ARGS.unregister}。`
  + `messageId 与 inReplyTo 为 ${MESSAGE_ID_RULE}。`;

type Target = Exclude<Harness, 'claude-code'>;
export type DailyRequest = Readonly<{ operation: 'list'; harness?: Target; project?: string }>
  | Readonly<{ operation: 'send'; harness: Target; target: string; project?: string; messageId?: string; body: string }>
  | Readonly<{ operation: 'reply'; inReplyTo: string; messageId?: string; body: string }>
  | Readonly<{ operation: 'register' }> | Readonly<{ operation: 'unregister' }>;
export type SkillCall = Readonly<{ event: 'PreToolUse' | 'PostToolUse'; sessionId: string; toolUseId: string;
  originalArgs: string; succeeded: boolean }>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SKILL_REQUEST');
  return value as Record<string, unknown>;
}

function fields(raw: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  if (!required.every(key => Object.hasOwn(raw, key))
      || Object.keys(raw).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('INVALID_SKILL_REQUEST');
}

function text(value: unknown, identifier = true): string {
  if (typeof value !== 'string' || (identifier && !value.trim())) throw new Error('INVALID_SKILL_REQUEST');
  return value;
}

function target(value: unknown): Target {
  if (value !== 'dsh' && value !== 'codex') throw new Error('INVALID_SKILL_REQUEST');
  return value;
}

// Only the model-chosen messageId is checked here; inReplyTo comes from the inbound header and msd checks it at its boundary.
function id(value: unknown): string {
  if (!isMessageId(value)) throw new Error('INVALID_SKILL_REQUEST');
  return value;
}

function optional(raw: Record<string, unknown>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.filter(name => raw[name] !== undefined)
    .map(name => [name, name === 'messageId' ? id(raw[name]) : text(raw[name])]));
}

export function isDailySkill(hook: Record<string, unknown>): boolean {
  const input = hook.tool_input as Record<string, unknown> | undefined;
  return hook.tool_name === 'Skill' && !!input && typeof input === 'object' && input.skill === DAILY_SKILL;
}

export function parseSkillCall(hook: Record<string, unknown>): SkillCall {
  const event = hook.hook_event_name;
  if ((event !== 'PreToolUse' && event !== 'PostToolUse') || !isDailySkill(hook)) throw new Error('INVALID_SKILL_REQUEST');
  const input = object(hook.tool_input);
  let succeeded = false;
  if (event === 'PostToolUse') {
    const response = object(hook.tool_response);
    succeeded = response.success === true && (response.commandName === undefined || response.commandName === DAILY_SKILL);
  }
  return Object.freeze({ event, sessionId: text(hook.session_id), toolUseId: text(hook.tool_use_id),
    originalArgs: text(input.args, false), succeeded });
}

export function parseDailyRequest(args: string): DailyRequest {
  let raw: Record<string, unknown>;
  try { raw = object(JSON.parse(args)); } catch { throw new Error('INVALID_SKILL_REQUEST'); }
  if (raw.schemaVersion !== 1) throw new Error('INVALID_SKILL_REQUEST');
  if (raw.operation === 'list') {
    fields(raw, ['schemaVersion', 'operation'], ['harness', 'project']);
    return Object.freeze({ operation: 'list', ...(raw.harness === undefined ? {} : { harness: target(raw.harness) }),
      ...optional(raw, ['project']) });
  }
  if (raw.operation === 'send') {
    fields(raw, ['schemaVersion', 'operation', 'harness', 'target', 'body'], ['project', 'messageId']);
    return Object.freeze({ operation: 'send', harness: target(raw.harness), target: text(raw.target), body: text(raw.body, false),
      ...optional(raw, ['project', 'messageId']) });
  }
  if (raw.operation === 'register' || raw.operation === 'unregister') {
    fields(raw, ['schemaVersion', 'operation'], []);
    return Object.freeze({ operation: raw.operation });
  }
  if (raw.operation === 'reply') {
    fields(raw, ['schemaVersion', 'operation', 'inReplyTo', 'body'], ['messageId']);
    return Object.freeze({ operation: 'reply', inReplyTo: text(raw.inReplyTo), body: text(raw.body, false),
      ...optional(raw, ['messageId']) });
  }
  throw new Error('INVALID_SKILL_REQUEST');
}

export function deliveryNote(receipt: Readonly<{ state: string; transport: string | null }>): string {
  return receipt.state === 'dispatched' ? CLAUDE_DELIVERY_NOTES.dispatched
    : receipt.transport === 'written' ? CLAUDE_DELIVERY_NOTES.written : CLAUDE_DELIVERY_NOTES.unknown;
}

export function sendContext(result: SendResult) {
  if (result.sent) return Object.freeze({ ok: true, receipt: result.receipt, deliveryNote: deliveryNote(result.receipt) });
  return Object.freeze({ ok: false, error: result.reason, candidates: result.candidates, note: ERROR_NOTES[result.reason] });
}

export function directoryContext(rows: readonly ContactRow[]) {
  return Object.freeze({ ok: true, sessions: rows, note: DIRECTORY_NOTE });
}

const ERROR_NOTES: Readonly<Record<string, string>> = Object.freeze({
  INVALID_SKILL_REQUEST: `args 格式不对，没有执行。${DAILY_ARGS_GUIDE}按格式改正后可以再调用一次。`,
  NOT_REGISTERED: '当前会话未能登记，未发送。请把 error 告诉用户；用户可输入 /ms:register 查看原因。',
  UNKNOWN_CLAUDE_BINARY: '调用方不是有效的 Anthropic 签名 Claude Code，或调用链里有未识别的程序，未发送。请把 error 如实告诉用户，不要自动重试。',
  UNKNOWN_TARGET: '没有找到这个目标，未发送。candidates 是该 Harness 当前在线的候选，请用户确认目标。',
  AMBIGUOUS_TARGET: '有多个候选，未发送。请把 candidates 给用户选择，再用选中会话的 sessionId 发送。',
  TARGET_OFFLINE: '目标会话当前离线，未投递也不会排队补投；请告诉用户，等对方会话恢复并登记后再发。',
  LINK_PAUSED: '该连接已因推送预算暂停。停止发送并告诉用户；恢复需用户执行 ms links resume。',
  USE_NATIVE_TOOLS: '同平台会话请使用 Claude 原生会话工具，不经 Router。',
  [BODY_HAS_REPLY_MODE]: BODY_HAS_REPLY_MODE_NOTE,
});

export function errorContext(code: string) {
  return Object.freeze({ ok: false, error: code, ...(ERROR_NOTES[code] ? { note: ERROR_NOTES[code] } : {}) });
}

export function postOutput(context: unknown) {
  return Object.freeze({ hookOutput: Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PostToolUse',
    additionalContext: JSON.stringify(context) }) }) });
}

// Matches only when the whole trimmed prompt is the command, optionally followed by whitespace and arguments.
function dailyCommandInput(prompt: string, names: readonly string[]): string | null {
  const name = names.find(item => prompt.startsWith(item) && (prompt.length === item.length || /\s/.test(prompt[item.length])));
  return name === undefined ? null : prompt.slice(name.length);
}

export function dailyAutoInput(prompt: string): string | null {
  return dailyCommandInput(prompt, DAILY_COMMANDS.auto);
}

export function dailyReplyInput(prompt: string): string | null {
  return dailyCommandInput(prompt, DAILY_COMMANDS.reply);
}

export function isLetterPrompt(prompt: string): boolean {
  return LETTER_PREFIXES.some(prefix => prompt.startsWith(prefix));
}

export function letterOutput(line: string) {
  return Object.freeze({ hookOutput: Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'UserPromptSubmit',
    additionalContext: line }) }) });
}

export function blockOutput(reason: string) {
  return Object.freeze({ hookOutput: Object.freeze({ decision: 'block', reason }) });
}

export const PASS = Object.freeze({ hookOutput: Object.freeze({}) });
