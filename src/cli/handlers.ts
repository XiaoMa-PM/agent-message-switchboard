// INPUT: Install environment, launchctl runner, uid, timing options and the ms ui browser opener and stop signal.
// OUTPUT: createHandlers → install/uninstall (whole, or one harness with --harness)/daemon/ui/upgrade handlers for runCli (dry runs
//         never write; ui reads msd only through the status page's read-only allowlist; upgrade runs the old bundle's CLI for real).
// POS: Wiring between the CLI dispatcher and the install/uninstall/daemon modules.
import { runDaemon } from './daemon.ts';
import { applyInstall } from './install-apply.ts';
import { describePlan, planInstall, type InstallEnv } from './install.ts';
import type { Launchctl } from './launchd.ts';
import type { CliHandlers } from './main.ts';
import { applyHarnessUninstall, applyUninstall, describeHarnessUninstall, describeUninstall, loadManifest } from './uninstall.ts';
import type { Harness } from './args.ts';
import { installHarness } from './harness-install.ts';
import { applyRepin, describeRepin, planRepin, type RepinDeps } from './repin.ts';
import { callControl } from './control-client.ts';
import { runUi } from './ui/command.ts';
import { installedHarnesses, readSnapshot } from './ui/snapshot.ts';
import { runUpgrade, systemRun } from './upgrade.ts';

export type HandlerContext = Readonly<{
  env: InstallEnv;
  repin: RepinDeps;
  launchctl: Launchctl;
  uid: number;
  controlTimeoutMs: number;
  readyTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  ui: Readonly<{ open: (url: string) => Promise<void>; untilStopped: () => Promise<void> }>;
}>;

export function createHandlers(context: HandlerContext): CliHandlers {
  const { env, launchctl, uid } = context;
  const daemonDeps = { paths: env.paths, launchctl, uid, controlTimeoutMs: context.controlTimeoutMs, readyTimeoutMs: context.readyTimeoutMs, sleep: context.sleep };
  return Object.freeze({
    install: async (dryRun: boolean, harness: Harness | null) => {
      if (harness !== null) return installHarness(env, harness, dryRun);
      const plan = await planInstall(env);
      return dryRun ? describePlan(plan, env.paths) : applyInstall(plan, env);
    },
    repin: async (dryRun: boolean) => {
      const plan = await planRepin(context.repin);
      return dryRun ? describeRepin(plan) : applyRepin(plan, context.repin);
    },
    uninstall: async (dryRun: boolean, keepData: boolean, harness: Harness | null) => {
      const manifest = await loadManifest(env.paths);
      if (harness !== null) {
        return dryRun ? describeHarnessUninstall(manifest, harness) : applyHarnessUninstall(manifest, env.paths, { dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli }, harness);
      }
      return dryRun ? describeUninstall(manifest, env.paths, keepData) : applyUninstall(manifest, { paths: env.paths, launchctl, uid, dshPnpm: env.dshPnpm, claudeCli: env.claudeCli, codexCli: env.codexCli }, keepData);
    },
    daemon: (action: 'start' | 'stop' | 'status') => runDaemon(action, daemonDeps),
    ui: (out: (text: string) => void) => runUi({ out, open: context.ui.open, stopped: context.ui.untilStopped(),
      snapshot: () => readSnapshot({ home: env.paths.home, installed: () => installedHarnesses(env.paths),
        control: (method, params) => callControl(env.paths.socket, method, params, { timeoutMs: context.controlTimeoutMs }) }) }),
    upgrade: (dryRun: boolean, out: (text: string) => void) => runUpgrade({ env, out, runOld: systemRun, daemon: action => runDaemon(action, daemonDeps) }, dryRun),
  });
}
