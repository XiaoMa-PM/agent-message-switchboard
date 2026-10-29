# INPUT: Canonical Unix temporary directories and Private pinned filesystem fixtures and explicitly injected role runners.
# OUTPUT: Closed config/loading, explicit App blocking and envelope identity tests.
# POS: Offline bootstrap fixtures; no live identity inspection, broker or model.
import builtins
import dataclasses
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[2] / 'src/bridge/native'
spec = importlib.util.spec_from_file_location('runtime_entry_fixture',
                                             SOURCE / 'runtime_entry.py')
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)


class RuntimeEntryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix='ms-entry-',
                                                dir=Path('/tmp').resolve())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.code = self.root / 'native'
        self.code.mkdir(mode=0o700)
        self.sockets = self.root / 'ipc'
        self.sockets.mkdir(mode=0o700)
        self.python = self.root / 'python'
        self.python.write_bytes(b'synthetic interpreter; not executable')
        self.python.chmod(0o755)
        names = (*runtime.NATIVE_MODULES, 'runtime_entry')
        self.pins = []
        for name in names:
            target = self.code / (name + '.py')
            target.write_bytes((SOURCE / target.name).read_bytes())
            target.chmod(0o600)
            self.pins.append({'path': str(target), 'sha256': self.hash(target)})
        self.entry = str(self.code / 'runtime_entry.py')
        self.path = self.code / 'broker-config.json'
        self.raw = {'schemaVersion': 1, 'role': 'broker',
                    'codeRoot': str(self.code),
                    'python': {'path': str(self.python), 'sha256': self.hash(self.python)},
                    'codePins': self.pins, 'socketPath': str(self.sockets / 'broker.sock')}
        self.write()
        self.addCleanup(self.clear_namespace)

    @staticmethod
    def hash(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @staticmethod
    def clear_namespace() -> None:
        for name in list(sys.modules):
            if name == runtime.NAMESPACE or name.startswith(runtime.NAMESPACE + '.'):
                del sys.modules[name]

    def write(self) -> None:
        self.path.write_text(json.dumps(self.raw), encoding='utf-8')
        self.path.chmod(0o600)

    def config(self):
        return runtime.readRuntimeConfig(str(self.path), self.entry)

    def load(self):
        with patch.object(runtime.sys, 'executable', str(self.python)), \
                patch.object(runtime.sys, 'platform', 'darwin'), \
                patch.object(runtime.sys, 'version_info', (3, 13, 14)):
            return runtime.loadPinnedModules(self.config(), self.entry)

    def client_config(self) -> None:
        self.path = self.root / 'client.json'
        self.raw.update(role='client', broker={'pid': 73, 'parentPid': 41,
            'uid': os.getuid(), 'pidVersion': 11, 'uniqueId': '730',
            'parentUniqueId': '410', 'exe': str(self.python),
            'sha256': self.hash(self.python)}, parent={'pid': 41, 'parentPid': 1,
            'uid': os.getuid(), 'pidVersion': 10, 'uniqueId': '410',
            'parentUniqueId': '1', 'exe': '/synthetic/dsh', 'sha256': 'b' * 64})
        self.write()

    def test_valid_config_is_frozen_and_bundle_loads_one_relative_namespace(self) -> None:
        try:
            config = self.config()
        except ValueError as error:
            self.fail(f'Valid config must be accepted: {error}')
        self.assertEqual(config.role, 'broker')
        with self.assertRaises(dataclasses.FrozenInstanceError):
            config.role = 'client'
        modules = self.load()
        self.assertEqual(set(modules), set(runtime.NATIVE_MODULES))
        self.assertIs(modules['broker_identity'].ProcessSnapshot,
                      modules['macos_identity'].ProcessSnapshot)
        self.assertEqual(sys.modules[runtime.NAMESPACE].__path__, [])
        self.assertFalse((self.code / '__pycache__').exists())

    def test_all_pins_are_verified_before_any_module_executes(self) -> None:
        marker = self.root / 'must-not-execute'
        first = self.code / 'macos_identity.py'
        first.write_text(f'open({str(marker)!r}, "w").write("executed")')
        self.pins[0]['sha256'] = self.hash(first)
        self.pins[-2]['sha256'] = '0' * 64
        self.write()
        with self.assertRaisesRegex(ValueError, '^RUNTIME_PIN_MISMATCH$'):
            self.load()
        self.assertFalse(marker.exists())
        self.assertNotIn(runtime.NAMESPACE, sys.modules)

    def test_loaded_code_uses_captured_bytes_not_a_second_file_read(self) -> None:
        target = self.code / 'ipc_frame.py'
        marker = self.root / 'must-not-execute'
        changed = False
        def compile_once(source, filename, mode):
            nonlocal changed
            if not changed:
                changed = True
                target.write_text(f'open({str(marker)!r}, "w").write("executed")')
            return builtins.compile(source, filename, mode)
        with patch.object(runtime, 'compile', compile_once, create=True):
            modules = self.load()
        self.assertTrue(callable(modules['ipc_frame'].encodeFrame))
        self.assertFalse(marker.exists())

    def test_missing_duplicate_or_config_code_pins_are_rejected(self) -> None:
        original = list(self.pins)
        for pins in [original[:-1], original + [original[0]],
                     original + [{'path': str(self.path), 'sha256': self.hash(self.path)}]]:
            self.raw['codePins'] = pins
            self.write()
            with self.assertRaisesRegex(ValueError, '^INVALID_RUNTIME_CONFIG$'):
                self.config()

    def test_extra_files_including_docs_or_symlink_are_not_runtime_resources(self) -> None:
        for name in ['AGENTS.md', 'other.py', '__pycache__']:
            path = self.code / name
            path.write_text('unlisted')
            with self.assertRaisesRegex(ValueError, '^UNTRUSTED_RUNTIME_BUNDLE$'):
                self.load()
            path.unlink()

    def test_config_exact_schema_roles_and_snapshot_types_fail_closed(self) -> None:
        original = dict(self.raw)
        for change in [{'schemaVersion': True}, {'role': 'other'}, {'pid': 73},
                       {'python': {'path': str(self.python), 'sha256': 'bad'}},
                       {'broker': {}}]:
            self.raw = {**original, **change}
            self.write()
            with self.assertRaisesRegex(ValueError, '^INVALID_RUNTIME_CONFIG$'):
                self.config()
        self.raw = original
        self.client_config()
        self.raw['broker']['pid'] = True
        self.write()
        with self.assertRaisesRegex(ValueError, '^INVALID_RUNTIME_CONFIG$'):
            self.config()

    def test_config_mode_symlink_and_private_directory_modes(self) -> None:
        self.path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, '^UNTRUSTED_RUNTIME_FILE$'):
            self.config()
        self.path.chmod(0o600)
        alias = self.code / 'alias.json'
        alias.symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, '^UNTRUSTED_RUNTIME_FILE$'):
            runtime.readRuntimeConfig(str(alias), self.entry)
        alias.unlink()
        self.code.chmod(0o755)
        with self.assertRaisesRegex(ValueError, '^UNTRUSTED_RUNTIME_FILE$'):
            self.config()

    def test_unsafe_code_file_and_changed_interpreter_pin_never_load(self) -> None:
        target = self.code / 'ipc_frame.py'
        target.chmod(0o622)
        with self.assertRaisesRegex(ValueError, '^UNTRUSTED_RUNTIME_FILE$'):
            self.load()
        target.chmod(0o600)
        self.python.write_bytes(b'changed interpreter')
        with self.assertRaisesRegex(ValueError, '^RUNTIME_PIN_MISMATCH$'):
            self.load()

    def test_outer_ancestor_permissions_follow_f1_group_and_sticky_rules(self) -> None:
        original = runtime.os.lstat
        for gid, mode, accepted in [(0, 0o775, True), (80, 0o775, True),
                                    (20, 0o775, False), (81, 0o775, False),
                                    (0, 0o1777, True), (0, 0o777, False)]:
            def changed(path):
                row = original(path)
                if str(path) != str(self.root):
                    return row
                values = {name: getattr(row, name) for name in dir(row)
                          if name.startswith('st_')}
                return SimpleNamespace(**{**values, 'st_gid': gid,
                    'st_mode': stat.S_IFDIR | mode})
            with self.subTest(gid=gid, mode=mode), patch.object(runtime.os, 'lstat', changed):
                if accepted:
                    self.load()
                    self.clear_namespace()
                else:
                    with self.assertRaisesRegex(ValueError, '^UNTRUSTED_RUNTIME_FILE$'):
                        self.load()

    def test_runtime_rejects_a_different_interpreter_without_fallback(self) -> None:
        with patch.object(runtime.sys, 'executable', '/different/python'):
            with self.assertRaisesRegex(ValueError, '^UNSUPPORTED_RUNTIME$'):
                runtime.loadPinnedModules(self.config(), self.entry)

    def test_runtime_rejects_a_different_platform_without_fallback(self) -> None:
        with patch.object(runtime.sys, 'executable', str(self.python)), \
                patch.object(runtime.sys, 'platform', 'linux'), \
                patch.object(runtime.sys, 'version_info', (3, 13, 14)):
            with self.assertRaisesRegex(ValueError, '^UNSUPPORTED_RUNTIME$'):
                runtime.loadPinnedModules(self.config(), self.entry)

    def test_runtime_rejects_a_different_version_without_fallback(self) -> None:
        with patch.object(runtime.sys, 'executable', str(self.python)), \
                patch.object(runtime.sys, 'platform', 'darwin'), \
                patch.object(runtime.sys, 'version_info', (3, 13, 13)):
            with self.assertRaisesRegex(ValueError, '^UNSUPPORTED_RUNTIME$'):
                runtime.loadPinnedModules(self.config(), self.entry)

    def test_runtime_accepts_3_13_14_and_newer_without_ceiling(self) -> None:
        for version in [(3, 13, 14), (3, 13, 15), (3, 14, 0)]:
            self.clear_namespace()
            with patch.object(runtime.sys, 'executable', str(self.python)), \
                    patch.object(runtime.sys, 'platform', 'darwin'), \
                    patch.object(runtime.sys, 'version_info', version):
                modules = runtime.loadPinnedModules(self.config(), self.entry)
            self.assertEqual(set(modules), set(runtime.NATIVE_MODULES))
        self.clear_namespace()

    def test_role_runners_are_only_called_after_validated_loading(self) -> None:
        calls = []
        def loader(config, entry):
            calls.append('load')
            return {'fixture': True}
        def runner(config, modules, stdin, stdout):
            calls.append(config.role)
        output, errors = io.BytesIO(), io.BytesIO()
        result = runtime.runRuntime(str(self.path), io.BytesIO(), output, errors,
            entry_path=self.entry, loader=loader, broker_runner=runner,
            client_runner=runner)
        self.assertEqual(result, 0)
        self.assertEqual(calls, ['load', 'broker'])
        self.assertEqual(output.getvalue(), b'')
        self.assertEqual(errors.getvalue(), b'')

    def test_client_matches_eight_field_dtos_using_real_full_snapshots(self) -> None:
        self.client_config()
        config, modules = self.config(), self.load()
        identity, hook = modules['macos_identity'], modules['hook_client']
        parent = identity.ProcessSnapshot(41, 1, os.getuid(), 10, '410', '1',
                                          '/synthetic/dsh', 'b' * 64, '100', '123')
        broker = identity.ProcessSnapshot(73, 41, os.getuid(), 11, '730', '410',
            str(self.python), self.hash(self.python), '101', '456')
        inspected = []
        def read(pid):
            inspected.append(pid)
            return broker if pid == 73 else parent
        def exchange(path, actual_broker, actual_parent, payload, inspect, audit):
            self.assertIs(actual_broker, broker)
            self.assertIs(actual_parent, parent)
            self.assertEqual(actual_broker.start_time(), ('101', '456'))
            return {'linkId': 'link', 'targetSessionId': 'original-dsh'}
        output = io.BytesIO()
        with patch.object(identity, 'MacIdentityInspector',
                          return_value=SimpleNamespace(read=read)), \
             patch.object(hook, 'exchangeHook', side_effect=exchange):
            runtime.runClientRole(config, modules,
                io.BytesIO(b'{"hook_event_name":"PostToolUse"}'), output)
        self.assertEqual(inspected, [73, 41])
        self.assertFalse(output.getvalue().endswith(b'\n'))
        self.assertIn(b'hookSpecificOutput', output.getvalue())

    def test_dto_mismatch_rejects_before_hook_exchange(self) -> None:
        self.client_config()
        config, modules = self.config(), self.load()
        identity, hook = modules['macos_identity'], modules['hook_client']
        wrong = identity.ProcessSnapshot(73, 41, os.getuid(), 12, '731', '410',
            str(self.python), self.hash(self.python), '101', '456')
        with patch.object(identity, 'MacIdentityInspector',
                          return_value=SimpleNamespace(read=lambda _: wrong)), \
             patch.object(hook, 'exchangeHook') as exchange:
            with self.assertRaisesRegex(ValueError, '^BROKER_IDENTITY_UNVERIFIED$'):
                runtime.runClientRole(config, modules, io.BytesIO(b'{}'), io.BytesIO())
            exchange.assert_not_called()

    def test_app_client_schema_and_explicit_entry_are_paired(self) -> None:
        self.client_config()
        self.raw['role'] = 'app-client'
        self.write()
        self.assertEqual(self.config().role, 'app-client')
        for explicit, expected in [(False, 1), (True, 0)]:
            errors = io.BytesIO()
            result = runtime.runRuntime(str(self.path), io.BytesIO(), io.BytesIO(),
                errors, entry_path=self.entry, loader=lambda *_: {},
                client_runner=lambda *_: None, app_client=explicit)
            self.assertEqual(result, expected)
        self.raw['role'] = 'client'
        self.write()
        self.assertEqual(runtime.runRuntime(str(self.path), io.BytesIO(),
            io.BytesIO(), io.BytesIO(), entry_path=self.entry,
            loader=lambda *_: {}, app_client=True), 2)
        self.raw['role'] = 'app-client'
        self.raw['extra'] = True
        self.write()
        with self.assertRaisesRegex(ValueError, '^INVALID_RUNTIME_CONFIG$'):
            self.config()

    def test_explicit_app_entry_blocks_config_load_and_rpc_failures(self) -> None:
        self.client_config()
        self.raw['role'] = 'app-client'
        self.write()
        for code in ['RUNTIME_PIN_MISMATCH', 'RUNTIME_LOAD_FAILED',
                     'INVALID_HOOK_EVENT', 'IPC_REQUEST_FAILED', 'private body']:
            def failed(*args):
                raise ValueError(code)
            errors = io.BytesIO()
            result = runtime.runRuntime(str(self.path), io.BytesIO(), io.BytesIO(),
                errors, entry_path=self.entry, loader=failed, app_client=True)
            self.assertEqual(result, 2)
            expected = code if code != 'private body' else 'RUNTIME_FAILED'
            self.assertEqual(errors.getvalue(),
                             ('MS_HOOK_FAILED:' + expected + '\n').encode())
        self.path.write_text('{')
        errors = io.BytesIO()
        self.assertEqual(runtime.runRuntime(str(self.path), io.BytesIO(),
            io.BytesIO(), errors, entry_path=self.entry, app_client=True), 2)

    def test_app_runner_json_rpc_and_render_errors_block(self) -> None:
        self.client_config()
        self.raw['role'] = 'app-client'
        self.write()
        modules = self.load()
        identity, hook = modules['macos_identity'], modules['hook_client']
        config = self.config()
        def read(pid):
            return SimpleNamespace(to_json=lambda: dict(
                config.broker if pid == 73 else config.parent))
        for raw, failure, response in [(b'{', None, None),
                (b'{"hook_event_name":"PreToolUse"}', ValueError('IPC_REQUEST_FAILED'), None),
                (b'{"hook_event_name":"PreToolUse"}', None, {'invalid': True})]:
            errors = io.BytesIO()
            with patch.object(identity, 'MacIdentityInspector',
                              return_value=SimpleNamespace(read=read)), \
                    patch.object(hook, 'exchangeHook', side_effect=failure,
                                 return_value=response):
                result = runtime.runRuntime(str(self.path), io.BytesIO(raw),
                    io.BytesIO(), errors, entry_path=self.entry,
                    loader=lambda *_: modules, app_client=True)
            self.assertEqual(result, 2)
            self.assertTrue(errors.getvalue().startswith(b'MS_HOOK_FAILED:'))

    def test_main_accepts_only_exact_app_argv_and_blocks_malformed_app_argv(self) -> None:
        for argv, status in [(['entry', '--app-client'], 2),
                             (['entry', '--app-client', 'config', 'extra'], 2),
                             (['entry'], 1)]:
            with patch.object(runtime.sys, 'argv', argv), \
                    patch.object(runtime.sys, 'stderr',
                                 SimpleNamespace(buffer=io.BytesIO())):
                self.assertEqual(runtime.main(), status)
        with patch.object(runtime.sys, 'argv', ['entry', '--app-client', 'config']), \
                patch.object(runtime, 'runRuntime', return_value=0) as run:
            self.assertEqual(runtime.main(), 0)
            self.assertTrue(run.call_args.kwargs['app_client'])

    def test_app_envelope_retains_start_resume_and_missing_socket(self) -> None:
        self.client_config()
        self.raw['role'] = 'app-client'
        self.write()
        config, modules = self.config(), self.load()
        identity, hook = modules['macos_identity'], modules['hook_client']
        def read(pid):
            return SimpleNamespace(to_json=lambda: dict(
                config.broker if pid == 73 else config.parent))
        events = [({'hook_event_name': 'SessionStart', 'source': 'resume'}, '/app.sock'),
                  ({'hook_event_name': 'SessionStart'}, None),
                  ({'hook_event_name': 'PreToolUse'}, '/ignored.sock'),
                  ({'hook_event_name': 'PostToolUse'}, None)]
        for raw, socket_path in events:
            result = ({'linkId': 'link', 'targetSessionId': 'dsh'}
                      if raw['hook_event_name'] == 'PostToolUse' else {'prepared': True})
            output = io.BytesIO()
            with patch.object(identity, 'MacIdentityInspector',
                              return_value=SimpleNamespace(read=read)), \
                    patch.object(hook, 'exchangeHook', return_value=result) as exchange, \
                    patch.dict(os.environ, {} if socket_path is None else {
                        'CLAUDE_CODE_MESSAGING_SOCKET': socket_path}, clear=True):
                runtime.runClientRole(config, modules,
                    io.BytesIO(json.dumps(raw).encode()), output)
            startup = ({'socketPath': socket_path}
                       if raw['hook_event_name'] == 'SessionStart' else None)
            self.assertEqual(exchange.call_args.args[3],
                             {'profile': 'app-code', 'hook': raw, 'startup': startup})
            if raw['hook_event_name'] != 'PostToolUse':
                self.assertEqual(json.loads(output.getvalue()), {})
            else:
                self.assertEqual(set(json.loads(output.getvalue())), {'hookSpecificOutput'})

    def test_owned_broker_signals_request_cleanup_and_restore_handlers(self) -> None:
        config, modules = self.config(), self.load()
        handlers, changes = {}, []
        def install(number, handler):
            handlers[number] = handler
            changes.append((number, handler))
        def serve(path, stdin, stdout, inspect, audit, stop, inspect_signed):
            self.assertEqual((inspect.__name__, inspect_signed.__name__), ('read', 'read_signed'))
            self.assertFalse(stop.is_set())
            self.assertIn(runtime.signal.SIGTERM, handlers)
            handlers[runtime.signal.SIGTERM](runtime.signal.SIGTERM, None)
            self.assertTrue(stop.is_set())
        with patch.object(runtime.signal, 'getsignal', return_value='original'), \
             patch.object(runtime.signal, 'signal', side_effect=install), \
             patch.object(modules['broker_server'], 'serveBroker', side_effect=serve):
            runtime.runBrokerRole(config, modules, io.BytesIO(), io.BytesIO())
        self.assertEqual(changes[-2:], [(runtime.signal.SIGTERM, 'original'),
                                        (runtime.signal.SIGINT, 'original')])

    def test_native_stdin_limit_and_fixed_failure_stderr_hide_original_data(self) -> None:
        errors, output = io.BytesIO(), io.BytesIO()
        def failed(*args):
            raise OSError('private original body and credentials path')
        result = runtime.runRuntime(str(self.path), io.BytesIO(), output, errors,
            entry_path=self.entry, loader=lambda *_: {}, broker_runner=failed)
        self.assertEqual(result, 1)
        self.assertEqual(output.getvalue(), b'')
        self.assertEqual(errors.getvalue(), b'MS_HOOK_FAILED:RUNTIME_FAILED\n')


if __name__ == '__main__':
    unittest.main()
