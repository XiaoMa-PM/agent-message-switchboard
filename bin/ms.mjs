#!/usr/bin/env node
// INPUT: ms argv, HOME, the temp directory and the Node running this file (path, version, platform and arch).
// OUTPUT: The process exit code from src/cli/launcher.mjs.
// POS: The npm bin entry (`ms`); all logic lives in the launcher, which stays plain JavaScript under node_modules.
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runLauncher } from '../src/cli/launcher.mjs';

process.exitCode = await runLauncher({
  argv: process.argv.slice(2), home: process.env.HOME ?? homedir(), tmpdir: tmpdir(),
  packageRoot: fileURLToPath(new URL('..', import.meta.url)), execPath: process.execPath, nodeVersion: process.versions.node,
  platform: process.platform, arch: process.arch,
  out: text => process.stdout.write(`${text}\n`), err: text => process.stderr.write(`${text}\n`),
});
