// INPUT: The checked-in plugins/ms-dsh package files (manifest, in-package patch, locales, icon) and the repo root manifest.
// OUTPUT: DSH bundle-package regressions: exact manifest and patch row, card metadata, engines.dsh on the package, resolution by package name.
// POS: Offline DSH plugin-manager packaging tests; no DSH code, pnpm or profile is touched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_VERSION } from '../../src/protocol/product-version.ts';

const PACKAGE_DIR = new URL('../../plugins/ms-dsh/', import.meta.url).pathname;
const file = (path: string) => join(PACKAGE_DIR, path);
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const NAME = 'agent-message-switchboard-dsh';

test('the plugin package manifest declares a DSH bundle with card metadata exports and a DSH floor', () => {
  assert.deepEqual(json(file('package.json')), {
    name: NAME, version: PRODUCT_VERSION, private: true,
    description: 'Agent Message Switchboard for DSH desktop: register this DSH session and message Claude Code / Codex sessions through msd.',
    type: 'module',
    exports: { '.': './index.mjs', './package.json': './package.json', './locale/*.json': './locale/*.json' },
    icon: './icon.svg', engines: { dsh: '>=0.2.0-rc.2' }, dsh: { bundle: { patch: './cordis.patch.yml' } } });
});

test('the nearest manifest above the plugin entry is the package, the only place declaring engines.dsh', () => {
  let dir = join(file('index.mjs'), '..');
  while (!statSync(join(dir, 'package.json'), { throwIfNoEntry: false })) dir = join(dir, '..');
  assert.equal(join(dir, 'package.json'), file('package.json'));
  assert.doesNotMatch(json(file('package.json')).engines.dsh, /<|\|\||\s-\s|\^|~/);
  const root = json(new URL('../../package.json', import.meta.url).pathname);
  assert.equal(root.engines?.dsh, undefined);
  assert.equal(root.engines?.node, '>=24.16.0 <25');
});

test('the in-package patch inserts the existing ms-dsh-client row by package name with the default root', () => {
  assert.equal(readFileSync(file('cordis.patch.yml'), 'utf8'), [
    '# Agent Message Switchboard DSH bundle: one row, mounted by package name.',
    '- insert:',
    '    - id: ms-dsh-client',
    `      name: ${NAME}`,
    '      config: {}',
    ''].join('\n'));
});

test('both locales carry only a fixed card title and description', () => {
  assert.deepEqual(json(file('locale/zh.json')), { meta: { title: 'Agent Message Switchboard',
    description: '把 DSH 会话登记到本机 msd，与 Claude Code、Codex 会话互发消息；输入 /ms-register、/ms-auto 管理登记。' } });
  assert.deepEqual(json(file('locale/en.json')), { meta: { title: 'Agent Message Switchboard',
    description: 'Register this DSH session with the local msd and message Claude Code and Codex sessions; use /ms-register and /ms-auto to manage registration.' } });
});

test('the icon is a small self-contained SVG with no script, handler or external reference', () => {
  const svg = readFileSync(file('icon.svg'), 'utf8');
  assert.ok(Buffer.byteLength(svg) < 256 * 1024);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]+"[^>]*>/);
  assert.match(svg, /<\/svg>\n$/);
  assert.doesNotMatch(svg, /<script|\son[a-z]+=|href=|url\(|<foreignObject|<image/i);
});

test('a profile node_modules link resolves the package name, manifest and locales to the private package files', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'ms-dsh-profile-'));
  await mkdir(join(profile, 'node_modules'));
  await symlink(PACKAGE_DIR, join(profile, 'node_modules', NAME));
  await writeFile(join(profile, 'package.json'), '{}\n');
  const require = createRequire(join(profile, 'package.json'));
  assert.equal(require.resolve(NAME), file('index.mjs'));
  assert.equal(require.resolve(`${NAME}/package.json`), file('package.json'));
  assert.equal(require.resolve(`${NAME}/locale/zh.json`), file('locale/zh.json'));
  assert.throws(() => require.resolve(`${NAME}/cordis.patch.yml`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
