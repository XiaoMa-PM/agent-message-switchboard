// INPUT: launcher.mjs, the plain-JavaScript npm launcher.
// OUTPUT: Types for runLauncher, nodeSupported and spawnInherit, so the TypeScript tests can drive it.
// POS: Declaration only; the launcher itself stays JavaScript because Node does not strip types under node_modules.
export type LauncherDeps = Readonly<{
  argv: readonly string[];
  home: string;
  tmpdir: string;
  packageRoot: string;
  execPath: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  out: (text: string) => void;
  err: (text: string) => void;
  run?: (command: string, args: readonly string[]) => Promise<number>;
}>;

export function runLauncher(deps: LauncherDeps): Promise<number>;
export function nodeSupported(version: string): boolean;
export function spawnInherit(command: string, args: readonly string[]): Promise<number>;
