// INPUT: Validated compact Skill result ready for RPC and native Post output; daily msd hook outputs.
// OUTPUT: Whole 1 MiB frames, Claude-directory-only 10,000 UTF-16 context guard and the daily output allowlist (block, PostToolUse
//         Skill results, the UserPromptSubmit reply-mode line beside a letter and, for the act hook, a PreToolUse ask or deny).
// POS: Output preflight only; no metadata read, transport, truncation or dispatch.
import { encodeIpcFrame } from './ipc-frame.ts';
import { type SessionDirectoryResult } from '../registry/session-view.ts';
const REQUEST_ID = '00000000-0000-0000-0000-000000000000';
export function assertHookOutputCapacity(result: unknown): void {
  encodeIpcFrame({ schemaVersion: 1, requestId: REQUEST_ID, ok: true, result });
  encodeIpcFrame({ hookSpecificOutput: {
    hookEventName: 'PostToolUse', additionalContext: JSON.stringify(result),
  } });
}

export function assertClaudeDirectoryOutputCapacity(result: SessionDirectoryResult): void {
  assertHookOutputCapacity(result);
  if (JSON.stringify(result).length > 10000) throw new Error('METADATA_CONTEXT_TOO_LARGE');
}

export type PermissionOutput = Readonly<{ hookEventName: 'PreToolUse'; permissionDecision: 'ask' | 'deny'; permissionDecisionReason: string }>;
export type DailyHookOutput = Readonly<Record<string, never>> | Readonly<{ decision: 'block'; reason: string }>
  | Readonly<{ hookSpecificOutput: Readonly<{ hookEventName: 'PostToolUse' | 'UserPromptSubmit'; additionalContext: string }> }>
  | Readonly<{ hookSpecificOutput: PermissionOutput }>;
const CONTEXT_EVENTS: ReadonlySet<unknown> = new Set(['PostToolUse', 'UserPromptSubmit']);
export type DailyHookResult = Readonly<{ hookOutput: DailyHookOutput }>;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';

// Mirrors native broker_server.dailyHookOutput: no allow, continue or other approval fields. ms only tightens: the act hook may
// ask or deny a PreToolUse call, never allow one.
export function parseDailyHookResult(value: unknown): DailyHookResult {
  if (!exactKeys(value, ['hookOutput'])) throw new Error('INVALID_IPC_RESULT');
  const output = value.hookOutput;
  if (exactKeys(output, [])) return Object.freeze({ hookOutput: Object.freeze({}) });
  if (exactKeys(output, ['decision', 'reason']) && output.decision === 'block' && filled(output.reason)) {
    return Object.freeze({ hookOutput: Object.freeze({ decision: 'block', reason: output.reason as string }) });
  }
  if (exactKeys(output, ['hookSpecificOutput'])) {
    const inner = output.hookSpecificOutput;
    if (exactKeys(inner, ['hookEventName', 'additionalContext']) && CONTEXT_EVENTS.has(inner.hookEventName)
        && filled(inner.additionalContext)) {
      return Object.freeze({ hookOutput: Object.freeze({ hookSpecificOutput: Object.freeze({
        hookEventName: inner.hookEventName as 'PostToolUse' | 'UserPromptSubmit', additionalContext: inner.additionalContext as string }) }) });
    }
    if (exactKeys(inner, ['hookEventName', 'permissionDecision', 'permissionDecisionReason']) && inner.hookEventName === 'PreToolUse'
        && (inner.permissionDecision === 'ask' || inner.permissionDecision === 'deny') && filled(inner.permissionDecisionReason)) {
      return Object.freeze({ hookOutput: Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PreToolUse' as const,
        permissionDecision: inner.permissionDecision, permissionDecisionReason: inner.permissionDecisionReason as string }) }) });
    }
  }
  throw new Error('INVALID_IPC_RESULT');
}
