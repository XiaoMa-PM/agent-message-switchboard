// INPUT: A shell command (string or Codex-style argv) from a peer-request tool call and the peer scope; the lexer and the shell rule files.
// OUTPUT: classifyCommand / classifyArgv → tier with reason (compound: highest; unparseable, secrets, egress: L3; whitelist: L0).
// POS: Pure shell rules of the shared standard. Text matching is not a sandbox; the host sandbox and approvals stay the boundary.
import { classifyPath, globMayMatchSecret, resolvePeerPath, type PathClass, type PeerScope } from './peer-paths.ts';
import { splitShell, type ShellCommand } from './peer-shell-lex.ts';
import { curlTier, ghApiSends, wgetTier } from './peer-shell-net.ts';
import { readOnlyTier } from './peer-shell-read.ts';
import { fileGlobs, pathWords, printsMatches, RECURSIVE_SEARCH, searchTier } from './peer-shell-search.ts';
import { COMMAND, maxTier, pathTier, READ_ONLY, tierResult as result, UNPARSEABLE, type TierResult } from './peer-tier-base.ts';

const SECRET = result('L3', 'secret');
const CONFIG = result('L3', 'config-change');
// The act rules forbid work that keeps running after the letter turn; peer-tiers turns this reason into the G2 gate.
const BACKGROUND_WORK = result('L3', 'background-work');
const DETACH = new Set(['nohup', 'setsid', 'disown']);
// tmux commands that start a server, session, window or pane, or run something inside one; matched anywhere among the arguments
// because tmux chains commands with \; (a stray match only denies more). Queries such as ls or has-session keep their tier.
const TMUX_STARTS = new Set(['start-server', 'start', 'new-session', 'new', 'new-window', 'neww', 'split-window', 'splitw',
  'respawn-pane', 'respawnp', 'respawn-window', 'respawnw', 'run-shell', 'run', 'send-keys', 'send']);
const LAUNCHCTL_STARTS = new Set(['submit', 'load', 'bootstrap', 'start', 'kickstart']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh']);
// Option letters that make an interpreter run a program given inline (python -c, node -e/-p, perl -e/-E, …).
const INLINE: Readonly<Record<string, string>> = Object.freeze({ python: 'c', python3: 'c', python2: 'c', node: 'ep', perl: 'eE', ruby: 'e',
  php: 'r', osascript: 'e', bun: 'e' });
const INLINE_LONG = new Set(['--eval', '--print', '--command']);
const INTERPRETERS = new Set([...SHELLS, ...Object.keys(INLINE), 'deno', 'awk', 'gawk', 'mawk', 'nawk']);
const UNPARSEABLE_NAMES = new Set(['eval', 'exec', 'source', '.', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while',
  'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'xargs']);
const WRAPPERS: Readonly<Record<string, RegExp>> = Object.freeze({ time: /^$/, command: /^$/, builtin: /^$/, noglob: /^$/,
  nice: /^-n$/, stdbuf: /^-[ioe]$/ });
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DELETE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'srm']);
const PERMISSION = new Set(['chmod', 'chown', 'chgrp', 'chflags', 'xattr']);
const NETWORK = new Set(['scp', 'sftp', 'ssh', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'socat', 'mosh']);
const CONFIG_NAMES = new Set(['sudo', 'su', 'doas', 'launchctl', 'crontab', 'systemsetup', 'networksetup', 'pfctl', 'csrutil', 'spctl',
  'dscl', 'scutil', 'visudo']);
const HARNESS_CLIS = new Set(['claude', 'codex', 'ms', 'dsh']);
const HARNESS_CONFIG = new Set(['config', 'mcp', 'plugin', 'plugins', 'install', 'uninstall', 'login', 'logout', 'setup-token', 'auth',
  'repin', 'links', 'alias', 'daemon']);
const PUBLISH: Readonly<Record<string, string>> = Object.freeze({ npm: 'publish', pnpm: 'publish', yarn: 'publish', bun: 'publish',
  cargo: 'publish', gem: 'push', twine: 'upload', poetry: 'publish', docker: 'push', podman: 'push' });
const GH_WRITE: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  pr: new Set(['create', 'merge', 'edit', 'comment', 'close', 'reopen', 'review', 'ready']),
  issue: new Set(['create', 'comment', 'edit', 'close', 'reopen', 'delete', 'transfer']),
  release: new Set(['create', 'upload', 'edit', 'delete']), gist: new Set(['create', 'edit', 'delete']),
  repo: new Set(['create', 'delete', 'fork', 'edit', 'rename', 'archive']), secret: new Set(['set', 'delete']) });
