# INPUT: Pinned isolated entry, explicit App/daily argv, private config and native hook/owned stdio.
# OUTPUT: Fixed-namespace dispatch: App (fail block), daily (fail open), --daily-act (fail closed) and --daily-turn clients.
# POS: Private bootstrap; caller must establish trusted config origin and owned pipes.
import sys
sys.dont_write_bytecode = True

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import threading
from types import MappingProxyType, ModuleType

NATIVE_MODULES = ('macos_identity', 'ipc_frame', 'broker_identity',
                  'inspect_control', 'broker_server', 'hook_client')
NAMESPACE = 'ms_native_runtime'
MAX_BYTES = 1048576
DAILY_COMMANDS = ('/ms:register', '/ms:unregister',
                  '/ms-register', '/ms-unregister')
DAILY_AUTO_COMMANDS = ('/ms:auto', '/ms-auto')
DAILY_REPLY_COMMANDS = ('/ms:reply', '/ms-reply')
# Letters msd may answer with the reply mode: an exact prefix, never trimmed, since Claude hands the hook the letter as delivered.
LETTER_PREFIXES = ('来源：DSH | Agent Message Switchboard', '来源：Codex | Agent Message Switchboard')
# The characters JavaScript's String.prototype.trim and /\s/ treat as whitespace, so this filter decides exactly as msd does.
JS_WHITESPACE = ('\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a'
                 '\u2028\u2029\u202f\u205f\u3000\ufeff')
REPIN_CODES = ('RUNTIME_PIN_MISMATCH', 'UNSUPPORTED_RUNTIME')
DAILY_SKILL = 'ms:message'
# Same text as protocol/act-text.ts ACT_TURN_NOTE and actUnavailableReason.
ACT_TURN_NOTE = '本轮含同伴来信，按来信把关；如果是你自己的要求，请在本轮结束后再发一次。'
# The act client's whole exchange with msd; the plugin's act hook timeout (30 s) is well above it, so the client denies first.
ACT_TIMEOUT_SECONDS = 10
# The turn client's whole exchange with msd; its answer is never shown and nothing waits on it (fail open).
TURN_TIMEOUT_SECONDS = 5
TURN_EVENTS = ('Stop', 'StopFailure')
CLIENT_ROLES = ('client', 'app-client', 'daily-client')


@dataclass(frozen=True)
class Config:
    role: str
    codeRoot: str
    python: object
    codePins: tuple
    socketPath: str
    broker: object = None
    parent: object = None


def _canonical(path: str):
    if type(path) is not str or not os.path.isabs(path):
        raise ValueError('UNTRUSTED_RUNTIME_FILE')
    if os.path.realpath(path) != path:
        raise ValueError('UNTRUSTED_RUNTIME_FILE')
    return os.lstat(path)


def _ancestors(path: str) -> tuple:
    rows = []
    directory = os.path.dirname(path)
    while True:
        info = _canonical(directory)
        if (not stat.S_ISDIR(info.st_mode)
                or info.st_uid not in (0, os.getuid())
                or (info.st_mode & 0o020 and info.st_gid not in (0, 80))
                or (info.st_mode & 0o002 and not info.st_mode & stat.S_ISVTX)):
            raise ValueError('UNTRUSTED_RUNTIME_FILE')
        rows.append((directory, info.st_dev, info.st_ino, info.st_mode,
                     info.st_uid, info.st_gid))
        parent = os.path.dirname(directory)
        if parent == directory:
            return tuple(rows)
        directory = parent


def _private(path: str) -> None:
    info = _canonical(path)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError('UNTRUSTED_RUNTIME_FILE')


def _signature(info) -> tuple:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _read(path: str, private: bool) -> bytes:
    chain = _ancestors(path)
    before = _canonical(path)
    if (not stat.S_ISREG(before.st_mode)
            or before.st_uid not in ((os.getuid(),) if private
                                     else (0, os.getuid()))
            or before.st_mode & 0o022
            or (private and stat.S_IMODE(before.st_mode) != 0o600)):
        raise ValueError('UNTRUSTED_RUNTIME_FILE')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if _signature(os.fstat(descriptor)) != _signature(before):
            raise ValueError('UNTRUSTED_RUNTIME_FILE')
        chunks = []
        while chunk := os.read(descriptor, 65536):
            chunks.append(chunk)
        if (_signature(os.fstat(descriptor)) != _signature(before)
                or _signature(_canonical(path)) != _signature(before)
                or _ancestors(path) != chain):
            raise ValueError('UNTRUSTED_RUNTIME_FILE')
        return b''.join(chunks)
    finally:
        os.close(descriptor)


