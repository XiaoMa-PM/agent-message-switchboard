// INPUT: Fixed helper config, original host-owned handler and trusted reply-written observer.
// OUTPUT: Child snapshot checks, live inspect / inspectSigned, explicit quiesce confirmation and immediate owned cleanup.
// POS: Owned helper self-report checks; not independent verification or hash-to-spawn TOCTOU mitigation.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { type HelperConfig, startOwnedHelper } from './helper-process.ts';
import { createStdioRpc, type StdioRequest, type ReplyWritten } from './stdio-rpc.ts';
import { type ClaudeChannelResult, type PreparedResult } from './claude-channel.ts';
import { type DailyHookResult } from './hook-output.ts';
import { type ProcessSnapshot } from '../adapters/claude/peer-identity.ts';

type Spawn = (path: string, args: readonly string[], options: Readonly<{ env: Readonly<Record<string,string>>;
  stdio: readonly ['pipe','pipe','pipe']; shell: false }>) => ChildProcessWithoutNullStreams;
const launch: Spawn = (path, args, options) => spawn(path, [...args], { env: options.env, stdio: 'pipe', shell: false });
type Result = ClaudeChannelResult | PreparedResult | DailyHookResult;
type Identities = Readonly<{ childIdentity: ProcessSnapshot; parentIdentity: ProcessSnapshot }>;

function same(a: ProcessSnapshot, b: ProcessSnapshot): boolean { return JSON.stringify(a) === JSON.stringify(b); }

class OwnedBroker {
  #config: HelperConfig;
  #handle: (request: StdioRequest) => Promise<Result>;
  #launch: Spawn;
  #onReplyWritten?: (reply: ReplyWritten) => void;
  #child?: ChildProcessWithoutNullStreams;
  #rpc?: ReturnType<typeof createStdioRpc>;
  #exited = Promise.withResolvers<void>();
  #exitSeen = false;
  #closing?: Promise<void>;

  constructor(config: HelperConfig, handle: (request: StdioRequest) => Promise<Result>, spawn: Spawn,
    onReplyWritten?: (reply: ReplyWritten) => void) {
    this.#config = config; this.#handle = handle; this.#launch = spawn; this.#onReplyWritten = onReplyWritten;
  }

  #spawn(path: string, args: readonly string[], options: Parameters<Spawn>[2]): ChildProcessWithoutNullStreams {
    const child = this.#launch(path, args, options); this.#child = child;
    child.once('exit', () => { this.#exitSeen = true; this.#rpc?.close(); this.#exited.resolve(); });
    child.once('error', () => { this.#exitSeen = true; this.#rpc?.close(); this.#exited.resolve(); });
    this.#rpc = createStdioRpc({ handle: this.#handle, write: frame => new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, error => error ? reject(new Error('IPC_WRITE_FAILED')) : resolve());
    }), close: () => {}, onReplyWritten: this.#onReplyWritten });
    child.stdout.on('data', bytes => {
      try { this.#rpc!.push(bytes); } catch { void this.close().catch(() => {}); }
    });
    child.stdout.once('end', () => {
      try { this.#rpc!.end(); } catch { this.#rpc!.close(); }
      void this.close().catch(() => {});
    });
    child.stdout.once('error', () => { void this.close().catch(() => {}); });
    child.stdin.once('error', () => { void this.close().catch(() => {}); });
    child.stderr.on('data', () => {});
    child.stderr.once('error', () => { void this.close().catch(() => {}); });
    return child;
  }

  #alive(): void {
    if (this.#exitSeen || this.#closing || !this.#child || this.#child.exitCode !== null
        || this.#child.signalCode !== null) throw new Error('OWNED_BROKER_UNAVAILABLE');
  }

  async #verify(child: ChildProcessWithoutNullStreams): Promise<Readonly<{ childIdentity: ProcessSnapshot;
    parentIdentity: ProcessSnapshot }>> {
    this.#alive();
    if (!Number.isInteger(child.pid) || child.pid! <= 1) throw new Error('OWNED_BROKER_UNAVAILABLE');
    const first = await this.#rpc!.inspect(child.pid!); const parent = await this.#rpc!.inspect(process.pid);
    const secondParent = await this.#rpc!.inspect(process.pid); const second = await this.#rpc!.inspect(child.pid!);
    this.#alive();
    if (!same(first, second) || !same(parent, secondParent) || first.pid !== child.pid
        || first.uid !== process.getuid!() || parent.uid !== process.getuid!()
        || first.exe !== this.#config.python.path || first.sha256 !== this.#config.python.sha256
        || parent.pid !== process.pid || parent.exe !== await realpath(process.execPath)
        || first.parentPid !== parent.pid || first.parentUniqueId !== parent.uniqueId) {
      throw new Error('OWNED_BROKER_UNAVAILABLE');
    }
    this.#alive();
    return Object.freeze({ childIdentity: first, parentIdentity: parent });
  }

  async start() {
    let identities: Identities | undefined;
    await startOwnedHelper(this.#config, { spawn: (path, args, options) => this.#spawn(path, args, options),
      verifyStarted: async child => { identities = await this.#verify(child); }, closeOwned: () => this.close() });
    if (!identities) throw new Error('OWNED_BROKER_UNAVAILABLE');
    return Object.freeze({ ...identities, whenClosed: this.#rpc!.whenClosed, inspect: (pid: number) => this.#rpc!.inspect(pid),
      inspectSigned: (pid: number) => this.#rpc!.inspectSigned(pid), quiesce: () => this.#rpc!.quiesce(),
      close: () => this.close() });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#rpc?.close();
    this.#closing = Promise.resolve().then(async () => {
      const child = this.#child;
      if (!child || this.#exitSeen) return;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await this.#exited.promise;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    });
    return this.#closing;
  }
}

export function startBroker(config: HelperConfig, handle: (request: StdioRequest) => Promise<Result>,
  spawnAdapter: Spawn = launch, onReplyWritten?: (reply: ReplyWritten) => void) {
  return new OwnedBroker(config, handle, spawnAdapter, onReplyWritten).start();
}
