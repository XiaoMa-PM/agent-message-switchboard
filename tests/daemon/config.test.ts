// INPUT: Synthetic msd config values and a private temp directory.
// OUTPUT: Contract for the schemaVersion 4 config: replyMode and actPreset required, merged per harness, act only where handled
// POS: Pure msd config boundary test; no socket, broker, host or model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configView, mergeConfig, parseDaemonConfig, readDaemonConfig, writeDaemonConfig } from '../../src/daemon/config.ts';

const pin = (name: string, digit: string) => ({ path: `/opt/${name}`, sha256: digit.repeat(64) });
const FILE = Object.freeze({ schemaVersion: 4, python: pin('python', 'a'), claude: { wrapperPins: [] },
  autoRegister: { claude: false, dsh: false, codex: false }, autoRegisterProjects: [],
  replyMode: { claude: 'direct', dsh: 'confirm', codex: 'direct' },
  actPreset: { claude: 'workspace-write', dsh: 'read-only', codex: 'full-access' }, linkBudget: { windowSeconds: 600, maxPushes: 30 } });

test('a schemaVersion 4 file reads replyMode and actPreset under protocol ids and the view shows them', () => {
  const config = parseDaemonConfig(FILE);
  assert.equal(config.schemaVersion, 4);
  assert.deepEqual(config.replyMode, { 'claude-code': 'direct', dsh: 'confirm', codex: 'direct' });
  assert.deepEqual(configView(config).replyMode, { 'claude-code': 'direct', dsh: 'confirm', codex: 'direct' });
  assert.deepEqual(config.actPreset, { 'claude-code': 'workspace-write', dsh: 'read-only', codex: 'full-access' });
  assert.deepEqual(configView(config).actPreset, { 'claude-code': 'workspace-write', dsh: 'read-only', codex: 'full-access' });
});

test('an old or malformed config is refused with INVALID_CONFIG, with no fallback for a missing replyMode or actPreset', () => {
  const { replyMode: _, ...withoutMode } = FILE;
  const { actPreset: __, ...withoutPreset } = FILE;
  for (const bad of [{ ...FILE, schemaVersion: 3 }, { ...withoutPreset, schemaVersion: 3 }, { ...withoutMode, schemaVersion: 2 },
    withoutMode, withoutPreset,
    { ...FILE, actPreset: { claude: 'read-only', dsh: 'read-only' } }, { ...FILE, actPreset: { ...FILE.actPreset, web: 'read-only' } },
    { ...FILE, actPreset: { ...FILE.actPreset, dsh: 'danger-full-access' } }, { ...FILE, actPreset: { ...FILE.actPreset, codex: 'standard' } },
    { ...FILE, actPreset: { 'claude-code': 'read-only', dsh: 'read-only', codex: 'read-only' } }, { ...FILE, actPreset: 'read-only' },
    { ...FILE, replyMode: { claude: 'direct', dsh: 'direct' } }, { ...FILE, replyMode: { ...FILE.replyMode, web: 'direct' } },
    { ...FILE, replyMode: { ...FILE.replyMode, dsh: 'Direct' } }, { ...FILE, replyMode: { ...FILE.replyMode, codex: true } },
    { ...FILE, replyMode: { 'claude-code': 'direct', dsh: 'direct', codex: 'direct' } }, { ...FILE, replyMode: 'direct' }]) {
    assert.throws(() => parseDaemonConfig(bad), /INVALID_CONFIG/, JSON.stringify(bad));
  }
});

test('act is accepted for claude-code, DSH and Codex', () => {
  for (const [key, harness] of [['claude', 'claude-code'], ['dsh', 'dsh'], ['codex', 'codex']] as const) {
    assert.equal(parseDaemonConfig({ ...FILE, replyMode: { ...FILE.replyMode, [key]: 'act' } }).replyMode[harness], 'act');
    assert.equal(mergeConfig(parseDaemonConfig(FILE), { replyMode: { [harness]: 'act' } }).replyMode[harness], 'act');
  }
});

test('config.set merges replyMode per protocol harness and refuses bad updates', () => {
  const config = parseDaemonConfig(FILE);
  const merged = mergeConfig(config, { replyMode: { dsh: 'direct', codex: 'confirm' } });
  assert.deepEqual(merged.replyMode, { 'claude-code': 'direct', dsh: 'direct', codex: 'confirm' });
  assert.deepEqual(config.replyMode, { 'claude-code': 'direct', dsh: 'confirm', codex: 'direct' });
  assert.deepEqual(mergeConfig(config, { autoRegister: { dsh: true } }).replyMode, config.replyMode);
  for (const bad of [{ replyMode: {} }, { replyMode: { claude: 'direct' } }, { replyMode: { web: 'direct' } },
    { replyMode: { dsh: 'maybe' } }, { replyMode: 'confirm' }]) {
    assert.throws(() => mergeConfig(config, bad), /INVALID_CONFIG/, JSON.stringify(bad));
  }
});

test('config.set merges actPreset per protocol harness and refuses bad updates', () => {
  const config = parseDaemonConfig(FILE);
  const merged = mergeConfig(config, { actPreset: { 'claude-code': 'full-access', dsh: 'workspace-write' } });
  assert.deepEqual(merged.actPreset, { 'claude-code': 'full-access', dsh: 'workspace-write', codex: 'full-access' });
  assert.deepEqual(config.actPreset, { 'claude-code': 'workspace-write', dsh: 'read-only', codex: 'full-access' });
  assert.deepEqual(mergeConfig(config, { replyMode: { dsh: 'direct' } }).actPreset, config.actPreset);
  for (const bad of [{ actPreset: {} }, { actPreset: { claude: 'read-only' } }, { actPreset: { web: 'read-only' } },
    { actPreset: { dsh: 'danger-full-access' } }, { actPreset: 'read-only' }]) {
    assert.throws(() => mergeConfig(config, bad), /INVALID_CONFIG/, JSON.stringify(bad));
  }
});

test('the written file uses the claude/dsh/codex keys and schemaVersion 4, and reads back the same config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ms-config-'));
  const path = join(dir, 'config.json');
  const config = mergeConfig(parseDaemonConfig(FILE), { replyMode: { 'claude-code': 'confirm' }, actPreset: { codex: 'read-only' } });
  await writeDaemonConfig(path, config);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.schemaVersion, 4);
  assert.deepEqual(saved.replyMode, { claude: 'confirm', dsh: 'confirm', codex: 'direct' });
  assert.deepEqual(saved.actPreset, { claude: 'workspace-write', dsh: 'read-only', codex: 'read-only' });
  assert.deepEqual(await readDaemonConfig(path), config);
});
