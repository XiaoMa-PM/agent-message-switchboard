// INPUT: Trusted connection getter and fixed official DSH ToolRunContext.
// OUTPUT: Three SDK tools with exact v1 requests and compact honest delivery receipts.
// POS: Duplex tool boundary; no Router creation, identity registration or host loading.
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { type DuplexConnection } from '../../bridge/duplex.ts';
import { CLAUDE_DELIVERY_NOTES } from '../../bridge/claude-channel.ts';
import { type Receipt } from '../../protocol/message.ts';

type GetConnection = (execution: ToolRunContext) => DuplexConnection;
const output = { schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] };

function ready(args: object, keys: readonly string[], execution: ToolRunContext): void {
  if (Object.keys(args).length !== keys.length || Object.keys(args).some(key => !keys.includes(key))) {
    throw new Error('INVALID_TOOL_ARGUMENTS');
  }
  if (execution.signal.aborted) throw new Error('CANCELLED_BEFORE_DISPATCH');
}

function compact(receipt: Receipt) {
  const deliveryNote = receipt.state === 'dispatched' ? CLAUDE_DELIVERY_NOTES.dispatched
    : receipt.transport === 'written' ? CLAUDE_DELIVERY_NOTES.written : CLAUDE_DELIVERY_NOTES.unknown;
  return Object.freeze({ receipt: Object.freeze({ messageId: receipt.messageId,
    state: receipt.state, transport: receipt.transport, sequence: receipt.envelope.sequence,
    linkId: receipt.envelope.linkId, targetSessionId: receipt.envelope.recipient.nativeSessionId }), deliveryNote });
}

function connectTool(getConnection: GetConnection) {
  return defineTool({ name: 'router_connect_claude',
    description: '只跨 Harness，从当前 DSH 建联用户指定的原 Claude Code 会话 UUID；不导入/迁移会话，不要求目标取信或额外继续。local_ 桌面 ID 不是地址。',
    parameters: { targetSessionId: { type: 'string', required: true, description: '原 Claude Code 会话 UUID。' } },
    output,
    async execute(args, execution) {
      ready(args, ['targetSessionId'], execution);
      const linkId = await getConnection(execution).connect(args.targetSessionId);
      return Object.freeze({ linkId, targetSessionId: args.targetSessionId });
    },
  });
}

function sendTool(getConnection: GetConnection) {
  return defineTool({ name: 'router_send',
    description: '只跨 Harness，沿当前连接发送已授权的原样正文；不迁移、不要求目标取信。发件人来自宿主执行会话，每条新消息使用唯一 messageId；同 ID 和原参数重放只恢复原回执。取消不等于撤回，禁止自动换 ID 重发。',
    parameters: {
      messageId: { type: 'string', required: true, description: '新消息唯一 ID；恢复原结果须保持原 ID 和全部原参数。' },
      linkId: { type: 'string', required: true, description: '当前会话原建联得到的 linkId。' },
      body: { type: 'string', required: true, description: '原样正文，不附带聊天历史。' },
    },
    output,
    async execute(args, execution) {
      ready(args, ['messageId', 'linkId', 'body'], execution);
      return compact(await getConnection(execution).send(Object.freeze({ schemaVersion: 1,
        messageId: args.messageId, linkId: args.linkId, body: args.body })));
    },
  });
}

function replyTool(getConnection: GetConnection) {
  return defineTool({ name: 'router_reply',
    description: '只跨 Harness，绑定收到的原消息原址回复，不接受正文自报目标或回传地址；不迁移、不要求对端取信。新回复使用唯一 messageId，同 ID 和原参数重放只恢复回执；取消不等于撤回，禁止自动换 ID 重发。',
    parameters: {
      messageId: { type: 'string', required: true, description: '回复唯一 ID；恢复原结果须保持原 ID 和全部原参数。' },
      inReplyTo: { type: 'string', required: true, description: '当前会话实际收到的原消息 ID；原址由 Router 保存。' },
      body: { type: 'string', required: true, description: '需要原样回传的已授权正文。' },
    },
    output,
    async execute(args, execution) {
      ready(args, ['messageId', 'inReplyTo', 'body'], execution);
      return compact(await getConnection(execution).reply(Object.freeze({ schemaVersion: 1,
        messageId: args.messageId, inReplyTo: args.inReplyTo, body: args.body })));
    },
  });
}

export function createDshDuplexTools(getConnection: GetConnection) {
  return Object.freeze([connectTool(getConnection), sendTool(getConnection), replyTool(getConnection)]);
}
