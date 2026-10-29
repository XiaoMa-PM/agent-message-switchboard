// INPUT: A command name and its arguments (already split, no shell expansion left) and the peer scope.
// OUTPUT: readOnlyTier → null outside the read-only set or for an unknown option shape; else L0 for workspace paths or the paths' tier.
// POS: Read-only commands as option whitelists: unlisted is never L0, so output options and operands cannot pass as reads.
import { type PeerScope } from './peer-paths.ts';
import { maxTier, pathTier, READ_ONLY, type TierResult } from './peer-tier-base.ts';

// Operand shapes: paths read; text that is not a path; a pattern then paths (grep, rg; rg --files takes paths only); at most one path (uniq: a second operand
// is its output); +FORMAT only (date: anything else sets the clock); git revisions, each also checked as a path (<rev>:<path> by
// its path), with paths after --; for git branch, operands only as --list patterns.
type Operands = 'paths' | 'text' | 'pattern-paths' | 'one-path' | 'date' | 'revs' | 'list';
// spaced: long value options that also take the next word as their value (rg --glob x); the value is a glob, never a path read.
type Spec = Readonly<{ letters?: string; long?: readonly string[]; values?: Readonly<Record<string, 'num' | 'text'>>; number?: boolean;
  spaced?: readonly string[]; operands: Operands }>;
type Parsed = Readonly<{ operands: readonly string[]; dashes: number; patterns: number; seen: ReadonlySet<string> }>;

const NUM = /^[+-]?\d+$/;
const GREP: Spec = { letters: 'abcEFGhHiIlLnoqrRsSUvwxZz', operands: 'pattern-paths',
  values: { '-e': 'text', '-A': 'num', '-B': 'num', '-C': 'num', '-m': 'num', '--regexp': 'text', '--max-count': 'num', '--color': 'text' },
  long: ['--recursive', '--line-number', '--ignore-case', '--count', '--files-with-matches', '--fixed-strings', '--extended-regexp',
    '--word-regexp', '--invert-match', '--no-messages', '--color', '--files-without-match', '--quiet', '--silent'] };
