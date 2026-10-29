// INPUT: Run as `<dir>/codex <subcommand> ...` through a node symlink; env MS_FAKE_CHILD (JSON argv), optional MS_FAKE_HOLD.
// OUTPUT: A parent whose ps comm/args look like a Codex subcommand; keeps MS_FAKE_HOLD open, runs the child on inherited stdio.
// POS: Offline stand-in for the Codex process that spawns the ms MCP entry (owner or exec-server); no real Codex state.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

if (process.env.MS_FAKE_HOLD) openSync(process.env.MS_FAKE_HOLD, 'r');
const child = spawn(process.execPath, JSON.parse(process.env.MS_FAKE_CHILD ?? '[]'), { stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
