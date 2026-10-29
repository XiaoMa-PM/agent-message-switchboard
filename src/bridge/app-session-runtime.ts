// INPUT: Authenticated kernel chains, owned App profile, explicit socket and operator confirmation.
// OUTPUT: Pending App candidate and a single active runtime retaining its original epoch ticket.
// POS: App lifecycle composition around the shared CLI runtime without Start replay.
import { createAppChannelSessionRuntime, type SessionRuntimeOptions } from './session-runtime.ts';
import { AppAdmission, type PendingAppCandidate } from './app-admission.ts';
import { parseAppHook } from './app-hook.ts';
import { captureAppSocket, verifyAppSocket, type AppSocketPin } from './app-socket.ts';
import { assertAppSkillProfile, type AppSkillProfile } from './skill-request.ts';
import { resolveClaudePeer, type ProcessSnapshot, type BinaryPin } from '../adapters/claude/peer-identity.ts';
import { resolveAppAncestor } from './claude-ancestry.ts';
import { type ClaudeRoute } from '../adapters/claude/registration.ts';
import { type StdioRequest } from './stdio-rpc.ts';
import { type DuplexConnection } from './duplex.ts';
import { type Endpoint, type Harness } from '../protocol/message.ts';

export type AppSessionRuntimeOptions = Readonly<Omit<SessionRuntimeOptions, 'getRoute'> & {
  runId: string; appPin: BinaryPin; appHelperPins: readonly BinaryPin[];
  getRoute: (identity: ProcessSnapshot, sid: string, socket: AppSocketPin) => Promise<ClaudeRoute> }>;
type Deferred<T> = Readonly<{ promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }>;
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return Object.freeze({ promise, resolve, reject });
}
type Candidate = Readonly<{ nativeSessionId: string; cli: ProcessSnapshot; app: ProcessSnapshot; socket: AppSocketPin;
  route: Deferred<ClaudeRoute>; job: Promise<unknown> }>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

class PendingAdmissionDenied extends Error {}

