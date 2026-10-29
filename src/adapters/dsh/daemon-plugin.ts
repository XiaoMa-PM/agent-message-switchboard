// INPUT: Daily DSH desktop ctx (agents, tools, profile, optional commands, systemPrompt, approval), the {root} config, msd socket.
// OUTPUT: startDshPlugin: router tools, /ms-* commands, guidance, act gate, staged init with stage codes, MS_PLUGIN_UNAVAILABLE, beacon.
// POS: Daily DSH plugin composition; a failed stage keeps the tools and reports a code, never the raw error.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, runPaths } from '../../daemon/paths.ts';
import { readGitWorktree } from '../git-worktree.ts';
import { createDshAct, type ActAgent, type DshAct } from './act-gate.ts';
import { createDshDaemonClient, type AutoEvent, type DaemonClientOptions, type DshAgent, type DshDaemonClient } from './daemon-client.ts';
import { dshCommandDefinitions, type CommandDefinition } from './daemon-commands.ts';
import { installDailyGuidance, type GuidancePrompt } from './daemon-guidance.ts';
import { createDshDaemonTools, PluginUnavailable, type PluginStage } from './daemon-tools.ts';
import { desktopVersionOf, supportedDesktopVersion } from './desktop-version.ts';
import { createDshStorageNamespace } from './namespace.ts';
import { createPluginBeacon, type BeaconSnapshot, type PluginBeacon } from './plugin-beacon.ts';
import { type ActPreset } from '../../protocol/peer-tiers.ts';
import { type ReplyMode } from '../../protocol/reply-mode-text.ts';

const DESKTOP_APP = '/Applications/DeepSeek Harness.app';
const SDK = 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';

type Tool = ReturnType<typeof createDshDaemonTools>[number];
type Sdk = Readonly<{ createUserMessage: (input: unknown) => ReturnType<DaemonClientOptions['createMessage']> }>;
type Titles = Readonly<{ get: (session: unknown) => Readonly<{ title?: string | null }> | undefined }>;
// The scoped ctx of the optional act injection: DSH's approval, working-directory and jobs services plus scoped events.
type ActScope = Readonly<{ approval: Readonly<{ effectivePolicy: (session: unknown) => unknown }>;
  workingDirectory: Readonly<{ get: (session: unknown) => unknown }>;
  jobs: Readonly<{ events: Readonly<{ subscribe: (filter: Readonly<{ owners: 'all' }>, listener: (event: unknown) => void) => unknown }> }>;
  on: (name: 'agent/created' | 'agent/disposed' | 'agent/inbox/claimed' | 'session/event', listener: (...args: never[]) => void) => unknown;
  effect: (execute: () => () => void) => void }>;
export type DshPluginContext = Readonly<{ get: (name: string) => unknown;
  agents: Readonly<{ get: (id: string) => DshAgent | undefined; list: () => Iterable<DshAgent>; roots: () => Iterable<DshAgent> }>;
  tools: Readonly<{ register: (tool: Tool) => () => void; get?: (name: string, scope: unknown) => unknown }>;
  on: (name: 'agent/created' | 'agent/disposed', listener: (event: Readonly<{ agent: DshAgent }>) => void) => void;
  effect: (execute: () => () => void) => void;
  inject: (deps: readonly string[], apply: (scoped: Readonly<{ commands: Readonly<{ register: (command: CommandDefinition) => () => void }>;
    systemPrompt: GuidancePrompt }> & ActScope) => void) => unknown }>;
type Options = Readonly<{ app?: string; pid?: number; retryMs?: number; createClient?: typeof createDshDaemonClient }>;
type Outcome = Readonly<{ client: DshDaemonClient } | { stage: PluginStage }>;
type Tracker = ReturnType<typeof tracker>;

function rootOf(config: unknown): string {
  const root = (config as { root?: unknown } | null | undefined)?.root ?? DEFAULT_ROOT;
  if (typeof root !== 'string' || !isAbsolute(root) || Object.keys(config ?? {}).some(key => key !== 'root')) {
    throw new Error('INVALID_MS_PLUGIN_CONFIG');
  }
  return root;
}

