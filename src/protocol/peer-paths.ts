// INPUT: A raw path or file glob from a peer-request tool call and the peer scope (workspace root, cwd, home).
// OUTPUT: PeerScope, resolvePeerPath, inWorkspace, isTildeUser, classifyPath (secret, protected, outside, inside), globMayMatchSecret.
// POS: Pure path rules of the shared standard; case-insensitive (APFS), no symlink following or I/O; the host sandbox is the real boundary.
import { posix } from 'node:path';

export type PeerScope = Readonly<{ workspace: string; cwd: string; home: string }>;
export type PathClass = 'secret' | 'protected' | 'outside' | 'inside';

// In lower case. Secrets are checked before protected config, so ~/.codex/auth.json is a secret and
// ~/.codex/config.toml config. The home-relative secrets also match under any other root, as whole path segments.
const SECRET_DIRS: ReadonlySet<string> = new Set(['.ssh', '.aws', '.gnupg', '.kube']);
const SECRET_NAME = /^(?:\.env(?:\.(?!(?:example|sample|template)$)[^/]+)?|.+\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.claude\.json|\.credentials\.json)$/;
const SECRET_SEQUENCES = ['.codex/auth.json', '.config/gh', '.config/gcloud', '.docker/config.json', 'library/keychains'];
const PROTECTED_DIRS: ReadonlySet<string> = new Set(['.git', '.claude', '.codex', '.agents', '.vscode', '.idea', '.husky', '.devcontainer']);
const PROTECTED_NAMES: ReadonlySet<string> = new Set(['claude.md', 'agents.md', '.mcp.json', '.gitconfig', '.zshrc', '.zshenv', '.zprofile',
  '.bashrc', '.bash_profile', '.profile']);
const PROTECTED_UNDER_HOME = ['library/launchagents', 'library/application support', '.config'];
// Names a file glob is tested against: one example of each secret name pattern above.
const SECRET_SAMPLES = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'key.pem', 'server.key',
  'cert.p12', 'cert.pfx', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.claude.json', '.credentials.json'];

export function resolvePeerPath(raw: string, scope: PeerScope): string {
  const expanded = raw === '~' ? scope.home : raw.startsWith('~/') ? posix.join(scope.home, raw.slice(2)) : raw;
  return posix.resolve(scope.cwd, expanded);
}

export const isTildeUser = (raw: string) => /^~[^/]/.test(raw);
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
export const inWorkspace = (raw: string, scope: PeerScope) => within(resolvePeerPath(raw, scope), scope.workspace);
const hasSequence = (lower: string, sequence: string) => `${lower}/`.includes(`/${sequence}/`);
const underHome = (lower: string, scope: PeerScope, list: readonly string[]) =>
  list.some(rel => within(lower, posix.join(scope.home, rel).toLowerCase()));

export function classifyPath(raw: string, scope: PeerScope): PathClass {
  const path = resolvePeerPath(raw, scope);
  const lower = path.toLowerCase();
  const parts = lower.split('/').filter(Boolean);
  const name = parts.at(-1) ?? '';
  if (parts.some(part => SECRET_DIRS.has(part)) || SECRET_NAME.test(name) || SECRET_SEQUENCES.some(item => hasSequence(lower, item))) {
    return 'secret';
  }
  if (parts.some(part => PROTECTED_DIRS.has(part)) || PROTECTED_NAMES.has(name) || underHome(lower, scope, PROTECTED_UNDER_HOME)) {
    return 'protected';
  }
  return inWorkspace(path, scope) ? 'inside' : 'outside';
}

const escape = (text: string) => text.replace(/[.+^$()|\\]/g, '\\$&');

// One glob segment as an anchored, case-insensitive regex; null when it is not understood (then it may match anything).
function segmentRegex(segment: string): RegExp | null {
  let out = '';
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (char === '*') { out += '.*'; continue; }
    if (char === '?') { out += '.'; continue; }
    if (char === '[' || char === '{') {
      const close = segment.indexOf(char === '[' ? ']' : '}', index + 1);
      const body = segment.slice(index + 1, close);
      if (close < 0 || /[[\]{}*?\\]/.test(body)) return null;
      out += char === '[' ? `[${body.startsWith('!') ? `^${escape(body.slice(1))}` : escape(body)}]` : `(?:${body.split(',').map(escape).join('|')})`;
      index = close; continue;
    }
    out += escape(char);
  }
  try { return new RegExp(`^${out}$`, 'i'); } catch { return null; }
}

// Whether a file filter glob (Grep's glob, a grep include) can select a secret file: its name segment is tested against one sample of
// each secret name, and a directory segment with a literal part against the secret directories (wildcard-only segments are skipped).
export function globMayMatchSecret(glob: string): boolean {
  const segments = glob.split('/').filter(segment => segment !== '' && segment !== '.');
  const last = segmentRegex(segments.at(-1) ?? '*');
  const dirs = segments.slice(0, -1).filter(segment => !/^\*+$/.test(segment)).map(segmentRegex);
  return last === null || SECRET_SAMPLES.some(sample => last.test(sample))
    || dirs.some(dir => dir === null || [...SECRET_DIRS].some(name => dir.test(name)));
}
