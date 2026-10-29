// INPUT: Trusted live Endpoint verification and complete observer metadata snapshots.
// OUTPUT: Frozen metadata records with revisions and platform-filtered verified reads.
// POS: Pure registration/query state; no Router, SDK, filesystem or message dispatch.
import { isAbsolute } from 'node:path';
import { parseEndpoint, type Endpoint, type Harness } from '../protocol/message.ts';

export type SessionMetadata = Readonly<{ title: string | null;
  titleProvider: 'host' | 'user' | 'provider' | 'fallback' | 'unknown';
  workspacePath: string | null; cwd: string | null; cwdSource: 'session-creation' | 'host-metadata' | 'unknown'; worktreePath: string | null;
  clientSurface: 'cli' | 'desktop' }>;
export type MetadataRecord = Readonly<{ endpoint: Endpoint; metadataRevision: number; metadata: SessionMetadata }>;
type Verify = (endpoint: Endpoint) => Promise<void>;
const metadataKeys = ['title', 'titleProvider', 'workspacePath', 'cwd', 'cwdSource', 'worktreePath', 'clientSurface'] as const;

export function parseSessionMetadata(value: unknown): SessionMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_SESSION_METADATA');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== metadataKeys.length || !metadataKeys.every(key => Object.hasOwn(descriptors, key))
      || keys.some(key => typeof key !== 'string' || !descriptors[key]?.enumerable
        || !Object.hasOwn(descriptors[key]!, 'value'))) throw new Error('INVALID_SESSION_METADATA');
  const raw = Object.fromEntries(metadataKeys.map(key => [key, descriptors[key]!.value]));
  if ((raw.title !== null && typeof raw.title !== 'string')
      || !['host', 'user', 'provider', 'fallback', 'unknown'].includes(raw.titleProvider)
      || !['session-creation', 'host-metadata', 'unknown'].includes(raw.cwdSource)
      || !['cli', 'desktop'].includes(raw.clientSurface)) throw new Error('INVALID_SESSION_METADATA');
  for (const key of ['workspacePath', 'cwd', 'worktreePath']) {
    const path = raw[key];
    if (path !== null && (typeof path !== 'string' || !path.trim() || !isAbsolute(path) || path.includes('\0'))) {
      throw new Error('INVALID_SESSION_METADATA');
    }
  }
  return Object.freeze(raw) as SessionMetadata;
}

function endpointId(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_METADATA_ENDPOINT_ID');
  return value;
}

class MetadataRegistry {
  #verify: Verify;
  #records = new Map<string, MetadataRecord>();
  #bindings = new Map<string, Endpoint>();
  #tickets = new Map<string, bigint>();
  #nextTicket = 0n;
  #revoked = new Set<string>();

  constructor(verify: Verify) { this.#verify = verify; }

  #open(id: string): void {
    if (this.#revoked.has(id)) throw new Error('METADATA_REVOKED');
  }

  async #live(endpoint: Endpoint): Promise<void> {
    try { await this.#verify(endpoint); }
    catch { throw new Error('METADATA_UNAVAILABLE'); }
  }

  #current(record: MetadataRecord): void {
    this.#open(record.endpoint.endpointId);
    if (this.#records.get(record.endpoint.endpointId) !== record) throw new Error('METADATA_CHANGED');
  }

  async observe(input: Endpoint, value: unknown): Promise<MetadataRecord> {
    const endpoint = parseEndpoint(input); const metadata = parseSessionMetadata(value); const id = endpoint.endpointId;
    this.#open(id);
    const bound = this.#bindings.get(id);
    if (bound && JSON.stringify(bound) !== JSON.stringify(endpoint)) throw new Error('METADATA_IDENTITY_CONFLICT');
    this.#bindings = new Map([...this.#bindings, [id, bound ?? endpoint]]);
    this.#nextTicket += 1n;
    const ticket = this.#nextTicket;
    this.#tickets = new Map([...this.#tickets, [id, ticket]]);
    await this.#live(endpoint);
    this.#open(id);
    if (this.#tickets.get(id) !== ticket) throw new Error('STALE_METADATA_OBSERVATION');
    const previous = this.#records.get(id);
    if (previous && JSON.stringify(previous.metadata) === JSON.stringify(metadata)) return previous;
    const record = Object.freeze({ endpoint: bound ?? endpoint,
      metadataRevision: (previous?.metadataRevision ?? 0) + 1, metadata });
    this.#records = new Map([...this.#records, [id, record]]);
    return record;
  }

  async get(value: string): Promise<MetadataRecord> {
    const id = endpointId(value); this.#open(id);
    const record = this.#records.get(id);
    if (!record) throw new Error('UNKNOWN_METADATA_ENDPOINT');
    await this.#live(record.endpoint); this.#current(record);
    return record;
  }

  async list(harness: Harness): Promise<readonly MetadataRecord[]> {
    if (!['dsh', 'claude-code', 'codex'].includes(harness)) throw new Error('INVALID_METADATA_HARNESS');
    const selected = [...this.#records.values()].filter(record => record.endpoint.harness === harness);
    await Promise.all(selected.map(record => this.#live(record.endpoint)));
    for (const record of selected) this.#current(record);
    return Object.freeze(selected);
  }

  remove(value: string): void {
    const id = endpointId(value);
    this.#revoked = new Set([...this.#revoked, id]);
    this.#records = new Map([...this.#records].filter(([key]) => key !== id));
  }
}

export function createMetadataRegistry({ verify }: { verify: Verify }) {
  if (typeof verify !== 'function') throw new Error('INVALID_METADATA_REGISTRY');
  const registry = new MetadataRegistry(verify);
  return Object.freeze({ observe: (endpoint: Endpoint, metadata: unknown) => registry.observe(endpoint, metadata),
    get: (id: string) => registry.get(id), list: (harness: Harness) => registry.list(harness),
    remove: (id: string) => registry.remove(id) });
}
