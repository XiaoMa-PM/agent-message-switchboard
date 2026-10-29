// INPUT: A Codex home (read only: config.toml hook records, installed plugin cache) and the declarations plugin.ts makes.
// OUTPUT: ACT_HOOK_EVENTS, codexVersionHash, codexHookDeclarationHash, codexPluginContentHash, codexActHooksTrusted.
// POS: Read-only check before a letter enters act: an untrusted hook never runs. Ports Codex's hashes; never trusts a hook for the user.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CODEX_HOOKS, CODEX_MARKETPLACE, CODEX_PLUGIN, CODEX_PLUGIN_ID } from './plugin.ts';

export type HookGroup = Readonly<{ matcher?: string; hooks: ReadonlyArray<Readonly<Record<string, unknown>>> }>;
type HookState = { enabled?: boolean; trusted_hash?: string; trusted_content_hash?: string };

// The hooks act depends on: the letter's turn opens in UserPromptSubmit and is gated by PreToolUse and PermissionRequest.
// SessionStart only registers, and Stop and Interrupt only settle no-reply receipts, so act does not depend on them.
export const ACT_HOOK_EVENTS: readonly string[] = Object.freeze(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest']);
// Codex's event key labels; only the events in WITH_MATCHER keep their matcher in the hash (the others drop it).
const LABELS: Readonly<Record<string, string>> = Object.freeze({ SessionStart: 'session_start', UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', Stop: 'stop', Interrupt: 'interrupt' });
const WITH_MATCHER = new Set(['SessionStart', 'PreToolUse', 'PermissionRequest']);
const HOOKS_FILE = 'hooks/hooks.json';

const sortAll = (value: unknown): unknown => (Array.isArray(value) ? value.map(sortAll)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortAll((value as Record<string, unknown>)[key])])) : value);

