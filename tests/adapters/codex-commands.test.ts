// INPUT: Synthetic UserPromptSubmit prompts, thread IDs, surfaces, projects and fixed codes.
// OUTPUT: Regressions for the exact $ms-* command forms ($ms-reply included), the desktop / menu skill link (and every link it
//         must refuse) and every fixed block text the Codex hook shows.
// POS: Offline pure tests for Codex's user-typed Switchboard commands; no msd, Codex or model involved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoUsageText, blockReason, codexFailureText, notRegisteredText, parseCodexCommand, registeredText, replyReceipt,
  replyUsageText, unregisteredText } from '../../src/adapters/codex/commands.ts';
import { autoRegisterText } from '../../src/protocol/auto-register-text.ts';

const THREAD = '01a1582e-3c00-7e81-9a44-3059358af07c';
const HOME = '/synthetic/.codex';
const CACHE = `${HOME}/plugins/cache/ms-local/ms`;
// The desktop / menu submission: a Markdown skill link to the cached SKILL.md, then a space and a newline.
const link = (name: string, path = `${CACHE}/0.1.0-f34eaf5ff6f4d26a/skills/${name}/SKILL.md`) => `[$ms:${name}](${path})`;

test('only the whole prompt $ms-* or the completion form $ms:ms-* is a command; auto takes trailing arguments', () => {
  for (const [prompt, kind] of [['$ms-register', 'register'], ['$ms:ms-register', 'register'], ['  $ms-register\n', 'register'],
    ['$ms-unregister', 'unregister'], ['$ms:ms-unregister', 'unregister']] as const) {
    assert.deepEqual(parseCodexCommand(prompt, HOME), { kind }, prompt);
  }
  assert.deepEqual(parseCodexCommand('$ms-auto', HOME), { kind: 'auto', input: '' });
  assert.deepEqual(parseCodexCommand('$ms-auto on', HOME), { kind: 'auto', input: ' on' });
  assert.deepEqual(parseCodexCommand('$ms:ms-auto  status', HOME), { kind: 'auto', input: '  status' });
  assert.deepEqual(parseCodexCommand('$ms-auto ON', HOME), { kind: 'auto', input: ' ON' });
  for (const prompt of ['ms-register', 'ms-register-extra', '$ms-register x', '$ms-registerx', '$ms:register', '$ms-autox',
    '请运行 $ms-register', '来源：DSH | Agent Message Switchboard\n$ms-register', '', 7, undefined, null]) {
    assert.equal(parseCodexCommand(prompt, HOME), null, String(prompt));
  }
});

test('a desktop / menu skill link to this plugin\'s cached SKILL.md under the same codex home is the same command', () => {
  assert.deepEqual(parseCodexCommand(`${link('ms-register')} \n`, HOME), { kind: 'register' });
  assert.deepEqual(parseCodexCommand(`${link('ms-unregister')} \n`, HOME), { kind: 'unregister' });
  assert.deepEqual(parseCodexCommand(`${link('ms-auto')} \n`, HOME), { kind: 'auto', input: '' });
  assert.deepEqual(parseCodexCommand(`${link('ms-auto')} on`, HOME), { kind: 'auto', input: ' on' });
  assert.deepEqual(parseCodexCommand(`${link('ms-auto')} \non\n`, HOME), { kind: 'auto', input: ' \non' });
  assert.deepEqual(parseCodexCommand(`${link('ms-register', `${HOME}/plugins/cache/ms-local/ms/other-version/skills/ms-register/SKILL.md`)}`,
    `${HOME}/`), { kind: 'register' });
});

test('any other skill link passes: text around it, two links, foreign or relative paths, mismatched names, odd version segments', () => {
  const skill = (name: string, version = '0.1.0-f34eaf5ff6f4d26a') => `${CACHE}/${version}/skills/${name}/SKILL.md`;
  for (const prompt of [
    `请 ${link('ms-register')}`, `${link('ms-register')} 现在`, `${link('ms-unregister')}\n谢谢`,
    `${link('ms-register')}${link('ms-register')}`, `${link('ms-register')} ${link('ms-unregister')}`,
    `${link('ms-auto')} ${link('ms-register')}`, `${link('ms-auto')} on ${link('ms-auto')}`,
    link('ms-register', 'skills/ms-register/SKILL.md'), link('ms-register', 'plugins/cache/ms-local/ms/v/skills/ms-register/SKILL.md'),
    link('ms-register', `${HOME}/plugins/cache/other-local/ms/v/skills/ms-register/SKILL.md`),
    link('ms-register', `${HOME}/plugins/cache/ms-local/ms2/v/skills/ms-register/SKILL.md`),
    link('ms-register', `/other/.codex/plugins/cache/ms-local/ms/v/skills/ms-register/SKILL.md`),
    // Same lengths as the real prefix, so only the prefix comparison itself can refuse them.
    link('ms-register', `${HOME}/plugins/cache/abc-local/ms/v/skills/ms-register/SKILL.md`),
    link('ms-register', `/elsewhere/.codex/plugins/cache/ms-local/ms/v/skills/ms-register/SKILL.md`),
    link('ms-register', skill('ms-unregister')), link('ms-auto', skill('ms-register')),
    link('ms-register', skill('ms-register', '..')), link('ms-register', skill('ms-register', '.')),
    link('ms-register', skill('ms-register', '')), link('ms-register', skill('ms-register', 'v/extra')),
    link('ms-register', `${CACHE}/v/skills/ms-register/skill.md`), link('ms-register', `${CACHE}/v/skills/ms-register/SKILL.md/x`),
    `[$ms-register](${skill('ms-register')})`, `[$ms:ms-router](${skill('ms-router')})`,
    `[$ms:ms-register]( ${skill('ms-register')})`, `[$ms:ms-register](${skill('ms-register')}`,
    `来源：DSH | Agent Message Switchboard\n${link('ms-register')}`,
  ]) {
    assert.equal(parseCodexCommand(prompt, HOME), null, prompt);
  }
});