def _pin(raw: object):
    if (type(raw) is not dict or set(raw) != {'path', 'sha256'}
            or type(raw['path']) is not str or not os.path.isabs(raw['path'])
            or type(raw['sha256']) is not str
            or re.fullmatch(r'[a-f0-9]{64}', raw['sha256']) is None):
        raise ValueError('INVALID_RUNTIME_CONFIG')
    return MappingProxyType(dict(raw))


def _dto(raw: object):
    fields = {'pid', 'parentPid', 'uid', 'pidVersion', 'uniqueId',
              'parentUniqueId', 'exe', 'sha256'}
    if type(raw) is not dict or set(raw) != fields:
        raise ValueError('INVALID_RUNTIME_CONFIG')
    for field, minimum, maximum in [('pid', 2, 0x7fffffff),
                                    ('parentPid', 1, 0x7fffffff),
                                    ('uid', 0, 0xfffffffe),
                                    ('pidVersion', 0, 0xffffffff)]:
        if type(raw[field]) is not int or not minimum <= raw[field] <= maximum:
            raise ValueError('INVALID_RUNTIME_CONFIG')
    for field in ['uniqueId', 'parentUniqueId']:
        value = raw[field]
        if (type(value) is not str or re.fullmatch(r'[1-9][0-9]{0,19}', value) is None
                or int(value) > 0xffffffffffffffff):
            raise ValueError('INVALID_RUNTIME_CONFIG')
    _pin({'path': raw['exe'], 'sha256': raw['sha256']})
    return MappingProxyType(dict(raw))


def _config(raw: object, entry_path: str) -> Config:
    base = {'schemaVersion', 'role', 'codeRoot', 'python', 'codePins', 'socketPath'}
    if type(raw) is not dict:
        raise ValueError('INVALID_RUNTIME_CONFIG')
    role = raw.get('role')
    if (role not in ('broker', *CLIENT_ROLES) or type(raw.get('schemaVersion')) is not int
            or raw['schemaVersion'] != 1
            or set(raw) != (base | {'broker', 'parent'} if role in CLIENT_ROLES else base)):
        raise ValueError('INVALID_RUNTIME_CONFIG')
    for field in ['codeRoot', 'socketPath']:
        if type(raw[field]) is not str or not os.path.isabs(raw[field]):
            raise ValueError('INVALID_RUNTIME_CONFIG')
    if type(raw['codePins']) is not list:
        raise ValueError('INVALID_RUNTIME_CONFIG')
    pins = tuple(_pin(pin) for pin in raw['codePins'])
    paths = [pin['path'] for pin in pins]
    expected = {str(Path(raw['codeRoot']) / (name + '.py'))
                for name in (*NATIVE_MODULES, 'runtime_entry')}
    if (len(paths) != len(expected) or set(paths) != expected
            or entry_path != str(Path(raw['codeRoot']) / 'runtime_entry.py')):
        raise ValueError('INVALID_RUNTIME_CONFIG')
    return Config(role, raw['codeRoot'], _pin(raw['python']), pins,
                  raw['socketPath'], _dto(raw['broker']) if role in CLIENT_ROLES else None,
                  _dto(raw['parent']) if role in CLIENT_ROLES else None)


def readRuntimeConfig(config_path: str, entry_path: str) -> Config:
    _private(os.path.dirname(config_path))
    data = _read(config_path, True)
    if len(data) > MAX_BYTES:
        raise ValueError('INVALID_RUNTIME_CONFIG')
    try:
        raw = json.loads(data.decode('utf-8'))
    except (ValueError, UnicodeError):
        raise ValueError('INVALID_RUNTIME_CONFIG') from None
    config = _config(raw, entry_path)
    _private(config.codeRoot)
    _private(os.path.dirname(config.socketPath))
    expected = str(Path(config.codeRoot) / 'broker-config.json')
    if ((config.role == 'broker' and config_path != expected)
            or (config.role in CLIENT_ROLES and Path(config_path).parent
                != Path(config.codeRoot).parent)):
        raise ValueError('INVALID_RUNTIME_CONFIG')
    return config