// The commands and guidance notes never change state: a host without either service keeps the tools and can still be ready.
function tracker(beacon: PluginBeacon, registered: boolean, guided: boolean) {
  let stages: BeaconSnapshot['stages'] = Object.freeze({});
  let current: Pick<BeaconSnapshot, 'state' | 'stage'> = Object.freeze({ state: 'initializing', stage: null });
  let commands: BeaconSnapshot['commands'] = registered ? 'registered' : 'none';
  let guidance: BeaconSnapshot['guidance'] = guided ? 'installed' : 'none';
  let auto: BeaconSnapshot['auto'] = Object.freeze({ listed: null, registered: 0, refused: 0, skipped: 0, disposed: 0,
    failed: Object.freeze({}) });
  let last = '';
  const publish = () => {
    const snapshot: BeaconSnapshot = Object.freeze({ stages, ...current, commands, guidance, auto });
    const key = JSON.stringify(snapshot);
    if (key !== last) { last = key; beacon.write(snapshot); }
  };
  const mark = (stage: PluginStage, result: 'ok' | 'failed') => {
    stages = Object.freeze({ ...stages, [stage]: result });
    current = Object.freeze({ stage: result === 'failed' ? stage : null,
      state: result === 'failed' ? 'failed' : stage === 'ATTACH' ? 'ready' : 'initializing' });
    publish();
  };
  return Object.freeze({ ok: (stage: PluginStage) => mark(stage, 'ok'), failed: (stage: PluginStage) => mark(stage, 'failed'),
    commands: () => { commands = 'registered'; publish(); }, guidance: () => { guidance = 'installed'; publish(); },
    auto: (event: AutoEvent) => {
      auto = Object.freeze(event.kind === 'listed' ? { ...auto, listed: event.count }
        : event.kind === 'failed' ? { ...auto, failed: Object.freeze({ ...auto.failed, [event.code]: (auto.failed[event.code] ?? 0) + 1 }) }
        : { ...auto, [event.kind]: auto[event.kind] + 1 });
      publish();
    } });
}

async function step<T>(track: Tracker, stage: PluginStage, run: () => T | Promise<T>): Promise<T> {
  let value: T;
  try { value = await run(); } catch { track.failed(stage); throw new PluginUnavailable(stage); }
  track.ok(stage);
  return value;
}

function gated(outcome: Promise<Outcome>): Pick<DshDaemonClient, 'register' | 'unregister' | 'autoRegister' | 'replyMode' | 'list' | 'call'>
  & Readonly<{ actPreset: () => Promise<ActPreset | null> }> {
  const use = async <T>(run: (client: DshDaemonClient) => Promise<T>): Promise<T> => {
    const settled = await outcome;
    if ('stage' in settled) throw new PluginUnavailable(settled.stage);
    return run(settled.client).catch((error: unknown) => {
      throw error instanceof Error && error.message === 'MS_UNAVAILABLE' ? new PluginUnavailable('ATTACH') : error;
    });
  };
  return Object.freeze({ register: (execution: unknown) => use(client => client.register(execution)),
    unregister: (execution: unknown) => use(client => client.unregister(execution)),
    autoRegister: (enabled: boolean | undefined) => use(client => client.autoRegister(enabled)),
    replyMode: (mode: ReplyMode | undefined) => use(client => client.replyMode(mode)),
    actPreset: () => use(async client => client.knownActPreset()),
    list: (execution: unknown, params: Record<string, unknown>) => use(client => client.list(execution, params)),
    call: (execution: unknown, method: string, params: Record<string, unknown>) => use(client => client.call(execution, method, params)) });
}

// DSH adds the reserved run_code transport to an agent's tool view exactly when that agent's presentation is not native (dsh-tools
// view; plugins cannot register the name), so the public tools.get answers it; a host without get counts as not native.
const nativeTools = (ctx: DshPluginContext, agent: unknown) =>
  typeof ctx.tools.get === 'function' && ctx.tools.get('run_code', agent) === undefined;

// The gate sits on each top-level agent. A subagent has an owner and is never gated, and its
// calls do not reach its parent's gate, so G2 refuses delegation in a letter turn instead.
function installAct(ctx: DshPluginContext, scoped: ActScope, client: () => DshDaemonClient | undefined): DshAct {
  const act = createDshAct({ mode: () => client()?.knownReplyMode() ?? null, preset: () => client()?.knownActPreset() ?? null,
    policy: agent => scoped.approval.effectivePolicy(agent.session), nativeTools: agent => nativeTools(ctx, agent),
    cwd: agent => scoped.workingDirectory.get(agent.session), projectOf: readGitWorktree, home: homedir(),
    onLetterTurnEnd: end => client()?.letterTurnEnd(end) });
  const watch = (agent: unknown) => { if ([...ctx.agents.roots()].includes(agent as DshAgent)) act.watch(agent as ActAgent); };
  scoped.on('agent/created', ({ agent }: Readonly<{ agent: unknown }>) => watch(agent));
  scoped.on('agent/disposed', ({ agent }: Readonly<{ agent: unknown }>) => act.disposed(agent));
  scoped.on('agent/inbox/claimed', (event: unknown) => act.claimed(event));
  scoped.on('session/event', (session: unknown, event: unknown) => act.sessionEvent(session, event));
  // Jobs the letter turn registers, so a command the host moved to the background keeps the letter's gate when it wakes the session.
  scoped.jobs.events.subscribe({ owners: 'all' }, event => act.jobEvent(event));
  for (const agent of ctx.agents.roots()) watch(agent);
  return act;
}

