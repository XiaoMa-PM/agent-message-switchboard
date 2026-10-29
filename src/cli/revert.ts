// INPUT: One manifest record, the file system as it is now, DSH's pnpm runner, the claude CLI and the codex CLI (for the plugin records).
// OUTPUT: revertRecord → 'reverted' | 'kept' | conflict detail; exact backup restore when the target is untouched since install.
// POS: Uninstall's per-record undo; never overwrites a byte the user changed after install.
import { isDeepStrictEqual } from 'node:util';
import { rm, rmdir } from 'node:fs/promises';
import { revertDsh, type DshPnpm } from './dsh-bundle.ts';
import { CliError } from './errors.ts';
import { readOptional, sha256 } from './fs-ops.ts';
import type { InstallRecord } from './manifest.ts';
import { hashTree, revertClaudePlugin, type ClaudeCli } from './claude-marketplace-step.ts';
import { revertCodexPlugin, type CodexCli } from './codex-plugin-step.ts';
import { conflict, done, type RevertOutcome } from './revert-file.ts';

export type { RevertOutcome };

async function revertCreate(path: string, expected: string): Promise<RevertOutcome> {
  const current = await readOptional(path);
  if (current === null) return done(`${path}: already absent`);
  if (sha256(current.bytes) !== expected) return conflict(`${path}: changed after install, kept`);
  await rm(path);
  return done(`${path}: removed`);
}

async function revertMkdir(path: string): Promise<RevertOutcome> {
  try { await rmdir(path); return done(`${path}: removed`); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return done(`${path}: already absent`);
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return Object.freeze({ ok: true, note: `${path}: not empty, kept`, retained: true });
    throw error;
  }
}

async function revertTree(record: Extract<InstallRecord, { kind: 'tree' }>): Promise<RevertOutcome> {
  try {
    if (record.captured && !isDeepStrictEqual(await hashTree(record.path), record.files)) {
      return conflict(`${record.path}: changed after install, kept`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return done(`${record.path}: already absent`);
    if (error instanceof CliError) return conflict(`${record.path}: ${error.detail}`);
    throw error;
  }
  await rm(record.path, { recursive: true, force: true });
  return done(`${record.path}: removed`);
}

export type RevertDeps = Readonly<{ dshPnpm: DshPnpm; claudeCli: ClaudeCli; codexCli: CodexCli }>;

export async function revertRecord(record: InstallRecord, deps: RevertDeps): Promise<RevertOutcome> {
  if (record.kind === 'mkdir') return revertMkdir(record.path);
  if (record.kind === 'create') return revertCreate(record.path, record.sha256);
  if (record.kind === 'dsh-bundle') return revertDsh(record, deps.dshPnpm);
  if (record.kind === 'claude-plugin') return revertClaudePlugin(record, deps.claudeCli);
  if (record.kind === 'codex-plugin') return revertCodexPlugin(record, deps.codexCli);
  return revertTree(record);
}
