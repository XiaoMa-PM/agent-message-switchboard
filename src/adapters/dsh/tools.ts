// INPUT: Trusted outbox assembly and fixed official DSH ToolRunContext.
// OUTPUT: Registry-ready tools, compact model receipts and honest delivery guidance.
// POS: SDK tool boundary only; no actual desktop loading or MCP transport.
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { type createDshOutbox } from './outbox.ts';

const output = { schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] };

function ready(args: object, keys: readonly string[], execution: ToolRunContext): void {
  if (Object.keys(args).length !== keys.length || Object.keys(args).some(key => !keys.includes(key))) {
    throw new Error('INVALID_TOOL_ARGUMENTS');
  }
  if (execution.signal.aborted) throw new Error('CANCELLED_BEFORE_DISPATCH');
}

export function createDshOutboxTools(outbox: ReturnType<typeof createDshOutbox>) {
  const connect = defineTool({
    name: 'router_connect_claude',
    description: '从 DSH 建联到用户指定的原 Claude Code 会话 UUID，只跨 Harness，不导入/迁移会话；local_ 桌面 ID 不是地址。',
    parameters: { targetSessionId: { type: 'string', required: true, description: '原 Claude Code 会话 UUID。' } },
    output,
    async execute(args, execution) {
      ready(args, ['targetSessionId'], execution);
      return { linkId: await outbox.connect(execution, args.targetSessionId), targetSessionId: args.targetSessionId };
    },
  });
  const send = defineTool({
    name: 'router_send',
    description: '发送用户指定正文或已授权结果，身份来自当前宿主执行会话。每条新消息使用唯一 messageId；相同 ID/原参数重放只恢复原回执，不重新派发。交付未知或取消不等于撤回，禁止自动换 ID 重试。',
    parameters: {
      messageId: { type: 'string', required: true, description: '消息唯一 ID；恢复结果时必须保持原 ID 和全部原参数。' },
      linkId: { type: 'string', required: true, description: '当前会话建联得到的 linkId。' },
      body: { type: 'string', required: true, description: '需要投递的原样正文，不自动附带聊天历史。' },
    },
    output,
    async execute(args, execution) {
      ready(args, ['messageId', 'linkId', 'body'], execution);
      const receipt = await outbox.send(execution, { schemaVersion: 1, ...args });
      const deliveryNote = receipt.transport === 'written'
        ? '已记录本机写入证据；未确认宿主受理、已读或完成。不要自动重发。'
        : '没有已确认的本机写入证据；原 messageId 重放不会再次派发。先核对目标和原结果，用户明确要求重新发送时才使用新 ID；不要自动重试。';
      return { receipt: { messageId: receipt.messageId, state: receipt.state, transport: receipt.transport,
        sequence: receipt.envelope.sequence, linkId: receipt.envelope.linkId,
        targetSessionId: receipt.envelope.recipient.nativeSessionId }, deliveryNote };
    },
  });
  return Object.freeze([connect, send]);
}
