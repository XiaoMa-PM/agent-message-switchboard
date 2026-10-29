// INPUT: The private root run/ directory, the DSH host instance id and plugin stage snapshots.
// OUTPUT: An atomically replaced 0600 run/dsh-plugin.json with only schema, host instance, stage results, state, the commands and guidance notes,
//         auto-register counts (fixed codes) and time.
// POS: DSH plugin load diagnostics; best effort and serialized, never throws and never creates the private root.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type PluginStage } from './daemon-tools.ts';

export type BeaconSnapshot = Readonly<{ state: 'initializing' | 'ready' | 'failed'; stage: PluginStage | null;
  stages: Readonly<Partial<Record<PluginStage, 'ok' | 'failed'>>>; commands: 'registered' | 'none'; guidance: 'installed' | 'none';
  auto: AutoSummary }>;
// Auto-register counts since load: last sweep's listed agents, outcomes, registered sessions taken offline because the host
// disposed their agent, and failures by fixed code only.
export type AutoSummary = Readonly<{ listed: number | null; registered: number; refused: number; skipped: number; disposed: number;
  failed: Readonly<Record<string, number>> }>;

export function createPluginBeacon(run: string, hostInstanceId: string, now: () => number = Date.now) {
  const path = join(run, 'dsh-plugin.json');
  let chain = Promise.resolve();
  let closed = false;
  const write = async (snapshot: BeaconSnapshot) => {
    if (closed) return;
    const temporary = join(run, `.dsh-plugin-${randomUUID()}.tmp`);
    const record = { schemaVersion: 1, hostInstanceId, ...snapshot, updatedAt: new Date(now()).toISOString() };
    try {
      await mkdir(run, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      await writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } catch { await rm(temporary, { force: true }).catch(() => {}); }
  };
  return Object.freeze({
    write: (snapshot: BeaconSnapshot) => { chain = chain.then(() => write(snapshot)); },
    close: () => { closed = true; },
  });
}
export type PluginBeacon = ReturnType<typeof createPluginBeacon>;
