// INPUT: Trusted CLI OS identities, lifecycle events and original v1 route snapshots.
// OUTPUT: First-start epoch capabilities and irreversible revocation without route replacement.
// POS: Pure fixed-session lifecycle gate; not native SID attestation or live switch support.
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { type ProcessIdentity } from './peer-identity.ts';
import { type ClaudeRoute } from './registration.ts';
import { parseEndpoint, type Endpoint } from '../../protocol/message.ts';

export type EpochTicket = Readonly<{ identity: ProcessIdentity; nativeSessionId: string; epoch: string }>;
export type EpochBinding = Readonly<EpochTicket & { endpoint: Endpoint; route: ClaudeRoute }>;
type Entry = Readonly<{ identity: ProcessIdentity; state: 'pending' | 'active' | 'revoked';
  ticket?: EpochTicket; binding?: EpochBinding }>;

function identitySnapshot(raw: ProcessIdentity): ProcessIdentity {
  const identity = Object.freeze({ pid: raw.pid, uid: raw.uid, pidVersion: raw.pidVersion, uniqueId: raw.uniqueId });
  if (!Number.isInteger(identity.pid) || identity.pid <= 1 || identity.pid > 0x7fffffff
      || !Number.isInteger(identity.uid) || identity.uid < 0 || identity.uid > 0xffffffff
      || !Number.isInteger(identity.pidVersion) || identity.pidVersion < 0 || identity.pidVersion > 0xffffffff
      || typeof identity.uniqueId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(identity.uniqueId)
      || BigInt(identity.uniqueId) > 0xffffffffffffffffn) throw new Error('INVALID_EPOCH_IDENTITY');
  return identity;
}

function identityKey(identity: ProcessIdentity): string {
  return JSON.stringify([identity.uniqueId, identity.pidVersion]);
}

function routeSnapshot(raw: ClaudeRoute, ticket: EpochTicket): ClaudeRoute {
  try {
    if (!raw || Object.keys(raw).length !== 5 || raw.schemaVersion !== 1
        || raw.ownerPid !== ticket.identity.pid || typeof raw.ownerStart !== 'string' || !raw.ownerStart.trim()
        || typeof raw.socket !== 'string' || !isAbsolute(raw.socket)) throw new Error('INVALID_ROUTE');
    const endpoint = parseEndpoint(raw.endpoint);
    if (endpoint.harness !== 'claude-code' || endpoint.nativeSessionId !== ticket.nativeSessionId
        || endpoint.endpointId !== `claude:${ticket.nativeSessionId}`
        || endpoint.hostInstanceId !== `claude-pid:${ticket.identity.pid}`
        || !/^[a-f0-9]{64}$/.test(endpoint.storageNamespace)) throw new Error('INVALID_ROUTE');
    return Object.freeze({ schemaVersion: 1, endpoint, socket: raw.socket,
      ownerPid: raw.ownerPid, ownerStart: raw.ownerStart });
  } catch { throw new Error('INVALID_EPOCH_ROUTE'); }
}

export class ClaudeSessionEpochs {
  #entries = new Map<string, Entry>();
  #pids = new Map<number, string>();
  #sids = new Set<string>();

  begin(rawIdentity: ProcessIdentity, sid: string): EpochTicket {
    const identity = identitySnapshot(rawIdentity);
    const key = identityKey(identity);
    this.#observe(identity);
    if (this.#entries.has(key)) {
      this.#revokeKey(key, identity);
      throw new Error('SESSION_EPOCH_REVOKED');
    }
    if (typeof sid !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sid)) {
      this.#revokeKey(key, identity);
      throw new Error('INVALID_SESSION');
    }
    if (this.#sids.has(sid.toLowerCase())) {
      this.#revokeKey(key, identity);
      throw new Error('DUPLICATE_SESSION');
    }
    const ticket = Object.freeze({ identity, nativeSessionId: sid, epoch: randomUUID() });
    this.#entries = new Map([...this.#entries, [key, Object.freeze({ identity, state: 'pending', ticket })]]);
    this.#sids = new Set([...this.#sids, sid.toLowerCase()]);
    return ticket;
  }

  activate(ticket: EpochTicket, rawRoute: ClaudeRoute): EpochBinding {
    const key = identityKey(ticket.identity);
    const entry = this.#entries.get(key);
    if (entry?.state === 'revoked') throw new Error('SESSION_EPOCH_REVOKED');
    if (entry?.state !== 'pending' || entry.ticket !== ticket) throw new Error('INVALID_EPOCH_TICKET');
    let route: ClaudeRoute;
    try { route = routeSnapshot(rawRoute, ticket); }
    catch (error) { this.#revokeKey(key, entry.identity); throw error; }
    const endpoint = parseEndpoint({ ...route.endpoint, endpointId: `claude-epoch:${ticket.epoch}` });
    const binding = Object.freeze({ ...ticket, endpoint, route });
    this.#entries = new Map([...this.#entries, [key, Object.freeze({ ...entry, state: 'active', binding })]]);
    return binding;
  }

  verify(binding: EpochBinding, rawCurrentIdentity: ProcessIdentity): EpochBinding {
    const entry = this.#entries.get(identityKey(binding.identity));
    if (entry?.state === 'revoked') throw new Error('SESSION_EPOCH_REVOKED');
    if (entry?.state !== 'active' || entry.binding !== binding) throw new Error('INVALID_EPOCH_BINDING');
    const current = identitySnapshot(rawCurrentIdentity);
    if (JSON.stringify(current) !== JSON.stringify(entry.identity)) throw new Error('INVALID_EPOCH_IDENTITY');
    return binding;
  }

  revoke(rawIdentity: ProcessIdentity): void {
    const identity = identitySnapshot(rawIdentity);
    this.#observe(identity);
    this.#revokeKey(identityKey(identity), identity);
  }

  #observe(identity: ProcessIdentity): void {
    const key = identityKey(identity);
    const previous = this.#pids.get(identity.pid);
    if (previous && previous !== key) this.#revokeKey(previous, this.#entries.get(previous)!.identity);
    this.#pids = new Map([...this.#pids, [identity.pid, key]]);
  }

  #revokeKey(key: string, identity: ProcessIdentity): void {
    const previous = this.#entries.get(key);
    this.#entries = new Map([...this.#entries,
      [key, Object.freeze({ identity: previous?.identity ?? identity, state: 'revoked' })]]);
  }
}