def _captured(config: Config) -> dict[str, bytes]:
    _private(config.codeRoot)
    expected = {Path(pin['path']).name for pin in config.codePins}
    if set(os.listdir(config.codeRoot)) != expected | {'broker-config.json'}:
        raise ValueError('UNTRUSTED_RUNTIME_BUNDLE')
    _read(str(Path(config.codeRoot) / 'broker-config.json'), True)
    captured = {}
    for pin in (*config.codePins, config.python):
        data = _read(pin['path'], pin is not config.python)
        if hashlib.sha256(data).hexdigest() != pin['sha256']:
            raise ValueError('RUNTIME_PIN_MISMATCH')
        if pin is not config.python:
            captured[Path(pin['path']).stem] = data
    return captured


def loadPinnedModules(config: Config, entry_path: str) -> dict:
    if (sys.platform != 'darwin' or tuple(sys.version_info[:3]) < (3, 13, 14)
            or sys.executable != config.python['path']):
        raise ValueError('UNSUPPORTED_RUNTIME')
    captured = _captured(config)
    if NAMESPACE in sys.modules:
        raise ValueError('UNTRUSTED_RUNTIME_BUNDLE')
    package = ModuleType(NAMESPACE)
    package.__path__ = []
    sys.modules[NAMESPACE] = package
    loaded = {}
    try:
        for name in NATIVE_MODULES:
            module = ModuleType(NAMESPACE + '.' + name)
            module.__package__ = NAMESPACE
            module.__file__ = str(Path(config.codeRoot) / (name + '.py'))
            sys.modules[module.__name__] = module
            exec(compile(captured[name], module.__file__, 'exec'), module.__dict__)
            loaded[name] = module
        return loaded
    except Exception:
        for name in list(sys.modules):
            if name == NAMESPACE or name.startswith(NAMESPACE + '.'):
                del sys.modules[name]
        raise ValueError('RUNTIME_LOAD_FAILED') from None


def runBrokerRole(config: Config, modules: dict, stdin, stdout) -> None:
    identity = modules['macos_identity']
    inspector = identity.MacIdentityInspector()
    stop = threading.Event()
    previous = {number: signal.getsignal(number)
                for number in (signal.SIGTERM, signal.SIGINT)}
    for number in previous:
        signal.signal(number, lambda *_: stop.set())
    try:
        modules['broker_server'].serveBroker(config.socketPath, stdin, stdout,
            inspector.read, identity.auditPeer, stop, inspector.read_signed)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def _matches(current: dict, expected) -> bool:
    return (set(current) == set(expected)
            and all(type(current[key]) is type(expected[key])
                    and current[key] == expected[key] for key in current))


def runClientRole(config: Config, modules: dict, stdin, stdout) -> None:
    identity, hook = modules['macos_identity'], modules['hook_client']
    inspector = identity.MacIdentityInspector()
    broker = inspector.read(config.broker['pid'])
    parent = inspector.read(config.parent['pid'])
    if not _matches(broker.to_json(), config.broker) or not _matches(parent.to_json(), config.parent):
        raise ValueError('BROKER_IDENTITY_UNVERIFIED')
    raw = stdin.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('IPC_FRAME_TOO_LARGE')
    try:
        value = json.loads(raw.decode('utf-8'))
        event = value['hook_event_name']
    except (ValueError, UnicodeError, TypeError, KeyError):
        raise ValueError('INVALID_HOOK_EVENT') from None
    payload = value
    if config.role == 'app-client':
        startup: dict[str, str | None] | None = None
        if event == 'SessionStart':
            startup = {'socketPath': os.environ.get('CLAUDE_CODE_MESSAGING_SOCKET')}
        payload = {'profile': 'app-code', 'hook': value, 'startup': startup}
    result = hook.exchangeHook(config.socketPath, broker, parent, payload,
                              inspector.read, identity.auditPeer)
    stdout.write(hook.renderHookResult(event, result))
    stdout.flush()


def _daily_command(prompt: str, names: tuple) -> bool:
    # Mirrors dailyCommandInput: the whole trimmed prompt is the command, then nothing or whitespace and its argument text.
    text = prompt.strip(JS_WHITESPACE)
    return any(text == name or (text.startswith(name) and text[len(name)] in JS_WHITESPACE) for name in names)


def _daily_auto(prompt: str) -> bool:
    return _daily_command(prompt, DAILY_AUTO_COMMANDS)


def _daily_reply(prompt: str) -> bool:
    return _daily_command(prompt, DAILY_REPLY_COMMANDS)


