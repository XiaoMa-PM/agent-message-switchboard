// INPUT: Trusted host bindings, awaited live checks, synchronous epoch guards and admission.
// OUTPUT: Exact native-ID connections sharing one Router and immutable original routes.
// POS: Duplex assembly seam; no native host, kernel, discovery or recovery policy.
import { parseEndpoint, parseSend, parseReply, type Endpoint, type Envelope,
  type PushOutcome, type Receipt } from '../protocol/message.ts';
import { createDshSourceBinding } from '../adapters/dsh/source.ts';
import { type EpochBinding } from '../adapters/claude/session-epoch.ts';
import { Router, type Connection } from '../router/router.ts';

type Push = (frame: Envelope) => PushOutcome | Promise<PushOutcome>;
export type DuplexConnection = Readonly<{ endpoint: Endpoint; connect: (targetNativeSessionId: string) => Promise<string>;
  send: (request: unknown) => Promise<Receipt>; reply: (request: unknown) => Promise<Receipt> }>;
type Options = Readonly<{ host: Parameters<typeof createDshSourceBinding>[0];
  verifyClaude: (binding: EpochBinding) => Promise<void>;
  assertClaudeCurrent: (binding: EpochBinding) => undefined; assertOpen: () => void; guardDispatch: () => void }>;
type Entry = Readonly<{ owner: unknown; endpoint: Endpoint; verify: () => Promise<void>; assertLocal: () => undefined;
  router: Connection; connection: DuplexConnection }>;

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

class Duplex {
  #router = new Router();
  #entries = new Map<string, Entry>();
  #links = new Map<string, readonly [string, string]>();
  #frames = new Map<string, Envelope>();
  #bindDsh: ReturnType<typeof createDshSourceBinding>;
  #verifyClaude: Options['verifyClaude'];
  #assertClaudeCurrent: Options['assertClaudeCurrent'];
  #assertOpen: Options['assertOpen'];
  #guardDispatch: Options['guardDispatch'];

  constructor(options: Options) {
    if ([options.verifyClaude, options.assertClaudeCurrent, options.assertOpen, options.guardDispatch].some(fn => typeof fn !== 'function')) {
      throw new Error('INVALID_DUPLEX_OPTIONS');
    }
    this.#bindDsh = createDshSourceBinding(options.host);
    this.#verifyClaude = options.verifyClaude;
    this.#assertClaudeCurrent = options.assertClaudeCurrent;
    this.#assertOpen = options.assertOpen;
    this.#guardDispatch = options.guardDispatch;
  }

  registerDsh(execution: unknown, push: Push): DuplexConnection {
    this.#assertOpen();
    const endpoint = this.#bindDsh(execution);
    const owner = (execution as Readonly<{ agent: Readonly<{ session: Readonly<{ header: unknown }> }> }>).agent;
    const header = owner.session.header;
    return this.#register(owner, endpoint, () => {
      if (owner.session.header !== header) throw new Error('INVALID_DSH_SOURCE');
      if (!sameEndpoint(this.#bindDsh({ agent: owner }), endpoint)) throw new Error('INVALID_DSH_SOURCE');
      return undefined;
    }, async () => {}, push);
  }