const HEAD: Spec = { letters: 'qv', number: true, values: { '-n': 'num', '-c': 'num', '--lines': 'num', '--bytes': 'num' }, operands: 'paths' };
const SPECS: Readonly<Record<string, Spec>> = Object.freeze({
  cat: { letters: 'benstuvAET', operands: 'paths' },
  ls: { letters: 'aAbBcCdeFfGghHiklLmnopqrRsStTuUvwx1@', operands: 'paths', values: { '--color': 'text' },
    long: ['--all', '--almost-all', '--human-readable', '--recursive', '--classify', '--color'] },
  pwd: { letters: 'LP', operands: 'text' }, echo: { letters: 'neE', operands: 'text' }, true: { operands: 'text' }, false: { operands: 'text' },
  // printf prints like echo; no option is listed, so bash's -v (assign a variable) is not L0.
  printf: { operands: 'text' },
  head: HEAD, tail: { ...HEAD, letters: 'fFqrv' }, wc: { letters: 'clmwL', operands: 'paths' },
  grep: GREP, egrep: GREP, fgrep: GREP,
  rg: { letters: 'cFHiIlLnNoqsSvwx', operands: 'pattern-paths',
    values: { '-e': 'text', '-A': 'num', '-B': 'num', '-C': 'num', '-m': 'num', '-t': 'text', '-T': 'text', '--regexp': 'text', '--type': 'text',
      '--max-count': 'num', '--color': 'text', '-g': 'text', '--glob': 'text', '--iglob': 'text' }, spaced: ['--glob', '--iglob'],
    long: ['--line-number', '--ignore-case', '--smart-case', '--count', '--files-with-matches', '--fixed-strings', '--word-regexp',
      '--invert-match', '--no-heading', '--color', '--files', '--files-without-match', '--count-matches', '--quiet'] },
  stat: { letters: 'FLlnqrsx', values: { '-f': 'text', '-t': 'text', '-c': 'text' }, operands: 'paths' },
  which: { letters: 'as', operands: 'text' },
  diff: { letters: 'abBdEeiNnpqrstTuwy', values: { '-U': 'num', '--unified': 'num' }, operands: 'paths',
    long: ['--brief', '--recursive', '--side-by-side', '--ignore-all-space', '--new-file', '--color'] },
  cut: { letters: 'nsw', values: { '-d': 'text', '-f': 'text', '-c': 'text', '-b': 'text' }, operands: 'paths' },
  tr: { letters: 'cdsCu', operands: 'text' },
  sort: { letters: 'bcCdfghiMmnrRsuVz', values: { '-k': 'text', '-t': 'text', '--key': 'text', '--field-separator': 'text' }, operands: 'paths' },
  uniq: { letters: 'cdDiu', values: { '-f': 'num', '-s': 'num' }, operands: 'one-path' },
  nl: { values: { '-b': 'text', '-n': 'text', '-s': 'text', '-w': 'num', '-v': 'num', '-i': 'num' }, operands: 'paths' },
  rev: { operands: 'paths' }, seq: { letters: 'w', values: { '-f': 'text', '-s': 'text', '-t': 'text' }, operands: 'text' },
  uname: { letters: 'amnoprsv', operands: 'text' }, whoami: { operands: 'text' }, id: { letters: 'AFGgnPpru', operands: 'text' },
  date: { letters: 'juR', operands: 'date' }, basename: { letters: 'a', values: { '-s': 'text' }, operands: 'text' },
  dirname: { operands: 'text' }, realpath: { letters: 'eLmPqsz', operands: 'paths' }, file: { letters: 'bhiILNz', operands: 'paths' },
  tree: { letters: 'adfgilnpqrstuvxACDFhJNQS', values: { '-L': 'num', '-I': 'text', '-P': 'text' }, operands: 'paths' },
  du: { letters: 'acghHkLmnrsx', values: { '-d': 'num' }, operands: 'paths' },
});
const GIT_SHOW_LONG = ['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--patch', '--abbrev-commit', '--no-color', '--color'];
const GIT: Readonly<Record<string, Spec>> = Object.freeze({
  status: { letters: 'sbvz', values: { '--porcelain': 'text', '--untracked-files': 'text' }, operands: 'paths',
    long: ['--short', '--branch', '--porcelain', '--long', '--verbose', '--ignored', '--show-stash', '--no-renames', '--ahead-behind'] },
  log: { letters: 'p', number: true, operands: 'revs',
    values: { '-n': 'num', '--max-count': 'num', '--skip': 'num', '--format': 'text', '--pretty': 'text', '--since': 'text', '--until': 'text',
      '--after': 'text', '--before': 'text', '--author': 'text', '--grep': 'text', '--date': 'text', '--color': 'text' },
    long: [...GIT_SHOW_LONG, '--oneline', '--graph', '--decorate', '--all', '--no-merges', '--merges', '--reverse', '--first-parent', '--follow'] },
  diff: { letters: 'pwbR', values: { '-U': 'num', '--unified': 'num', '--diff-filter': 'text', '--color': 'text' }, operands: 'revs',
    long: [...GIT_SHOW_LONG, '--cached', '--staged', '--ignore-all-space', '--ignore-space-change', '--minimal', '--summary', '--check'] },
  show: { letters: 'ps', values: { '--format': 'text', '--pretty': 'text', '--color': 'text' }, operands: 'revs',
    long: [...GIT_SHOW_LONG, '--oneline', '--no-patch'] },
  branch: { letters: 'arvl', operands: 'list', long: ['--list', '--show-current', '--all', '--remotes', '--verbose', '--no-color', '--color'] },
  'rev-parse': { letters: 'q', values: { '--short': 'num' }, operands: 'revs',
    long: ['--show-toplevel', '--abbrev-ref', '--short', '--verify', '--git-dir', '--absolute-git-dir', '--is-inside-work-tree',
      '--show-prefix', '--show-cdup', '--symbolic-full-name'] },
  'ls-files': { letters: 'cdmosuz', operands: 'paths',
    long: ['--cached', '--deleted', '--modified', '--others', '--stage', '--unmerged', '--exclude-standard', '--error-unmatch', '--full-name'] },
  blame: { letters: 'wslp', long: ['--porcelain', '--line-porcelain', '--show-email'], operands: 'revs' },
});
const FIND_VALUES = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-maxdepth',
  '-mindepth', '-mtime', '-mmin', '-atime', '-ctime', '-size', '-user', '-group', '-perm']);