def _daily_forwarded(value: dict) -> bool:
    event = value.get('hook_event_name')
    if event in ('SessionStart', 'SessionEnd'):
        return True
    if event == 'UserPromptSubmit':
        prompt = value.get('prompt')
        return type(prompt) is str and (prompt.strip(JS_WHITESPACE) in DAILY_COMMANDS or _daily_auto(prompt)
                                        or _daily_reply(prompt) or prompt.startswith(LETTER_PREFIXES))
    tool = value.get('tool_input')
    return (event in ('PreToolUse', 'PostToolUse') and value.get('tool_name') == 'Skill'
            and type(tool) is dict and tool.get('skill') == DAILY_SKILL)


def _daily_output(output: dict) -> bytes:
    return json.dumps(output, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def _daily_fallback(value, code: str) -> bytes:
    if type(value) is not dict or not _daily_forwarded(value):
        return _daily_output({})
    event = value['hook_event_name']
    if event == 'UserPromptSubmit':
        # A letter goes on to the model untouched; without msd it simply carries no reply mode (the rules then say confirm).
        if value['prompt'].startswith(LETTER_PREFIXES):
            return _daily_output({})
        hint = ('Python 或运行时与安装记录不一致，请运行 ms repin 后重试。' if code in REPIN_CODES
                else '请确认 msd 正在运行后重试。')
        action = ('本次未切换自动登记。' if _daily_auto(value['prompt'])
                  else '本次未切换回复档位。' if _daily_reply(value['prompt']) else '本次未登记也未撤销。')
        return _daily_output({'decision': 'block', 'reason': 'Switchboard 服务不可用（' + code + '）：' + action + hint})
    if event == 'PostToolUse':
        context = json.dumps({'ok': False, 'error': 'MS_UNAVAILABLE', 'detail': code},
                             separators=(',', ':'))
        return _daily_output({'hookSpecificOutput': {
            'hookEventName': 'PostToolUse', 'additionalContext': context}})
    return _daily_output({})


def _act_unavailable(code: str) -> bytes:
    # The act hook only runs while this session's letter-turn marker exists, so no answer from msd means deny, never allow.
    return _daily_output({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
        'permissionDecisionReason': 'Switchboard 不可用（' + code + '）：暂时拒绝本轮的工具调用。' + ACT_TURN_NOTE}})


def runDailyClientRole(config: Config, modules: dict, value: dict, profile: str = 'daily') -> bytes:
    identity, hook = modules['macos_identity'], modules['hook_client']
    inspector = identity.MacIdentityInspector()
    broker = inspector.read(config.broker['pid'])
    parent = inspector.read(config.parent['pid'])
    if not _matches(broker.to_json(), config.broker) or not _matches(parent.to_json(), config.parent):
        raise ValueError('BROKER_IDENTITY_UNVERIFIED')
    payload = {'profile': profile, 'hook': value,
               'messagingSocket': os.environ.get('CLAUDE_CODE_MESSAGING_SOCKET')}
    limit = ({'timeout': ACT_TIMEOUT_SECONDS} if profile == 'daily-act'
             else {'timeout': TURN_TIMEOUT_SECONDS} if profile == 'daily-turn' else {})
    result = hook.exchangeHook(config.socketPath, broker, parent, payload,
                               inspector.read, identity.auditPeer, daily=True, **limit)
    if profile == 'daily-turn':
        return _daily_output({})
    return hook.renderDailyHookResult(value['hook_event_name'], result)


