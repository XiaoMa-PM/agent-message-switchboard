// INPUT: An in-harness /ms-auto argument, the harness's auto-register flag and the msd project allowlist.
// OUTPUT: parseAutoInput (on/off/status, empty = status) and autoRegisterText, the fixed receipt without the "not sent" ending.
// POS: Shared fixed copy for the DSH and Claude /ms-auto and the Codex $ms-auto commands; no I/O, never changes the project allowlist.
export type AutoAction = 'on' | 'off' | 'status';
type AutoHarness = 'dsh' | 'claude-code' | 'codex';

const EFFECT: Readonly<Record<AutoHarness, string>> = Object.freeze({
  dsh: '已打开的 DSH 主会话会立即登记，之后新建的主会话也会自动登记。',
  'claude-code': '从下一次新开或恢复的会话起自动登记；当前会话如需登记请输入 /ms:register。',
  codex: '从下一次新开或恢复的 Codex 会话起自动登记；当前会话如需登记请输入 $ms-register。' });
const UNREGISTER: Readonly<Record<AutoHarness, string>> = Object.freeze({ dsh: '/ms-unregister', 'claude-code': '/ms:unregister',
  codex: '$ms-unregister' });

export function parseAutoInput(raw: string): AutoAction | null {
  const input = raw.trim();
  if (input === '') return 'status';
  return input === 'on' || input === 'off' || input === 'status' ? input : null;
}

function scope(projects: readonly string[]): string {
  return projects.length === 0 ? '所有项目' : `仅限名单内的 ${projects.length} 个项目：${projects.join('、')}`;
}

export function autoRegisterText(harness: AutoHarness, action: AutoAction, enabled: boolean, projects: readonly string[]): string {
  if (action === 'on') return `已开启 Switchboard 自动登记（${harness}），范围为${scope(projects)}：${EFFECT[harness]}`;
  if (action === 'off') {
    return `已关闭 Switchboard 自动登记（${harness}）：之后的会话不再自动登记，已登记的会话不受影响，可用 ${UNREGISTER[harness]} 撤销。`;
  }
  return `Switchboard 自动登记（${harness}）：${enabled ? '开' : '关'}，范围为${scope(projects)}。`
    + '项目名单请在电脑上用 ms config set auto-register --project <目录> on|off 修改。';
}
