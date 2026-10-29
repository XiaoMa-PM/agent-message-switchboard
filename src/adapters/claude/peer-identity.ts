// INPUT: Trusted kernel token, required asynchronous live reads and fixed classification pins.
// OUTPUT: A frozen nearest fixed-binary CLI identity (with matched pin index), or fail-closed rejection; shared snapshot types (plain and signed).
// POS: Pure macOS identity contract; no OS calls or request-supplied authentication.
import { isAbsolute } from 'node:path';
export type KernelPeer = Readonly<{ pid: number; uid: number; pidVersion: number }>;
export type ProcessIdentity = Readonly<KernelPeer & { uniqueId: string }>;
export type ProcessSnapshot = Readonly<ProcessIdentity & { parentPid: number; parentUniqueId: string;
  exe: string; sha256: string }>;
export type BinaryPin = Readonly<{ path: string; sha256: string }>;
export type Inspect = (pid: number) => Promise<ProcessSnapshot | null>;
export type CodeSigner = Readonly<{ teamId: string; identifier: string; runtime: boolean }>;
export type SignedSnapshot = Readonly<ProcessIdentity & { parentPid: number; parentUniqueId: string; exe: string;
  sha256: string | null; signing: CodeSigner | null }>;
export type InspectSigned = (pid: number) => Promise<SignedSnapshot | null>;
export type Classify = (snapshot: ProcessSnapshot) => 'cli' | 'wrapper' | 'unsupported';

function unsigned(value: number, maximum = 0xffffffff): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

function unique(value: string): boolean {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
    && BigInt(value) <= 0xffffffffffffffffn;
}

async function readSnapshot(pid: number, inspect: Inspect): Promise<ProcessSnapshot> {
  const raw = await inspect(pid);
  if (!raw) throw new Error('INVALID_PEER_IDENTITY');
  const snapshot = Object.freeze({ pid: raw.pid, uid: raw.uid, pidVersion: raw.pidVersion,
    uniqueId: raw.uniqueId, parentPid: raw.parentPid, parentUniqueId: raw.parentUniqueId,
    exe: raw.exe, sha256: raw.sha256 });
  if (snapshot.pid !== pid || !unsigned(snapshot.pid, 0x7fffffff) || snapshot.pid <= 1
      || !unsigned(snapshot.uid) || !unsigned(snapshot.pidVersion) || !unique(snapshot.uniqueId)
      || !unsigned(snapshot.parentPid, 0x7fffffff) || snapshot.parentPid < 1
      || !unique(snapshot.parentUniqueId) || typeof snapshot.exe !== 'string' || !isAbsolute(snapshot.exe)
      || typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) {
    throw new Error('INVALID_PEER_IDENTITY');
  }
  return snapshot;
}

async function verifyChain(chain: readonly ProcessSnapshot[], inspect: Inspect): Promise<void> {
  for (const expected of chain.toReversed()) {
    if (JSON.stringify(await readSnapshot(expected.pid, inspect)) !== JSON.stringify(expected)) {
      throw new Error('INVALID_PEER_IDENTITY');
    }
  }
}

export async function resolveClaudePeer(rawPeer: KernelPeer, inspect: Inspect,
  classify: Classify, rawPin: BinaryPin): Promise<ProcessSnapshot> {
  return (await resolveClaudePeerAmong(rawPeer, inspect, classify, [rawPin])).snapshot;
}

export async function resolveClaudePeerAmong(rawPeer: KernelPeer, inspect: Inspect, classify: Classify,
  rawPins: readonly BinaryPin[]): Promise<Readonly<{ snapshot: ProcessSnapshot; pinIndex: number }>> {
  const peer = Object.freeze({ pid: rawPeer.pid, uid: rawPeer.uid, pidVersion: rawPeer.pidVersion });
  const pins = Object.freeze(rawPins.map(pin => Object.freeze({ path: pin.path, sha256: pin.sha256 })));
  if (!unsigned(peer.pid, 0x7fffffff) || peer.pid <= 1 || !unsigned(peer.uid) || !unsigned(peer.pidVersion)) {
    throw new Error('INVALID_PEER_IDENTITY');
  }
  if (pins.length === 0 || pins.some(pin => typeof pin.path !== 'string' || !isAbsolute(pin.path)
      || typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256))) {
    throw new Error('UNSUPPORTED_CLAUDE_BINARY');
  }
  let chain: readonly ProcessSnapshot[] = Object.freeze([]);
  let pid = peer.pid;
  while (pid > 1 && !chain.some(snapshot => snapshot.pid === pid)) {
    const snapshot = await readSnapshot(pid, inspect);
    const child = chain.at(-1);
    if (chain.some(previous => previous.uniqueId === snapshot.uniqueId)
        || snapshot.uid !== peer.uid || (!child && snapshot.pidVersion !== peer.pidVersion)
        || (child && child.parentUniqueId !== snapshot.uniqueId)) throw new Error('INVALID_PEER_IDENTITY');
    chain = Object.freeze([...chain, snapshot]);
    const kind = classify(snapshot);
    if (kind === 'cli') {
      const pinIndex = pins.findIndex(pin => snapshot.exe === pin.path && snapshot.sha256 === pin.sha256);
      if (pinIndex < 0) throw new Error('UNSUPPORTED_CLAUDE_BINARY');
      await verifyChain(chain, inspect);
      return Object.freeze({ snapshot, pinIndex });
    }
    if (kind !== 'wrapper') throw new Error('UNSUPPORTED_PEER_ANCESTRY');
    pid = snapshot.parentPid;
  }
  throw new Error('INVALID_PEER_IDENTITY');
}
