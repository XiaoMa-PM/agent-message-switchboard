// INPUT: Trusted desktop profile name and absolute data directory.
// OUTPUT: An opaque SHA-256 storage namespace for that canonical profile.
// POS: DSH profile identity seam; never returns or logs the plaintext directory.
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function createDshStorageNamespace(profile: unknown): Promise<string> {
  const { name, dir } = (profile ?? {}) as Readonly<{ name?: unknown; dir?: unknown }>;
  if (typeof name !== 'string' || !name.trim() || typeof dir !== 'string' || !isAbsolute(dir)) {
    throw new Error('INVALID_DSH_PROFILE');
  }
  const directory = await realpath(dir).catch(() => { throw new Error('INVALID_DSH_PROFILE'); });
  const canonical = JSON.stringify([directory, name]);
  return createHash('sha256').update(canonical).digest('hex');
}
