// INPUT: The peer scope and the path classes from peer-paths.ts.
// OUTPUT: Tier, TierResult, tierResult, maxTier, the shared READ_ONLY, COMMAND and UNPARSEABLE results, and pathTier (one path a
//         shell command reads or writes).
// POS: Smallest shared layer of the tier rules, used by the shell, read-only, network and tool modules.
import { classifyPath, inWorkspace, type PeerScope } from './peer-paths.ts';

export type Tier = 'L0' | 'L1' | 'L2' | 'L3';
export type TierResult = Readonly<{ tier: Tier; reason: string }>;

const ORDER: Readonly<Record<Tier, number>> = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3 });
// The first result of the highest tier wins, so its reason names the deciding rule.
export const maxTier = (results: readonly TierResult[], fallback: TierResult): TierResult =>
  results.reduce((best, item) => (ORDER[item.tier] > ORDER[best.tier] ? item : best), fallback);
export const tierResult = (tier: Tier, reason: string): TierResult => Object.freeze({ tier, reason });
export const READ_ONLY = tierResult('L0', 'read-only');
export const COMMAND = tierResult('L2', 'command');
export const UNPARSEABLE = tierResult('L3', 'unparseable');

// A shell write inside the workspace is still L2 here: only file tools and redirects (peer-shell redirectTier) give L1. Reading
// protected config is fine inside the workspace only.
export function pathTier(raw: string, scope: PeerScope, write: boolean): TierResult {
  const kind = classifyPath(raw, scope);
  if (kind === 'secret') return tierResult('L3', 'secret');
  if (write && kind === 'protected') return tierResult('L3', 'config-change');
  if (kind === 'outside' || !inWorkspace(raw, scope)) return tierResult('L2', write ? 'outside-write' : 'outside-read');
  return write ? COMMAND : READ_ONLY;
}
