// INPUT: Authorized private root and one bootstrap snapshot.
// OUTPUT: Reserved per-run atomic observation record or owned temporary cleanup.
// POS: Desktop observation writer, not message persistence.
import { randomUUID } from 'node:crypto';
import { lstat, open, link, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function prepareLoadObservation(root: string) {
  const directory = join(root, 'raw');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error('INVALID_OBSERVATION_DIRECTORY');
  const name = `desktop-load-${randomUUID()}.json`;
  const temporary = join(directory, name + '.tmp');
  const file = await open(temporary, 'wx', 0o600);
  return Object.freeze({ name,
    async commit(snapshot: unknown) {
      await file.writeFile(JSON.stringify(snapshot));
      await file.close();
      await link(temporary, join(directory, name));
      await rm(temporary);
    },
    async discard() { await file.close(); await rm(temporary, { force: true }); },
  });
}
