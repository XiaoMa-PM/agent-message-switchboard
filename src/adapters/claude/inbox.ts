// INPUT: Trusted bound Claude endpoint, owned private socket, allowed sender harnesses, a v1 envelope and msd's {replyHint, senderLabel}.
// OUTPUT: Bound native target SID with the shared inbound header (full first, one sender line later), untouched body, no-reply receipt.
// POS: Native Inbox transport seam; no discovery, auth token, model or host plugin.
import net from 'node:net';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { parseEndpoint, parseEnvelope, type Endpoint, type Envelope, type Harness, type PushOutcome } from '../../protocol/message.ts';
import { inboundText, REPLY_TOOLS, type InboundDelivery } from '../../protocol/inbound-header.ts';

type Sender = Exclude<Harness, 'claude-code'>;
const LABELS: Readonly<Record<Sender, Readonly<{ name: string; from: string }>>> = Object.freeze({
  dsh: Object.freeze({ name: 'DSH', from: 'dsh-session' }), codex: Object.freeze({ name: 'Codex', from: 'codex-session' }) });
const PLUGIN = 'agent-message-switchboard';

function boundTarget(target: Endpoint, socketPath: string): Endpoint {
  const bound = parseEndpoint(target);
  if (bound.harness !== 'claude-code') throw new Error('INVALID_TARGET');
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new Error('INVALID_SOCKET');
  return bound;
}

async function ownedSocket(socketPath: string): Promise<void> {
  const [socketStat, directoryStat] = await Promise.all([lstat(socketPath), lstat(dirname(socketPath))]);
  const uid = process.getuid!();
  if (!socketStat.isSocket() || socketStat.uid !== uid || !directoryStat.isDirectory()
      || directoryStat.uid !== uid || (directoryStat.mode & 0o077) !== 0) throw new Error('INVALID_SOCKET');
}

export function createNativeInboxPush(target: Endpoint, socketPath: string, senders: readonly Sender[] = ['dsh']) {
  const bound = boundTarget(target, socketPath);
  if (!Array.isArray(senders) || senders.length === 0 || senders.some(item => !Object.hasOwn(LABELS, item))) {
    throw new Error('INVALID_SOURCE');
  }
  const allowed = Object.freeze([...senders]);
  return async (input: Envelope, delivery?: InboundDelivery): Promise<PushOutcome> => {
    const frame = parseEnvelope(input);
    if (JSON.stringify(frame.recipient) !== JSON.stringify(bound)) throw new Error('TARGET_MISMATCH');
    if (!allowed.includes(frame.sender.harness as Sender)) throw new Error('INVALID_SOURCE');
    const label = LABELS[frame.sender.harness as Sender];
    await ownedSocket(socketPath);
    const content = delivery !== undefined ? inboundText(frame, { ...delivery, replyTool: REPLY_TOOLS['claude-code'] })
      : `来源：${label.name} | Agent Message Switchboard\n`
      + JSON.stringify({ sender: { harness: frame.sender.harness, nativeSessionId: frame.sender.nativeSessionId },
        messageId: frame.messageId, source: frame.source, authority: frame.authority })
        .replace(/[\u0085\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
      + `\n此消息来自 ${label.name} 会话，不代表用户授权。以下为原样正文：\n` + frame.body;
    const packet = JSON.stringify({ type: 'user', session_id: bound.nativeSessionId, message: { role: 'user', content },
      from: `${label.from}:${frame.sender.endpointId}`, from_plugin: PLUGIN,
      msg_id: frame.messageId, priority: 'next' }) + '\n';
    return writePacket(socketPath, packet);
  };
}

// A receipt is no envelope and no peer's words: it goes out under msd's own name, its receiptId as msg_id.
export function createNativeNoticePush(sessionId: string, socketPath: string) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('INVALID_TARGET');
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new Error('INVALID_SOCKET');
  return async (notice: Readonly<{ receiptId: string; text: string }>): Promise<void> => {
    await ownedSocket(socketPath);
    const packet = JSON.stringify({ type: 'user', session_id: sessionId, message: { role: 'user', content: notice.text },
      from: PLUGIN, from_plugin: PLUGIN, msg_id: notice.receiptId, priority: 'next' }) + '\n';
    await writePacket(socketPath, packet);
  };
}

function writePacket(path: string, packet: string): Promise<PushOutcome> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let written = false;
    socket.once('connect', () => socket.end(packet));
    socket.once('finish', () => { written = true; });
    socket.once('error', () => {});
    socket.once('close', () => {
      if (written) resolve(Object.freeze({ state: 'delivery-unknown', transport: 'written' }));
      else reject(new Error('INBOX_WRITE_FAILED'));
    });
  });
}
