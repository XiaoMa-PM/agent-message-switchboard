// INPUT: LaunchAgent label/program paths and an injectable launchctl runner.
// OUTPUT: renderPlist (escaped XML), systemLaunchctl, serviceState, bootstrapService, bootoutService (confirms absence via print on non-zero) and kickstartService.
// POS: The only place ms talks to launchd; tests always inject a fake runner.
import { spawn } from 'node:child_process';
import { CliError } from './errors.ts';

export type LaunchctlResult = Readonly<{ code: number; stdout: string }>;
export type Launchctl = (args: readonly string[]) => Promise<LaunchctlResult>;
export type ServiceState = Readonly<{ loaded: boolean; state: string | null; pid: number | null }>;
export type PlistSpec = Readonly<{
  label: string; program: readonly string[]; workingDirectory: string; stdoutPath: string; stderrPath: string;
}>;

const NOT_FOUND = 113;

function xml(text: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new CliError('INSTALL_PRECONDITION_FAILED', 'path not XML-safe');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderPlist(spec: PlistSpec): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(spec.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...spec.program.map(arg => `    <string>${xml(arg)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(spec.workingDirectory)}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ProcessType</key><string>Background</string>',
    '  <key>Umask</key><integer>63</integer>',
    `  <key>StandardOutPath</key><string>${xml(spec.stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(spec.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function systemLaunchctl(): Launchctl {
  return args => new Promise((resolve, reject) => {
    const child = spawn('/bin/launchctl', [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout }));
  });
}

export async function serviceState(launchctl: Launchctl, domain: string, label: string): Promise<ServiceState> {
  const result = await launchctl(['print', `${domain}/${label}`]);
  if (result.code === NOT_FOUND) return Object.freeze({ loaded: false, state: null, pid: null });
  if (result.code !== 0) throw new CliError('LAUNCHD_FAILED', `print exit ${result.code}`);
  const state = result.stdout.match(/^\s*state = (\S+)/m)?.[1] ?? null;
  const pid = result.stdout.match(/^\s*pid = (\d+)/m)?.[1];
  return Object.freeze({ loaded: true, state, pid: pid === undefined ? null : Number(pid) });
}

export async function bootstrapService(launchctl: Launchctl, domain: string, plistPath: string): Promise<void> {
  const result = await launchctl(['bootstrap', domain, plistPath]);
  if (result.code !== 0) throw new CliError('LAUNCHD_FAILED', `bootstrap exit ${result.code}`);
}

export async function bootoutService(launchctl: Launchctl, domain: string, label: string): Promise<void> {
  const result = await launchctl(['bootout', `${domain}/${label}`]);
  if (result.code === 0) return;
  if ((await serviceState(launchctl, domain, label)).loaded) throw new CliError('LAUNCHD_FAILED', `bootout exit ${result.code}`);
}

export async function kickstartService(launchctl: Launchctl, domain: string, label: string): Promise<boolean> {
  const result = await launchctl(['kickstart', '-k', `${domain}/${label}`]);
  if (result.code === NOT_FOUND) return false;
  if (result.code !== 0) throw new CliError('LAUNCHD_FAILED', `kickstart exit ${result.code}`);
  return true;
}
