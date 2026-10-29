// INPUT: Trusted DSH execution, private Claude route registry and process inspection.
// OUTPUT: Exact-ID connections and ordered receipts from a single-direction assembly.
// POS: Offline outbox orchestration; not a DSH plugin or reverse delivery transport.
import { Router, type Connection } from '../../router/router.ts';
import { type Envelope } from '../../protocol/message.ts';
import { readClaude, type ClaudeRoute, type Inspect } from '../claude/registration.ts';
import { createNativeInboxPush } from '../claude/inbox.ts';
import { createDshSourceBinding } from './source.ts';

function verifiedPush(root: string, expected: ClaudeRoute, inspect: Inspect) {
  return async (frame: Envelope) => {
    const current = await readClaude(root, expected.endpoint.nativeSessionId, inspect);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('TARGET_CHANGED');
    return createNativeInboxPush(expected.endpoint, expected.socket)(frame);
  };
}

export function createDshOutbox(host: Parameters<typeof createDshSourceBinding>[0], root: string, inspect: Inspect) {
  const router = new Router();
  const bind = createDshSourceBinding(host);
  let sources = new Map<string, Connection>();
  let targets = new Map<string, ClaudeRoute>();
  function source(execution: unknown): Connection {
    const endpoint = bind(execution);
    const existing = sources.get(endpoint.endpointId);
    if (existing) return existing;
    const connection = router.register(endpoint, () => ({ state: 'delivery-unknown', transport: null }));
    sources = new Map([...sources, [endpoint.endpointId, connection]]);
    return connection;
  }
  return Object.freeze({
    async connect(execution: unknown, targetSessionId: string): Promise<string> {
      const sender = source(execution);
      const route = await readClaude(root, targetSessionId, inspect);
      const id = route.endpoint.endpointId;
      const existing = targets.get(id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(route)) throw new Error('TARGET_CHANGED');
      if (!existing) {
        router.register(route.endpoint, verifiedPush(root, route, inspect));
        targets = new Map([...targets, [id, route]]);
      }
      return sender.connect(id);
    },
    async send(execution: unknown, request: unknown) { return source(execution).send(request); },
  });
}
