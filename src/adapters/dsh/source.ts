// INPUT: Trusted desktop identity (desktop surface at or above DSH_MIN_DESKTOP_VERSION) with SHA-256 namespace and host execution.
// OUTPUT: A frozen v1 DSH sender without a plaintext profile path in its namespace.
// POS: DSH source-binding seam; not a plugin loader or message transport.
import { parseEndpoint, type Endpoint } from '../../protocol/message.ts';
import { supportedDesktopVersion } from './desktop-version.ts';

type Host = Readonly<{ surface: string; version: string; storageNamespace: string;
  hostInstanceId: string; routeGeneration: string;
  getAgent: (id: string) => unknown; isArchived: (id: string) => boolean }>;
type Agent = Readonly<{ id?: unknown;
  session?: Readonly<{ header?: Readonly<{ id?: unknown; origin?: unknown }> }> }>;

export function createDshSourceBinding(host: Host): (execution: unknown) => Endpoint {
  if (host.surface !== 'desktop' || !supportedDesktopVersion(host.version)) throw new Error('UNSUPPORTED_DSH_HOST');
  if (typeof host.storageNamespace !== 'string' || !/^[a-f0-9]{64}$/.test(host.storageNamespace)) throw new Error('INVALID_DSH_NAMESPACE');
  const { storageNamespace, hostInstanceId, routeGeneration, getAgent, isArchived } = host;
  return execution => {
    const agent = (execution as Readonly<{ agent?: Agent }> | null)?.agent;
    const id = agent?.id;
    if (!agent || typeof id !== 'string' || !id.trim() || getAgent(id) !== agent || isArchived(id)
        || agent.session?.header?.id !== id || agent.session.header.origin !== undefined) {
      throw new Error('INVALID_DSH_SOURCE');
    }
    return parseEndpoint({ schemaVersion: 1, endpointId: JSON.stringify(['dsh', storageNamespace, id]),
      harness: 'dsh', nativeSessionId: id, storageNamespace, hostInstanceId, routeGeneration });
  };
}
