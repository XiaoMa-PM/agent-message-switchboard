// INPUT: Synthetic control-API results in the shared contract shapes.
// OUTPUT: Human/JSON rendering, terminal-control escaping, strict result-shape regressions and isResult (the status page's check).
// POS: Pure formatting boundary tests; no daemon, socket or host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isResult, renderResult } from '../../src/cli/format.ts';

const STATUS = {
  version: '0.1.0', startedAt: '2026-10-20T08:00:00.000Z',
  sessions: { 'claude-code': { online: 2, offline: 1 }, dsh: { online: 1, offline: 0 }, codex: { online: 0, offline: 0 } },
  links: { total: 3, suspended: 1, paused: 0 }, autoRegister: { 'claude-code': true, dsh: false, codex: false }, autoRegisterProjects: [],
  replyMode: { 'claude-code': 'direct', dsh: 'confirm', codex: 'direct' },
  actPreset: { 'claude-code': 'workspace-write', dsh: 'read-only', codex: 'full-access' }, adapters: { dsh: 1, codex: 0 },
};
const SESSION = {
  harness: 'claude-code', sessionId: 'S-claude-1', clientSurface: 'cli', title: '产品文档', cwd: '/tmp/work/sub',
  project: '/tmp/work', alias: '文档', online: true, registeredAt: '2026-10-20T08:01:00.000Z', lastSeenAt: '2026-10-20T09:00:00.000Z',
};
const LINK = { linkId: 'L1', a: { harness: 'claude-code', sessionId: 'S-a' }, b: { harness: 'dsh', sessionId: 'S-b' }, messages: 3, paused: false, suspended: true };
const MESSAGE = {
  messageId: 'M1', linkId: 'L1', from: { harness: 'dsh', sessionId: 'S-b' }, to: { harness: 'claude-code', sessionId: 'S-a' },
  sentAt: '2026-10-20T08:02:00.000Z', state: 'dispatched', bytes: 12,
};
const CONFIG = {
  autoRegister: { 'claude-code': true, dsh: true, codex: false }, autoRegisterProjects: [], linkBudget: { windowSeconds: 600, maxPushes: 30 },
  replyMode: { 'claude-code': 'confirm', dsh: 'direct', codex: 'direct' },
  actPreset: { 'claude-code': 'workspace-write', dsh: 'workspace-write', codex: 'workspace-write' },
};
const PROJECT = { project: '/tmp/work', sessions: { 'claude-code': { online: 1, offline: 0 }, dsh: { online: 1, offline: 1 }, codex: { online: 0, offline: 0 } } };

test('status renders online/offline counts, link states, version, auto-register state, reply modes, act presets and adapters', () => {
  assert.equal(renderResult('status', STATUS, false), [
    'msd 0.1.0 (started 2026-10-20T08:00:00.000Z)',
    'sessions: claude-code 2 online / 1 offline, dsh 1 online / 0 offline, codex 0 online / 0 offline',
    'links: 3 (1 suspended, 0 paused)',
    'auto-register: claude-code on, dsh off, codex off',
    'auto-register projects: (any)',
    'reply-mode: claude-code direct, dsh confirm, codex direct',
    'act-preset: claude-code workspace-write, dsh read-only, codex full-access',
    'adapters: dsh 1 attached, codex 0 attached',
  ].join('\n'));
});

test('lists render aligned rows, null as dash and empty lists as (none)', () => {
  const other = { ...SESSION, harness: 'dsh', sessionId: 'S-d', clientSurface: 'desktop', title: null, cwd: null, project: null, alias: null, online: false };
  const lines = renderResult('sessions', [SESSION, other], false).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^HARNESS +SURFACE +SESSION +ALIAS +TITLE +PROJECT +STATE +LAST SEEN$/);
  assert.match(lines[1], /^claude-code +cli +S-claude-1 +文档 +产品文档 +\/tmp\/work +online +2026-10-20T09:00:00.000Z$/);
  assert.match(lines[2], /^dsh +desktop +S-d +- +- +- +offline +2026-10-20T09:00:00.000Z$/);
  assert.match(renderResult('projects', [PROJECT], false), /^PROJECT +CLAUDE-CODE ON\/OFF +DSH ON\/OFF +CODEX ON\/OFF\n\/tmp\/work +1\/0 +1\/1 +0\/0$/);
  assert.match(renderResult('links', [LINK], false).split('\n')[1], /^L1 +claude-code:S-a +dsh:S-b +3 +no +yes$/);
  assert.match(renderResult('messages', [MESSAGE], false).split('\n')[1], /^M1 +L1 +dsh:S-b +claude-code:S-a +2026-10-20T08:02:00.000Z +dispatched +12$/);
  for (const view of ['sessions', 'projects', 'links', 'messages'] as const) assert.equal(renderResult(view, [], false), '(none)');
});

