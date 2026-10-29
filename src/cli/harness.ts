// INPUT: ms paths, the pinned bundle and Python path, and each harness's own step (DSH bundle, Claude plugin, Codex plugin).
// OUTPUT: HarnessStep/HarnessSkip, planHarnesses (a failed precondition skips only that harness), harnessContext (records tagged
//         with their harness), planLines/resultLines and the manual-install pointers into docs/user-guide.md.
// POS: The per-harness seam of ms install/uninstall: the core is installed once, each harness plugs in through one step,
//      so a harness can move to its host's plugin mechanism by swapping its planner here.
import { join } from 'node:path';
import type { Harness } from './args.ts';
import { applyDsh, describeDsh, DSH_PACKAGE, DSH_PLUGIN_DIR, planDsh } from './dsh-bundle.ts';
import { CliError } from './errors.ts';
import type { InstallEnv, StepContext } from './install.ts';
import type { InstallRecord } from './manifest.ts';

export const USER_GUIDE = 'docs/user-guide.md';
export const HARNESS_ORDER: readonly Harness[] = Object.freeze(['dsh', 'claude-code', 'codex']);

export type HarnessStep = Readonly<{ harness: Harness; lines: readonly string[]; note: string; apply: (context: StepContext) => Promise<void> }>;
export type HarnessSkip = Readonly<{ harness: Harness; skip: string; manual: string }>;
export type HarnessPlan = HarnessStep | HarnessSkip;
export type HarnessTarget = Readonly<{ bundleDir: string; pythonPath: string; bundled: (relative: string) => boolean }>;

// act needs the first three; Stop and Interrupt only settle no-reply receipts.
const CODEX_NOTE = 'start a new Codex session and trust all six ms hooks in /hooks; until UserPromptSubmit, PreToolUse and '
  + 'PermissionRequest are trusted, act letters are handled as direct, and an untrusted Stop or Interrupt only means no no-reply receipts';

type Planner = (env: InstallEnv, target: HarnessTarget) => Promise<Omit<HarnessStep, 'harness'> | Readonly<{ skip: string }>>;

export function manualPointer(harness: Harness, bundleDir: string): string {
  const where = `manual install: ${USER_GUIDE}#manual-${harness}`;
  return harness === 'dsh' ? `${where}, plugin directory ${join(bundleDir, DSH_PLUGIN_DIR)}` : where;
}

const PLANNERS: Readonly<Record<Harness, Planner>> = Object.freeze({
  dsh: async (env, target) => {
    const plan = await planDsh(env.paths, target.bundleDir, env.dshPnpm);
    return { lines: describeDsh(plan), note: `restart DSH once so it loads ${DSH_PACKAGE}`, apply: context => applyDsh(plan, context, env.dshPnpm) };
  },
  'claude-code': async (env, target) => {
    const step = await env.planClaude({ pythonPath: target.pythonPath });
    return { lines: step.lines, note: 'new Claude sessions load it; open sessions need /reload-plugins', apply: step.apply };
  },
  codex: async (env, target) => {
    const step = await env.planCodex({ bundleDir: target.bundleDir, bundled: target.bundled });
    return { lines: step.lines, note: CODEX_NOTE, apply: step.apply };
  },
});

export async function planHarness(env: InstallEnv, target: HarnessTarget, harness: Harness): Promise<HarnessPlan> {
  try {
    const planned = await PLANNERS[harness](env, target);
    if ('skip' in planned) return Object.freeze({ harness, skip: planned.skip, manual: manualPointer(harness, target.bundleDir) });
    return Object.freeze({ harness, ...planned });
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'INSTALL_PRECONDITION_FAILED') throw error;
    return Object.freeze({ harness, skip: error.detail ?? error.code, manual: manualPointer(harness, target.bundleDir) });
  }
}

export async function planHarnesses(env: InstallEnv, target: HarnessTarget): Promise<HarnessPlan[]> {
  const plans: HarnessPlan[] = [];
  for (const harness of HARNESS_ORDER) plans.push(await planHarness(env, target, harness));
  return plans;
}

export function harnessContext(context: StepContext, harness: Harness): StepContext {
  return Object.freeze({
    ...context,
    journal: (record: InstallRecord) => context.journal(Object.freeze({ ...record, harness })),
    amend: (record: InstallRecord) => context.amend(Object.freeze({ ...record, harness })),
  });
}

const skipped = (plan: HarnessSkip) => `${plan.harness}: skipped (${plan.skip}); ${plan.manual}`;

export function planLines(plans: readonly HarnessPlan[]): string[] {
  return plans.flatMap(plan => ('skip' in plan ? [skipped(plan)] : [`${plan.harness}:`, ...plan.lines.map(line => `  ${line}`)]));
}

export function resultLines(plans: readonly HarnessPlan[]): string[] {
  return plans.map(plan => ('skip' in plan ? skipped(plan) : `${plan.harness}: installed (${plan.note})`));
}
