// INPUT: Synthetic workspace, cwd and home paths.
// OUTPUT: Contract for peer-request path handling: resolution (~, relative, ..), the four classes (secret, protected,
//         outside, inside) behind the tiers, matched regardless of case, and whether a file glob can match a secret name.
// POS: Pure contract for src/protocol/peer-paths.ts; no file system access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPath, globMayMatchSecret, resolvePeerPath } from '../../src/protocol/peer-paths.ts';

const scope = Object.freeze({ workspace: '/repo', cwd: '/repo/sub', home: '/Users/u' });

test('paths resolve against the cwd and home without touching the file system', () => {
  for (const [raw, resolved] of [['a.ts', '/repo/sub/a.ts'], ['../x', '/repo/x'], ['~', '/Users/u'], ['~/x/../y', '/Users/u/y'],
    ['/abs/../b', '/b'], ['./', '/repo/sub']] as const) {
    assert.equal(resolvePeerPath(raw, scope), resolved, raw);
  }
});

test('each path falls into exactly one class: secret before protected before outside before inside', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['/repo/src/a.ts', 'inside'], ['/repo', 'inside'], ['README.md', 'inside'], ['/repo/.env.example', 'inside'],
    ['/repo/.env', 'secret'], ['/repo/.env.local', 'secret'], ['/repo/certs/server.pem', 'secret'], ['/repo/deploy.key', 'secret'],
    ['~/.ssh/config', 'secret'], ['~/.ssh', 'secret'], ['/repo/.aws/credentials', 'secret'], ['~/.netrc', 'secret'],
    ['~/.codex/auth.json', 'secret'], ['~/.claude.json', 'secret'], ['~/.config/gh/hosts.yml', 'secret'], ['id_rsa', 'secret'],
    ['/repo/.git/config', 'protected'], ['/repo/CLAUDE.md', 'protected'], ['/repo/sub/AGENTS.md', 'protected'],
    ['/repo/.claude/settings.json', 'protected'], ['/repo/.mcp.json', 'protected'], ['~/.zshrc', 'protected'],
    ['~/.gitconfig', 'protected'], ['~/Library/LaunchAgents/x.plist', 'protected'], ['~/.codex/config.toml', 'protected'],
    ['~/Library/Application Support/agent-message-switchboard/config.json', 'protected'], ['~/.config/fish/config.fish', 'protected'],
    ['/etc/hosts', 'outside'], ['/repo-other/x', 'outside'], ['/tmp/out.txt', 'outside'], ['~/notes.txt', 'outside'],
  ];
  for (const [raw, kind] of cases) assert.equal(classifyPath(raw, scope), kind, raw);
});

test('secret and protected lists match regardless of case; home-relative secrets match under any root', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['/repo/.ENV', 'secret'], ['/repo/.Env.Local', 'secret'], ['/repo/.env.EXAMPLE', 'inside'], ['~/.SSH/config', 'secret'],
    ['/repo/KEYS/Server.PEM', 'secret'], ['~/.Codex/Auth.json', 'secret'], ['/repo/vendor/.codex/auth.json', 'secret'],
    ['~/.CONFIG/GH/hosts.yml', 'secret'], ['~/library/keychains/login.keychain-db', 'secret'], ['/repo/.GIT/config', 'protected'],
    ['/repo/Claude.md', 'protected'], ['~/.ZSHRC', 'protected'], ['~/library/launchagents/x.plist', 'protected'],
  ];
  for (const [raw, kind] of cases) assert.equal(classifyPath(raw, scope), kind, raw);
});

test('a file glob may match a secret when any secret name fits it, ignoring case', () => {
  for (const glob of ['.env', '.ENV', '*', '.*', '*.env', '.env*', '**/.env.local', '*.{ts,env}', '*.pem', 'id_*', '**/*', '.e[n]v', '?env',
    '.ssh/**', '**/.aws/*']) {
    assert.equal(globMayMatchSecret(glob), true, glob);
  }
  for (const glob of ['*.ts', 'src/**/*.ts', '*.{ts,tsx}', 'README.md', '*.md', '.env.example', 'docs/*.md', 'src/*/index.ts']) {
    assert.equal(globMayMatchSecret(glob), false, glob);
  }
});
