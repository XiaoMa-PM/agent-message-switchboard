// INPUT: Codex's own hash vectors, a synthetic plugin tree hashed by a Rust copy of its algorithm, the ms plugin files, temp trust records.
// OUTPUT: Read-only hook trust check: declaration hash, bundle hash, hooks.state reader and codexActHooksTrusted (all act hooks trusted).
// POS: Offline contract for src/adapters/codex/hook-trust.ts; never touches the real ~/.codex.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACT_HOOK_EVENTS, codexActHooksTrusted, codexHookDeclarationHash, codexPluginContentHash, codexVersionHash }
  from '../../src/adapters/codex/hook-trust.ts';
import { CODEX_HOOKS, CODEX_PLUGIN_ID, prepareDailyCodexMarketplace } from '../../src/adapters/codex/plugin.ts';

// Codex's own fingerprint fixture: the same value in any key order hashes to this.
test('version_for_toml: sorted compact JSON of the TOML value, as Codex\'s own fixture', () => {
  for (const value of [{ rows: [{ z: 2, a: 1 }, { z: 4, a: 3 }], nested: { z: 'text', a: true } },
    { nested: { a: true, z: 'text' }, rows: [{ a: 1, z: 2 }, { a: 3, z: 4 }] }]) {
    assert.equal(codexVersionHash(value), 'sha256:a5e4c8fbdbc75d185b0f2b5291bfb2de10e8c523d6c89248876fd78a97c83176');
  }
});

// Codex's own plugin test trusts a plugin's command hooks by these declaration hashes; the identity is
// its hook_hash: event label, matcher, and the one normalized handler (timeout 600 when unset, async false).
test('a hook declaration hash matches the declarations Codex\'s own plugin test trusts', () => {
  const handler = { type: 'command', command: 'python3 -I -S ${PLUGIN_ROOT}/hooks/pre_tool_use_hook.py', timeout: 600, async: false };
  assert.equal(codexVersionHash({ event_name: 'pre_tool_use', matcher: '^Bash$', hooks: [handler] }),
    'sha256:c9ee1aca1b5d8c72b99df6571c87d61350b09f7f4594ae30e7250a2027e9d76b');
  assert.equal(codexVersionHash({ event_name: 'post_tool_use', matcher: '^Bash$', hooks: [handler] }),
    'sha256:9eef43ad6f26b1f9b94f318a50445f8bb62c363da08152a2966b73d308bf42ba');
});

test('an mcp_tool hook is normalized like Codex: timeout filled and Interrupt clamped, matcher kept only where events take one', () => {
  const input = { turn_id: '${turn_id}' };
  const hook = (timeout?: number, matcher?: string) =>
    ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'mcp_tool', server: 'ms', tool: 't', input, ...(timeout === undefined ? {} : { timeout }) }] });
  const identity = (event: string, timeout: number, matcher?: string) => codexVersionHash({ event_name: event,
    ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'mcp_tool', server: 'ms', tool: 't', input, timeout }] });
  assert.equal(codexHookDeclarationHash('PreToolUse', hook(10, '*')), identity('pre_tool_use', 10, '*'));
  assert.equal(codexHookDeclarationHash('PreToolUse', hook(undefined, '*')), identity('pre_tool_use', 600, '*'));
  assert.equal(codexHookDeclarationHash('Stop', hook(10, '*')), identity('stop', 10), 'Stop ignores a matcher');
  assert.equal(codexHookDeclarationHash('UserPromptSubmit', hook(0)), identity('user_prompt_submit', 1));
  assert.equal(codexHookDeclarationHash('Interrupt', hook(10)), identity('interrupt', 3));
  assert.equal(codexHookDeclarationHash('Interrupt', hook()), identity('interrupt', 1));
  assert.throws(() => codexHookDeclarationHash('PreToolUse', { hooks: [{ type: 'command', command: 'x' }] }), /UNSUPPORTED_HOOK/);
});

