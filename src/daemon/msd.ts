// INPUT: msd root (install-written config.json, private state/), owned-broker starter and the Claude Native Inbox push and receipt
//        factories.
// OUTPUT: A running daemon (owned Python broker, restored Claude sessions, persisted switchboard, 0600 control socket) and dailyClaudePush;
//         a root whose socket path macOS cannot bind is refused first with MS_SOCKET_PATH_TOO_LONG.
// POS: msd composition root; no Harness settings edits, LaunchAgent or plugin installation.
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { startBroker } from '../bridge/owned-broker.ts';
import { type StdioRequest } from '../bridge/stdio-rpc.ts';
import { createNativeInboxPush, createNativeNoticePush } from '../adapters/claude/inbox.ts';
import { type Endpoint } from '../protocol/message.ts';
import { createClaudeHooks } from './claude-hooks.ts';
import { autoAllows, readDaemonConfig } from './config.ts';
import { readGitWorktree } from '../adapters/git-worktree.ts';
import { createStateStore } from './state-store.ts';
import { createConfigStore, createControlMethods } from './control-methods.ts';
import { listenControl } from './control-server.ts';
import { prepareNativeBundle, privateDirectory, writeClientConfig } from './native-bundle.ts';
import { longSocketPath, runPaths, SOCKET_PATH_TOO_LONG } from './paths.ts';
import { createSwitchboard } from './switchboard.ts';
import { PRODUCT_VERSION } from '../protocol/product-version.ts';

// Daily Claude inbound: DSH and Codex senders; the switchboard decides per delivery whether the header carries reply guidance.
export function dailyClaudePush(endpoint: Endpoint, socketPath: string) {
  return createNativeInboxPush(endpoint, socketPath, ['dsh', 'codex']);
}

type Options = Readonly<{ root: string; startBroker?: typeof startBroker; now?: () => number;
  projectOf?: (cwd: string | null) => Promise<string | null> }>;

export async function projectOf(cwd: string | null): Promise<string | null> {
  return cwd === null ? null : (await readGitWorktree(cwd)) ?? cwd;
}

export async function startMsd(options: Options) {
  if (longSocketPath(options.root) !== null) throw new Error(SOCKET_PATH_TOO_LONG);
  const paths = runPaths(options.root);
  const config = await readDaemonConfig(paths.config);
  await privateDirectory(paths.run);
  const project = options.projectOf ?? projectOf;
  const board = createSwitchboard({ budget: config.linkBudget, now: options.now, store: createStateStore(paths.state) });
  const store = createConfigStore(paths.config, config, next => board.setBudget(next.linkBudget));
  let claude: ReturnType<typeof createClaudeHooks> | undefined;
  const control = await listenControl(paths.control, createControlMethods({ board, config: store,
    version: PRODUCT_VERSION, startedAt: new Date(options.now?.() ?? Date.now()).toISOString(), projectOf: project,
    owners: { 'claude-code': sessionId => claude?.unregister(sessionId) ?? false } }));
  let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
  try {
    const bundle = await prepareNativeBundle(options.root, config.python);
    broker = await (options.startBroker ?? startBroker)(bundle.helper, (request: StdioRequest) =>
      claude ? claude.handle(request) : Promise.reject(new Error('IPC_REQUEST_FAILED')));
    const inspect = broker.inspectSigned;
    claude = createClaudeHooks({ board, inspect: pid => inspect(pid), wrapperPins: () => store.get().claude.wrapperPins,
      python: config.python,
      auto: { enabled: () => store.get().autoRegister['claude-code'], allows: value => autoAllows(store.get(), value),
        projects: () => store.get().autoRegisterProjects,
        set: async enabled => { await store.set({ autoRegister: { 'claude-code': enabled } }); } },
      reply: { mode: () => store.get().replyMode['claude-code'],
        set: async mode => { await store.set({ replyMode: { 'claude-code': mode } }); } }, projectOf: project,
      makePush: dailyClaudePush, makeNotice: createNativeNoticePush,
      act: { preset: () => store.get().actPreset['claude-code'], markers: paths.letterTurns, home: homedir() } });
    await claude.restore();
    await writeClientConfig(bundle, broker.childIdentity, broker.parentIdentity);
  } catch (error) {
    await rm(paths.client, { force: true });
    try { await control.close(); } finally { await broker?.close(); }
    throw error;
  }
  const owned = broker;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await rm(paths.client, { force: true });
    try { await control.close(); } finally { await owned.close(); }
  })();
  return Object.freeze({ board, paths, close, whenBrokerClosed: owned.whenClosed });
}
