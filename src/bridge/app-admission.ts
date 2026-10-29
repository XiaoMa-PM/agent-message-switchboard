// INPUT: Authenticated Start observations, original opaque tickets and explicit App confirmations.
// OUTPUT: A single irreversible App admission capability and read-only pending views.
// POS: Pure run lifecycle gate between authenticated runtime and management activation.
import { createHash, randomUUID } from 'node:crypto';
import { type ProcessIdentity } from '../adapters/claude/peer-identity.ts';

export type AppAdmissionState = 'awaiting-start' | 'pending' | 'activating' | 'active' | 'revoked';
export type PendingAppCandidate = Readonly<{ schemaVersion: 1; runId: string; candidateId: string;
  nativeSessionId: string; cliGeneration: ProcessIdentity; appGeneration: ProcessIdentity;
  identityFingerprint: string }>;
export type AppConfirmation = Readonly<{ schemaVersion: 1; action: 'activate-app'; runId: string;
  candidateId: string; source: 'app-status-copy-all'; nativeSessionId: string;
  desktopSessionId: string; identityFingerprint: string; statusReportSha256: string }>;
export type AppAdmissionOptions<Opaque, Active> = Readonly<{ runId: string;
  verifyCandidate: (opaque: Opaque) => Promise<void>;
  activateCandidate: (opaque: Opaque) => Promise<Active>;
  assertOpen: () => void; onRevoke: (reason: string) => void }>;
type Candidate<Opaque> = Readonly<{ view: PendingAppCandidate; opaque: Opaque }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const confirmationKeys = ['schemaVersion', 'action', 'runId', 'candidateId', 'source',
  'nativeSessionId', 'desktopSessionId', 'identityFingerprint', 'statusReportSha256'];
function generation(raw: ProcessIdentity): ProcessIdentity {
  const value = Object.freeze({ pid: raw.pid, uid: raw.uid, pidVersion: raw.pidVersion, uniqueId: raw.uniqueId });
  if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || value.pid > 0x7fffffff
      || !Number.isInteger(value.uid) || value.uid < 0 || value.uid > 0xffffffff
      || !Number.isInteger(value.pidVersion) || value.pidVersion < 0 || value.pidVersion > 0xffffffff
      || typeof value.uniqueId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.uniqueId)
      || BigInt(value.uniqueId) > 0xffffffffffffffffn) throw new Error('APP_ADMISSION_INVALID_GENERATION');
  return value;
}
function confirmationMatches(raw: unknown, view: PendingAppCandidate): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== confirmationKeys.length || keys.some(key => typeof key !== 'string'
      || !confirmationKeys.includes(key) || !descriptors[key]!.enumerable
      || !Object.hasOwn(descriptors[key]!, 'value'))) return false;
  const value = Object.fromEntries(confirmationKeys.map(key => [key, descriptors[key]!.value]));
  return value.schemaVersion === 1 && value.action === 'activate-app'
    && value.source === 'app-status-copy-all' && value.runId === view.runId
    && value.candidateId === view.candidateId && uuid.test(value.candidateId)
    && value.nativeSessionId === view.nativeSessionId && uuid.test(value.nativeSessionId)
    && typeof value.desktopSessionId === 'string' && value.desktopSessionId.startsWith('local_')
    && uuid.test(value.desktopSessionId.slice(6))
    && value.identityFingerprint === view.identityFingerprint && hash.test(value.identityFingerprint)
    && typeof value.statusReportSha256 === 'string' && hash.test(value.statusReportSha256);
}
export class AppAdmission<Opaque, Active> {
  #options: AppAdmissionOptions<Opaque, Active>;
  #state: AppAdmissionState = 'awaiting-start';
  #candidate?: Candidate<Opaque>;
  #active?: Active;
  #waiting: Promise<PendingAppCandidate>;
  #resolve!: (candidate: PendingAppCandidate) => void;
  #reject!: (error: Error) => void;
  constructor(options: AppAdmissionOptions<Opaque, Active>) {
    this.#options = Object.freeze({ ...options });
    if (typeof options.runId !== 'string' || !uuid.test(options.runId)) throw new Error('APP_ADMISSION_INVALID_RUN');
    this.#waiting = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    void this.#waiting.catch(() => {});
  }
  get state(): AppAdmissionState { return this.#state; }
  get whenCandidate(): Promise<PendingAppCandidate> { return this.#waiting; }
  observeStart(input: Readonly<{ nativeSessionId: string; cliGeneration: ProcessIdentity; appGeneration: ProcessIdentity;
    candidateOpaque: Opaque }>): PendingAppCandidate {
    try {
      this.#options.assertOpen();
      if (this.#state !== 'awaiting-start') throw new Error('APP_ADMISSION_SECOND_START');
      if (typeof input.nativeSessionId !== 'string' || !uuid.test(input.nativeSessionId)) throw new Error('APP_ADMISSION_INVALID_SESSION');
      const cliGeneration = generation(input.cliGeneration);
      const appGeneration = generation(input.appGeneration);
      const identityFingerprint = createHash('sha256').update(JSON.stringify([
        this.#options.runId, input.nativeSessionId, cliGeneration, appGeneration])).digest('hex');
      const view: PendingAppCandidate = Object.freeze({ schemaVersion: 1, runId: this.#options.runId,
        candidateId: randomUUID(), nativeSessionId: input.nativeSessionId, cliGeneration,
        appGeneration, identityFingerprint });
      this.#candidate = Object.freeze({ view, opaque: input.candidateOpaque });
      this.#state = 'pending'; this.#resolve(view); return view;
    } catch (error) { this.invalidate(); throw error; }
  }
  async activate(candidateId: string, confirmation: unknown): Promise<Active> {
    const candidate = this.#candidate;
    try {
      this.#options.assertOpen();
      if (this.#state !== 'pending' || !candidate || candidateId !== candidate.view.candidateId
          || !confirmationMatches(confirmation, candidate.view)) throw new Error('APP_ADMISSION_INVALID_CONFIRMATION');
      this.#state = 'activating';
      await this.#options.verifyCandidate(candidate.opaque);
      this.#assertCandidate(candidate);
      const active = await this.#options.activateCandidate(candidate.opaque);
      this.#assertCandidate(candidate);
      this.#active = active; this.#state = 'active'; return active;
    } catch (error) { this.invalidate(); throw error; }
  }
  assertActive(): Active {
    try {
      this.#options.assertOpen();
      if (this.#state !== 'active') throw new Error('APP_ADMISSION_NOT_ACTIVE');
      return this.#active as Active;
    } catch (error) {
      if (this.#state === 'active') this.invalidate();
      throw error;
    }
  }
  invalidate(reason = 'APP_ADMISSION_REVOKED'): void {
    if (this.#state === 'revoked') return;
    this.#state = 'revoked'; this.#candidate = undefined; this.#active = undefined;
    this.#reject(new Error(reason)); this.#options.onRevoke(reason);
  }
  #assertCandidate(candidate: Candidate<Opaque>): void {
    this.#options.assertOpen();
    if (this.#state !== 'activating' || this.#candidate !== candidate) throw new Error('APP_ADMISSION_REVOKED');
  }
}
