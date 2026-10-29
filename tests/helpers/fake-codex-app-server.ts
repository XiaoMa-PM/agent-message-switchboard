// INPUT: Line-delimited app-server JSON on stdin; FAKE_CODEX_MODE and FAKE_CODEX_LOG environment.
// OUTPUT: Synthetic initialize/queue responses, one server request, and a JSON-lines log of received messages.
// POS: Offline stand-in for `codex app-server --listen stdio://`; never touches a real Codex home.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_CODEX_MODE ?? 'ok';
const log = process.env.FAKE_CODEX_LOG;
let initialized = false;

function send(message: unknown): void { process.stdout.write(JSON.stringify(message) + '\n'); }

function answer(request: Record<string, any>): void {
  const { id, method, params } = request;
  if (method === 'initialize') {
    initialized = true;
    send({ id: 'server-1', method: 'item/tool/requestUserInput', params: {} });
    send({ method: 'configWarning', params: {} });
    send({ id, result: { userAgent: 'fake', codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos' } });
    return;
  }
  if (!initialized) { send({ id, error: { code: -32600, message: 'Not initialized' } }); return; }
  if (mode === 'hang') return;
  if (mode === 'exit') process.exit(3);
  if (method === 'thread/queue/add') {
    if (mode === 'reject') { send({ id, error: { code: -32600, message: 'thread not found' } }); return; }
    const clientUserMessageId = mode === 'mismatch' ? 'other' : params.clientUserMessageId;
    send({ id, result: { queuedSubmission: { id: 'queued-1', input: params.input, clientUserMessageId } } });
    return;
  }
  if (method === 'thread/queue/delete') { send({ id, result: { deleted: true } }); return; }
  send({ id, error: { code: -32601, message: 'unknown' } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + '\n');
  if (message.method !== undefined && message.id !== undefined) answer(message);
}