def runDailyRuntime(config_path, stdin, stdout, stderr, *, entry_path=None,
                    loader=loadPinnedModules, daily_runner=runDailyClientRole, act: bool = False,
                    turn: bool = False) -> int:
    known = {'INVALID_RUNTIME_CONFIG', 'UNTRUSTED_RUNTIME_FILE', 'RUNTIME_PIN_MISMATCH',
             'UNTRUSTED_RUNTIME_BUNDLE', 'UNSUPPORTED_RUNTIME', 'RUNTIME_LOAD_FAILED',
             'BROKER_IDENTITY_UNVERIFIED', 'IPC_FRAME_TOO_LARGE', 'INVALID_HOOK_EVENT',
             'INVALID_IPC_RESPONSE', 'INVALID_HOOK_RESULT', 'UNTRUSTED_HOOK_SOCKET',
             'IPC_REQUEST_FAILED', 'MSD_TIMEOUT'}
    value = None
    try:
        raw = stdin.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError('IPC_FRAME_TOO_LARGE')
        try:
            value = json.loads(raw.decode('utf-8'))
            if type(value) is not dict or type(value.get('hook_event_name')) is not str:
                raise ValueError('INVALID_HOOK_EVENT')
        except (ValueError, UnicodeError):
            raise ValueError('INVALID_HOOK_EVENT') from None
        event = value['hook_event_name']
        forwarded = event == 'PreToolUse' if act else event in TURN_EVENTS if turn else _daily_forwarded(value)
        if not forwarded:
            output = _daily_output({})
        else:
            entry = entry_path if entry_path is not None else os.path.realpath(__file__)
            config = readRuntimeConfig(config_path, entry)
            if config.role != 'daily-client':
                raise ValueError('INVALID_RUNTIME_CONFIG')
            modules = loader(config, entry)
            output = (daily_runner(config, modules, value, 'daily-act') if act
                      else daily_runner(config, modules, value, 'daily-turn') if turn else daily_runner(config, modules, value))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error) in known else (
            'MSD_NOT_RUNNING' if isinstance(error, FileNotFoundError) else 'RUNTIME_FAILED')
        stderr.write(('MS_HOOK_UNAVAILABLE:' + code + '\n').encode())
        stderr.flush()
        output = _act_unavailable(code) if act else _daily_fallback(value, code)
    if turn:
        output = _daily_output({})
    stdout.write(output)
    stdout.flush()
    return 0


def runRuntime(config_path, stdin, stdout, stderr, *, entry_path=None,
               loader=loadPinnedModules, broker_runner=runBrokerRole,
               client_runner=runClientRole, app_client: bool = False) -> int:
    known = {'INVALID_RUNTIME_CONFIG', 'UNTRUSTED_RUNTIME_FILE',
             'RUNTIME_PIN_MISMATCH', 'UNTRUSTED_RUNTIME_BUNDLE',
             'UNSUPPORTED_RUNTIME', 'RUNTIME_LOAD_FAILED',
             'BROKER_IDENTITY_UNVERIFIED', 'IPC_FRAME_TOO_LARGE',
             'INVALID_HOOK_EVENT', 'INVALID_IPC_RESPONSE', 'BROKER_CLEANUP_FAILED'}
    if app_client:
        known = known | {'IPC_REQUEST_FAILED'}
    try:
        entry = entry_path if entry_path is not None else os.path.realpath(__file__)
        config = readRuntimeConfig(config_path, entry)
        if (config.role == 'app-client') != app_client or config.role == 'daily-client':
            raise ValueError('INVALID_RUNTIME_CONFIG')
        modules = loader(config, entry)
        runner = broker_runner if config.role == 'broker' else client_runner
        runner(config, modules, stdin, stdout)
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error) in known else 'RUNTIME_FAILED'
        stderr.write(('MS_HOOK_FAILED:' + code + '\n').encode())
        stderr.flush()
        return 2 if app_client else 1


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == '--daily-client':
        if len(sys.argv) != 3:
            sys.stdout.buffer.write(b'{}')
            return 0
        return runDailyRuntime(sys.argv[2], sys.stdin.buffer, sys.stdout.buffer,
                               sys.stderr.buffer)
    if len(sys.argv) > 1 and sys.argv[1] == '--daily-act':
        if len(sys.argv) != 3:
            sys.stdout.buffer.write(_act_unavailable('INVALID_RUNTIME_CONFIG'))
            return 0
        return runDailyRuntime(sys.argv[2], sys.stdin.buffer, sys.stdout.buffer,
                               sys.stderr.buffer, act=True)
    if len(sys.argv) > 1 and sys.argv[1] == '--daily-turn':
        if len(sys.argv) != 3:
            sys.stdout.buffer.write(b'{}')
            return 0
        return runDailyRuntime(sys.argv[2], sys.stdin.buffer, sys.stdout.buffer,
                               sys.stderr.buffer, turn=True)
    app_client = len(sys.argv) > 1 and sys.argv[1] == '--app-client'
    if (app_client and len(sys.argv) == 3):
        return runRuntime(sys.argv[2], sys.stdin.buffer, sys.stdout.buffer,
                          sys.stderr.buffer, app_client=True)
    if len(sys.argv) != 2 or app_client:
        sys.stderr.buffer.write(b'MS_HOOK_FAILED:INVALID_RUNTIME_CONFIG\n')
        return 2 if app_client else 1
    return runRuntime(sys.argv[1], sys.stdin.buffer, sys.stdout.buffer,
                      sys.stderr.buffer)


if __name__ == '__main__':
    raise SystemExit(main())
