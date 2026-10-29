// INPUT: node:crypto randomness (or an injected secret source in tests), the server's port and raw Cookie headers.
// OUTPUT: createUiAuth → the one-time launch code, the Set-Cookie value, redeem (once) and signedIn; sameSecret; cookieValue.
// POS: ms ui authentication; the session token only ever leaves through Set-Cookie, never printed.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const UI_BASE = '/ms-ui/';

export type UiAuth = Readonly<{
  launchCode: string;
  setCookie: string;
  redeem: (code: string | null) => boolean;
  signedIn: (cookieHeader: string | undefined) => boolean;
}>;

const freshSecret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

// Hashing first gives both sides the same length, so the comparison time does not depend on what was sent.
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

// The cookie name carries the port so two ms ui pages do not overwrite each other (cookies ignore ports), and the path keeps
// the browser from sending it to other local servers on 127.0.0.1.
export function createUiAuth(port: number, newSecret: () => string = freshSecret): UiAuth {
  const launchCode = newSecret();
  const token = newSecret();
  const name = `ms_ui_${port}`;
  let redeemed = false;
  return Object.freeze({
    launchCode,
    setCookie: `${name}=${token}; Path=${UI_BASE}; HttpOnly; SameSite=Strict`,
    redeem: (code: string | null) => {
      if (redeemed || code === null || !sameSecret(code, launchCode)) return false;
      redeemed = true;
      return true;
    },
    signedIn: (header: string | undefined) => {
      const value = cookieValue(header, name);
      return value !== null && value !== '' && sameSecret(value, token);
    },
  });
}