// The expected value comes from Codex's plugin_fingerprint copied verbatim into a Rust program that records the
// bytes it hashes; the tree covers dotfiles, nested and empty directories, a file larger than its 64 KiB read
// buffer, non-ASCII text and every excluded name (__pycache__, .venv, *.pyc, *.egg-info).
async function syntheticTree(root: string): Promise<void> {
  const files: Record<string, string> = {
    '.codex-plugin/plugin.json': '{"name":"ms","version":"0.1.0-x"}\n', '.mcp.json': '{"mcpServers":{"ms":{"command":"/r/node"}}}\n',
    'hooks/hooks.json': '{"hooks":{}}\n', 'skills/ms-router/SKILL.md': '---\nname: "ms-router"\n---\n\n路由说明\n',
    'skills/ms-auto/SKILL.md': '', 'skills/B-upper/x.txt': 'b', 'big.bin': 'x'.repeat(70000), '__pycache__/m.cpython.pyc': 'skip',
    'lib/a.pyc': 'skip', 'lib/keep.py': 'print(1)\n', '.venv/pyvenv.cfg': 'skip', 'pkg.egg-info/PKG-INFO': 'skip' };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await mkdir(join(root, 'empty-dir'));
}

test('the plugin bundle hash matches Codex\'s algorithm and refuses what Codex refuses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ms-trust-'));
  try {
    const root = join(dir, 'tree');
    await syntheticTree(root);
    assert.equal(await codexPluginContentHash(root), 'sha256:5e1ade9b265c5486a7338680033fde77f08e693362569cbb8aceaa29665e2518');
    await writeFile(join(root, 'lib', 'keep.py'), 'print(2)\n');
    assert.notEqual(await codexPluginContentHash(root), 'sha256:5e1ade9b265c5486a7338680033fde77f08e693362569cbb8aceaa29665e2518');
    await symlink('/etc/hosts', join(root, 'link'));
    await assert.rejects(codexPluginContentHash(root));
    await assert.rejects(codexPluginContentHash(join(dir, 'missing')));
    await assert.rejects(codexPluginContentHash(join(root, 'big.bin')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const LABELS: Readonly<Record<string, string>> = { UserPromptSubmit: 'user_prompt_submit', PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request', Stop: 'stop', Interrupt: 'interrupt' };
const keyOf = (event: string) => `${CODEX_PLUGIN_ID}:hooks/hooks.json:${LABELS[event]}:0:0`;

// A CODEX_HOME holding the real ms plugin in the cache layout Codex uses (plugins/cache/<marketplace>/<plugin>/<version>).
async function codexHome() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ms-trust-home-')));
  const market = join(home, 'market');
  await prepareDailyCodexMarketplace({ directory: market, root: join(home, 'root'), bundleDir: join(home, 'root', 'bundles', 'abc123') });
  const plugin = join(home, 'plugins', 'cache', 'ms-local', 'ms', '0.1.0-abc123');
  await mkdir(join(plugin, '..'), { recursive: true });
  await cp(join(market, 'plugins', 'ms'), plugin, { recursive: true });
  const content = await codexPluginContentHash(plugin);
  const trust = (events: readonly string[] = ACT_HOOK_EVENTS, extra: (event: string) => string = () => '') => events.map(event =>
    `[hooks.state.${JSON.stringify(keyOf(event))}]\ntrusted_hash = ${JSON.stringify(codexHookDeclarationHash(event, CODEX_HOOKS[event][0]))}\n`
    + `trusted_content_hash = ${JSON.stringify(content)}\n${extra(event)}`).join('\n');
  const config = async (text: string) => writeFile(join(home, 'config.toml'), `model = "x"\n\n[plugins."ms@ms-local"]\nenabled = true\n\n${text}`);
  return { home, plugin, content, trust, config, close: () => rm(home, { recursive: true, force: true }) };
}

// The trust Codex keeps for each ms hook: a change here makes every user trust that hook again, so it has to be
// deliberate. The first four are the hashes users trusted earlier.
test('the six ms hook declarations hash to their fixed snapshot', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(CODEX_HOOKS).map(([event, groups]) => [event, codexHookDeclarationHash(event, groups[0])])), {
    SessionStart: 'sha256:70616bdb0b1896b884861eb20546b6730679132bf169770dfa22a42ec2586efa',
    UserPromptSubmit: 'sha256:e9324c93836b7392210735cb51ee519f8540a2940d96926a337b01154546654b',
    PreToolUse: 'sha256:383b0aecdf334a19235724c6ea905cc71b4aeef0b10157a2d685aaf5bca6af80',
    PermissionRequest: 'sha256:81041d7300f2e15a20249ebb4b7962c2c08ee71dbffc7b867e12a0baa56fa8ff',
    Stop: 'sha256:27cba61d1d37cd4f45366beeb8d374b5ff3f62f66313340b94ab1393d5a14b77',
    Interrupt: 'sha256:1faa89ac518a870cf4034c07fb26e325b4c781a07d16f4d3a5294966b40c2d45',
  });
});

