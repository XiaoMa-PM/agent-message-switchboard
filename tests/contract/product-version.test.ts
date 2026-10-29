// INPUT: The checked-in root package.json and plugins/ms-dsh/package.json, and PRODUCT_VERSION.
// OUTPUT: The version contract: PRODUCT_VERSION is the root package.json version, and the DSH plugin's static package.json carries
//         the same one (bump both together before a release).
// POS: Offline contract test over real repository files; nothing is generated or installed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PRODUCT_VERSION } from '../../src/protocol/product-version.ts';

const version = (path: string) => (JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version: string }).version;

test('the DSH plugin package.json carries the product version of the root package.json', () => {
  assert.equal(version('../../package.json'), PRODUCT_VERSION);
  assert.equal(version('../../plugins/ms-dsh/package.json'), PRODUCT_VERSION);
});
