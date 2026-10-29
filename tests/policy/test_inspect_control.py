# INPUT: Synthetic owned-parent control requests and injected process reads.
# OUTPUT: Strict control correlation, fresh reads and sanitized failure regressions.
# POS: Offline helper control dispatcher tests; no real stdio, socket or system calls.
import importlib.util
from pathlib import Path
import sys
from types import ModuleType
import unittest

ROOT = Path(__file__).resolve().parents[2] / 'src/bridge/native'
PACKAGE = 'inspect_control_fixture'
namespace = ModuleType(PACKAGE)
namespace.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = namespace
for name in ['macos_identity', 'inspect_control']:
    spec = importlib.util.spec_from_file_location(
        PACKAGE + '.' + name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
identity = sys.modules[PACKAGE + '.macos_identity']
control = sys.modules[PACKAGE + '.inspect_control']

REQUEST = {'schemaVersion': 1, 'requestId': '00000000-0000-0000-0000-000000000001',
           'operation': 'inspect', 'pid': 73}
SNAPSHOT = identity.ProcessSnapshot(
    73, 41, 501, 11, '18446744073709551614', '18446744073709551613',
    '/synthetic/python', 'a' * 64, '1700000000', '1')


class ControlTests(unittest.TestCase):
    def test_each_request_reads_fresh_and_returns_exact_correlated_shape(self):
        calls = []
        def read(pid):
            calls.append(pid)
            return SNAPSHOT
        for _ in range(2):
            result = control.inspectControl(dict(REQUEST), read)
            self.assertEqual(result, {
                'schemaVersion': 1, 'requestId': REQUEST['requestId'],
                'operation': 'inspect', 'ok': True,
                'snapshot': SNAPSHOT.to_json()})
            self.assertNotIn('_start_tvsec', result['snapshot'])
        self.assertEqual(calls, [73, 73])

    def test_invalid_control_never_calls_system_reader(self):
        bad = [None, [], {**REQUEST, 'authority': 'user'},
               {**REQUEST, 'schemaVersion': True},
               {**REQUEST, 'operation': 'send'},
               {**REQUEST, 'requestId': 'bad'}]
        bad += [{**REQUEST, 'pid': pid} for pid in
                [True, 0, 1, -1, 1.5, 0x80000000, '73']]
        for request in bad:
            with self.subTest(request=request):
                with self.assertRaisesRegex(
                        ValueError, '^INVALID_IPC_CONTROL$'):
                    control.inspectControl(request, lambda _pid: self.fail('read'))

    def test_unknown_exception_never_returns_private_message(self):
        def read(_pid):
            raise OSError('private path body')
        result = control.inspectControl(dict(REQUEST), read)
        self.assertEqual(result['error'], 'IPC_REQUEST_FAILED')
        self.assertNotIn('private', str(result))

    def test_identity_error_only_returns_known_fixed_codes(self):
        for code in ['PROCESS_IDENTITY_UNAVAILABLE', 'UNTRUSTED_EXECUTABLE',
                     'INVALID_PROCESS_PATH', 'INVALID_PROCESS_IDENTITY',
                     'private path']:
            def read(_pid):
                raise identity.IdentityError(code)
            result = control.inspectControl(dict(REQUEST), read)
            self.assertEqual(result['ok'], False)
            expected = code if code != 'private path' else 'IPC_REQUEST_FAILED'
            self.assertEqual(result['error'], expected)

    def test_signed_inspect_uses_its_own_reader_and_echoes_its_operation(self):
        signed = identity.SignedSnapshot(
            73, 41, 501, 11, '18446744073709551614', '18446744073709551613',
            '/synthetic/claude', None,
            identity.Signer('Q6L2SF6YDW', 'com.anthropic.claude-code', True))
        request = {**REQUEST, 'operation': 'inspect-signed'}
        result = control.inspectControl(dict(request), lambda _pid: self.fail('legacy read'),
                                        lambda _pid: signed)
        self.assertEqual(result, {'schemaVersion': 1, 'requestId': REQUEST['requestId'],
                                  'operation': 'inspect-signed', 'ok': True, 'snapshot': signed.to_json()})
        legacy = control.inspectControl(dict(request), lambda _pid: SNAPSHOT, lambda _pid: SNAPSHOT)
        self.assertEqual(legacy['error'], 'IPC_REQUEST_FAILED')
        with self.assertRaisesRegex(ValueError, '^INVALID_IPC_CONTROL$'):
            control.inspectControl(dict(request), lambda _pid: SNAPSHOT)
        def unavailable(_pid):
            raise identity.IdentityError('CODE_SIGNING_UNAVAILABLE')
        failed = control.inspectControl(dict(request), lambda _pid: SNAPSHOT, unavailable)
        self.assertEqual((failed['operation'], failed['error']), ('inspect-signed', 'CODE_SIGNING_UNAVAILABLE'))

    def test_wrong_snapshot_or_wrong_pid_cannot_be_reported_as_current(self):
        for snapshot in [None, SNAPSHOT.to_json(),
                         identity.ProcessSnapshot(
                             74, 41, 501, 11, '4', '3', '/synthetic/python',
                             'a' * 64, '1700000000', '1')]:
            result = control.inspectControl(dict(REQUEST), lambda _pid: snapshot)
            self.assertEqual(result['ok'], False)
            self.assertEqual(result['error'], 'IPC_REQUEST_FAILED')


if __name__ == '__main__':
    unittest.main()
