// INPUT: Unknown explicit App hook wrapper from the fixed native client.
// OUTPUT: Frozen exact wrapper retaining the original hook for lifecycle validation.
// POS: App-only transport shape boundary; no identity or lifecycle authority.
export type AppHook = Readonly<{ profile: 'app-code'; hook: unknown;
  startup: null | Readonly<{ socketPath: string | null }> }>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_APP_HOOK');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_APP_HOOK');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
    || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw new Error('INVALID_APP_HOOK');
  return value as Record<string, unknown>;
}

function exact(raw: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(raw).length !== keys.length || !keys.every(key => Object.hasOwn(raw, key))) {
    throw new Error('INVALID_APP_HOOK');
  }
}

export function parseAppHook(value: unknown): AppHook {
  const raw = object(value); exact(raw, ['profile', 'hook', 'startup']);
  if (raw.profile !== 'app-code') throw new Error('INVALID_APP_HOOK');
  const hook = object(raw.hook);
  if (hook.hook_event_name === 'SessionStart') {
    const startup = object(raw.startup); exact(startup, ['socketPath']);
    if (startup.socketPath !== null && typeof startup.socketPath !== 'string') throw new Error('INVALID_APP_HOOK');
    return Object.freeze({ profile: 'app-code', hook: raw.hook,
      startup: Object.freeze({ socketPath: startup.socketPath as string | null }) });
  }
  if (!['SessionEnd', 'PreToolUse', 'PostToolUse'].includes(hook.hook_event_name as string)
    || raw.startup !== null) throw new Error('INVALID_APP_HOOK');
  return Object.freeze({ profile: 'app-code', hook: raw.hook, startup: null });
}
