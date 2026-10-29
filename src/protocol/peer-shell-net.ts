// INPUT: curl, wget or gh api arguments (already split) and the peer scope.
// OUTPUT: parseOptions, shortOptions (combined short forms), curlTier, wgetTier (L3 egress, unparseable, file tiers), ghApiSends.
// POS: Network-command rules of the shell standard.
import { type PeerScope } from './peer-paths.ts';
import { COMMAND, maxTier, pathTier, tierResult, UNPARSEABLE, type TierResult } from './peer-tier-base.ts';

export type CommandOption = Readonly<{ name: string; value: string | null }>;

const EGRESS = tierResult('L3', 'egress');
const CURL_SHORT_VALUES = 'AbcCdDeEFHKmoPQrTtuUwXxyYz';
const CURL_LONG_VALUES = new Set(['--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--form', '--form-string',
  '--upload-file', '--json', '--request', '--output', '--output-dir', '--header', '--user', '--config', '--cookie', '--cookie-jar',
  '--dump-header', '--url', '--user-agent', '--referer', '--max-time', '--connect-timeout', '--retry', '--proxy', '--cert', '--key',
  '--cacert', '--range', '--write-out', '--trace', '--trace-ascii', '--stderr', '--libcurl', '--netrc-file']);
const CURL_WRITES = new Set(['-o', '--output', '--output-dir', '-D', '--dump-header', '-c', '--cookie-jar', '--trace', '--trace-ascii',
  '--stderr', '--libcurl']);
const WGET_SHORT_VALUES = 'aABDeiIlOoPQRtTUwX';
const WGET_LONG_VALUES = new Set(['--output-document', '--output-file', '--append-output', '--directory-prefix', '--execute', '--input-file',
  '--post-data', '--post-file', '--body-data', '--body-file', '--method', '--header', '--user-agent', '--tries', '--timeout', '--wait',
  '--user', '--password', '--load-cookies', '--save-cookies', '--config']);
const WGET_WRITES = new Set(['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix',
  '--save-cookies']);
const SAFE_METHOD = /^(?:GET|HEAD)$/i;

export function parseOptions(args: readonly string[], shortValues: string, longValues: ReadonlySet<string>):
    Readonly<{ options: readonly CommandOption[]; operands: readonly string[] }> {
  const options: CommandOption[] = []; const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { operands.push(...args.slice(index + 1)); break; }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      options.push(equals >= 0 ? { name: arg.slice(0, equals), value: arg.slice(equals + 1) }
        : { name: arg, value: longValues.has(arg) ? args[++index] ?? '' : null });
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') { operands.push(arg); continue; }
    for (let at = 1; at < arg.length; at++) {
      if (!shortValues.includes(arg[at])) { options.push({ name: `-${arg[at]}`, value: null }); continue; }
      options.push({ name: `-${arg[at]}`, value: at + 1 < arg.length ? arg.slice(at + 1) : args[++index] ?? '' });
      break;
    }
  }
  return Object.freeze({ options: Object.freeze(options), operands: Object.freeze(operands) });
}

export const shortOptions = (args: readonly string[], shortValues: string, longValues: ReadonlySet<string>): readonly CommandOption[] =>
  parseOptions(args, shortValues, longValues).options;

const writes = (targets: readonly string[], scope: PeerScope): TierResult | null => {
  const files = targets.filter(target => target !== '' && target !== '-');
  return files.length === 0 ? null : maxTier(files.map(target => pathTier(target, scope, true)), COMMAND);
};

export function curlTier(args: readonly string[], scope: PeerScope): TierResult | null {
  const options = shortOptions(args, CURL_SHORT_VALUES, CURL_LONG_VALUES);
  if (options.some(item => item.name === '-K' || item.name === '--config')) return UNPARSEABLE;
  if (options.some(item => /^(?:-[dFT]|--data.*|--form.*|--upload-file|--json)$/.test(item.name)
      || (/^(?:-X|--request)$/.test(item.name) && !SAFE_METHOD.test(item.value ?? '')))) return EGRESS;
  return writes(options.filter(item => CURL_WRITES.has(item.name)).map(item => item.value ?? ''), scope);
}

export function wgetTier(args: readonly string[], scope: PeerScope): TierResult | null {
  const options = shortOptions(args, WGET_SHORT_VALUES, WGET_LONG_VALUES);
  if (options.some(item => /^(?:-e|--execute|--config)$/.test(item.name))) return UNPARSEABLE;
  if (options.some(item => /^--(?:post|body)-(?:data|file)$/.test(item.name)
      || (item.name === '--method' && !SAFE_METHOD.test(item.value ?? '')))) return EGRESS;
  return writes(options.filter(item => WGET_WRITES.has(item.name)).map(item => item.value ?? ''), scope);
}

// gh api sends when it carries fields or an input body, or uses a method other than GET.
export function ghApiSends(args: readonly string[]): boolean {
  const options = shortOptions(args, 'fFXHpqt', new Set(['--field', '--raw-field', '--input', '--method', '--header', '--jq', '--template',
    '--hostname', '--cache', '--preview']));
  return options.some(item => /^(?:-f|-F|--field|--raw-field|--input)$/.test(item.name)
    || (/^(?:-X|--method)$/.test(item.name) && !/^GET$/i.test(item.value ?? '')));
}
