// INPUT: The plugin's staged gate (register/unregister through the host execution's source binding, autoRegister and replyMode for
//        the dsh flags, the dsh act preset msd last announced) and a command invocation's agent and raw input.
// OUTPUT: /ms-register, /ms-unregister, /ms-auto on|off|status and /ms-reply direct|confirm|act|status DSH command definitions
//         returning fixed command-card text (status names the act preset), never a raw error.
// POS: Daily DSH user commands run host-side by the DSH commands service; nothing is sent to the model.
import { autoRegisterText, parseAutoInput } from '../../protocol/auto-register-text.ts';
import { type ActPreset } from '../../protocol/peer-tiers.ts';
import { isReplyMode, parseReplyInput, replyModeText, type ReplyMode } from '../../protocol/reply-mode-text.ts';
import { PluginUnavailable } from './daemon-tools.ts';

export const DSH_COMMAND_NAMES = Object.freeze({ register: 'ms-register', unregister: 'ms-unregister', auto: 'ms-auto',
  reply: 'ms-reply' } as const);
export type CommandResult = Readonly<{ kind: 'success' | 'error'; text: string }>;
export type CommandInvocation = Readonly<{ agent: unknown; rawInput: string }>;
export type CommandDefinition = Readonly<{ name: string; description: string; input?: Readonly<{ hint: string }>;
  handler: (invocation: CommandInvocation) => Promise<CommandResult> }>;
export type CommandGate = Readonly<{ register: (execution: unknown) => Promise<unknown>; unregister: (execution: unknown) => Promise<unknown>;
  autoRegister: (enabled: boolean | undefined) => Promise<unknown>; replyMode: (mode: ReplyMode | undefined) => Promise<unknown>;
  actPreset: () => Promise<ActPreset | null> }>;

const NOT_SENT = '本命令未发送给模型。';
const REASONS: Readonly<Record<string, string>> = Object.freeze({
  MS_PLUGIN_UNAVAILABLE: 'Switchboard 插件未就绪，请运行 ms status 或查看私有根 run/dsh-plugin.json',
  INVALID_DSH_SOURCE: '只能登记当前 DSH 的主会话（不含子会话与归档会话）' });

function failure(verb: string, name: string, error: unknown, usage = `/${name} 不接受参数`): CommandResult {
  const code = error instanceof PluginUnavailable ? `MS_PLUGIN_UNAVAILABLE：${error.stage}`
    : error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'INTERNAL_ERROR';
  const key = code.split('：')[0];
  const reason = key === 'INVALID_COMMAND_INPUT' ? usage : REASONS[key];
  return Object.freeze({ kind: 'error', text: `Switchboard ${verb}失败（${code}）${reason ? `：${reason}` : ''}；${NOT_SENT}` });
}

function command(name: string, verb: string, description: string,
  run: (agent: Readonly<{ id: string }>) => Promise<string>): CommandDefinition {
  return Object.freeze({ name, description, handler: async ({ agent, rawInput }: CommandInvocation) => {
    try {
      if (rawInput.trim() !== '') throw new Error('INVALID_COMMAND_INPUT');
      return Object.freeze({ kind: 'success' as const, text: await run(agent as Readonly<{ id: string }>) });
    } catch (error) { return failure(verb, name, error); }
  } });
}

function autoCommand(gate: CommandGate): CommandDefinition {
  const name = DSH_COMMAND_NAMES.auto;
  return Object.freeze({ name, input: Object.freeze({ hint: 'on|off|status' }),
    description: '查看或切换本机 Agent Message Switchboard 对 DSH 会话的自动登记：on、off 或 status（不经模型）',
    handler: async ({ rawInput }: CommandInvocation) => {
      try {
        const action = parseAutoInput(rawInput);
        if (action === null) throw new Error('INVALID_COMMAND_INPUT');
        const result = await gate.autoRegister(action === 'status' ? undefined : action === 'on') as
          { autoRegister?: unknown; autoRegisterProjects?: unknown };
        if (typeof result?.autoRegister !== 'boolean' || !Array.isArray(result.autoRegisterProjects)) throw new Error('INVALID_RESPONSE');
        return Object.freeze({ kind: 'success' as const,
          text: autoRegisterText('dsh', action, result.autoRegister, result.autoRegisterProjects as string[]) + NOT_SENT });
      } catch (error) { return failure('自动登记', name, error, `用法 /${name} on|off|status`); }
    } });
}

function replyCommand(gate: CommandGate): CommandDefinition {
  const name = DSH_COMMAND_NAMES.reply;
  return Object.freeze({ name, input: Object.freeze({ hint: 'direct|confirm|act|status' }),
    description: '查看或切换本机 Agent Message Switchboard 对 DSH 来信的回复档位：direct、confirm、act 或 status（不经模型）',
    handler: async ({ rawInput }: CommandInvocation) => {
      try {
        const action = parseReplyInput(rawInput, 'dsh');
        if (action === null) throw new Error('INVALID_COMMAND_INPUT');
        const result = await gate.replyMode(action === 'status' ? undefined : action) as { replyMode?: unknown };
        if (!isReplyMode(result?.replyMode)) throw new Error('INVALID_RESPONSE');
        const preset = await gate.actPreset() ?? undefined;
        return Object.freeze({ kind: 'success' as const, text: replyModeText('dsh', action, result.replyMode, preset) + NOT_SENT });
      } catch (error) { return failure('回复档位设置', name, error, `用法 /${name} direct|confirm|act|status`); }
    } });
}

export function dshCommandDefinitions(gate: CommandGate): readonly CommandDefinition[] {
  const register = command(DSH_COMMAND_NAMES.register, '登记',
    '把当前 DSH 会话登记到本机 Agent Message Switchboard，供 Claude Code / Codex 会话联系（不经模型）', async agent => {
      const result = await gate.register({ agent }) as { registered?: unknown; sessionId?: string; project?: string | null };
      if (result?.registered !== true) throw new Error('NOT_REGISTERED');
      return `已登记 Switchboard：dsh 会话 ${result.sessionId}${result.project ? `（项目 ${result.project}）` : ''}。其他 Harness 现在可以联系本会话；${NOT_SENT}`;
    });
  const unregister = command(DSH_COMMAND_NAMES.unregister, '撤销',
    '撤销当前 DSH 会话在本机 Agent Message Switchboard 的登记（不经模型）', async agent => {
      const result = await gate.unregister({ agent }) as { unregistered?: unknown };
      return result?.unregistered === true
        ? `已撤销 Switchboard 登记：dsh 会话 ${agent.id} 现为离线，线路保留，重新 /${DSH_COMMAND_NAMES.register} 后续上。${NOT_SENT}`
        : `当前会话 ${agent.id} 未登记 Switchboard，无需撤销；${NOT_SENT}`;
    });
  return Object.freeze([register, unregister, autoCommand(gate), replyCommand(gate)]);
}
