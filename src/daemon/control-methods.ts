// INPUT: Control requests per connection, the switchboard, config store, project resolver and per-harness unregister owners.
// OUTPUT: status/sessions/projects/alias/links/messages/config(get/set/reload)/adapter.attach results and adapter delegation
//         (an adapter's autoRegister and replyMode switches share config.set's write and notify path; attach and config events
//         carry that harness's replyMode and actPreset); status also counts the attached DSH and Codex channels.
// POS: msd control-method dispatcher; validates params at the boundary, no socket or identity work.
import { type Harness } from '../protocol/message.ts';
import { AdapterChannel } from './adapter-channel.ts';
import { autoAllows, configView, mergeConfig, readDaemonConfig, writeDaemonConfig, type DaemonConfig } from './config.ts';
import { exactParams, type ControlRequest } from './control-protocol.ts';
import { type ControlConnection } from './control-server.ts';
import { parseHarness, type Switchboard } from './switchboard.ts';

type Params = Readonly<Record<string, unknown>>;
export type ConfigStore = Readonly<{ get: () => DaemonConfig; set: (update: unknown) => Promise<DaemonConfig>;
  reload: () => Promise<DaemonConfig> }>;
export type UnregisterOwner = (sessionId: string) => boolean;
type Options = Readonly<{ board: Switchboard; config: ConfigStore; version: string; startedAt: string;
  projectOf: (cwd: string | null) => Promise<string | null>;
  owners?: Partial<Record<Harness, UnregisterOwner>>; deliveryTimeoutMs?: number }>;

export function createConfigStore(path: string, initial: DaemonConfig, apply: (config: DaemonConfig) => void,
  read: (path: string) => Promise<DaemonConfig> = readDaemonConfig): ConfigStore {
  let current = initial;
  let tail = Promise.resolve();
  const serial = (step: () => Promise<DaemonConfig>) => {
    const next = tail.then(step);
    tail = next.then(() => {}, () => {});
    return next;
  };
  return Object.freeze({ get: () => current,
    set: (update: unknown) => serial(async () => {
      const merged = mergeConfig(current, update);
      await writeDaemonConfig(path, merged);
      current = merged; apply(merged);
      return merged;
    }),
    reload: () => serial(async () => {
      const loaded = await read(path);
      current = loaded; apply(loaded);
      return loaded;
    }) });
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_REQUEST');
  return value;
}

class ControlMethods {
  #options: Options;
  #channels = new Map<ControlConnection, AdapterChannel>();

  constructor(options: Options) { this.#options = options; }

  #status(params: Params) {
    exactParams(params, []);
    const { board, config, version, startedAt } = this.#options;
    const links = board.links();
    return Object.freeze({ version, startedAt, sessions: board.counts(),
      links: Object.freeze({ total: links.length, suspended: links.filter(link => link.suspended).length,
        paused: links.filter(link => link.paused).length }),
      autoRegister: config.get().autoRegister, autoRegisterProjects: config.get().autoRegisterProjects,
      replyMode: config.get().replyMode, actPreset: config.get().actPreset, adapters: this.#adapters() });
  }

  // Claude Code never attaches (adapter.attach refuses it), so only the two adapter harnesses are counted.
  #adapters() {
    const channels = [...this.#channels.values()];
    return Object.freeze({ dsh: channels.filter(channel => channel.harness === 'dsh').length,
      codex: channels.filter(channel => channel.harness === 'codex').length });
  }

  #alias(params: Params) {
    exactParams(params, ['harness', 'sessionId', 'alias']);
    return this.#options.board.alias({ harness: parseHarness(params.harness), sessionId: sessionId(params.sessionId) }, params.alias);
  }

  #unregister(params: Params) {
    exactParams(params, ['harness', 'sessionId']);
    const harness = parseHarness(params.harness); const id = sessionId(params.sessionId);
    const owner = this.#options.owners?.[harness];
    return Object.freeze({ unregistered: owner ? owner(id) : this.#options.board.unregister({ harness, sessionId: id }) });
  }

  #notify(before: DaemonConfig, after: DaemonConfig): void {
    const projectsChanged = JSON.stringify(before.autoRegisterProjects) !== JSON.stringify(after.autoRegisterProjects);
    for (const channel of this.#channels.values()) {
      const harness = channel.harness;
      if (projectsChanged || before.autoRegister[harness] !== after.autoRegister[harness]
          || before.replyMode[harness] !== after.replyMode[harness] || before.actPreset[harness] !== after.actPreset[harness]) {
        channel.emitConfig(after.autoRegister[harness], after.autoRegisterProjects, after.replyMode[harness], after.actPreset[harness]);
      }
    }
  }

  async #configSet(params: Params) {
    const before = this.#options.config.get();
    const after = await this.#options.config.set(params);
    this.#notify(before, after);
    return configView(after);
  }