class AppSessionRuntime {
  #profile: AppSkillProfile;
  #options: AppSessionRuntimeOptions;
  #core: ReturnType<typeof createAppChannelSessionRuntime>;
  #admission: AppAdmission<Candidate, void>;
  #closed = false;
  #observedStart = false;
  #candidate?: Candidate;
  #revoked = deferred<string>();
  #routeRequested = deferred<ProcessSnapshot>();
  #route = deferred<ClaudeRoute>();
  constructor(options: AppSessionRuntimeOptions, profile: AppSkillProfile) {
    assertAppSkillProfile(profile);
    this.#profile = profile;
    this.#options = Object.freeze({ ...options, cliPin: Object.freeze({ ...options.cliPin }),
      appPin: Object.freeze({ ...options.appPin }), appHelperPins: Object.freeze(options.appHelperPins.map(pin => Object.freeze({ ...pin }))) });
    this.#admission = new AppAdmission({ runId: options.runId, assertOpen: () => this.#open(),
      verifyCandidate: candidate => this.#verify(candidate), activateCandidate: candidate => this.#activate(candidate),
      onRevoke: reason => this.#shutdown(reason) });
    this.#core = createAppChannelSessionRuntime({ ...options, assertOpen: () => this.#open(),
      guardDispatch: () => { this.#active(); options.guardDispatch(); },
      getRoute: async (identity, _sid) => { this.#routeRequested.resolve(identity); return this.#route.promise; },
      makeClaudePush: binding => {
        const push = options.makeClaudePush(binding);
        return frame => { this.#active(); return push(frame); };
      },
      makeDshPush: (execution, endpoint) => {
        const push = options.makeDshPush(execution, endpoint);
        return frame => { this.#active(); return push(frame); };
      },
    }, profile, { assertCurrent: () => this.#current(), verifyBinding: async () => {
      const candidate = this.#candidate;
      if (!candidate) throw new Error('APP_ADMISSION_REVOKED');
      await this.#verify(candidate);
    } });
  }
  #open(): void {
    if (this.#closed) throw new Error('APP_ADMISSION_REVOKED');
    this.#options.assertOpen();
  }
  #current(): void {
    try {
      this.#open();
      if (this.#candidate) verifyAppSocket(this.#candidate.socket);
    } catch (error) { this.invalidate(); throw error; }
  }
  #active(): void {
    try { this.#admission.assertActive(); this.#current(); }
    catch (error) { if (this.#admission.state === 'active') this.invalidate(); throw error; }
  }
  #shutdown(reason: string): void {
    if (this.#closed) return;
    this.#closed = true; this.#revoked.resolve(reason);
    const error = new Error('APP_ADMISSION_REVOKED');
    this.#route.reject(error); this.#routeRequested.reject(error); this.#core?.close();
  }
  invalidate(reason = 'APP_ADMISSION_REVOKED'): void { this.#admission.invalidate(reason); }
  close(): void { this.invalidate(); }
  get whenRevoked(): Promise<string> { return this.#revoked.promise; }
  get whenCandidate(): Promise<PendingAppCandidate> { return this.#admission.whenCandidate; }
  activate(candidateId: string, confirmation: unknown): Promise<void> {
    return this.#admission.activate(candidateId, confirmation);
  }
  #appAncestor(cli: ProcessSnapshot): Promise<ProcessSnapshot> {
    return resolveAppAncestor(cli, { inspect: this.#options.inspect, appPin: this.#options.appPin,
      appHelperPins: this.#options.appHelperPins, assertOpen: () => this.#open() });
  }
  async #verify(candidate: Candidate): Promise<void> {
    try {
      this.#current();
      const cli = await resolveClaudePeer(candidate.cli, this.#options.inspect, this.#options.classify, this.#options.cliPin);
      this.#current();
      if (!same(cli, candidate.cli)) throw new Error('INVALID_APP_GENERATION');
      const app = await this.#appAncestor(cli); this.#current();
      if (!same(app, candidate.app) || this.#candidate !== candidate) throw new Error('INVALID_APP_GENERATION');
    } catch (error) { this.invalidate(); throw error; }
  }
  async #activate(candidate: Candidate): Promise<void> {
    const route = await this.#options.getRoute(candidate.cli, candidate.nativeSessionId, candidate.socket);
    this.#current();
    if (route.socket !== candidate.socket.path || this.#candidate !== candidate) throw new Error('INVALID_APP_ROUTE');
    await this.#verify(candidate); this.#current(); candidate.route.resolve(route);
    await candidate.job; this.#current();
    await this.#verify(candidate); this.#current();
  }
  async #start(request: StdioRequest, cli: ProcessSnapshot, app: ProcessSnapshot, socketPath: string | null): Promise<Readonly<{ prepared: true }>> {
    if (this.#observedStart) throw new Error('APP_ADMISSION_SECOND_START');
    this.#observedStart = true;
    this.#open();
    if (socketPath === null) throw new Error('APP_SOCKET_UNAVAILABLE');
    const socket = captureAppSocket(socketPath);
    const job = this.#core.handle(request); void job.catch(() => {});
    const observed = await Promise.race([this.#routeRequested.promise, job.then(() => { throw new Error('APP_ROUTE_NOT_REQUESTED'); })]);
    this.#open();
    if (!same(observed, cli)) throw new Error('INVALID_APP_GENERATION');
    const hook = request.payload as { session_id: string };
    const candidate = Object.freeze({ nativeSessionId: hook.session_id, cli, app, socket, route: this.#route, job }); this.#candidate = candidate;
    this.#admission.observeStart({ nativeSessionId: hook.session_id, cliGeneration: cli, appGeneration: app, candidateOpaque: candidate });
    return Object.freeze({ prepared: true });
  }
  async handle(request: StdioRequest) {
    this.#open();
    // Authentication failure has no authority to invalidate an existing candidate.
    const cli = await resolveClaudePeer(request.peer, this.#options.inspect, this.#options.classify, this.#options.cliPin);
    this.#open();
    const app = await this.#appAncestor(cli); this.#open();
    try {
      const wrapped = parseAppHook(request.payload);
      const hook = wrapped.hook as { hook_event_name: string };
      const inner = Object.freeze({ ...request, payload: wrapped.hook });
      if (hook.hook_event_name === 'SessionStart') return await this.#start(inner, cli, app, wrapped.startup!.socketPath);
      if (hook.hook_event_name === 'SessionEnd') { this.invalidate('APP_SESSION_ENDED'); return Object.freeze({ prepared: true as const }); }
      if (this.#admission.state === 'pending' || this.#admission.state === 'activating') {
        this.#profile.parseInvocation(wrapped.hook);
        await this.#verify(this.#candidate!);
        throw new PendingAdmissionDenied('APP_ADMISSION_NOT_ACTIVE');
      }
      this.#active(); await this.#verify(this.#candidate!); this.#active();
      return await this.#core.handle(inner);
    } catch (error) {
      if (!(error instanceof PendingAdmissionDenied)) this.invalidate();
      throw error;
    }
  }
  registerDsh(execution: unknown): DuplexConnection {
    const connection = this.#core.registerDsh(execution);
    return Object.freeze({ endpoint: connection.endpoint,
      connect: async (target: string) => { this.#active(); return connection.connect(target); },
      send: async (request: unknown) => { this.#active(); return connection.send(request); },
      reply: async (request: unknown) => { this.#active(); return connection.reply(request); } });
  }
  async describe(harness: Harness) {
    this.#open();
    if (this.#admission.state !== 'active') return Object.freeze([]);
    this.#active(); const result = await this.#core.describe(harness); this.#active(); return result;
  }
  async verifyEndpoint(endpoint: Endpoint): Promise<void> {
    this.#active(); await this.#core.verifyEndpoint(endpoint); this.#active();
  }
  attachDirectory(read: () => Promise<unknown>): () => void {
    return this.#core.attachDirectory(async () => { this.#active(); const result = await read(); this.#active(); return result; });
  }
  captureClaudeRegistrationCheck(): () => void {
    const check = this.#core.captureClaudeRegistrationCheck();
    return () => { this.#active(); check(); };
  }
}
export function createAppSessionRuntime(options: AppSessionRuntimeOptions, profile: AppSkillProfile) {
  const runtime = new AppSessionRuntime(options, profile);
  return Object.freeze({ whenCandidate: runtime.whenCandidate, whenRevoked: runtime.whenRevoked,
    activate: (candidateId: string, confirmation: unknown) => runtime.activate(candidateId, confirmation),
    invalidate: (reason?: string) => runtime.invalidate(reason), close: () => runtime.close(),
    handle: (request: StdioRequest) => runtime.handle(request), registerDsh: (execution: unknown) => runtime.registerDsh(execution),
    describe: (harness: Harness) => runtime.describe(harness), verifyEndpoint: (endpoint: Endpoint) => runtime.verifyEndpoint(endpoint),
    attachDirectory: (read: () => Promise<unknown>) => runtime.attachDirectory(read),
    captureClaudeRegistrationCheck: () => runtime.captureClaudeRegistrationCheck() });
}
