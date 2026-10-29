// INPUT: Synthetic launch codes, session tokens and Cookie headers.
// OUTPUT: Regressions for the ms ui one-time launch code, the session cookie, constant-time comparison and cookie parsing.
// POS: Pure tests of src/cli/ui/auth.ts; no server, socket or browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { cookieValue, createUiAuth, sameSecret } from '../../src/cli/ui/auth.ts';

test('fresh secrets are 32 random bytes in base64url and differ every start', () => {
  const [one, two] = [createUiAuth(4100), createUiAuth(4100)];
  for (const auth of [one, two]) assert.match(auth.launchCode, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(one.launchCode, two.launchCode);
  assert.notEqual(one.setCookie, two.setCookie);
});

test('the session cookie is per port, HttpOnly, SameSite=Strict and scoped to /ms-ui/', () => {
  const auth = createUiAuth(4100, (() => { const values = ['code-1', 'token-1']; return () => values.shift()!; })());
  assert.equal(auth.launchCode, 'code-1');
  assert.equal(auth.setCookie, 'ms_ui_4100=token-1; Path=/ms-ui/; HttpOnly; SameSite=Strict');
  assert.equal(auth.signedIn('ms_ui_4100=token-1'), true);
  assert.equal(auth.signedIn('other=1; ms_ui_4100=token-1; x=y'), true);
  for (const header of [undefined, '', 'ms_ui_4100=token-2', 'ms_ui_4101=token-1', 'ms_ui_41000=token-1', 'ms_ui_4100', 'ms_ui_4100=']) {
    assert.equal(auth.signedIn(header), false, String(header));
  }
});

test('the launch code redeems exactly once and a wrong or missing code never does', () => {
  const auth = createUiAuth(4100, (() => { const values = ['code-1', 'token-1']; return () => values.shift()!; })());
  assert.equal(auth.redeem(null), false);
  assert.equal(auth.redeem('code-2'), false);
  assert.equal(auth.redeem('code-1'), true);
  assert.equal(auth.redeem('code-1'), false);
});

test('secrets compare through sha256 and timingSafeEqual, whatever their lengths', async () => {
  assert.equal(sameSecret('abc', 'abc'), true);
  assert.equal(sameSecret('abc', 'abd'), false);
  assert.equal(sameSecret('abc', 'abcd'), false);
  assert.equal(sameSecret('', 'abc'), false);
  const source = await readFile(new URL('../../src/cli/ui/auth.ts', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual\(digest\(given\), digest\(expected\)\)/);
  assert.doesNotMatch(source, /=== expected|expected ===/);
});

test('cookieValue reads one named cookie and ignores look-alike names', () => {
  assert.equal(cookieValue('a=1; b=2', 'b'), '2');
  assert.equal(cookieValue(' b = 2 ', 'b'), '2');
  assert.equal(cookieValue('ab=1', 'b'), null);
  assert.equal(cookieValue('b', 'b'), null);
  assert.equal(cookieValue(undefined, 'b'), null);
});