  async registerClaude(binding: EpochBinding, push: Push): Promise<DuplexConnection> {
    this.#assertOpen();
    await this.#verifyClaude(binding);
    this.#assertOpen(); this.#assertClaudeCurrent(binding);
    const endpoint = parseEndpoint(binding.endpoint);
    if (endpoint.harness !== 'claude-code' || endpoint.nativeSessionId !== binding.nativeSessionId) {
      throw new Error('INVALID_CLAUDE_BINDING');
    }
    return this.#register(binding, endpoint, () => {
      this.#assertClaudeCurrent(binding);
      if (!sameEndpoint(parseEndpoint(binding.endpoint), endpoint) || binding.nativeSessionId !== endpoint.nativeSessionId) {
        throw new Error('INVALID_CLAUDE_BINDING');
      }
      return undefined;
    }, () => this.#verifyClaude(binding), push);
  }

  #register(owner: unknown, endpoint: Endpoint, assertLocal: () => undefined, verify: () => Promise<void>, push: Push): DuplexConnection {
    if (typeof push !== 'function') throw new Error('INVALID_RECEIVER');
    const existing = this.#entries.get(endpoint.endpointId);
    if (existing) {
      if (existing.owner !== owner || !sameEndpoint(existing.endpoint, endpoint)) throw new Error('DUPLICATE_ENDPOINT');
      this.#validate(existing);
      return existing.connection;
    }
    const router = this.#router.register(endpoint, frame => this.#push(frame, push));
    const connection = Object.freeze({ endpoint: router.endpoint,
      connect: (target: string) => this.#connect(endpoint.endpointId, target),
      send: (request: unknown) => this.#send(endpoint.endpointId, request),
      reply: (request: unknown) => this.#reply(endpoint.endpointId, request) });
    const entry = Object.freeze({ owner, endpoint: router.endpoint, verify, assertLocal, router, connection });
    this.#entries = new Map([...this.#entries, [endpoint.endpointId, entry]]);
    return connection;
  }

  #validate(entry: Entry): void {
    this.#assertOpen(); entry.assertLocal();
  }

  async #verified(id: string): Promise<Entry> {
    this.#assertOpen();
    const entry = this.#entries.get(id);
    if (!entry) throw new Error('UNKNOWN_TARGET');
    await entry.verify();
    this.#validate(entry);
    return entry;
  }

  async #connect(source: string, target: string): Promise<string> {
    const sender = await this.#verified(source);
    const candidates = [...this.#entries.values()].filter(entry =>
      entry.endpoint.harness !== sender.endpoint.harness && entry.endpoint.nativeSessionId === target);
    if (candidates.length === 0) throw new Error('UNKNOWN_TARGET');
    if (candidates.length !== 1) throw new Error('AMBIGUOUS_TARGET');
    const recipient = await this.#verified(candidates[0].endpoint.endpointId);
    this.#validate(sender); this.#validate(recipient);
    const link = sender.router.connect(recipient.endpoint.endpointId);
    this.#links = new Map([...this.#links, [link, Object.freeze([source, recipient.endpoint.endpointId] as const)]]);
    return link;
  }

  #assertLink(source: string, link: string): readonly string[] {
    const members = this.#links.get(link);
    if (!members) throw new Error('UNKNOWN_LINK');
    if (!members.includes(source)) throw new Error('NOT_A_MEMBER');
    for (const member of members) this.#validate(this.#entries.get(member)!);
    return members;
  }

  async #verifyLink(source: string, link: string): Promise<void> {
    const members = this.#assertLink(source, link);
    for (const member of members) await this.#verified(member);
    this.#assertLink(source, link);
  }

  async #send(source: string, input: unknown): Promise<Receipt> {
    const sender = await this.#verified(source);
    const request = parseSend(input);
    await this.#verifyLink(source, request.linkId);
    this.#assertLink(source, request.linkId);
    return sender.router.send(request);
  }

  async #reply(source: string, input: unknown): Promise<Receipt> {
    const sender = await this.#verified(source);
    const request = parseReply(input);
    const original = this.#frames.get(request.inReplyTo);
    if (!original) throw new Error('UNKNOWN_MESSAGE');
    if (original.recipient.endpointId !== source) throw new Error('NOT_RECIPIENT');
    await this.#verifyLink(source, original.linkId);
    this.#assertLink(source, original.linkId);
    return sender.router.reply(request);
  }

  async #push(frame: Envelope, push: Push): Promise<PushOutcome> {
    this.#frames = new Map([...this.#frames, [frame.messageId, frame]]);
    this.#assertOpen();
    await this.#verifyLink(frame.sender.endpointId, frame.linkId);
    const sender = this.#entries.get(frame.sender.endpointId)!;
    const recipient = this.#entries.get(frame.recipient.endpointId)!;
    if (!sameEndpoint(frame.sender, sender.endpoint) || !sameEndpoint(frame.recipient, recipient.endpoint)) {
      throw new Error('TARGET_CHANGED');
    }
    this.#assertLink(frame.sender.endpointId, frame.linkId);
    this.#guardDispatch();
    return push(frame);
  }
}

export function createDuplex(options: Options): Readonly<{
  registerDsh: (execution: unknown, push: Push) => DuplexConnection;
  registerClaude: (binding: EpochBinding, push: Push) => Promise<DuplexConnection>;
}> {
  const duplex = new Duplex(options);
  return Object.freeze({ registerDsh: (execution: unknown, push: Push) => duplex.registerDsh(execution, push),
    registerClaude: (binding: EpochBinding, push: Push) => duplex.registerClaude(binding, push) });
}
