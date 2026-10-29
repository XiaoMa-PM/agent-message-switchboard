// INPUT: Synthetic endpoints and Router push callbacks.
// OUTPUT: Connected fake sessions with JSON-roundtripped observation snapshots and explicit simulated confirmation.
// POS: Offline simulation fixture; no native Harness or pull-to-deliver operation.
import { parseEnvelope, type Endpoint, type Envelope } from '../../src/protocol/message.ts';
import { Router } from '../../src/router/router.ts';

export function endpoint(id: string, harness: Endpoint['harness'] = 'dsh'): Endpoint {
  return { schemaVersion: 1, endpointId: id, harness, storageNamespace: 'fixture',
    nativeSessionId: `synthetic-${id}`, hostInstanceId: `host-${id}`, routeGeneration: 'run-1' };
}

export function session(router: Router, ep: Endpoint,
  receive: (frame: Envelope) => void | Promise<void> = () => {}) {
  let observed: readonly Envelope[] = [];
  const connection = router.register(ep, async (frame) => {
    const decoded = parseEnvelope(JSON.parse(JSON.stringify(frame)));
    observed = [...observed, decoded];
    await receive(decoded);
    return { state: 'dispatched', transport: null } as const;
  });
  return { connection, observed: () => observed };
}