const FIND_RUNS = /^-(?:exec|execdir|ok|okdir)$/;
const XARGS_VALUES = /^(?:-[IinPLldEesa]|--(?:max-args|max-procs|max-lines|max-chars|delimiter|eof|replace|arg-file))$/;
// One sed command we understand: an optional address, then a substitution with plain flags or p, d, q, =. Anything else (w, r, e, a
// script file) can write, read or run files, so it is unparseable.
const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:\\.|[^/\\])*/)`;
const SED_COMMAND = new RegExp(String.raw`^\s*(?:${SED_ADDRESS}(?:\s*,\s*${SED_ADDRESS})?)?\s*!?\s*`
  + String.raw`(?:s([/|#:,])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiI0-9]*|[pdq=])?\s*$`);
const AWK_UNSAFE = /system|getline|ENVIRON|close\s*\(|fflush|[|>]/;

const nameOf = (word: string) => word.split('/').at(-1) ?? word;
const flag = (word: string) => word.startsWith('-') && word.length > 1;
const operands = (args: readonly string[]) => args.filter(arg => !flag(arg));
const dynamic = (word: string) => word.includes('$');
const outsideOrWorse = (kind: PathClass) => kind !== 'inside';
// An argument as path candidates: itself and what follows its first = or : (--target=x, if=x, <rev>:<path>, a volume src:dst).
const candidates = (arg: string) => [arg, ...[...'=:'].filter(mark => arg.includes(mark)).map(mark => arg.slice(arg.indexOf(mark) + 1))];
const names = (args: readonly string[], scope: PeerScope, kind: PathClass) =>
  args.some(arg => candidates(arg).some(path => classifyPath(path, scope) === kind));

// git's global options come before the subcommand. -c sets any config for one run and --exec-path picks the programs git runs, so
// both are config changes; -C and the directory options are read paths of their own.
function gitGlobal(args: readonly string[]): Readonly<{ words: readonly string[]; paths: readonly string[] }> | null {
  let index = 0; const paths: string[] = [];
  while (index < args.length && flag(args[index])) {
    if (/^(?:-c|--config-env|--exec-path)/.test(args[index])) return null;
    if (/^(?:-C|--git-dir|--work-tree)$/.test(args[index])) { paths.push(args[index + 1] ?? ''); index += 2; continue; }
    if (/^--(?:git-dir|work-tree)=/.test(args[index])) paths.push(args[index].slice(args[index].indexOf('=') + 1));
    index += args[index] === '--namespace' ? 2 : 1;
  }
  return Object.freeze({ words: args.slice(index), paths: Object.freeze(paths) });
}

const findRoots = (args: readonly string[]) => {
  const end = args.findIndex(arg => /^[-(!]/.test(arg));
  return args.slice(0, end < 0 ? args.length : end).filter(arg => !flag(arg));
};

// A redirect into the workspace writes a file like the Write tool does, so it is L1 (printf or
// echo creating a note); outside it is L2, onto a secret or protected path L3. The command itself is tiered separately.
const WORKSPACE_WRITE = result('L1', 'workspace-write');
function redirectTier(command: ShellCommand, scope: PeerScope): TierResult {
  const tiers = command.redirects.filter(item => item.target !== '/dev/null' && !/^\d$|^-$/.test(item.target)).map(item => {
    if (dynamic(item.target)) return UNPARSEABLE;
    const write = item.op !== '<' && item.op !== '<&';
    const tier = pathTier(item.target, scope, write);
    return write && tier === COMMAND ? WORKSPACE_WRITE : tier;
  });
  return maxTier(tiers, READ_ONLY);
}

function deleteTier(targets: readonly string[], scope: PeerScope): TierResult {
  for (const target of targets) {
    if (dynamic(target)) return result('L3', 'delete-outside');
    const kind = classifyPath(target, scope);
    if (kind === 'secret') return SECRET;
    if (kind === 'protected') return CONFIG;
    if (kind === 'outside') return result('L3', 'delete-outside');
  }
  return COMMAND;
}

function egressTier(name: string, args: readonly string[], scope: PeerScope): TierResult | null {
  const egress = result('L3', 'egress');
  if (NETWORK.has(name)) return egress;
  if (name === 'curl') return curlTier(args, scope);
  if (name === 'wget') return wgetTier(args, scope);
  if (name === 'rsync' && operands(args).some(arg => /^[^/]*:/.test(arg))) return egress;
  if (name === 'git' && ['push', 'send-email'].includes(operands(args)[0] ?? '')) return egress;
  if (name === 'git' && operands(args)[0] === 'remote' && ['add', 'set-url'].includes(operands(args)[1] ?? '')) return egress;
  const words = name === 'gh' ? args.filter((arg, i) => !flag(arg) && !/^(?:-R|--repo)$/.test(args[i - 1] ?? '')) : operands(args);
  if (name === 'gh' && (GH_WRITE[words[0] ?? '']?.has(words[1] ?? '') || (words[0] === 'api' && ghApiSends(args)))) return egress;
  if (PUBLISH[name] !== undefined && words.includes(PUBLISH[name])) return egress;
  return null;
}

function configTier(name: string, args: readonly string[], scope: PeerScope): TierResult | null {
  if (CONFIG_NAMES.has(name)) return CONFIG;
  if (name === 'security' || (name === 'gh' && operands(args)[0] === 'auth') || (name === 'git' && /^credential/.test(operands(args)[0] ?? ''))) {
    return SECRET;
  }
  if (name === 'defaults' && ['write', 'delete', 'import'].includes(operands(args)[0] ?? '')) return CONFIG;
  if (HARNESS_CLIS.has(name) && HARNESS_CONFIG.has(operands(args)[0] ?? '')) return CONFIG;
  if (name === 'git' && operands(args)[0] === 'config') {
    const reads = args.some(arg => /^(?:--get|--get-all|--get-regexp|--list|-l)$/.test(arg));
    return args.some(arg => /^(?:--global|--system|--file|-f)$/.test(arg)) || (!reads && operands(args).length >= 3) ? CONFIG : COMMAND;
  }
  if (PERMISSION.has(name)) return operands(args).some(arg => dynamic(arg) || outsideOrWorse(classifyPath(arg, scope))) ? CONFIG : COMMAND;
  return null;
}

function moveCopyTier(name: string, args: readonly string[], scope: PeerScope): TierResult | null {
  if (!['mv', 'cp', 'ln', 'install', 'tee', 'rsync'].includes(name)) return null;
  const kinds = operands(args).map(path => classifyPath(path, scope));
  if (kinds.includes('secret')) return SECRET;
  const sources = name === 'tee' ? [] : kinds.slice(0, -1); const targets = name === 'tee' ? kinds : kinds.slice(-1);
  if (targets.includes('protected')) return CONFIG;
  if (name === 'mv' && sources.some(outsideOrWorse)) return result('L3', sources.includes('protected') ? 'config-change' : 'delete-outside');
  if (sources.includes('outside')) return result('L2', 'outside-read');
  return targets.includes('outside') ? result('L2', 'outside-write') : COMMAND;
}

// sed: only scripts we understand; -i writes the files. touch, truncate and dd of= write their targets.
function sedTier(args: readonly string[], scope: PeerScope): TierResult {
  const scripts: string[] = []; const files: string[] = []; let inPlace = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!flag(arg)) { files.push(arg); continue; }
    if (/^(?:-e|--expression)$/.test(arg)) { scripts.push(args[++index] ?? ''); continue; }
    if (arg.startsWith('--expression=')) { scripts.push(arg.slice(13)); continue; }
    if (/^-i|^--in-place/.test(arg)) {
      inPlace = true;
      if (arg === '-i' && (args[index + 1] === '' || /^\.\w*$/.test(args[index + 1] ?? ''))) index++;
      continue;
    }
    if (!/^-[nErsuz]+$/.test(arg)) return UNPARSEABLE;
  }
  const program = scripts.length > 0 ? scripts : files.splice(0, 1);
  if (program.length === 0 || !program.every(script => script.split(/[;\n]/).every(part => SED_COMMAND.test(part)))) return UNPARSEABLE;
  return inPlace ? maxTier(files.map(file => pathTier(file, scope, true)), COMMAND) : COMMAND;
}

function writerTier(name: string, args: readonly string[], scope: PeerScope): TierResult | null {
  if (name === 'sed') return sedTier(args, scope);
  const targets = name === 'touch' || name === 'truncate' ? operands(args)
    : name === 'dd' ? args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)) : [];
  return targets.length === 0 ? null : maxTier(targets.map(target => (dynamic(target) ? UNPARSEABLE : pathTier(target, scope, true))), COMMAND);
}

// A program given inline (or a script piped in) cannot be read here: shells with -c, interpreters with their eval options before the
// script operand, awk programs that run, read or write beyond plain text processing, deno eval, find -exec and xargs (arguments only
// known at run time).
const INTERPRETER_VALUES = /^(?:-[WXr]|--require|--import|--loader|--input-type)$/;
function inlineProgram(name: string, args: readonly string[], piped: boolean): boolean {
  let end = 0;
  while (end < args.length && (flag(args[end]) || INTERPRETER_VALUES.test(args[end - 1] ?? ''))) end++;
  const before = args.slice(0, end);
  if (UNPARSEABLE_NAMES.has(name) || (name === 'find' && args.some(arg => FIND_RUNS.test(arg)))) return true;
  if (SHELLS.has(name) && args.some(arg => /^-[a-z]*c[a-z]*$/.test(arg))) return true;
  if (INLINE[name] !== undefined && before.some(arg => INLINE_LONG.has(arg.split('=')[0])
      || (/^-[A-Za-z]+$/.test(arg) && [...INLINE[name]].some(letter => arg.includes(letter))))) return true;
  if (/^[gmn]?awk$/.test(name) && (args.some(arg => /^-f|^--file/.test(arg)) || operands(args).slice(0, 1).some(program => AWK_UNSAFE.test(program)))) {
    return true;
  }
  return (name === 'deno' && operands(args)[0] === 'eval') || (piped && INTERPRETERS.has(name) && operands(args).length === 0);
}

// xargs and find -exec are unparseable anyway; when the command they run is a search that prints matching lines, the reason says
// so, so the model gets the hint to locate files by name first.
function runsSearch(name: string, args: readonly string[]): boolean {
  let inner: readonly string[] = [];
  if (name === 'xargs') {
    let index = 0;
    while (index < args.length && flag(args[index])) index += XARGS_VALUES.test(args[index]) ? 2 : 1;
    inner = args.slice(index);
  }
  const at = name === 'find' ? args.findIndex(arg => FIND_RUNS.test(arg)) : -1;
  if (at >= 0) inner = args.slice(at + 1).filter((_, index, all) => !all.slice(0, index + 1).some(arg => arg === ';' || arg === '+'));
  const command = nameOf(inner[0] ?? '');
  return command === 'git' ? inner[1] === 'grep' && printsMatches('git-grep', inner.slice(2)) : printsMatches(command, inner.slice(1));
}

function envDump(name: string, args: readonly string[]): boolean {
  return name === 'printenv' || (name === 'export' && (args.length === 0 || args.includes('-p')))
    || (name === 'set' && args.length === 0) || (name === 'declare' && args.some(arg => /^-[a-z]*[xp]/.test(arg)));
}

// Work that keeps running after the turn without a trailing & or nohup. screen detaches (-d, -D) or starts (-m) a
// session, or sends it a command (-X), in any flag cluster; at and batch queue a job unless listing, removing or printing one (-l,
// -r, -d, -c). Everything else launchctl does stays a config change, and crontab stays one like Claude's CronCreate.
function startsLastingWork(name: string, args: readonly string[]): boolean {
  if (name === 'screen') return args.some(arg => /^-[A-Za-z]*[dDmX]/.test(arg));
  if (name === 'tmux') return args.some(arg => TMUX_STARTS.has(arg));
  if (name === 'at' || name === 'batch') return !args.some(arg => /^-[A-Za-z]*[lrdc]/.test(arg));
  return name === 'launchctl' && LAUNCHCTL_STARTS.has(operands(args)[0] ?? '');
}

function commandTier(name: string, rawArgs: readonly string[], piped: boolean, scope: PeerScope): TierResult {
  if (dynamic(name)) return UNPARSEABLE;
  if (startsLastingWork(name, rawArgs)) return BACKGROUND_WORK;
  const git = name === 'git' ? gitGlobal(rawArgs) : undefined;
  if (git === null) return CONFIG;
  const args = git?.words ?? rawArgs;
  if (runsSearch(name, args)) return RECURSIVE_SEARCH;
  if (inlineProgram(name, args, piped)) return UNPARSEABLE;
  // A file glob that can select a secret name reads a secret, as with Grep's glob.
  if (envDump(name, args) || names(pathWords(name, args), scope, 'secret') || fileGlobs(name, args).some(globMayMatchSecret)) return SECRET;
  const rules = [name === 'git' && args[0] === 'grep' ? searchTier('git-grep', args.slice(1), piped) : searchTier(name, args, piped),
    DELETE.has(name) ? deleteTier(operands(args), scope) : null,
    name === 'find' && args.includes('-delete') ? deleteTier(findRoots(args), scope) : null,
    egressTier(name, args, scope), configTier(name, args, scope), moveCopyTier(name, args, scope), writerTier(name, args, scope)]
    .filter((item): item is TierResult => item !== null);
  const read = rules.length === 0 ? readOnlyTier(name, args, scope) : null;
  const touchesConfig = read === null && names(args, scope, 'protected');
  const base = maxTier([...rules, ...(touchesConfig ? [CONFIG] : [])], read ?? COMMAND);
  return maxTier([base, ...(git?.paths ?? []).map(path => pathTier(path, scope, false))], READ_ONLY);
}

// env runs its command after flags and assignments. -S splits one string into the command line, tiered as one; -C moves the cwd
// (and is read itself); -u and -P take a value; an option not listed is unparseable, and env with no command prints the environment.
function envTier(args: readonly string[], piped: boolean, scope: PeerScope): TierResult {
  let index = 0; let here = scope; let floor = READ_ONLY; const tiers: TierResult[] = [];
  while (index < args.length) {
    const arg = args[index];
    if (ASSIGNMENT.test(arg)) { floor = COMMAND; index++; continue; }
    if (arg === '--') { index++; break; }
    if (!flag(arg) && arg !== '-') break;
    const split = /^-S(.*)$/.exec(arg) ?? /^--split-string(?:=(.*))?$/.exec(arg);
    if (split !== null) {
      const text = split[1] || args[index + 1];
      if (text === undefined || args.length > index + (split[1] ? 1 : 2)) return UNPARSEABLE;
      return maxTier([classifyCommand(text, here), ...tiers], floor);
    }
    const chdir = /^(?:-C|--chdir)$/.test(arg) ? args[index + 1] : arg.startsWith('--chdir=') ? arg.slice(8) : undefined;
    if (chdir !== undefined) {
      tiers.push(pathTier(chdir, scope, false)); here = Object.freeze({ ...scope, cwd: resolvePeerPath(chdir, scope) });
      index += arg.includes('=') ? 1 : 2; continue;
    }
    if (/^(?:-u|--unset|-P)$/.test(arg)) { floor = arg === '-P' ? COMMAND : floor; index += 2; continue; }
    if (!/^(?:-i|-0|-v|-|--ignore-environment|--null|--debug|--unset=.*)$/.test(arg)) return UNPARSEABLE;
    index++;
  }
  const inner = args.slice(index);
  return inner.length === 0 ? SECRET : maxTier([classifyWords(inner, piped, here), ...tiers], floor);
}

// Wrappers run the rest of their words as the command, so the inner command's tier counts; timeout also drops its duration.
function wrappedTier(name: string, args: readonly string[], piped: boolean, scope: PeerScope): TierResult | null {
  if (DETACH.has(name)) return BACKGROUND_WORK;
  if (name === 'env') return envTier(args, piped, scope);
  const valued = name === 'timeout' ? /^-[sk]$/ : WRAPPERS[name];
  if (valued === undefined) return null;
  let index = 0;
  while (index < args.length && flag(args[index])) index += valued.test(args[index]) ? 2 : 1;
  const inner = args.slice(name === 'timeout' ? index + 1 : index);
  return inner.length === 0 ? COMMAND : classifyWords(inner, piped, scope);
}

// Leading assignments change the command's environment (PATH, GIT_*, …), so such a command is never L0.
function classifyWords(words: readonly string[], piped: boolean, scope: PeerScope): TierResult {
  const start = words.findIndex(word => !ASSIGNMENT.test(word));
  if (start < 0) return words.length > 0 ? COMMAND : READ_ONLY;
  const name = nameOf(words[start]); const args = words.slice(start + 1);
  return maxTier([wrappedTier(name, args, piped, scope) ?? commandTier(name, args, piped, scope)], start > 0 ? COMMAND : READ_ONLY);
}

// The one heredoc form tiered by its target: cat, bare or reading -, writing the quoted body
// through > or >> with no other input. Any other command fed a heredoc (an interpreter, tee, cat of a file) stays unparseable.
const writesHeredoc = (command: ShellCommand) => command.argv.length <= 2 && command.argv[0] === 'cat'
  && (command.argv.length === 1 || command.argv[1] === '-') && command.redirects.some(item => item.op === '>' || item.op === '>>')
  && command.redirects.every(item => item.op !== '<' && item.op !== '<&');

function classifySimple(command: ShellCommand, scope: PeerScope): TierResult {
  if (command.background) return BACKGROUND_WORK;
  if (command.expands || (command.heredoc && !writesHeredoc(command))) return UNPARSEABLE;
  return maxTier([classifyWords(command.argv, command.piped, scope)], redirectTier(command, scope));
}

export function classifyCommand(text: string, scope: PeerScope): TierResult {
  const commands = splitShell(text);
  if (commands === null) return UNPARSEABLE;
  return maxTier(commands.map(command => classifySimple(command, scope)), READ_ONLY);
}

// Codex hands shell commands over as argv, usually [bash|zsh|sh, -lc|-c, script]: that wrapper is the host's own, so the script
// inside is tiered like any command string; any other argv is one already-split command with nothing left to expand.
export function classifyArgv(argv: readonly string[], scope: PeerScope): TierResult {
  if (argv.length === 3 && SHELLS.has(nameOf(argv[0])) && /^-[a-z]*c[a-z]*$/.test(argv[1])) return classifyCommand(argv[2], scope);
  return classifySimple(Object.freeze({ argv, redirects: Object.freeze([]), piped: false, expands: false, background: false,
    heredoc: false }), scope);
}
