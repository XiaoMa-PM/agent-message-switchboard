// INPUT: Official daily DSH desktop ctx (agents/tools/profileContext/workspaceRegistry/sessionTitle) and optional {root} config.
// OUTPUT: The plugin name, inject list and an apply that registers four router tools first and never rejects.
// POS: Daily DSH desktop plugin entry; staged host init, the unavailable gate and the beacon live in src/adapters/dsh/daemon-plugin.ts.
import { startDshPlugin } from '../../src/adapters/dsh/daemon-plugin.ts';

export const name = 'agent-message-switchboard';
export const inject = ['agents', 'tools', 'profileContext', 'workspaceRegistry', 'sessionTitle'];

export function apply(ctx, config) {
  return startDshPlugin(ctx, config);
}
