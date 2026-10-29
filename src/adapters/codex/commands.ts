// INPUT: A UserPromptSubmit prompt with the process's codex home, a verified thread ID with its surface/project, and fixed error codes.
// OUTPUT: parseCodexCommand (whole-prompt $ms-*, completion form $ms:ms-*, or the desktop / menu's skill link to this plugin's
//         cached SKILL.md; auto and reply take arguments) and the fixed block texts the hook shows.
// POS: Codex's user-typed Switchboard commands; pure, no I/O. The bridge runs them; the hook block keeps the prompt from the model.
import { join } from 'node:path';
import { CODEX_MARKETPLACE, CODEX_PLUGIN } from './plugin.ts';
import { REPLY_COMMANDS } from '../../protocol/reply-mode-text.ts';
import { type ClientSurface } from './thread-owner.ts';

export type CommandKind = 'register' | 'unregister' | 'auto' | 'reply';
export type CodexCommand = Readonly<{ kind: 'register' | 'unregister' } | { kind: 'auto' | 'reply'; input: string }>;
const NOT_SENT = '本提示未发送给模型。';
const NAMES: ReadonlyArray<readonly [CommandKind, string]> = Object.freeze([
  ['register', 'ms-register'], ['unregister', 'ms-unregister'], ['auto', 'ms-auto'], ['reply', 'ms-reply']]);
const VERBS: Readonly<Record<CommandKind, string>> = Object.freeze({ register: '登记', unregister: '撤销', auto: '自动登记',
  reply: '回复档位设置' });

// Only auto and reply take anything after the command, and only after whitespace.
function commandOf(kind: CommandKind, rest: string): CodexCommand | null {
  if (kind !== 'auto' && kind !== 'reply') return rest === '' ? Object.freeze({ kind }) : null;
  return rest === '' || /\s/.test(rest[0]) ? Object.freeze({ kind, input: rest }) : null;
}

// The desktop / menu submits [$ms:<name>](<codex home>/plugins/cache/ms-local/ms/<version>/skills/<name>/SKILL.md).
// Returns what follows the one link, or null when the label, the path or a second link says it is not ours.
function afterSkillLink(text: string, name: string, codexHome: string): string | null {
  const open = `[$ms:${name}](`;
  const close = text.startsWith(open) ? text.indexOf(')', open.length) : -1;
  if (close < 0) return null;
  const path = text.slice(open.length, close);
  const cache = `${join(codexHome, 'plugins', 'cache', CODEX_MARKETPLACE, CODEX_PLUGIN)}/`;
  if (!path.startsWith(cache)) return null;
  const [version, ...rest] = path.slice(cache.length).split('/');
  if (['', '.', '..'].includes(version) || rest.join('/') !== `skills/${name}/SKILL.md`) return null;
  const after = text.slice(close + 1);
  return after.includes('](') ? null : after;
}

// Exact whole-prompt match only: plain text, partial words and Switchboard letters (which start with a source header) never match.
export function parseCodexCommand(prompt: unknown, codexHome: string): CodexCommand | null {
  if (typeof prompt !== 'string') return null;
  const text = prompt.trim();
  for (const [kind, name] of NAMES) {
    const rests = [`$${name}`, `$ms:${name}`].map(form => (text.startsWith(form) ? text.slice(form.length) : null))
      .concat(afterSkillLink(text, name, codexHome));
    for (const rest of rests) {
      const command = rest === null ? null : commandOf(kind, rest);
      if (command !== null) return command;
    }
  }
  return null;
}

export function blockReason(reason: string) {
  return Object.freeze({ decision: 'block' as const, reason });
}

export function registeredText(state: 'registered' | 'unchanged', threadId: string, surface: ClientSurface, project: unknown): string {
  return `${state === 'registered' ? '已登记' : '已登记（无变化）'} Switchboard：codex 会话 ${threadId}`
    + `（${surface === 'cli' ? 'CLI' : '桌面'}${typeof project === 'string' && project ? `，项目 ${project}` : ''}）。`
    + `其他 Harness 现在可以联系本会话。${NOT_SENT}`;
}

export function unregisteredText(threadId: string): string {
  return `已撤销 Switchboard 登记：codex 会话 ${threadId} 现为离线，线路保留，重新 $ms-register 后续上。${NOT_SENT}`;
}

export function notRegisteredText(threadId: string): string {
  return `当前会话 ${threadId} 未登记 Switchboard，无需撤销；${NOT_SENT}`;
}

export function codexFailureText(kind: CommandKind, code: string, reason?: string): string {
  return `Switchboard ${VERBS[kind]}失败（${code}）${reason ? `：${reason}` : ''}；${NOT_SENT}`;
}

export function autoUsageText(): string {
  return codexFailureText('auto', 'INVALID_COMMAND_INPUT', '用法 $ms-auto on|off|status');
}

export function autoReceipt(text: string): string {
  return `${text}${NOT_SENT}`;
}

export function replyUsageText(): string {
  return codexFailureText('reply', 'INVALID_COMMAND_INPUT', `用法 ${REPLY_COMMANDS.codex} direct|confirm|act|status`);
}

export function replyReceipt(text: string): string {
  return `${text}${NOT_SENT}`;
}
