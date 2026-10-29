// INPUT: The arguments of grep (egrep, fgrep), rg or git grep (already split) and whether stdin is piped in; the option parser.
// OUTPUT: RECURSIVE_SEARCH, searchTier, printsMatches, fileGlobs (rg's file filters, checked against secret names), pathWords.
// POS: Printing matching lines across a directory tree would print secret files (.env) unchecked, so it is refused under every preset.
import { parseOptions } from './peer-shell-net.ts';
import { tierResult, type TierResult } from './peer-tier-base.ts';

export const RECURSIVE_SEARCH = tierResult('L3', 'recursive-search');

type Grammar = Readonly<{ values: string; longValues: ReadonlySet<string>; quiet: RegExp }>;
const PATTERN_OPTIONS = /^(?:-[ef]|--regexp|--file)$/;
// Option letters and long options that take a value, and the options that print names, counts or nothing instead of lines.
const GRAMMARS: Readonly<Record<string, Grammar>> = Object.freeze({
  grep: { values: 'ABCDdefm', quiet: /^(?:-[lLcq]|--files-with-matches|--files-without-match|--count|--quiet|--silent)$/,
    longValues: new Set(['--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count', '--devices', '--directories',
      '--include', '--exclude', '--exclude-dir', '--label', '--binary-files']) },
  rg: { values: 'efgtTABCmMdEjr', quiet: /^(?:-[lcq]|--files-with-matches|--files-without-match|--count|--count-matches|--quiet|--files)$/,
    longValues: new Set(['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--type-add', '--after-context', '--before-context',
      '--context', '--max-count', '--max-columns', '--max-depth', '--max-filesize', '--encoding', '--threads', '--replace', '--pre',
      '--pre-glob', '--sort', '--sortr', '--color', '--colors', '--path-separator', '--engine']) },
  'git-grep': { values: 'efABCm', quiet: /^(?:-[lLcq]|--name-only|--files-with-matches|--files-without-match|--count|--quiet)$/,
    longValues: new Set(['--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count', '--max-depth', '--threads']) },
});
const grammarOf = (name: string) => (name === 'egrep' || name === 'fgrep' ? 'grep' : name);
// Without a stat, only these operands are known to be directories.
const directory = (operand: string) => /^(?:\.{1,2}|~|\/)$|\/$/.test(operand);

// rg --files without a pattern prints file names and reads no file, so its globs select names only (listing
// names is read-only). With a pattern, -l and -c included, rg reads every file the glob selects.
export function fileGlobs(name: string, args: readonly string[]): readonly string[] {
  if (name !== 'rg') return [];
  const grammar = GRAMMARS.rg;
  const { options } = parseOptions(args, grammar.values, grammar.longValues);
  if (options.some(item => item.name === '--files') && !options.some(item => PATTERN_OPTIONS.test(item.name))) return [];
  return options.filter(item => /^(?:-g|--glob|--iglob)$/.test(item.name) && item.value !== null).map(item => item.value as string);
}

// rg's -g/--glob/--iglob values are globs, checked by fileGlobs, never paths; every other word is kept for the path checks.
export function pathWords(name: string, args: readonly string[]): readonly string[] {
  if (name !== 'rg') return args;
  const values = GRAMMARS.rg.values; const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { words.push(...args.slice(index)); break; }
    if (/^--i?glob$/.test(arg)) { index++; continue; }
    if (/^--i?glob=/.test(arg)) continue;
    const at = /^-[^-]/.test(arg) ? [...arg.slice(1)].findIndex(letter => values.includes(letter)) : -1;
    if (at >= 0 && arg[at + 1] === 'g') { if (at + 2 === arg.length) index++; continue; }
    words.push(arg);
  }
  return words;
}

export function printsMatches(name: string, args: readonly string[]): boolean {
  const grammar = GRAMMARS[grammarOf(name)];
  return grammar !== undefined && !parseOptions(args, grammar.values, grammar.longValues).options.some(item => grammar.quiet.test(item.name));
}

// grep walks directories with -r, -R, -d recurse or a directory operand; rg walks every path it is given (a file and a directory
// look alike here) and the cwd when stdin is not piped; git grep always walks the tracked tree.
export function searchTier(name: string, args: readonly string[], piped: boolean): TierResult | null {
  const key = grammarOf(name);
  const grammar = GRAMMARS[key];
  if (grammar === undefined || !printsMatches(key, args)) return null;
  const { options, operands } = parseOptions(args, grammar.values, grammar.longValues);
  const paths = options.some(item => PATTERN_OPTIONS.test(item.name)) ? operands : operands.slice(1);
  const walks = key === 'git-grep' || (key === 'rg' ? paths.length > 0 || !piped
    : paths.some(directory) || options.some(item => /^(?:-[rR]|--recursive|--dereference-recursive)$/.test(item.name)
      || (/^(?:-d|--directories)$/.test(item.name) && item.value === 'recurse')));
  return walks ? RECURSIVE_SEARCH : null;
}
