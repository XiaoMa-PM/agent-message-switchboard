// INPUT: Synthetic semver strings and Info.plist texts.
// OUTPUT: Precedence (prerelease-aware), minimum-version floor and plist extraction regressions for the daily DSH version gate.
// POS: Offline version policy tests; no real desktop bundle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, desktopVersionOf, DSH_MIN_DESKTOP_VERSION, supportedDesktopVersion }
  from '../../src/adapters/dsh/desktop-version.ts';

const plist = (version: string) => `<plist><dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict></plist>\n`;

test('versions order by semver precedence, prerelease identifiers included and build metadata ignored', () => {
  const ordered = ['0.1.9', '0.2.0-alpha', '0.2.0-alpha.1', '0.2.0-beta.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.10',
    '0.2.0', '0.2.1-rc.2', '0.2.1', '0.3.0', '1.0.0'];
  for (const [i, left] of ordered.entries()) {
    for (const [j, right] of ordered.entries()) {
      assert.equal(Math.sign(compareVersions(left, right)), Math.sign(i - j), `${left} vs ${right}`);
    }
  }
  assert.equal(compareVersions('0.2.1+build.5', '0.2.1'), 0);
  assert.ok(compareVersions('0.2.0-rc.2.1', '0.2.0-rc.2') > 0);
  assert.ok(compareVersions('0.2.0-1', '0.2.0-rc') < 0);
});

test('the floor is 0.2.0-rc.2 with no ceiling; malformed versions are never supported', () => {
  assert.equal(DSH_MIN_DESKTOP_VERSION, '0.2.0-rc.2');
  for (const version of ['0.2.0-rc.2', '0.2.0', '0.2.1-rc.2', '0.3.0', '9.0.0']) assert.equal(supportedDesktopVersion(version), true, version);
  for (const version of ['0.2.0-rc.1', '0.1.9', '0.2', 'v0.2.1', '0.2.1-', '01.2.3', '0.2.0-rc.01', ' 0.2.1', '', null, 2]) {
    assert.equal(supportedDesktopVersion(version), false, String(version));
  }
});

test('desktopVersionOf reads CFBundleShortVersionString and yields null when it is missing or not semver', () => {
  assert.equal(desktopVersionOf(plist('0.2.1-rc.2')), '0.2.1-rc.2');
  assert.equal(desktopVersionOf(plist('v0.2.1')), null);
  assert.equal(desktopVersionOf(plist('')), null);
  assert.equal(desktopVersionOf('<plist><dict><key>CFBundleVersion</key><string>0.2.1</string></dict></plist>'), null);
  assert.equal(desktopVersionOf('not a plist'), null);
});
