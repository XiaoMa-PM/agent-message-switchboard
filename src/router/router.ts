// INPUT: Trusted connector registrations and validated v1 send/reply requests.
// OUTPUT: Bound links, ordered envelopes, explicit transport evidence and idempotent receipts, and active-receiver send rejection.
// POS: In-memory simulation core; production transports and lifecycle are later cards.
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseEndpoint, parseEnvelope, parseSend, parseReply, parsePushOutcome,
  type Endpoint, type Envelope, type Receipt, type SendRequest, type PushOutcome } from '../protocol/message.ts';

type Push = (frame: Envelope) => PushOutcome | Promise<PushOutcome>;
type Session = Readonly<{ endpoint: Endpoint; push: Push }>;
type Entry = Readonly<{ frame: Envelope; result: Promise<Receipt> }>;
export type Connection = Readonly<{ endpoint: Endpoint; connect: (targetId: string) => string;
  send: (request: unknown) => Promise<Receipt>; reply: (request: unknown) => Promise<Receipt> }>;

export class Router {
  #sessions = new Map<string, Session>();
  #links = new Map<string, readonly [string, string]>();
  #pairs = new Map<string, string>();
  #messages = new Map<string, Entry>();
  #sequences = new Map<string, number>();
  #tails = new Map<string, Promise<void>>();
  #deliveryContext = new AsyncLocalStorage<readonly symbol[]>();
  #activePushes = new Set<symbol>();

  register(raw: unknown, push: Push): Connection {
    const endpoint = parseEndpoint(raw);
    const id = endpoint.endpointId;
    if (this.#sessions.has(id)) throw new Error('DUPLICATE_ENDPOINT');
    if (typeof push !== 'function') throw new Error('INVALID_RECEIVER');
    this.#sessions = new Map([...this.#sessions, [id, Object.freeze({ endpoint, push })]]);
    return Object.freeze({ endpoint, connect: (target: string) => this.#connect(id, target),
      send: async (input: unknown) => this.#send(id, parseSend(input), null),
      reply: async (input: unknown) => {
        const request = parseReply(input);
        const original = this.#messages.get(request.inReplyTo)?.frame;
        if (!original) throw new Error('UNKNOWN_MESSAGE');
        if (original.recipient.endpointId !== id) throw new Error('NOT_RECIPIENT');
        return this.#send(id, { schemaVersion: 1, messageId: request.messageId,
          linkId: original.linkId, body: request.body }, original.messageId);
      } });
  }

  #connect(source: string, target: string): string {
    const a = this.#sessions.get(source)!;
    const b = this.#sessions.get(target);
    if (!b) throw new Error('UNKNOWN_TARGET');
    if (a.endpoint.harness === b.endpoint.harness) throw new Error('USE_NATIVE_TOOLS');
    const pair = JSON.stringify([source, target].sort());
    const existing = this.#pairs.get(pair);
    if (existing) return existing;
    const id = randomUUID();
    const members = Object.freeze([source, target] as const);
    this.#links = new Map([...this.#links, [id, members]]);
    this.#pairs = new Map([...this.#pairs, [pair, id]]);
    return id;
  }

  #send(source: string, request: SendRequest, inReplyTo: string | null): Promise<Receipt> {
    this.#rejectReentry();
    const members = this.#links.get(request.linkId);
    if (!members) throw new Error('UNKNOWN_LINK');
    if (!members.includes(source)) throw new Error('NOT_A_MEMBER');
    const direction = JSON.stringify([request.linkId, source]);
    const previous = this.#messages.get(request.messageId);
    if (previous) {
      const f = previous.frame;
      if (f.sender.endpointId !== source || f.linkId !== request.linkId
          || f.body !== request.body || f.inReplyTo !== inReplyTo) throw new Error('MESSAGE_ID_CONFLICT');
      return previous.result;
    }
    const recipientId = members[0] === source ? members[1] : members[0];
    const sender = this.#sessions.get(source)!.endpoint;
    const recipient = this.#sessions.get(recipientId)!.endpoint;
    const sequence = (this.#sequences.get(direction) ?? 0) + 1;
    const frame = parseEnvelope({ ...request, sender, recipient, replyTo: sender, inReplyTo,
      sequence, sentAt: new Date().toISOString(), source: 'peer', authority: 'none' });
    const deferred = Promise.withResolvers<Receipt>();
    this.#messages = new Map([...this.#messages,
      [request.messageId, Object.freeze({ frame, result: deferred.promise })]]);
    this.#sequences = new Map([...this.#sequences, [direction, sequence]]);
    const task = (this.#tails.get(direction) ?? Promise.resolve()).then(async () => {
      const receipt = await this.#dispatch(frame);
      deferred.resolve(receipt);
    });
    this.#tails = new Map([...this.#tails, [direction, task]]);
    return deferred.promise;
  }

  #rejectReentry(): void {
    if (this.#deliveryContext.getStore()?.some(token => this.#activePushes.has(token))) {
      throw new Error('REENTRANT_DELIVERY');
    }
  }

  async #dispatch(frame: Envelope): Promise<Receipt> {
    let outcome: PushOutcome = Object.freeze({ state: 'delivery-unknown', transport: null });
    const token = Symbol();
    const scopes = Object.freeze([...(this.#deliveryContext.getStore() ?? []), token]);
    this.#activePushes = new Set([...this.#activePushes, token]);
    try { outcome = parsePushOutcome(await this.#deliveryContext.run(scopes,
      () => this.#sessions.get(frame.recipient.endpointId)!.push(frame))); }
    catch { /* Failure leaves the outcome unknown, without claimed write evidence. */ }
    finally { this.#activePushes = new Set([...this.#activePushes].filter(item => item !== token)); }
    return Object.freeze({ messageId: frame.messageId, ...outcome, envelope: frame });
  }
}