  async #configReload(params: Params) {
    exactParams(params, []);
    const before = this.#options.config.get();
    const after = await this.#options.config.reload();
    this.#notify(before, after);
    return Object.freeze({ ...configView(after), restartRequired: JSON.stringify(before.python) !== JSON.stringify(after.python) });
  }

  #attach(connection: ControlConnection, params: Params) {
    exactParams(params, ['harness', 'instanceId']);
    const harness = parseHarness(params.harness);
    if (harness === 'claude-code') throw new Error('INVALID_HARNESS');
    const config = this.#options.config;
    const channel = new AdapterChannel(connection, harness, sessionId(params.instanceId), { board: this.#options.board,
      projectOf: this.#options.projectOf, timeoutMs: this.#options.deliveryTimeoutMs,
      auto: { enabled: item => config.get().autoRegister[item], allows: project => autoAllows(config.get(), project),
        projects: () => config.get().autoRegisterProjects,
        set: async (item, enabled) => { await this.#configSet({ autoRegister: { [item]: enabled } }); } },
      reply: { mode: item => config.get().replyMode[item],
        set: async (item, mode) => { await this.#configSet({ replyMode: { [item]: mode } }); } } });
    this.#channels = new Map([...this.#channels, [connection, channel]]);
    void connection.whenClosed.then(() => {
      channel.close();
      this.#channels = new Map([...this.#channels].filter(([item]) => item !== connection));
    });
    return Object.freeze({ attached: true, harness, autoRegister: config.get().autoRegister[harness],
      autoRegisterProjects: config.get().autoRegisterProjects, replyMode: config.get().replyMode[harness],
      actPreset: config.get().actPreset[harness] });
  }

  async dispatch(connection: ControlConnection, request: ControlRequest): Promise<unknown> {
    const channel = this.#channels.get(connection);
    const { method, params } = request;
    if (channel) {
      if (method === 'adapter.attach') throw new Error('ALREADY_ATTACHED');
      return channel.handle(method, params);
    }
    const { board, config } = this.#options;
    if (method === 'status') return this.#status(params);
    if (method === 'sessions.list') {
      exactParams(params, [], ['harness', 'project']);
      return board.list({ harness: params.harness === undefined ? undefined : parseHarness(params.harness),
        project: params.project === undefined ? undefined : sessionId(params.project) });
    }
    if (method === 'sessions.unregister') return this.#unregister(params);
    if (method === 'sessions.alias') return this.#alias(params);
    if (method === 'projects.list') { exactParams(params, []); return board.projects(); }
    if (method === 'links.list') { exactParams(params, []); return board.links(); }
    if (method === 'links.resume') { exactParams(params, ['linkId']); return board.resume(params.linkId); }
    if (method === 'messages.list') {
      exactParams(params, [], ['linkId', 'limit']);
      return board.messages({ linkId: params.linkId as string | undefined, limit: params.limit as number | undefined });
    }
    if (method === 'config.get') { exactParams(params, []); return configView(config.get()); }
    if (method === 'config.set') return this.#configSet(params);
    if (method === 'config.reload') return this.#configReload(params);
    if (method === 'adapter.attach') return this.#attach(connection, params);
    throw new Error('UNKNOWN_METHOD');
  }
}

export function createControlMethods(options: Options) {
  const methods = new ControlMethods(options);
  return (connection: ControlConnection, request: ControlRequest) => methods.dispatch(connection, request);
}
