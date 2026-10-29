# INPUT: Private pinned runtime fixtures, synthetic daily hook payloads and injected exchange/inspector seams.
# OUTPUT: Daily-client local filtering (shared prompt contract with msd), auto forwarding, fail-open fallback, role pairing,
#         hook-output allowlist tests, the act client (every PreToolUse forwarded as daily-act, fail-closed deny) and the
#         turn client (Stop and StopFailure forwarded as daily-turn within 5 s, always {} back).
# POS: Offline native fixtures; no live broker, kernel identity, Claude or model.
import dataclasses
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[2] / 'src/bridge/native'
PROMPTS = json.loads((Path(__file__).resolve().parents[1] / 'contract/daily-prompts.json').read_text(encoding='utf-8'))
spec = importlib.util.spec_from_file_location('daily_runtime_fixture', SOURCE / 'runtime_entry.py')
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
PACKAGE = 'daily_native_fixture'
package = ModuleType(PACKAGE)
package.__path__ = [str(SOURCE)]
sys.modules[PACKAGE] = package
native = {}
for stem in ['macos_identity', 'ipc_frame', 'broker_identity', 'inspect_control', 'broker_server', 'hook_client']:
    module_spec = importlib.util.spec_from_file_location(PACKAGE + '.' + stem, SOURCE / (stem + '.py'))
    module = importlib.util.module_from_spec(module_spec)
    sys.modules[module_spec.name] = module
    module_spec.loader.exec_module(module)
    native[stem] = module
broker_server, hook_client = native['broker_server'], native['hook_client']

SID = '11111111-1111-4111-8111-111111111111'
POST_CONTEXT = {'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': '{"ok":true}'}}
LETTER_CONTEXT = {'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': 'Switchboard 回复档位：direct'}}
ASK = {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'ask', 'permissionDecisionReason': '审批理由'}}
DENY = {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': '拒绝理由'}}
NOTE = '本轮含同伴来信，按来信把关；如果是你自己的要求，请在本轮结束后再发一次。'


def unavailable(code):
    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                   'permissionDecisionReason': 'Switchboard 不可用（' + code + '）：暂时拒绝本轮的工具调用。' + NOTE}}


def hook(event, **extra):
    return {'hook_event_name': event, 'session_id': SID, 'cwd': '/w', 'transcript_path': '/t', **extra}


def skill(event, name='ms:message'):
    return hook(event, tool_name='Skill', tool_use_id='t1', tool_input={'skill': name, 'args': '{}'},
                **({'tool_response': {'success': True}} if event == 'PostToolUse' else {}))


def run_daily(config_path, value, **kwargs):
    stdout, stderr = io.BytesIO(), io.BytesIO()
    raw = value if isinstance(value, bytes) else json.dumps(value).encode()
    code = runtime.runDailyRuntime(config_path, io.BytesIO(raw), stdout, stderr, **kwargs)
    return code, json.loads(stdout.getvalue()), stderr.getvalue()


class DailyClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix='ms-daily-', dir=Path('/tmp').resolve())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.code = self.root / 'native'
        self.code.mkdir(mode=0o700)
        (self.root / 'broker').mkdir(mode=0o700)
        python = self.root / 'python'
        python.write_bytes(b'synthetic interpreter')
        python.chmod(0o755)
        pins = []
        for name in (*runtime.NATIVE_MODULES, 'runtime_entry'):
            target = self.code / (name + '.py')
            target.write_bytes((SOURCE / target.name).read_bytes())
            target.chmod(0o600)
            pins.append({'path': str(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        self.entry = str(self.code / 'runtime_entry.py')
        broker = {'schemaVersion': 1, 'role': 'broker', 'codeRoot': str(self.code),
                  'python': {'path': str(python), 'sha256': hashlib.sha256(python.read_bytes()).hexdigest()},
                  'codePins': pins, 'socketPath': str(self.root / 'broker' / 'broker.sock')}
        (self.code / 'broker-config.json').write_text(json.dumps(broker))
        (self.code / 'broker-config.json').chmod(0o600)
        identity = {'uid': os.getuid(), 'exe': str(python), 'sha256': 'b' * 64}
        self.raw = {**broker, 'role': 'daily-client',
                    'broker': {'pid': 73, 'parentPid': 41, 'pidVersion': 11, 'uniqueId': '730',
                               'parentUniqueId': '410', **identity},
                    'parent': {'pid': 41, 'parentPid': 1, 'pidVersion': 10, 'uniqueId': '410',
                               'parentUniqueId': '1', **identity}}
        self.path = self.root / 'claude-client.json'
        self.write()

    def write(self) -> None:
        self.path.write_text(json.dumps(self.raw))
        self.path.chmod(0o600)

    def test_unrelated_prompts_and_skills_pass_locally_without_reading_config(self) -> None:
        missing = str(self.root / 'absent.json')
        for value in [hook('UserPromptSubmit', prompt='hello /ms-register'), skill('PreToolUse', 'other:skill'),
                      hook('PostToolUse', tool_name='Bash', tool_input={'command': 'ls'}), hook('Notification')]:
            code, output, errors = run_daily(missing, value,
                loader=lambda *_: self.fail('must not load'), daily_runner=lambda *_: self.fail('must not run'))
            self.assertEqual((code, output, errors), (0, {}, b''))

    def test_unavailable_daemon_fails_open_with_user_or_model_visible_notice(self) -> None:
        missing = str(self.root / 'absent.json')
        code, output, errors = run_daily(missing, hook('UserPromptSubmit', prompt=' /ms-register '))
        self.assertEqual(code, 0)
        self.assertEqual(output['decision'], 'block')
        self.assertIn('Switchboard 服务不可用（MSD_NOT_RUNNING）', output['reason'])
        self.assertEqual(errors, b'MS_HOOK_UNAVAILABLE:MSD_NOT_RUNNING\n')
        code, output, _ = run_daily(missing, skill('PostToolUse'))
        context = json.loads(output['hookSpecificOutput']['additionalContext'])
        self.assertEqual((code, context['error']), (0, 'MS_UNAVAILABLE'))
        for value in [hook('SessionStart', source='startup'), hook('SessionEnd', reason='exit'), skill('PreToolUse')]:
            self.assertEqual(run_daily(missing, value)[:2], (0, {}))
        self.assertEqual(run_daily(missing, b'not json')[:2], (0, {}))
        self.assertEqual(run_daily(missing, b'x' * (runtime.MAX_BYTES + 1))[:2], (0, {}))

    def test_forwarding_matches_the_shared_msd_prompt_contract(self) -> None:
        for prompt in PROMPTS['intercepted']:
            self.assertTrue(runtime._daily_forwarded(hook('UserPromptSubmit', prompt=prompt)), repr(prompt))
        for prompt in PROMPTS['passed']:
            self.assertFalse(runtime._daily_forwarded(hook('UserPromptSubmit', prompt=prompt)), repr(prompt))
        for prompt in PROMPTS['letters']:
            self.assertTrue(runtime._daily_forwarded(hook('UserPromptSubmit', prompt=prompt)), repr(prompt))

    def test_letters_reach_the_daily_runner_and_render_its_reply_mode_context(self) -> None:
        for prompt in PROMPTS['letters']:
            seen = []
            def runner(config, modules, value):
                seen.append(value['prompt'])
                return hook_client.renderDailyHookResult(value['hook_event_name'], {'hookOutput': LETTER_CONTEXT})
            code, output, errors = run_daily(str(self.path), hook('UserPromptSubmit', prompt=prompt),
                entry_path=self.entry, loader=lambda *_: {}, daily_runner=runner)
            self.assertEqual((code, output, errors, seen), (0, LETTER_CONTEXT, b'', [prompt]))

    def test_unavailable_daemon_passes_letters_untouched_and_keeps_the_reply_mode_unswitched(self) -> None:
        missing = str(self.root / 'absent.json')
        for prompt in PROMPTS['letters']:
            code, output, errors = run_daily(missing, hook('UserPromptSubmit', prompt=prompt))
            self.assertEqual((code, output, errors), (0, {}, b'MS_HOOK_UNAVAILABLE:MSD_NOT_RUNNING\n'), repr(prompt))
        _, output, _ = run_daily(missing, hook('UserPromptSubmit', prompt='/ms:reply confirm'))
        self.assertEqual(output, {'decision': 'block',
                                  'reason': 'Switchboard 服务不可用（MSD_NOT_RUNNING）：本次未切换回复档位。请确认 msd 正在运行后重试。'})

    def test_auto_prompts_reach_the_daily_runner_and_render_its_block(self) -> None:
        reason = 'Switchboard 自动登记（claude-code）：关，范围为所有项目。本提示未发送给模型。'
        for prompt in ['/ms:auto', '/ms:auto status', '/ms:auto  on', '/ms-auto off']:
            seen = []
            def runner(config, modules, value):
                seen.append(value['prompt'])
                return hook_client.renderDailyHookResult(value['hook_event_name'],
                    {'hookOutput': {'decision': 'block', 'reason': reason}})
            code, output, errors = run_daily(str(self.path), hook('UserPromptSubmit', prompt=prompt),
                entry_path=self.entry, loader=lambda *_: {}, daily_runner=runner)
            self.assertEqual((code, output, errors, seen), (0, {'decision': 'block', 'reason': reason}, b'', [prompt]))
        for prompt in ['/ms:autox', 'hello /ms:auto']:
            code, output, _ = run_daily(str(self.path), hook('UserPromptSubmit', prompt=prompt),
                loader=lambda *_: self.fail('must not load'), daily_runner=lambda *_: self.fail('must not run'))
            self.assertEqual((code, output), (0, {}))

    def test_unavailable_daemon_blocks_auto_with_a_not_switched_notice(self) -> None:
        missing = str(self.root / 'absent.json')
        code, output, _ = run_daily(missing, hook('UserPromptSubmit', prompt='/ms:auto on'))
        self.assertEqual((code, output['decision']), (0, 'block'))
        self.assertEqual(output['reason'], 'Switchboard 服务不可用（MSD_NOT_RUNNING）：本次未切换自动登记。请确认 msd 正在运行后重试。')
        _, output, _ = run_daily(missing, hook('UserPromptSubmit', prompt='/ms:register'))
        self.assertEqual(output['reason'], 'Switchboard 服务不可用（MSD_NOT_RUNNING）：本次未登记也未撤销。请确认 msd 正在运行后重试。')

    def test_pin_mismatch_fallback_asks_for_repin(self) -> None:
        def mismatch(*_):
            raise ValueError('RUNTIME_PIN_MISMATCH')
        code, output, _ = run_daily(str(self.path), hook('UserPromptSubmit', prompt='/ms:register'),
            entry_path=self.entry, loader=mismatch)
        self.assertEqual(code, 0)
        self.assertIn('RUNTIME_PIN_MISMATCH', output['reason'])
        self.assertIn('ms repin', output['reason'])
        _, output, _ = run_daily(str(self.root / 'absent.json'), hook('UserPromptSubmit', prompt='/ms-register'))
        self.assertNotIn('repin', output['reason'])

    def test_runner_failures_never_leak_detail_and_still_exit_zero(self) -> None:
        def failed(*_):
            raise OSError('private body /Users/someone/secret')
        code, output, errors = run_daily(str(self.path), hook('UserPromptSubmit', prompt='/ms-unregister'),
            entry_path=self.entry, loader=lambda *_: {}, daily_runner=failed)
        self.assertEqual(code, 0)
        self.assertIn('RUNTIME_FAILED', output['reason'])
        self.assertNotIn(b'secret', errors)

    def test_daily_role_is_paired_with_the_daily_entry_only(self) -> None:
        self.assertEqual(runtime.readRuntimeConfig(str(self.path), self.entry).role, 'daily-client')
        calls = []
        code, output, _ = run_daily(str(self.path), hook('SessionStart', source='startup'), entry_path=self.entry,
            loader=lambda *_: {}, daily_runner=lambda config, modules, value: calls.append(value) or b'{}')
        self.assertEqual((code, output, len(calls)), (0, {}, 1))
        self.assertEqual(runtime.runRuntime(str(self.path), io.BytesIO(), io.BytesIO(), io.BytesIO(),
            entry_path=self.entry, loader=lambda *_: {}, client_runner=lambda *_: None), 1)
        self.raw['role'] = 'client'
        self.write()
        code, output, errors = run_daily(str(self.path), hook('UserPromptSubmit', prompt='/ms-register'),
            entry_path=self.entry, loader=lambda *_: {}, daily_runner=lambda *_: self.fail('must not run'))
        self.assertEqual(code, 0)
        self.assertIn('INVALID_RUNTIME_CONFIG', output['reason'])

    def test_daily_runner_wraps_hook_with_messaging_socket_and_renders_allowed_output(self) -> None:
        config = runtime.readRuntimeConfig(str(self.path), self.entry)
        identity = SimpleNamespace(MacIdentityInspector=lambda: SimpleNamespace(read=lambda pid: SimpleNamespace(
            to_json=lambda: dict(config.broker if pid == 73 else config.parent))), auditPeer=object())
        seen = []
        def exchange(path, broker, parent, payload, inspect, audit, daily=False):
            seen.append((payload, daily))
            return {'hookOutput': {'decision': 'block', 'reason': '已登记'}}
        modules = {'macos_identity': identity,
                   'hook_client': SimpleNamespace(exchangeHook=exchange, renderDailyHookResult=hook_client.renderDailyHookResult)}
        value = hook('UserPromptSubmit', prompt='/ms-register')
        with patch.dict(os.environ, {'CLAUDE_CODE_MESSAGING_SOCKET': '/tmp/claude.sock'}, clear=True):
            output = runtime.runDailyClientRole(config, modules, value)
        self.assertEqual(json.loads(output), {'decision': 'block', 'reason': '已登记'})
        self.assertEqual(seen, [({'profile': 'daily', 'hook': value, 'messagingSocket': '/tmp/claude.sock'}, True)])
        with patch.dict(os.environ, {}, clear=True):
            runtime.runDailyClientRole(config, modules, value)
        self.assertIsNone(seen[-1][0]['messagingSocket'])
        wrong = dict(config.broker, pidVersion=99)
        modules['macos_identity'] = SimpleNamespace(MacIdentityInspector=lambda: SimpleNamespace(
            read=lambda pid: SimpleNamespace(to_json=lambda: wrong)), auditPeer=object())
        with self.assertRaisesRegex(ValueError, '^BROKER_IDENTITY_UNVERIFIED$'):
            runtime.runDailyClientRole(config, modules, value)

    def test_act_client_forwards_every_pre_tool_use_as_daily_act_and_renders_its_decision(self) -> None:
        seen = []
        def runner(config, modules, value, profile='daily'):
            seen.append((value['tool_name'], profile))
            return hook_client.renderDailyHookResult(value['hook_event_name'], {'hookOutput': ASK})
        value = hook('PreToolUse', tool_name='Bash', tool_use_id='t1', tool_input={'command': 'npm test'})
        code, output, errors = run_daily(str(self.path), value, act=True, entry_path=self.entry, loader=lambda *_: {},
                                         daily_runner=runner)
        self.assertEqual((code, output, errors, seen), (0, ASK, b'', [('Bash', 'daily-act')]))
        for other in [hook('Stop'), hook('UserPromptSubmit', prompt='hi'), skill('PostToolUse')]:
            self.assertEqual(run_daily(str(self.path), other, act=True, loader=lambda *_: self.fail('must not load'),
                                       daily_runner=lambda *_: self.fail('must not run'))[:2], (0, {}))

    def test_act_client_denies_whenever_it_cannot_get_an_answer(self) -> None:
        missing = str(self.root / 'absent.json')
        value = hook('PreToolUse', tool_name='Read', tool_use_id='t1', tool_input={'file_path': '/w/a.ts'})
        self.assertEqual(run_daily(missing, value, act=True), (0, unavailable('MSD_NOT_RUNNING'),
                                                                b'MS_HOOK_UNAVAILABLE:MSD_NOT_RUNNING\n'))
        self.assertEqual(run_daily(missing, b'not json', act=True)[:2], (0, unavailable('INVALID_HOOK_EVENT')))
        def failed(*_):
            raise OSError('private /Users/someone/secret')
        code, output, errors = run_daily(str(self.path), value, act=True, entry_path=self.entry, loader=lambda *_: {},
                                         daily_runner=failed)
        self.assertEqual((code, output), (0, unavailable('RUNTIME_FAILED')))
        self.assertNotIn(b'secret', errors)
        self.assertEqual(run_daily(str(self.path), value, act=True, entry_path=self.entry, loader=lambda *_: {},
                                   daily_runner=lambda *_: hook_client.renderDailyHookResult('PreToolUse', {'hookOutput': {
                                       'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'allow'}}}))[:2],
                         (0, unavailable('INVALID_HOOK_RESULT')))

    def test_act_client_denies_within_its_time_limit_when_the_broker_never_answers(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix='ha-', dir='/tmp')
        self.addCleanup(temp.cleanup)
        path = Path(temp.name).resolve() / 's'
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path)); path.chmod(0o600); listener.listen(1)
        release = threading.Event()
        def silent():
            connection, _ = listener.accept()
            with connection:
                while connection.recv(65536):
                    pass
                release.wait(5)
        thread = threading.Thread(target=silent, daemon=True)
        thread.start()
        self.addCleanup(lambda: (release.set(), thread.join(3), listener.close()))
        macos = native['macos_identity']
        uid = os.getuid()
        broker = macos.ProcessSnapshot(73, 41, uid, 11, '730', '410', self.raw['broker']['exe'], 'b' * 64, '101', '0')
        parent = macos.ProcessSnapshot(41, 1, uid, 10, '410', '1', self.raw['parent']['exe'], 'b' * 64, '100', '0')
        rows = {73: broker, 41: parent}
        identity = SimpleNamespace(MacIdentityInspector=lambda: SimpleNamespace(read=rows.__getitem__),
                                   auditPeer=lambda _connection: macos.KernelPeer(73, uid, 11))
        modules = {'macos_identity': identity, 'hook_client': hook_client}
        def runner(config, _modules, value, profile='daily'):
            return runtime.runDailyClientRole(dataclasses.replace(config, socketPath=str(path)), modules, value, profile)
        value = hook('PreToolUse', tool_name='Bash', tool_use_id='t1', tool_input={'command': 'npm test'})
        started = time.monotonic()
        with patch.object(runtime, 'ACT_TIMEOUT_SECONDS', 0.3):
            code, output, errors = run_daily(str(self.path), value, act=True, entry_path=self.entry,
                                             loader=lambda *_: {}, daily_runner=runner)
        self.assertLess(time.monotonic() - started, 2.5)
        self.assertEqual((code, output, errors), (0, unavailable('MSD_TIMEOUT'), b'MS_HOOK_UNAVAILABLE:MSD_TIMEOUT\n'))
        self.assertEqual(runtime.ACT_TIMEOUT_SECONDS, 10)

    def test_act_role_wraps_the_hook_as_daily_act(self) -> None:
        config = runtime.readRuntimeConfig(str(self.path), self.entry)
        identity = SimpleNamespace(MacIdentityInspector=lambda: SimpleNamespace(read=lambda pid: SimpleNamespace(
            to_json=lambda: dict(config.broker if pid == 73 else config.parent))), auditPeer=object())
        seen = []
        def exchange(path, broker, parent, payload, inspect, audit, daily=False, timeout=None):
            seen.append(payload)
            limits.append(timeout)
            return {'hookOutput': DENY}
        limits = []
        modules = {'macos_identity': identity,
                   'hook_client': SimpleNamespace(exchangeHook=exchange, renderDailyHookResult=hook_client.renderDailyHookResult)}
        value = hook('PreToolUse', tool_name='Bash', tool_use_id='t1', tool_input={'command': 'git push'})
        with patch.dict(os.environ, {'CLAUDE_CODE_MESSAGING_SOCKET': '/tmp/claude.sock'}, clear=True):
            output = runtime.runDailyClientRole(config, modules, value, 'daily-act')
        self.assertEqual(json.loads(output), DENY)
        self.assertEqual(seen, [{'profile': 'daily-act', 'hook': value, 'messagingSocket': '/tmp/claude.sock'}])
        self.assertEqual(limits, [runtime.ACT_TIMEOUT_SECONDS])

    def test_turn_client_forwards_only_stop_and_stop_failure_as_daily_turn_and_always_prints_empty(self) -> None:
        seen = []
        def runner(config, modules, value, profile='daily'):
            seen.append((value['hook_event_name'], profile))
            return b'{"decision":"block","reason":"never shown"}'
        for event in ('Stop', 'StopFailure'):
            value = hook(event, prompt_id='p1')
            self.assertEqual(run_daily(str(self.path), value, turn=True, entry_path=self.entry, loader=lambda *_: {},
                                       daily_runner=runner), (0, {}, b''))
        self.assertEqual(seen, [('Stop', 'daily-turn'), ('StopFailure', 'daily-turn')])
        for other in [hook('Notification', notification_type='idle_prompt'), hook('UserPromptSubmit', prompt='hi'),
                      hook('PreToolUse', tool_name='Bash', tool_use_id='t1', tool_input={}), hook('SessionEnd'), skill('PostToolUse')]:
            self.assertEqual(run_daily(str(self.path), other, turn=True, loader=lambda *_: self.fail('must not load'),
                                       daily_runner=lambda *_: self.fail('must not run'))[:2], (0, {}))

    def test_turn_client_fails_open_with_empty_output(self) -> None:
        missing = str(self.root / 'absent.json')
        self.assertEqual(run_daily(missing, hook('Stop'), turn=True), (0, {}, b'MS_HOOK_UNAVAILABLE:MSD_NOT_RUNNING\n'))
        self.assertEqual(run_daily(missing, b'not json', turn=True)[:2], (0, {}))
        def failed(*_):
            raise OSError('private /Users/someone/secret')
        code, output, errors = run_daily(str(self.path), hook('StopFailure'), turn=True, entry_path=self.entry,
                                         loader=lambda *_: {}, daily_runner=failed)
        self.assertEqual((code, output), (0, {}))
        self.assertNotIn(b'secret', errors)

    def test_turn_role_wraps_the_hook_as_daily_turn_within_its_time_limit(self) -> None:
        config = runtime.readRuntimeConfig(str(self.path), self.entry)
        identity = SimpleNamespace(MacIdentityInspector=lambda: SimpleNamespace(read=lambda pid: SimpleNamespace(
            to_json=lambda: dict(config.broker if pid == 73 else config.parent))), auditPeer=object())
        seen = []
        def exchange(path, broker, parent, payload, inspect, audit, daily=False, timeout=None):
            seen.append((payload, daily, timeout))
            return {'hookOutput': {}}
        modules = {'macos_identity': identity,
                   'hook_client': SimpleNamespace(exchangeHook=exchange, renderDailyHookResult=lambda *_: self.fail('not rendered'))}
        value = hook('Stop', prompt_id='p1', background_tasks=[])
        with patch.dict(os.environ, {'CLAUDE_CODE_MESSAGING_SOCKET': '/tmp/claude.sock'}, clear=True):
            output = runtime.runDailyClientRole(config, modules, value, 'daily-turn')
        self.assertEqual(json.loads(output), {})
        self.assertEqual(seen, [({'profile': 'daily-turn', 'hook': value, 'messagingSocket': '/tmp/claude.sock'}, True, 5)])
        self.assertEqual(runtime.TURN_TIMEOUT_SECONDS, 5)

    def test_main_routes_daily_flag_and_bad_argv_fails_open(self) -> None:
        with patch.object(runtime.sys, 'argv', ['entry', '--daily-client', str(self.path)]), \
                patch.object(runtime, 'runDailyRuntime', return_value=0) as run:
            self.assertEqual(runtime.main(), 0)
            run.assert_called_once()
        out = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(runtime.sys, 'argv', ['entry', '--daily-client']), patch.object(runtime.sys, 'stdout', out):
            self.assertEqual(runtime.main(), 0)
        self.assertEqual(out.buffer.getvalue(), b'{}')
        with patch.object(runtime.sys, 'argv', ['entry', '--daily-act', str(self.path)]), \
                patch.object(runtime, 'runDailyRuntime', return_value=0) as run:
            self.assertEqual(runtime.main(), 0)
            self.assertEqual(run.call_args.kwargs, {'act': True})
        out = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(runtime.sys, 'argv', ['entry', '--daily-act']), patch.object(runtime.sys, 'stdout', out):
            self.assertEqual(runtime.main(), 0)
        self.assertEqual(json.loads(out.buffer.getvalue()), unavailable('INVALID_RUNTIME_CONFIG'))
        with patch.object(runtime.sys, 'argv', ['entry', '--daily-turn', str(self.path)]), \
                patch.object(runtime, 'runDailyRuntime', return_value=0) as run:
            self.assertEqual(runtime.main(), 0)
            self.assertEqual(run.call_args.kwargs, {'turn': True})
        out = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(runtime.sys, 'argv', ['entry', '--daily-turn', 'a', 'b']), patch.object(runtime.sys, 'stdout', out):
            self.assertEqual(runtime.main(), 0)
        self.assertEqual(out.buffer.getvalue(), b'{}')


class DailyOutputTests(unittest.TestCase):
    def test_render_allows_only_event_specific_shapes(self) -> None:
        block = {'decision': 'block', 'reason': '已登记'}
        self.assertEqual(hook_client.renderDailyHookResult('UserPromptSubmit', {'hookOutput': block}),
                         json.dumps(block, ensure_ascii=False, separators=(',', ':')).encode())
        self.assertEqual(hook_client.renderDailyHookResult('SessionStart', {'hookOutput': {}}), b'{}')
        self.assertIn(b'additionalContext', hook_client.renderDailyHookResult('PostToolUse', {'hookOutput': POST_CONTEXT}))
        self.assertEqual(json.loads(hook_client.renderDailyHookResult('UserPromptSubmit', {'hookOutput': LETTER_CONTEXT})),
                         LETTER_CONTEXT)
        for decision in [ASK, DENY]:
            self.assertEqual(json.loads(hook_client.renderDailyHookResult('PreToolUse', {'hookOutput': decision})), decision)
        pre_inner = ASK['hookSpecificOutput']
        letter_inner = LETTER_CONTEXT['hookSpecificOutput']
        rejected = [('PostToolUse', block), ('UserPromptSubmit', POST_CONTEXT), ('PostToolUse', LETTER_CONTEXT),
                    ('SessionStart', LETTER_CONTEXT), ('PreToolUse', block),
                    ('UserPromptSubmit', {'hookSpecificOutput': {**letter_inner, 'additionalContext': ' '}}),
                    ('UserPromptSubmit', {'hookSpecificOutput': {**letter_inner, 'extra': 1}}),
                    ('PreToolUse', {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'allow'}}),
                    ('PreToolUse', {'hookSpecificOutput': {**pre_inner, 'permissionDecision': 'allow'}}),
                    ('PreToolUse', {'hookSpecificOutput': {**pre_inner, 'permissionDecisionReason': ' '}}),
                    ('PreToolUse', {'hookSpecificOutput': {**pre_inner, 'updatedInput': {}}}),
                    ('UserPromptSubmit', ASK), ('PostToolUse', DENY),
                    ('UserPromptSubmit', {'decision': 'approve', 'reason': 'x'}),
                    ('UserPromptSubmit', {'decision': 'block', 'reason': ' '}),
                    ('UserPromptSubmit', {'continue': False}), ('Stop', {}),
                    ('PostToolUse', {'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': 'x',
                                                            'extra': 1}})]
        for event, output in rejected:
            with self.assertRaisesRegex(ValueError, '^INVALID_HOOK_RESULT$'):
                hook_client.renderDailyHookResult(event, {'hookOutput': output})
        with self.assertRaisesRegex(ValueError, '^INVALID_HOOK_RESULT$'):
            hook_client.renderDailyHookResult('SessionStart', {'prepared': True})

    def test_daily_and_legacy_responses_do_not_cross(self) -> None:
        request_id = '00000000-0000-4000-8000-000000000001'
        daily = {'schemaVersion': 1, 'requestId': request_id, 'ok': True, 'result': {'hookOutput': {}}}
        legacy = {'schemaVersion': 1, 'requestId': request_id, 'ok': True, 'result': {'prepared': True}}
        self.assertEqual(hook_client._response(daily, request_id, True), {'hookOutput': {}})
        with self.assertRaisesRegex(ValueError, '^INVALID_IPC_RESPONSE$'):
            hook_client._response(legacy, request_id, True)
        with self.assertRaisesRegex(ValueError, '^INVALID_IPC_RESPONSE$'):
            hook_client._response(daily, request_id)

    def test_broker_relays_daily_outputs_and_rejects_approval_fields(self) -> None:
        self.assertTrue(broker_server._result({'hookOutput': {}}))
        self.assertTrue(broker_server._result({'hookOutput': POST_CONTEXT}))
        self.assertTrue(broker_server._result({'hookOutput': LETTER_CONTEXT}))
        self.assertTrue(broker_server._result({'hookOutput': {'decision': 'block', 'reason': 'x'}}))
        self.assertFalse(broker_server._result({'hookOutput': {'decision': 'allow', 'reason': 'x'}}))
        self.assertFalse(broker_server._result({'hookOutput': {'hookSpecificOutput': {
            'hookEventName': 'PreToolUse', 'permissionDecision': 'allow'}}}))
        self.assertTrue(broker_server._result({'hookOutput': ASK}))
        self.assertTrue(broker_server._result({'hookOutput': DENY}))
        self.assertFalse(broker_server._result({'hookOutput': {'hookSpecificOutput': {
            **ASK['hookSpecificOutput'], 'permissionDecision': 'allow'}}}))
        self.assertFalse(broker_server._result({'hookOutput': {'hookSpecificOutput': {
            **ASK['hookSpecificOutput'], 'hookEventName': 'PostToolUse'}}}))
        self.assertFalse(broker_server._result({'hookOutput': [], 'extra': 1}))
        self.assertTrue(broker_server._result({'prepared': True}))


if __name__ == '__main__':
    unittest.main()
