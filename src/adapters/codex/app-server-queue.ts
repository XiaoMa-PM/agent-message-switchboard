// INPUT: The owner's Codex executable (or a test command), inherited CODEX_HOME env, one queue request.
// OUTPUT: Official thread/queue/add and best-effort thread/queue/delete through a short-lived stdio app-server.
// POS: The only Codex write path; never loads, resumes, steers or starts a thread turn itself.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PRODUCT_VERSION } from '../../protocol/product-version.ts';

export type QueueLaunch = Readonly<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }>;
export type QueuedSubmission = Readonly<{ id: string; clientUserMessageId: string }>;
export type QueueSession = Readonly<{
  add: (threadId: string, text: string, clientUserMessageId: string) => Promise<QueuedSubmission>;
  remove: (threadId: string, queuedSubmissionId: string) => Promise<boolean>;
  close: () => void;
}>;
type Pending = Readonly<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;

const CLIENT_INFO = Object.freeze({ name: 'agent-message-switchboard', title: null, version: PRODUCT_VERSION });

export function codexQueueLaunch(executable: string): QueueLaunch {
  return Object.freeze({ command: executable, args: Object.freeze(['app-server', '--listen', 'stdio://']) });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function openQueueSession(launch: QueueLaunch, timeoutMs: number): Promise<QueueSession> {
  const child = spawn(launch.command, [...launch.args], { stdio: ['pipe', 'pipe', 'ignore'], env: launch.env ?? process.env });
  let pending = new Map<number, Pending>();
  let failure: Error | null = null;
  let nextId = 1;
  const fail = (code: string) => {
    failure ??= new Error(code);
    for (const item of pending.values()) item.reject(failure);
    pending = new Map();
  };
  const timer = setTimeout(() => { fail('APP_SERVER_TIMEOUT'); child.kill('SIGKILL'); }, timeoutMs);
  child.once('error', () => fail('APP_SERVER_UNAVAILABLE'));
  child.once('exit', () => fail('APP_SERVER_EXITED'));
  child.stdin.on('error', () => {});
  const write = (message: unknown) => { if (!failure) child.stdin.write(JSON.stringify(message) + '\n'); };
  createInterface({ input: child.stdout }).on('line', line => {
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(line)); } catch { return; }
    if (message.method !== undefined && message.id !== undefined) {
      write({ id: message.id, error: { code: -32601, message: 'Unsupported by agent-message-switchboard' } });
      return;
    }
    const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending = new Map([...pending].filter(([id]) => id !== message.id));
    if (message.error !== undefined) waiter.reject(new Error('QUEUE_REJECTED'));
    else waiter.resolve(message.result);
  });
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    const deferred = Promise.withResolvers<unknown>();
    pending = new Map([...pending, [id, { resolve: deferred.resolve, reject: deferred.reject }]]);
    write({ id, method, params });
    return deferred.promise;
  };
  const close = () => { clearTimeout(timer); child.stdin.end(); setTimeout(() => child.kill('SIGTERM'), 2000).unref(); };
  try {
    await request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false } });
    write({ method: 'initialized' });
  } catch (error) { close(); throw error; }
  return Object.freeze({
    close,
    add: async (threadId: string, text: string, clientUserMessageId: string) => {
      const submission = record(record(await request('thread/queue/add',
        { threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId })).queuedSubmission);
      if (typeof submission.id !== 'string' || !submission.id || submission.clientUserMessageId !== clientUserMessageId) {
        throw new Error('QUEUE_REJECTED');
      }
      return Object.freeze({ id: submission.id, clientUserMessageId });
    },
    remove: async (threadId: string, queuedSubmissionId: string) =>
      record(await request('thread/queue/delete', { threadId, queuedSubmissionId })).deleted === true,
  });
}
