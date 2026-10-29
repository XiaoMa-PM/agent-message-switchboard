// INPUT: Desktop Info.plist text or a version string.
// OUTPUT: DSH_MIN_DESKTOP_VERSION, semver precedence (prerelease-aware), the CFBundleShortVersionString reader and the minimum-version gate.
// POS: Daily DSH version policy: a supported floor and no ceiling; real incompatibility surfaces in later interface stages.
export const DSH_MIN_DESKTOP_VERSION = '0.2.0-rc.2';

const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?`
  + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$');
const SHORT_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/;

type Parsed = Readonly<{ core: readonly number[]; prerelease: readonly string[] }>;

function parse(version: string): Parsed | null {
  const match = SEMVER.exec(version);
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split('.') ?? [] } : null;
}

function compareIdentifiers(left: string, right: string): number {
  const numeric = [/^\d+$/.test(left), /^\d+$/.test(right)];
  if (numeric[0] && numeric[1]) return Number(left) - Number(right);
  if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (!left.length || !right.length) return right.length - left.length;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = compareIdentifiers(left[index], right[index]);
    if (order) return order;
  }
  return left.length - right.length;
}

export function compareVersions(left: string, right: string): number {
  const [a, b] = [parse(left), parse(right)];
  if (!a || !b) throw new Error('INVALID_VERSION');
  const core = a.core.map((value, index) => value - b.core[index]).find(value => value !== 0);
  return core ?? comparePrerelease(a.prerelease, b.prerelease);
}

export function supportedDesktopVersion(version: unknown): version is string {
  return typeof version === 'string' && parse(version) !== null && compareVersions(version, DSH_MIN_DESKTOP_VERSION) >= 0;
}

export function desktopVersionOf(plist: string): string | null {
  const version = SHORT_VERSION.exec(plist)?.[1];
  return version !== undefined && parse(version) ? version : null;
}