const FIND_FLAGS = new Set(['-print', '-print0', '-prune', '-empty', '-not', '-o', '-or', '-a', '-and', '-true', '-false', '-depth', '-xdev',
  '-ls', '!', '(', ')']);

const valueOk = (spec: Spec, name: string, value: string) => {
  const kind = spec.values?.[name];
  return kind === 'text' || (kind === 'num' && NUM.test(value));
};

// Long options are accepted only as listed: --name alone, or --name=value for a value option (never --name value, so a following
// operand is never swallowed unchecked). Short options may be clustered; a value option takes the rest of the cluster or the next word.
function parse(spec: Spec, args: readonly string[]): Parsed | null {
  const operands: string[] = []; const seen = new Set<string>(); let dashes = -1; let patterns = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (dashes >= 0 || arg === '-' || !arg.startsWith('-')) { operands.push(arg); continue; }
    if (arg === '--') { dashes = operands.length; continue; }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('='); const name = equals < 0 ? arg : arg.slice(0, equals);
      if (equals < 0 && (spec.spaced ?? []).includes(name)) {
        const value = args[++index];
        if (value === undefined || !valueOk(spec, name, value)) return null;
        seen.add(name); continue;
      }
      if (equals < 0 ? !(spec.long ?? []).includes(name) : !valueOk(spec, name, arg.slice(equals + 1))) return null;
      seen.add(name); if (name === '--regexp') patterns++;
      continue;
    }
    if (spec.number === true && /^-\d+$/.test(arg)) continue;
    for (let at = 1; at < arg.length; at++) {
      const option = `-${arg[at]}`; seen.add(option);
      if (spec.values?.[option] !== undefined) {
        const value = at + 1 < arg.length ? arg.slice(at + 1) : args[++index];
        if (value === undefined || !valueOk(spec, option, value)) return null;
        if (option === '-e') patterns++;
        break;
      }
      if (!(spec.letters ?? '').includes(arg[at])) return null;
    }
  }
  return { operands, dashes, patterns, seen };
}

function operandsTier(kind: Operands, parsed: Parsed, scope: PeerScope): TierResult | null {
  const reads = (paths: readonly string[]) => maxTier(paths.filter(path => path !== '').map(path => pathTier(path, scope, false)), READ_ONLY);
  const { operands } = parsed;
  if (kind === 'paths') return reads(operands);
  if (kind === 'text') return READ_ONLY;
  if (kind === 'pattern-paths') return reads(parsed.patterns > 0 || parsed.seen.has('--files') ? operands : operands.slice(1));
  if (kind === 'one-path') return operands.length <= 1 ? reads(operands) : null;
  if (kind === 'date') return operands.every(operand => operand.startsWith('+')) ? READ_ONLY : null;
  if (kind === 'list') return operands.length === 0 || parsed.seen.has('--list') || parsed.seen.has('-l') ? READ_ONLY : null;
  return reads(operands.map((operand, index) => (parsed.dashes >= 0 && index >= parsed.dashes ? operand
    : operand.includes(':') ? operand.slice(operand.indexOf(':') + 1) : operand)));
}

function findTier(args: readonly string[], scope: PeerScope): TierResult | null {
  let index = 0;
  while (/^-[HLP]$/.test(args[index] ?? '')) index++;
  const roots: string[] = [];
  while (index < args.length && !/^[-(!)]/.test(args[index])) roots.push(args[index++]);
  for (; index < args.length; index++) {
    if (FIND_VALUES.has(args[index]) && index + 1 < args.length) { index++; continue; }
    if (!FIND_FLAGS.has(args[index])) return null;
  }
  return maxTier((roots.length > 0 ? roots : ['.']).map(root => pathTier(root, scope, false)), READ_ONLY);
}

export function readOnlyTier(name: string, args: readonly string[], scope: PeerScope): TierResult | null {
  if (name === 'find') return findTier(args, scope);
  const [table, key, rest] = name === 'git' ? [GIT, args[0] ?? '', args.slice(1)] : [SPECS, name, args];
  if (!Object.hasOwn(table, key)) return null;
  const parsed = parse(table[key], rest);
  return parsed === null ? null : operandsTier(table[key].operands, parsed, scope);
}