test('config, alias and link resume render one-line confirmations', () => {
  assert.equal(renderResult('config', CONFIG, false),
    'auto-register: claude-code on, dsh on, codex off\nauto-register projects: (any)\nreply-mode: claude-code confirm, dsh direct, codex direct\n'
    + 'act-preset: claude-code workspace-write, dsh workspace-write, codex workspace-write\nlink-budget: 30 pushes per 600 s');
  assert.match(renderResult('config', { ...CONFIG, autoRegisterProjects: ['/a', '/b'] }, false), /\nauto-register projects: \/a, \/b\n/);
  assert.equal(renderResult('alias', { ...SESSION, harness: 'dsh', sessionId: 'S-1', alias: '文档同步' }, false), 'alias dsh:S-1 = 文档同步');
  assert.equal(renderResult('alias', { ...SESSION, harness: 'dsh', sessionId: 'S-1', alias: null }, false), 'alias dsh:S-1 cleared');
  assert.equal(renderResult('link-resume', { linkId: 'L9', paused: false }, false), 'link L9 resumed');
});

test('json mode prints the validated result verbatim', () => {
  assert.deepEqual(JSON.parse(renderResult('links', [LINK], true)), [LINK]);
  assert.deepEqual(JSON.parse(renderResult('config', CONFIG, true)), CONFIG);
  assert.deepEqual(JSON.parse(renderResult('status', STATUS, true)).replyMode, STATUS.replyMode);
  assert.deepEqual(JSON.parse(renderResult('status', STATUS, true)).actPreset, STATUS.actPreset);
});

test('terminal control characters in daemon strings are escaped, never emitted raw', () => {
  const hostile = { ...SESSION, title: 'a\u001b[31mred\u0007\nnext\u2028', cwd: '/tmp/\u009bx' };
  const text = renderResult('sessions', [hostile], false);
  assert.doesNotMatch(text.split('\n').slice(1).join(''), /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  assert.match(text, /a\\u001b\[31mred\\u0007\\u000anext\\u2028/);
});

test('results outside the contract shape are DAEMON_PROTOCOL_INVALID', () => {
  const bad: Array<[Parameters<typeof renderResult>[0], unknown]> = [
    ['status', { ...STATUS, links: 1 }],
    ['status', { ...STATUS, sessions: { claude: 1, dsh: 1, codex: 1 } }],
    ['status', { ...STATUS, sessions: { claude: { online: 1, offline: 0 }, dsh: { online: 0, offline: 0 }, codex: { online: 0, offline: 0 } } }],
    ['sessions', [{ ...SESSION, harness: 'claude' }]],
    ['config', { ...CONFIG, autoRegister: { claude: true, dsh: true, codex: false } }],
    ['status', { ...STATUS, extra: 1 }],
    ['status', { ...STATUS, autoRegister: { 'claude-code': true, dsh: false } }],
    ['status', { ...STATUS, replyMode: undefined }],
    ['status', { ...STATUS, replyMode: { claude: 'direct', dsh: 'direct', codex: 'direct' } }],
    ['config', { ...CONFIG, replyMode: { 'claude-code': 'auto', dsh: 'direct', codex: 'direct' } }],
    ['config', { ...CONFIG, replyMode: { 'claude-code': 'direct', dsh: 'direct' } }],
    ['status', { ...STATUS, actPreset: undefined }],
    ['config', (({ actPreset: _, ...rest }) => rest)(CONFIG)],
    ['status', { ...STATUS, actPreset: { claude: 'read-only', dsh: 'read-only', codex: 'read-only' } }],
    ['status', { ...STATUS, adapters: undefined }],
    ['status', { ...STATUS, adapters: { dsh: 1 } }],
    ['status', { ...STATUS, adapters: { 'claude-code': 0, dsh: 1, codex: 0 } }],
    ['status', { ...STATUS, adapters: { dsh: -1, codex: 0 } }],
    ['config', { ...CONFIG, actPreset: { 'claude-code': 'danger-full-access', dsh: 'read-only', codex: 'read-only' } }],
    ['sessions', {}],
    ['sessions', [{ ...SESSION, harness: 'web' }]],
    ['sessions', [{ ...SESSION, title: 3 }]],
    ['links', [{ ...LINK, paused: 'no' }]],
    ['links', [{ ...LINK, a: { harness: 'claude' } }]],
    ['messages', [{ ...MESSAGE, bytes: -1 }]],
    ['messages', [{ ...MESSAGE, body: 'leak' }]],
    ['config', { ...CONFIG, linkBudget: { windowSeconds: 0, maxPushes: 30 } }],
    ['config', null],
    ['config', { ...CONFIG, autoRegisterProjects: ['relative'] }],
    ['projects', [{ ...PROJECT, sessions: { 'claude-code': 1 } }]],
    ['projects', [{ project: '/p', sessions: 3, online: 2 }]],
    ['sessions', [{ ...SESSION, online: 'yes' }]],
    ['links', [{ ...LINK, suspended: undefined }]],
    ['alias', { harness: 'dsh', sessionId: 'S', alias: 'x' }],
    ['link-resume', { linkId: 'L', paused: true }],
  ];
  for (const [view, value] of bad) {
    assert.throws(() => renderResult(view, value, false), { code: 'DAEMON_PROTOCOL_INVALID' }, `${view} ${JSON.stringify(value)}`);
  }
});

test('isResult applies the same strict shapes without rendering', () => {
  assert.equal(isResult('status', STATUS), true);
  assert.equal(isResult('status', { ...STATUS, adapters: { dsh: 1 } }), false);
  assert.equal(isResult('sessions', [SESSION]), true);
  assert.equal(isResult('links', [{ ...LINK, paused: 'no' }]), false);
  assert.equal(isResult('messages', [MESSAGE]), true);
});
