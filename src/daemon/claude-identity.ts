// INPUT: A daily hook's kernel peer, signed live inspect (pidversion-bound Developer ID signer per process) and sha256 wrapper pins.
// OUTPUT: The nearest Anthropic-signed Claude Code CLI with its surface (desktop, standalone, App terminal panel, agent view), or fail-closed codes.
// POS: Daily Claude identity by code signature; older registrations keep path+sha256 pins.
import { isAbsolute } from 'node:path';
import { type BinaryPin, type KernelPeer, type SignedSnapshot, type InspectSigned } from '../adapters/claude/peer-identity.ts';

export const ANTHROPIC_TEAM_ID = 'Q6L2SF6YDW';
export const CLAUDE_IDENTIFIERS = Object.freeze({ cli: 'com.anthropic.claude-code', app: 'com.anthropic.claudefordesktop',
  helper: 'disclaimer', terminalHost: 'com.anthropic.claudefordesktop.helper' } as const);
// The App's four helper programs (plain, Renderer, GPU, Plugin) share the terminalHost identifier; only the plain one hosts the panel.
const TERMINAL_HOST_EXE = '/Claude Helper.app/Contents/MacOS/Claude Helper';
type Role = keyof typeof CLAUDE_IDENTIFIERS;
export type ClaudeIdentity = Readonly<{ snapshot: SignedSnapshot; surface: 'cli' | 'desktop' }>;

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const integer = (value: unknown, minimum: number, maximum: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
const unique = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
function fail(code: string): never { throw new Error(code); }

export function claudeRole(row: SignedSnapshot): Role | null {
  const signing = row.signing;
  if (!signing || signing.teamId !== ANTHROPIC_TEAM_ID || !signing.runtime) return null;
  return (Object.keys(CLAUDE_IDENTIFIERS) as Role[]).find(role => CLAUDE_IDENTIFIERS[role] === signing.identifier) ?? null;
}

async function read(pid: number, inspect: InspectSigned): Promise<SignedSnapshot> {
  const raw = await inspect(pid);
  if (!raw) fail('INVALID_PEER_IDENTITY');
  const signing = raw.signing === null ? null
    : Object.freeze({ teamId: raw.signing.teamId, identifier: raw.signing.identifier, runtime: raw.signing.runtime });
  const row = Object.freeze({ pid: raw.pid, uid: raw.uid, pidVersion: raw.pidVersion, uniqueId: raw.uniqueId,
    parentPid: raw.parentPid, parentUniqueId: raw.parentUniqueId, exe: raw.exe, sha256: raw.sha256, signing });
  if (row.pid !== pid || !integer(row.uid, 0, 0xffffffff) || !integer(row.pidVersion, 0, 0xffffffff) || !unique(row.uniqueId)
      || !integer(row.parentPid, 1, 0x7fffffff) || !unique(row.parentUniqueId) || typeof row.exe !== 'string' || !isAbsolute(row.exe)
      || (row.sha256 === null) === (signing === null) || (row.sha256 !== null && !/^[a-f0-9]{64}$/.test(row.sha256))
      || (signing && (typeof signing.teamId !== 'string' || typeof signing.identifier !== 'string'
        || typeof signing.runtime !== 'boolean'))) fail('INVALID_PEER_IDENTITY');
  return row;
}

async function nearestCli(peer: KernelPeer, inspect: InspectSigned, wrappers: readonly BinaryPin[]): Promise<readonly SignedSnapshot[]> {
  let chain: readonly SignedSnapshot[] = [];
  let pid = peer.pid;
  while (pid > 1) {
    const row = await read(pid, inspect);
    const child = chain.at(-1);
    if (row.uid !== peer.uid || chain.some(item => item.uniqueId === row.uniqueId)
        || (child ? child.parentUniqueId !== row.uniqueId : row.pidVersion !== peer.pidVersion)) fail('INVALID_PEER_IDENTITY');
    chain = Object.freeze([...chain, row]);
    const role = claudeRole(row);
    if (role === 'cli') return chain;
    if (role !== null || row.signing !== null || !wrappers.some(pin => row.exe === pin.path && row.sha256 === pin.sha256)) {
      fail('UNKNOWN_CLAUDE_BINARY');
    }
    pid = row.parentPid;
  }
  return fail('INVALID_PEER_IDENTITY');
}

// App-hosted: the CLI's parent is a helper or the App, helpers lead to Claude.app. Standalone: no Claude process up to pid 1,
// except the App terminal panel: the CLI's parent is not Anthropic-signed (a shell) and the walk reaches the App's plain
// Electron helper (by signature and executable path) directly under Claude.app. Agent view: the CLI's parent is a CLI (the pty
// host), whose parent is launchd (adopted) or a CLI (the supervisor, shared by all background sessions); the walk stops there.
async function ancestry(cli: SignedSnapshot, inspect: InspectSigned) {
  let rows: readonly SignedSnapshot[] = [];
  let child = cli;
  let mode: 'desktop' | 'cli' | 'panel' | 'hosted' | undefined;
  while (child.parentPid > 1) {
    const parent = await read(child.parentPid, inspect);
    const role = claudeRole(parent);
    mode ??= role === 'helper' || role === 'app' ? 'desktop' : role === 'cli' ? 'hosted' : 'cli';
    const code = mode === 'desktop' ? 'INVALID_APP_ANCESTRY' : 'INVALID_CLI_ANCESTRY';
    if (parent.uniqueId !== child.parentUniqueId || [cli, ...rows].some(row => row.uniqueId === parent.uniqueId)) fail(code);
    rows = Object.freeze([...rows, parent]);
    if (mode === 'hosted') {
      if (role !== 'cli' || parent.uid !== cli.uid) fail(code);
      if (rows.length === 2) return Object.freeze({ surface: 'cli' as const, rows });
    } else if (mode !== 'cli' && role === 'app') {
      if (parent.uid !== cli.uid) fail(code);
      return Object.freeze({ surface: mode === 'desktop' ? 'desktop' as const : 'cli' as const, rows });
    } else if (mode === 'cli' && role === 'terminalHost' && parent.exe.endsWith(TERMINAL_HOST_EXE)
        && rows[0].signing?.teamId !== ANTHROPIC_TEAM_ID && parent.uid === cli.uid) mode = 'panel';
    else if (mode === 'panel' || (mode === 'desktop' ? role !== 'helper' : role !== null)) fail(code);
    child = parent;
  }
  if (mode === 'desktop') fail('INVALID_APP_ANCESTRY');
  if (mode === 'panel') fail('INVALID_CLI_ANCESTRY');
  return Object.freeze({ surface: 'cli' as const, rows });
}

export async function resolveClaudeIdentity(rawPeer: KernelPeer, inspect: InspectSigned,
  wrappers: readonly BinaryPin[]): Promise<ClaudeIdentity> {
  const peer = Object.freeze({ pid: rawPeer.pid, uid: rawPeer.uid, pidVersion: rawPeer.pidVersion });
  if (!integer(peer.pid, 2, 0x7fffffff) || !integer(peer.uid, 0, 0xffffffff) || !integer(peer.pidVersion, 0, 0xffffffff)) {
    fail('INVALID_PEER_IDENTITY');
  }
  const chain = await nearestCli(peer, inspect, wrappers);
  const cli = chain.at(-1)!;
  const { surface, rows } = await ancestry(cli, inspect);
  for (const expected of [...chain, ...rows].toReversed()) {
    if (!same(await read(expected.pid, inspect), expected)) fail('INVALID_PEER_IDENTITY');
  }
  return Object.freeze({ snapshot: cli, surface });
}