test('all three act hooks trusted for the current declarations and bundle: trusted', async () => {
  const f = await codexHome();
  try {
    assert.deepEqual([...ACT_HOOK_EVENTS], ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest']);
    await f.config(`[hooks.state]\n\n${f.trust()}\n# a comment\n[hooks.state."other@x:hooks/hooks.json:stop:0:0"]\nenabled = false\n`);
    assert.equal(await codexActHooksTrusted(f.home), true);
    // SessionStart is not needed for act; an enabled = true override and spacing variants are fine.
    await f.config(f.trust(ACT_HOOK_EVENTS, () => 'enabled = true\n').replaceAll('[hooks.state.', '[ hooks . state . '));
    assert.equal(await codexActHooksTrusted(f.home), true);
    // Stop and Interrupt only settle receipts; disabled, outdated or never trusted, act is unaffected.
    await f.config(`${f.trust()}\n${f.trust(['Stop'], () => 'enabled = false\n')}\n`
      + f.trust(['Interrupt']).replace(/trusted_hash = "sha256:[0-9a-f]{64}"/, `trusted_hash = "sha256:${'0'.repeat(64)}"`));
    assert.equal(await codexActHooksTrusted(f.home), true);
  } finally { await f.close(); }
});

test('a missing, outdated, disabled or declaration-only trust, a changed bundle or an unreadable record is not trusted', async () => {
  const f = await codexHome();
  try {
    for (const event of ACT_HOOK_EVENTS) {
      await f.config(f.trust(ACT_HOOK_EVENTS.filter(item => item !== event)));
      assert.equal(await codexActHooksTrusted(f.home), false, `without ${event}`);
    }
    const cases: Array<[string, string]> = [
      ['disabled', f.trust(ACT_HOOK_EVENTS, event => (event === 'PreToolUse' ? 'enabled = false\n' : ''))],
      ['old declaration', f.trust().replace(/trusted_hash = "sha256:[0-9a-f]{64}"/, 'trusted_hash = "sha256:' + '0'.repeat(64) + '"')],
      ['declaration only', f.trust().replace(/trusted_content_hash = .*\n/, '')],
      ['inline table', `${f.trust(ACT_HOOK_EVENTS.slice(1))}\n[hooks.state]\n${JSON.stringify(keyOf('UserPromptSubmit'))} = { trusted_hash = "x" }\n`],
      ['dotted key', `${f.trust()}\n[hooks]\nstate.${JSON.stringify(keyOf('PermissionRequest'))}.enabled = false\n`],
      ['duplicate table', `${f.trust()}\n${f.trust(['PermissionRequest'])}`],
      ['unknown field', f.trust(ACT_HOOK_EVENTS, event => (event === 'PermissionRequest' ? 'trusted_hash_v2 = "x"\n' : ''))],
      ['literal key', f.trust().replace(`"${keyOf('PermissionRequest')}"`, `'${keyOf('PermissionRequest')}'`)],
    ];
    for (const [name, text] of cases) {
      await f.config(text);
      assert.equal(await codexActHooksTrusted(f.home), false, name);
    }
    await f.config(f.trust());
    assert.equal(await codexActHooksTrusted(f.home), true);
    await writeFile(join(f.plugin, 'skills', 'ms-router', 'SKILL.md'), 'changed');
    assert.equal(await codexActHooksTrusted(f.home), false, 'bundle changed after trust');
  } finally { await f.close(); }
});

test('no config, no installed plugin, or more than one installed version is not trusted', async () => {
  const f = await codexHome();
  try {
    assert.equal(await codexActHooksTrusted(f.home), false, 'no config.toml');
    await f.config(f.trust());
    assert.equal(await codexActHooksTrusted(f.home), true);
    await mkdir(join(f.home, 'plugins', 'cache', 'ms-local', 'ms', '0.1.0-def456'));
    assert.equal(await codexActHooksTrusted(f.home), false, 'two versions: which one Codex runs is a semver question');
    await rm(join(f.home, 'plugins', 'cache', 'ms-local', 'ms'), { recursive: true });
    assert.equal(await codexActHooksTrusted(f.home), false, 'not installed');
    assert.equal(await codexActHooksTrusted(join(f.home, 'nowhere')), false);
  } finally { await f.close(); }
});
