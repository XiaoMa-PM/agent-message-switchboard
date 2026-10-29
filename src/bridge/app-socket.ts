// INPUT: Explicit exported socket path and current-UID private filesystem nodes.
// OUTPUT: Frozen canonical socket pin and fixed-code verification failures.
// POS: App transport filesystem sampling; provides no kernel SID or TOCTOU guarantee.
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

type NodePin = Readonly<{
  path: string;
  dev: string;
  ino: string;
  uid: string;
  mode: string;
}>;

export type AppSocketPin = NodePin & Readonly<{ parent: NodePin }>;

function signature(path: string, row: BigIntStats): NodePin {
  return Object.freeze({ path, dev: String(row.dev), ino: String(row.ino),
    uid: String(row.uid), mode: String(row.mode) });
}

function same(left: NodePin, right: NodePin): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && left.mode === right.mode;
}

function sample(path: string): AppSocketPin {
  const parentPath = dirname(path);
  const socket = lstatSync(path, { bigint: true });
  const parent = lstatSync(parentPath, { bigint: true });
  const uid = process.getuid?.();
  if (uid === undefined || !socket.isSocket() || !parent.isDirectory()
      || socket.uid !== BigInt(uid) || parent.uid !== BigInt(uid)
      || (parent.mode & 0o777n) !== 0o700n
      || realpathSync(path) !== path || realpathSync(parentPath) !== parentPath) {
    throw new Error('APP_SOCKET_UNAVAILABLE');
  }
  return Object.freeze({ ...signature(path, socket),
    parent: signature(parentPath, parent) });
}

export function captureAppSocket(exportedPath: string): AppSocketPin {
  try {
    if (typeof exportedPath !== 'string' || !isAbsolute(exportedPath)
        || exportedPath.includes('\0')) throw new Error();
    const raw = lstatSync(exportedPath, { bigint: true });
    const rawParent = lstatSync(dirname(exportedPath), { bigint: true });
    if (!raw.isSocket() || !rawParent.isDirectory()) throw new Error();
    const canonical = realpathSync(exportedPath);
    const pin = sample(canonical);
    if (!same(signature(canonical, raw), pin)
        || !same(signature(dirname(canonical), rawParent), pin.parent)
        || realpathSync(exportedPath) !== canonical) throw new Error();
    verifyAppSocket(pin);
    return pin;
  } catch {
    throw new Error('APP_SOCKET_UNAVAILABLE');
  }
}

export function verifyAppSocket(pin: AppSocketPin): void {
  try {
    const current = sample(pin.path);
    if (!same(pin, current) || !same(pin.parent, current.parent)) throw new Error();
  } catch {
    throw new Error('APP_SOCKET_UNAVAILABLE');
  }
}
