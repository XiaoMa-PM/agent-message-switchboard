// INPUT: Unknown v1 requests, fixed CLI Skill hooks and instance-owned App Skill profiles.
// OUTPUT: Frozen exact-profile parsers, connect/send/reply/list requests and correlation without sender authority.
// POS: Pure bridge data boundary; no approval decision, identity or dispatch.
import { parseSend, parseReply, type SendRequest, type ReplyRequest } from '../protocol/message.ts';

export type BridgeRequest = Readonly<{ schemaVersion: 1; operation: 'connect'; targetSessionId: string }>
  | Readonly<{ schemaVersion: 1; operation: 'list'; harness: 'dsh' }>
  | Readonly<SendRequest & { operation: 'send' }>
  | Readonly<ReplyRequest & { operation: 'reply' }>;
export type SkillInvocation = Readonly<{ event: 'PreToolUse' | 'PostToolUse'; sessionId: string;
  toolUseId: string; request: BridgeRequest; originalArgs: string }>;

const SKILL_NAME = 'agent-message-switchboard:message';
const commonRequired = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'tool_name', 'tool_input', 'tool_use_id'];
const commonOptional = ['prompt_id', 'permission_mode', 'agent_id', 'agent_type', 'scratchpad_dir', 'effort'];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_OBJECT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw new Error('INVALID_OBJECT');
  return value as Record<string, unknown>;
}

function fields(raw: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (!required.every(key => Object.hasOwn(raw, key))
      || Object.keys(raw).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('INVALID_FIELDS');
}

function text(value: unknown, identifier = false): string {
  if (typeof value !== 'string' || (identifier && !value.trim())) throw new Error('INVALID_TEXT');
  return value;
}

export function parseBridgeRequest(value: unknown): BridgeRequest {
  try {
    const raw = record(value);
    if (raw.schemaVersion !== 1) throw new Error('UNSUPPORTED_SCHEMA');
    if (raw.operation === 'list') {
      fields(raw, ['schemaVersion', 'operation', 'harness']);
      if (raw.harness !== 'dsh') throw new Error('INVALID_HARNESS');
      return Object.freeze({ schemaVersion: 1, operation: 'list', harness: 'dsh' });
    }
    if (raw.operation === 'connect') {
      fields(raw, ['schemaVersion', 'operation', 'targetSessionId']);
      return Object.freeze({ schemaVersion: 1, operation: 'connect', targetSessionId: text(raw.targetSessionId, true) });
    }
    if (raw.operation === 'send') {
      fields(raw, ['schemaVersion', 'operation', 'messageId', 'linkId', 'body']);
      return Object.freeze({ ...parseSend({ schemaVersion: 1, messageId: raw.messageId, linkId: raw.linkId, body: raw.body }),
        operation: 'send' });
    }
    if (raw.operation === 'reply') {
      fields(raw, ['schemaVersion', 'operation', 'messageId', 'inReplyTo', 'body']);
      return Object.freeze({ ...parseReply({ schemaVersion: 1, messageId: raw.messageId, inReplyTo: raw.inReplyTo, body: raw.body }),
        operation: 'reply' });
    }
    throw new Error('INVALID_OPERATION');
  } catch { throw new Error('INVALID_BRIDGE_REQUEST'); }
}

function metadata(raw: Record<string, unknown>): void {
  text(raw.transcript_path); text(raw.cwd);
  for (const key of commonOptional.filter(key => key !== 'effort')) {
    if (Object.hasOwn(raw, key)) text(raw[key]);
  }
  if (Object.hasOwn(raw, 'effort')) {
    const effort = record(raw.effort);
    fields(effort, ['level']); text(effort.level);
  }
  if (Object.hasOwn(raw, 'duration_ms') && (typeof raw.duration_ms !== 'number'
      || !Number.isFinite(raw.duration_ms) || raw.duration_ms < 0)) throw new Error('INVALID_DURATION');
}

function successfulPost(value: unknown, skillName: string): void {
  const response = record(value);
  fields(response, ['success', 'commandName'], ['readOnly', 'status']);
  if (response.success !== true || response.commandName !== skillName
      || (Object.hasOwn(response, 'readOnly') && response.readOnly !== false)
      || (Object.hasOwn(response, 'status') && response.status !== 'inline')) throw new Error('INVALID_SKILL_RESULT');
}

function parseInvocation(value: unknown, skillName: string): SkillInvocation {
  try {
    const raw = record(value);
    const event = raw.hook_event_name;
    if (event !== 'PreToolUse' && event !== 'PostToolUse') throw new Error('INVALID_EVENT');
    fields(raw, [...commonRequired, ...(event === 'PostToolUse' ? ['tool_response'] : [])],
      [...commonOptional, ...(event === 'PostToolUse' ? ['duration_ms'] : [])]);
    if (raw.tool_name !== 'Skill') throw new Error('INVALID_TOOL');
    metadata(raw);
    const input = record(raw.tool_input);
    fields(input, ['skill', 'args']);
    if (input.skill !== skillName) throw new Error('INVALID_SKILL');
    if (event === 'PostToolUse') successfulPost(raw.tool_response, skillName);
    const originalArgs = text(input.args);
    const request = parseBridgeRequest(JSON.parse(originalArgs));
    return Object.freeze({ event, sessionId: text(raw.session_id, true), toolUseId: text(raw.tool_use_id, true),
      request, originalArgs });
  } catch { throw new Error('INVALID_SKILL_INVOCATION'); }
}

export type AppSkillProfile = Readonly<{ name: string; parseInvocation: (value: unknown) => SkillInvocation }>;
const appProfiles = new WeakSet<AppSkillProfile>();

export function assertAppSkillProfile(profile: AppSkillProfile): void {
  if (!appProfiles.has(profile)) throw new Error('INVALID_APP_SKILL_PROFILE');
}

export function createAppSkillProfile(runId: string): AppSkillProfile {
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) {
    throw new Error('INVALID_APP_RUN_ID');
  }
  const name = 'ms-app-message-' + runId.slice(0, 8);
  const profile = Object.freeze({ name, parseInvocation: (value: unknown) => parseInvocation(value, name) });
  appProfiles.add(profile);
  return profile;
}

export function parseSkillInvocation(value: unknown): SkillInvocation {
  return parseInvocation(value, SKILL_NAME);
}