// Codex's version hash: compact JSON with every object's keys sorted, SHA-256, "sha256:" + hex.
export function codexVersionHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(sortAll(value))).digest('hex')}`;
}

// Handler normalization: Interrupt (and SessionEnd) default to 1 second, clamped to 1..3; other events default to 600, at least 1.
function timeoutOf(event: string, value: unknown): number {
  const given = typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  return event === 'Interrupt' ? Math.min(Math.max(given ?? 1, 1), 3) : Math.max(given ?? 600, 1);
}

// Declaration hash: the event label, the matcher where the event takes one, and the single normalized handler.
// ms only declares mcp_tool handlers; an absent statusMessage is left out, as TOML has no null.
export function codexHookDeclarationHash(event: string, group: HookGroup, index = 0): string {
  const handler = group.hooks[index];
  if (LABELS[event] === undefined || handler?.type !== 'mcp_tool') throw new Error('UNSUPPORTED_HOOK');
  const normalized = { type: 'mcp_tool', server: handler.server, tool: handler.tool, input: handler.input ?? {},
    timeout: timeoutOf(event, handler.timeout), ...(handler.statusMessage === undefined ? {} : { statusMessage: handler.statusMessage }) };
  const matcher = WITH_MATCHER.has(event) ? group.matcher : undefined;
  return codexVersionHash({ event_name: LABELS[event], ...(matcher === undefined ? {} : { matcher }), hooks: [normalized] });
}

const EXCLUDED = (name: string) => name === '__pycache__' || name === '.venv' || name.endsWith('.pyc') || name.endsWith('.egg-info');
const lengthOf = (size: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(size)); return bytes; };

// Plugin bundle hash: a depth-first walk in byte order of names, each entry framed by its length-prefixed relative path and
// "directory" or "file" + length + bytes; excluded names are skipped and anything that is neither a file nor a directory fails.
export async function codexPluginContentHash(root: string): Promise<string> {
  if (!(await lstat(root)).isDirectory()) throw new Error('PLUGIN_ROOT_NOT_DIRECTORY');
  const hash = createHash('sha256').update('codex-plugin-bundle-v1');
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop() as string;
    if (relative !== '' && EXCLUDED(basename(relative))) continue;
    const name = Buffer.from(relative);
    hash.update(lengthOf(name.length)).update(name);
    const path = relative === '' ? root : join(root, relative);
    const info = await lstat(path);
    if (info.isDirectory()) {
      hash.update('directory');
      const names = (await readdir(path)).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      pending.push(...names.reverse().map(item => (relative === '' ? item : `${relative}/${item}`)));
    } else if (info.isFile()) {
      const bytes = await readFile(path);
      if (bytes.length !== info.size) throw new Error('PLUGIN_FILE_CHANGED');
      hash.update('file').update(lengthOf(info.size)).update(bytes);
    } else {
      throw new Error('UNSUPPORTED_PLUGIN_ENTRY');
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

const keyOf = (event: string) => `${CODEX_PLUGIN_ID}:${HOOKS_FILE}:${LABELS[event]}:0:0`;
const HEADER = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*"((?:[^"\\]|\\.)*)"\s*\](?:\s*#.*)?$/;
const FIELD = /^\s*(enabled|trusted_hash|trusted_content_hash)\s*=\s*(true|false|"(?:[^"\\]|\\.)*")\s*(?:#.*)?$/;
const OWN = `${CODEX_PLUGIN_ID}:`;

// The [hooks.state."<key>"] tables for ms's own keys, in the form Codex's config writer leaves them (one table per key, one field
// per line). Any other spelling of an ms key (inline table, dotted key, literal string, a repeated table, an unknown field) is
// not understood, so the whole record counts as unreadable (null).
function hookStates(text: string): ReadonlyMap<string, HookState> | null {
  const states = new Map<string, HookState>();
  let current: HookState | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      const header = HEADER.exec(line);
      const key = header === null ? null : JSON.parse(`"${header[1]}"`) as string;
      if (key === null || !key.startsWith(OWN)) {
        if (line.includes(OWN)) return null;
        current = null;
        continue;
      }
      if (states.has(key)) return null;
      current = {};
      states.set(key, current);
      continue;
    }
    if (current === null) {
      if (line.includes(OWN)) return null;
      continue;
    }
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const field = FIELD.exec(line);
    if (field === null) return null;
    const name = field[1] as keyof HookState;
    if (Object.hasOwn(current, name)) return null;
    const value: unknown = JSON.parse(field[2]);
    if ((name === 'enabled') !== (typeof value === 'boolean')) return null;
    Object.assign(current, { [name]: value });
  }
  return states;
}

// Exactly one installed version: with several, Codex runs the highest by semver, which ms does not decide here.
async function pluginRoot(codexHome: string): Promise<string | null> {
  const base = join(codexHome, 'plugins', 'cache', CODEX_MARKETPLACE, CODEX_PLUGIN);
  const versions: string[] = [];
  for (const entry of await readdir(base, { withFileTypes: true })) if (entry.isDirectory()) versions.push(entry.name);
  return versions.length === 1 ? join(base, versions[0]) : null;
}

// Codex's trust match: the stored declaration hash equals the current one and the stored bundle hash equals the bundle's
// current contents. A declaration-only record is not accepted here.
export async function codexActHooksTrusted(codexHome: string): Promise<boolean> {
  try {
    const states = hookStates(await readFile(join(codexHome, 'config.toml'), 'utf8'));
    const root = states === null ? null : await pluginRoot(codexHome);
    if (states === null || root === null) return false;
    const content = await codexPluginContentHash(root);
    return ACT_HOOK_EVENTS.every(event => {
      const state = states.get(keyOf(event));
      return state !== undefined && state.enabled !== false && state.trusted_content_hash === content
        && state.trusted_hash === codexHookDeclarationHash(event, CODEX_HOOKS[event][0]);
    });
  } catch { return false; }
}
