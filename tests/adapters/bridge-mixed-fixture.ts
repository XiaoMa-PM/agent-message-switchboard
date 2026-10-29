// INPUT: Synthetic standalone/App process tables, real temporary sockets and recorded push/end callbacks.
// OUTPUT: Shared mixed-runtime fixture helpers for CLI and App hook requests.
// POS: Offline test support only; no real App, CLI, DSH, broker or model.
import { mkdtempSync, mkdirSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { type TestContext } from 'node:test';
import { createMixedSessionRuntime } from '../../src/bridge/mixed-session-runtime.ts';
import { type ProcessSnapshot, type BinaryPin } from '../../src/adapters/claude/peer-identity.ts';
import { type Envelope } from '../../src/protocol/message.ts';

export const runId = '12345678-1234-4234-8234-123456789abc';
export const cliSid = '00000000-0000-4000-8000-000000000001';
export const appSid = '00000000-0000-4000-8000-000000000002';
const pinOf = (path: string, digit: string): BinaryPin => Object.freeze({ path, sha256: digit.repeat(64) });
export const pins = { cli: pinOf('/fx/claude-2.1.295', 'a'), appCli: pinOf('/fx/claude-2.1.299', 'b'),
  app: pinOf('/fx/Claude', 'c'), helper: pinOf('/fx/Helper', 'd'), wrapper: pinOf('/fx/python', 'e') };
let unique = 5000;
export function proc(pid: number, parent: ProcessSnapshot | null, pin: BinaryPin, uid = 501): ProcessSnapshot {
  unique += 1;
  return Object.freeze({ pid, uid, pidVersion: pid + 1, uniqueId: String(unique),
    parentPid: parent?.pid ?? 1, parentUniqueId: parent?.uniqueId ?? '1', exe: pin.path, sha256: pin.sha256 });
}

async function listen(path: string, servers: Server[]): Promise<void> {
  const server = createServer(); servers.push(server);
  await new Promise<void>(resolve => server.listen(path, resolve)); chmodSync(path, 0o600);
}

function processes() {
  const login = proc(10, null, pinOf('/usr/bin/login', '1'), 0);
  const shell = proc(11, login, pinOf('/bin/zsh', '2'));
  const cli = proc(12, shell, pins.cli); const cliHook = proc(13, cli, pins.wrapper);
  const app = proc(20, null, pins.app); const helper = proc(21, app, pins.helper);
  const appCli = proc(22, helper, pins.appCli); const appHook = proc(23, appCli, pins.wrapper);
  return { login, shell, cli, cliHook, app, helper, appCli, appHook };
}

const lifecycle = (sid: string, event: string, extra: object = {}) => ({ hook_event_name: event, session_id: sid,
  transcript_path: '/t', cwd: '/w',
  ...(event === 'SessionStart' ? { source: 'startup' } : { reason: 'exit' }), ...extra });
const skillHook = (sid: string, name: string, event: string, args: object, callId: string) => ({ hook_event_name: event,
  session_id: sid, transcript_path: '/t', cwd: '/w', tool_name: 'Skill', tool_use_id: callId,
  tool_input: { skill: name, args: JSON.stringify(args) },
  ...(event === 'PostToolUse' ? { tool_response: { success: true, commandName: name, ...(name.startsWith('ms-app')
    ? { readOnly: false, status: 'inline' } : {}) } } : {}) });

export async function mixedFixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mixed-runtime-'))); chmodSync(dir, 0o700);
  const cliDir = join(dir, 'cli-ipc'); const appDir = join(dir, 'app-ipc');
  mkdirSync(cliDir, { mode: 0o700 }); mkdirSync(appDir, { mode: 0o700 });
  chmodSync(cliDir, 0o700); chmodSync(appDir, 0o700);
  const cliSocket = join(cliDir, 'claude.sock'); const appSocket = join(appDir, 'claude.sock');
  const servers: Server[] = [];
  await listen(cliSocket, servers); await listen(appSocket, servers);
  t.after(async () => {
    for (const server of servers.toReversed()) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  let table: ReturnType<typeof processes> & Record<string, ProcessSnapshot> = processes();
  const rows = () => Object.values(table);
  let inspectGate = async (_pid: number) => {};
  const claudeFrames: Envelope[] = []; const dshFrames: Envelope[] = []; const ends: string[] = [];
  let dispatches = 0;
  const actor = { id: 'dsh-original', ctx: {}, session: { header: { id: 'dsh-original', cwd: '/dsh' } } };
  const route = (identity: ProcessSnapshot, sid: string, socket: { path: string }) => Object.freeze({ schemaVersion: 1 as const,
    ownerPid: identity.pid, ownerStart: `kernel:${identity.pid}`, socket: socket.path,
    endpoint: Object.freeze({ schemaVersion: 1 as const, endpointId: `claude:${sid}`, harness: 'claude-code' as const,
      nativeSessionId: sid, storageNamespace: 'd'.repeat(64), hostInstanceId: `claude-pid:${identity.pid}`, routeGeneration: 'g' }) });
  const runtime = createMixedSessionRuntime({ runId, cliSessionId: cliSid, cliSocketPath: cliSocket,
    cliPin: pins.cli, appCliPin: pins.appCli, wrapperPins: [pins.wrapper], appPin: pins.app, appHelperPins: [pins.helper],
    host: { surface: 'desktop', version: '0.2.0-rc.2', storageNamespace: 'c'.repeat(64), hostInstanceId: 'host',
      routeGeneration: 'generation', getAgent: id => id === actor.id ? actor : undefined, isArchived: () => false },
    inspect: async pid => { await inspectGate(pid); return rows().find(row => row.pid === pid) ?? null; },
    assertOpen() {}, guardDispatch() { dispatches += 1; },
    getCliRoute: async (identity, sid, socket) => route(identity, sid, socket),
    getAppRoute: async (identity, sid, socket) => route(identity, sid, socket),
    makeClaudePush: () => frame => { claudeFrames.push(frame); return { state: 'delivery-unknown', transport: 'written' }; },
    makeDshPush: () => frame => { dshFrames.push(frame); return { state: 'dispatched', transport: null }; },
    onAppEnd: requestId => { ends.push(requestId); } });
  let requests = 0;
  const id = () => `00000000-0000-4000-8000-${String(++requests).padStart(12, '0')}`;
  const peerOf = (row: ProcessSnapshot) => ({ pid: row.pid, uid: row.uid, pidVersion: row.pidVersion });
  const cliRequest = (payload: unknown, peer = table.cliHook) => ({ schemaVersion: 1 as const, requestId: id(),
    peer: peerOf(peer), snapshots: [], payload });
  const appRequest = (hook: unknown, startup: unknown = null, peer = table.appHook) => ({ schemaVersion: 1 as const,
    requestId: id(), peer: peerOf(peer), snapshots: [], payload: { profile: 'app-code', startup, hook } });
  const cliSkill = 'agent-message-switchboard:message'; const appSkill = `ms-app-message-${runId.slice(0, 8)}`;
  const api = {
    runtime, actor, claudeFrames, dshFrames, ends, cliSocket, appSocket, cliRequest, appRequest, table: () => table,
    dispatches: () => dispatches,
    setTable(next: Record<string, ProcessSnapshot>) { table = { ...table, ...next }; },
    setInspectGate(gate: (pid: number) => Promise<void>) { inspectGate = gate; },
    cliStart: (extra: object = {}, sid = cliSid) => runtime.handle(cliRequest(lifecycle(sid, 'SessionStart', extra))),
    cliEnd: () => runtime.handle(cliRequest(lifecycle(cliSid, 'SessionEnd'))),
    appStart: (sid = appSid) => runtime.handle(appRequest(lifecycle(sid, 'SessionStart'), { socketPath: appSocket })),
    appEnd: () => { const request = appRequest(lifecycle(appSid, 'SessionEnd')); return { request, done: runtime.handle(request) }; },
    async activate(sid = appSid) {
      const candidate = await runtime.whenCandidate;
      await runtime.activate(candidate.candidateId, { schemaVersion: 1, action: 'activate-app', runId,
        candidateId: candidate.candidateId, source: 'app-status-copy-all', nativeSessionId: sid,
        desktopSessionId: `local_${sid}`, identityFingerprint: candidate.identityFingerprint, statusReportSha256: 'e'.repeat(64) });
    },
    async cliCall(args: object, callId: string) {
      await runtime.handle(cliRequest(skillHook(cliSid, cliSkill, 'PreToolUse', args, callId)));
      return runtime.handle(cliRequest(skillHook(cliSid, cliSkill, 'PostToolUse', args, callId)));
    },
    async appCall(args: object, callId: string) {
      await runtime.handle(appRequest(skillHook(appSid, appSkill, 'PreToolUse', args, callId)));
      return runtime.handle(appRequest(skillHook(appSid, appSkill, 'PostToolUse', args, callId)));
    },
    async replaceSocket(path: string) { rmSync(path); await listen(path, servers); },
    async ready() {
      await api.cliStart(); await api.appStart(); await api.activate();
      return runtime.registerDsh({ agent: actor });
    },
  };
  return api;
}
