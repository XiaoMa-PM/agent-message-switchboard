// INPUT: A journaled file snapshot, the file as it is now and a text-level fallback remover.
// OUTPUT: revertFile → exact backup restore when untouched since install or when only ms content differs, else ms-only removal or a conflict;
//         restoreExact, cutOnce, sameTextLines, sameJson and RevertOutcome helpers.
// POS: Shared per-file undo used by uninstall for DSH and Codex entries; never overwrites user changes.
import { readFile, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { readOptional, replaceFile, sha256 } from './fs-ops.ts';
import type { FileSnapshot } from './manifest.ts';

export type RevertOutcome = Readonly<{ ok: boolean; note: string; retained?: boolean }>;
export type TextRevert = (current: string) => { text: string | null; conflict: string | null };
export type Equivalent = (candidate: string, original: string) => boolean;

export const done = (note: string): RevertOutcome => Object.freeze({ ok: true, note });
export const conflict = (note: string): RevertOutcome => Object.freeze({ ok: false, note });

export async function restoreExact(file: FileSnapshot): Promise<void> {
  if (file.created || file.backup === null) { await rm(file.path, { force: true }); return; }
  await replaceFile(file.path, await readFile(file.backup), file.mode);
}

export function cutOnce(text: string, piece: string | null): string | null {
  if (!piece) return null;
  const first = text.indexOf(piece);
  if (first < 0 || text.lastIndexOf(piece) !== first) return null;
  return text.slice(0, first) + text.slice(first + piece.length);
}

const contentLines = (text: string) => text.split('\n').filter(line => line.trim() !== '');

export const sameTextLines: Equivalent = (candidate, original) => {
  const [a, b] = [contentLines(candidate), contentLines(original)];
  return a.length === b.length && a.every((line, index) => line === b[index]);
};

export const sameJson: Equivalent = (candidate, original) => {
  try { return isDeepStrictEqual(JSON.parse(candidate), JSON.parse(original)); } catch { return false; }
};

async function originalText(file: FileSnapshot): Promise<string | null> {
  return file.created || file.backup === null ? null : (await readFile(file.backup)).toString('utf8');
}

export async function revertFile(file: FileSnapshot, textual: TextRevert, equivalent?: Equivalent): Promise<RevertOutcome> {
  const current = await readOptional(file.path);
  if (current === null) return done(`${file.path}: already absent`);
  const currentSha = sha256(current.bytes);
  if (currentSha === file.beforeSha && !file.created) return done(`${file.path}: unchanged by install`);
  if (currentSha === file.afterSha) { await restoreExact(file); return done(`${file.path}: restored exactly`); }
  const result = textual(current.bytes.toString('utf8'));
  if (result.conflict !== null) return conflict(`${file.path}: ${result.conflict}`);
  if (result.text === null) return done(`${file.path}: ms entries already absent`);
  if (file.created && /^\s*(\{\s*\}|\[\s*\])\s*$/.test(result.text)) { await rm(file.path); return done(`${file.path}: removed`); }
  const original = equivalent ? await originalText(file) : null;
  if (original !== null && equivalent!(result.text, original)) {
    await restoreExact(file);
    return done(`${file.path}: only ms content had changed, restored exactly`);
  }
  await replaceFile(file.path, result.text, current.mode);
  return done(`${file.path}: ms entries removed, later user changes kept`);
}