async function initialize(ctx: DshPluginContext, root: string, hostInstanceId: string, track: Tracker, options: Options) {
  const app = options.app ?? DESKTOP_APP;
  const version = await step(track, 'DESKTOP_VERSION', async () => {
    const read = desktopVersionOf(await readFile(join(app, 'Contents/Info.plist'), 'utf8'));
    if (!supportedDesktopVersion(read)) throw new Error('UNSUPPORTED_DESKTOP_VERSION');
    return read;
  });
  const workspace = await step(track, 'ARCHIVE_STATE', () => {
    const registry = ctx.get('workspaceRegistry') as Readonly<{ archivedSessionIds?: Iterable<string> }> | undefined;
    if (!registry?.archivedSessionIds) throw new Error('ARCHIVE_STATE_UNAVAILABLE');
    return registry as Readonly<{ archivedSessionIds: Iterable<string> }>;
  });
  const storageNamespace = await step(track, 'PROFILE_NAMESPACE', () => createDshStorageNamespace(ctx.get('profileContext')));
  const sdk = await step(track, 'SDK_IMPORT', async () => await import(pathToFileURL(join(app, SDK)).href) as Sdk);
  return step(track, 'CLIENT_INIT', () => {
    const titles = ctx.get('sessionTitle') as Titles | undefined;
    return (options.createClient ?? createDshDaemonClient)({ socketPath: runPaths(root).control, instanceId: hostInstanceId,
      host: { surface: 'desktop', version, storageNamespace, hostInstanceId, routeGeneration: randomUUID(),
        getAgent: id => ctx.agents.get(id), isArchived: id => new Set(workspace.archivedSessionIds).has(id) },
      getAgent: id => ctx.agents.get(id), listAgents: () => ctx.agents.list(),
      describe: agent => ({ title: titles?.get(agent.session)?.title ?? null,
        cwd: (agent.session.header as Readonly<{ cwd?: string }>).cwd ?? null }),
      createMessage: (content, source) => sdk.createUserMessage({ content: [{ type: 'text', text: content }], source }),
      ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
      onAttached: attached => attached ? track.ok('ATTACH') : track.failed('ATTACH'), onAuto: event => track.auto(event) });
  });
}

export async function startDshPlugin(ctx: DshPluginContext, config: unknown, options: Options = {}): Promise<void> {
  const outcome = Promise.withResolvers<Outcome>();
  const gate = gated(outcome.promise);
  const disposers = createDshDaemonTools(gate).map(tool => ctx.tools.register(tool));
  let closed = false; let client: DshDaemonClient | undefined; let beacon: PluginBeacon | undefined;
  let track: Tracker | undefined; let commandDisposers: Array<() => void> = []; let guidanceDisposers: Array<() => void> = [];
  let act: DshAct | undefined;
  ctx.inject(['approval', 'workingDirectory', 'jobs'], scoped => {
    const installed = installAct(ctx, scoped, () => client);
    act = installed;
    scoped.effect(() => () => { if (act === installed) act = undefined; installed.dispose(); });
  });
  // act is told to a session only where its letters can be gated (a never session or a host without act services reads direct).
  const mode = (agent: unknown): ReplyMode | null => {
    const value = client?.knownReplyMode() ?? null;
    return value === 'act' && act?.canAct(agent) !== true ? 'direct' : value;
  };
  ctx.inject(['commands'], scoped => {
    commandDisposers = dshCommandDefinitions(gate).map(command => scoped.commands.register(command));
    track?.commands();
  });
  ctx.inject(['systemPrompt'], scoped => {
    try { guidanceDisposers = [installDailyGuidance(scoped.systemPrompt, mode)]; } catch { return; }
    track?.guidance();
  });
  ctx.effect(() => () => {
    closed = true; beacon?.close(); client?.close();
    for (const dispose of [...disposers, ...commandDisposers, ...guidanceDisposers].toReversed()) dispose();
  });
  let root: string;
  try { root = rootOf(config); } catch { outcome.resolve({ stage: 'CONFIG' }); return; }
  const hostInstanceId = `dsh-desktop:${options.pid ?? process.pid}`;
  beacon = createPluginBeacon(runPaths(root).run, hostInstanceId);
  track = tracker(beacon, commandDisposers.length > 0, guidanceDisposers.length > 0);
  track.ok('CONFIG');
  try { client = await initialize(ctx, root, hostInstanceId, track, options); } catch (error) {
    outcome.resolve({ stage: (error as PluginUnavailable).stage }); return;
  }
  const ready = client;
  outcome.resolve({ client: ready });
  if (closed) { ready.close(); return; }
  ctx.on('agent/created', ({ agent }) => { ready.agentCreated(agent); });
  // A disposed session's letters are reported (closed) before its unregister, whichever listener the host calls first: msd only
  // settles letters for a session still registered.
  ctx.on('agent/disposed', ({ agent }) => { act?.disposed(agent); ready.agentDisposed(agent); });
  ready.start();
}
