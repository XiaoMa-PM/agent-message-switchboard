// INPUT: An already-authenticated CLI snapshot, required live OS reads and fixed App/CLI pins.
// OUTPUT: The pinned App ancestor of an App-hosted CLI, or proof of a standalone chain to pid 1.
// POS: Strict ancestry predicates for App and mixed entries; not SID attestation or recovery.
import { type BinaryPin, type Inspect, type ProcessSnapshot } from '../adapters/claude/peer-identity.ts';

type Open = () => void;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const matches = (row: ProcessSnapshot, pin: BinaryPin) => row.exe === pin.path && row.sha256 === pin.sha256;

export async function resolveAppAncestor(cli: ProcessSnapshot, options: Readonly<{ inspect: Inspect;
  appPin: BinaryPin; appHelperPins: readonly BinaryPin[]; assertOpen: Open }>): Promise<ProcessSnapshot> {
  const chain: ProcessSnapshot[] = [cli];
  let child = cli;
  while (child.parentPid > 1) {
    const parent = await options.inspect(child.parentPid); options.assertOpen();
    if (!parent || parent.pid !== child.parentPid || parent.uniqueId !== child.parentUniqueId
        || parent.uid !== cli.uid || chain.some(row => row.pid === parent.pid || row.uniqueId === parent.uniqueId)) {
      throw new Error('INVALID_APP_ANCESTRY');
    }
    const snapshot = Object.freeze({ ...parent }); chain.push(snapshot);
    if (matches(snapshot, options.appPin)) {
      for (const expected of chain.toReversed()) {
        const current = await options.inspect(expected.pid); options.assertOpen();
        if (!same(current, expected)) throw new Error('INVALID_APP_ANCESTRY');
      }
      return snapshot;
    }
    if (!options.appHelperPins.some(pin => matches(snapshot, pin))) throw new Error('INVALID_APP_ANCESTRY');
    child = snapshot;
  }
  throw new Error('INVALID_APP_ANCESTRY');
}

async function read(inspect: Inspect, pid: number, assertOpen: Open): Promise<ProcessSnapshot | null> {
  let row: ProcessSnapshot | null;
  try { row = await inspect(pid); } catch { throw new Error('INVALID_CLI_ANCESTRY'); }
  assertOpen(); return row;
}

export async function assertStandaloneAncestry(cli: ProcessSnapshot, options: Readonly<{ inspect: Inspect;
  forbidden: readonly BinaryPin[]; assertOpen: Open }>): Promise<void> {
  const chain: ProcessSnapshot[] = [cli];
  let child = cli;
  while (child.parentPid > 1) {
    const parent = await read(options.inspect, child.parentPid, options.assertOpen);
    if (!parent || parent.pid !== child.parentPid || parent.uniqueId !== child.parentUniqueId
        || chain.some(row => row.pid === parent.pid || row.uniqueId === parent.uniqueId)
        || options.forbidden.some(pin => matches(parent, pin))) throw new Error('INVALID_CLI_ANCESTRY');
    child = Object.freeze({ ...parent }); chain.push(child);
  }
  for (const expected of chain.toReversed()) {
    if (!same(await read(options.inspect, expected.pid, options.assertOpen), expected)) throw new Error('INVALID_CLI_ANCESTRY');
  }
}