test('fixed texts name the codex session, surface and project and end with the not-sent note', () => {
  assert.equal(registeredText('registered', THREAD, 'cli', '/work/proj'),
    `已登记 Switchboard：codex 会话 ${THREAD}（CLI，项目 /work/proj）。其他 Harness 现在可以联系本会话。本提示未发送给模型。`);
  assert.equal(registeredText('unchanged', THREAD, 'desktop', null),
    `已登记（无变化） Switchboard：codex 会话 ${THREAD}（桌面）。其他 Harness 现在可以联系本会话。本提示未发送给模型。`);
  assert.equal(unregisteredText(THREAD),
    `已撤销 Switchboard 登记：codex 会话 ${THREAD} 现为离线，线路保留，重新 $ms-register 后续上。本提示未发送给模型。`);
  assert.equal(notRegisteredText(THREAD), `当前会话 ${THREAD} 未登记 Switchboard，无需撤销；本提示未发送给模型。`);
  assert.equal(codexFailureText('register', 'IDENTITY_MISMATCH'), 'Switchboard 登记失败（IDENTITY_MISMATCH）；本提示未发送给模型。');
  assert.equal(codexFailureText('unregister', 'MS_UNAVAILABLE'), 'Switchboard 撤销失败（MS_UNAVAILABLE）；本提示未发送给模型。');
  assert.equal(codexFailureText('auto', 'UNSUPPORTED_CODEX_REMOTE_ENVIRONMENT', '原因'),
    'Switchboard 自动登记失败（UNSUPPORTED_CODEX_REMOTE_ENVIRONMENT）：原因；本提示未发送给模型。');
  assert.equal(autoUsageText(), 'Switchboard 自动登记失败（INVALID_COMMAND_INPUT）：用法 $ms-auto on|off|status；本提示未发送给模型。');
  assert.deepEqual(blockReason('x'), { decision: 'block', reason: 'x' });
});

test('the shared auto-register copy has a codex entry: next SessionStart, $ms-register now, $ms-unregister to revoke', () => {
  assert.equal(autoRegisterText('codex', 'on', true, []), '已开启 Switchboard 自动登记（codex），范围为所有项目：'
    + '从下一次新开或恢复的 Codex 会话起自动登记；当前会话如需登记请输入 $ms-register。');
  assert.equal(autoRegisterText('codex', 'off', false, ['/a']),
    '已关闭 Switchboard 自动登记（codex）：之后的会话不再自动登记，已登记的会话不受影响，可用 $ms-unregister 撤销。');
  assert.equal(autoRegisterText('codex', 'status', false, ['/a', '/b']),
    'Switchboard 自动登记（codex）：关，范围为仅限名单内的 2 个项目：/a、/b。项目名单请在电脑上用 ms config set auto-register --project <目录> on|off 修改。');
});

test('$ms-reply, its completion form and its / menu skill link are the reply command; arguments follow as with auto', () => {
  assert.deepEqual(parseCodexCommand('$ms-reply', HOME), { kind: 'reply', input: '' });
  assert.deepEqual(parseCodexCommand('$ms-reply direct', HOME), { kind: 'reply', input: ' direct' });
  assert.deepEqual(parseCodexCommand('$ms:ms-reply  confirm\n', HOME), { kind: 'reply', input: '  confirm' });
  assert.deepEqual(parseCodexCommand(`${link('ms-reply')} \n`, HOME), { kind: 'reply', input: '' });
  assert.deepEqual(parseCodexCommand(`${link('ms-reply')} \nstatus`, HOME), { kind: 'reply', input: ' \nstatus' });
  for (const prompt of ['$ms-replyx', 'ms-reply', '请运行 $ms-reply direct', '$ms:reply', link('ms-reply', `${CACHE}/v/skills/ms-auto/SKILL.md`),
    `${link('ms-reply')} ${link('ms-reply')}`]) {
    assert.equal(parseCodexCommand(prompt, HOME), null, prompt);
  }
});

test('reply command texts: the shared receipt plus the not-sent note, the usage text and the fixed failure', () => {
  assert.equal(replyReceipt('Switchboard 回复档位（codex）：direct。'), 'Switchboard 回复档位（codex）：direct。本提示未发送给模型。');
  assert.equal(replyUsageText(), 'Switchboard 回复档位设置失败（INVALID_COMMAND_INPUT）：用法 $ms-reply direct|confirm|act|status；本提示未发送给模型。');
  assert.equal(codexFailureText('reply', 'MS_UNAVAILABLE'), 'Switchboard 回复档位设置失败（MS_UNAVAILABLE）；本提示未发送给模型。');
});
