# INPUT: Synthetic kernel peers, pinned process snapshots and changing read adapters.
# OUTPUT: Broker/parent identity, double-read stability and fixed-code rejection tests.
# POS: Offline client identity fixtures; no socket, process, host or model operations.
import ctypes
import dataclasses
import importlib.util
import os
from pathlib import Path
import sys
import traceback
from types import ModuleType
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2] / 'src/bridge/native'
PACKAGE = 'broker_identity_fixture_native'
namespace = ModuleType(PACKAGE)
namespace.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = namespace
for stem in ['macos_identity', 'broker_identity']:
    spec = importlib.util.spec_from_file_location(
        PACKAGE + '.' + stem, ROOT / (stem + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
identity = sys.modules[PACKAGE + '.macos_identity']
broker = sys.modules[PACKAGE + '.broker_identity']


def fixture() -> tuple[identity.KernelPeer, identity.ProcessSnapshot,
                       identity.ProcessSnapshot]:
    parent = identity.ProcessSnapshot(
        pid=41, parent_pid=1, uid=501, pid_version=10,
        unique_id='18446744073709551613', parent_unique_id='1',
        exe='/synthetic/DeepSeek Harness', sha256='b' * 64,
        _start_tvsec='1700000000', _start_tvusec='123456')
    child = identity.ProcessSnapshot(
        pid=73, parent_pid=41, uid=501, pid_version=11,
        unique_id='18446744073709551614',
        parent_unique_id=parent.unique_id,
        exe='/synthetic/python3.13', sha256='a' * 64,
        _start_tvsec='1700000001', _start_tvusec='456789')
    peer = identity.KernelPeer(child.pid, child.uid, child.pid_version)
    return peer, child, parent


class ReadFixture:
    def __init__(self, child: identity.ProcessSnapshot,
                 parent: identity.ProcessSnapshot) -> None:
        self.rows = {child.pid: child, parent.pid: parent}
        self.calls: list[int] = []
        self.changed_at: dict[int, object] = {}

    def read(self, pid: int) -> identity.ProcessSnapshot:
        self.calls.append(pid)
        changed = self.changed_at.get(len(self.calls))
        if isinstance(changed, Exception):
            raise changed
        return changed if changed is not None else self.rows[pid]


class BrokerIdentityTests(unittest.TestCase):
    def verify(self, peer: identity.KernelPeer, child: identity.ProcessSnapshot,
               parent: identity.ProcessSnapshot,
               reader: ReadFixture) -> identity.ProcessSnapshot:
        return broker.verifyBrokerPeer(peer, child, parent, reader.read)

    def test_same_namespace_uses_existing_snapshot_and_peer_types(self) -> None:
        self.assertIs(broker.KernelPeer, identity.KernelPeer)
        self.assertIs(broker.ProcessSnapshot, identity.ProcessSnapshot)
        self.assertTrue(callable(broker.verifyBrokerPeer))

    def test_exact_kernel_peer_and_original_parent_return_a_frozen_copy(self) -> None:
        peer, child, parent = fixture()
        reader = ReadFixture(child, parent)
        try:
            result = self.verify(peer, child, parent, reader)
        except identity.IdentityError as error:
            self.fail(f'Exact trusted peer must verify: {error}')
        self.assertEqual(result, child)
        self.assertIsNot(result, child)
        self.assertEqual(reader.calls, [child.pid, parent.pid, parent.pid, child.pid])
        self.assertEqual(result.unique_id, '18446744073709551614')
        with self.assertRaises(dataclasses.FrozenInstanceError):
            result.pid = 9

    def test_mismatched_kernel_pid_uid_or_version_never_reads_processes(self) -> None:
        peer, child, parent = fixture()
        for field, value in [('pid', 74), ('uid', 502), ('pid_version', 12),
                             ('pid', True), ('uid', False),
                             ('pid_version', True)]:
            with self.subTest(field=field, value=value):
                reader = ReadFixture(child, parent)
                changed = dataclasses.replace(peer, **{field: value})
                with self.assertRaisesRegex(identity.IdentityError,
                                            '^BROKER_IDENTITY_UNVERIFIED$'):
                    self.verify(changed, child, parent, reader)
                self.assertEqual(reader.calls, [])

    def test_broker_pin_unique_or_parent_relation_mismatch_is_rejected(self) -> None:
        peer, child, parent = fixture()
        changes = [('unique_id', '2'), ('exe', '/shadow/python3.13'),
                   ('sha256', 'c' * 64), ('parent_pid', 42),
                   ('parent_unique_id', '2'), ('uid', 502),
                   ('pid_version', 12), ('_start_tvsec', '1700000002'),
                   ('_start_tvusec', '456788')]
        for field, value in changes:
            with self.subTest(field=field):
                reader = ReadFixture(dataclasses.replace(child, **{field: value}), parent)
                with self.assertRaisesRegex(identity.IdentityError,
                                            '^BROKER_IDENTITY_UNVERIFIED$'):
                    self.verify(peer, child, parent, reader)

    def test_original_dsh_parent_snapshot_must_match_completely(self) -> None:
        peer, child, parent = fixture()
        changes = [('pid', 42), ('uid', 502), ('pid_version', 12),
                   ('unique_id', '2'), ('parent_pid', 2),
                   ('parent_unique_id', '2'), ('exe', '/shadow/DeepSeek Harness'),
                   ('sha256', 'c' * 64), ('_start_tvsec', '1700000002'),
                   ('_start_tvusec', '123455')]
        for field, value in changes:
            with self.subTest(field=field):
                reader = ReadFixture(child, parent)
                reader.changed_at[2] = dataclasses.replace(parent, **{field: value})
                with self.assertRaisesRegex(identity.IdentityError,
                                            '^BROKER_IDENTITY_UNVERIFIED$'):
                    self.verify(peer, child, parent, reader)

    def test_snapshot_changes_on_second_read_cannot_authenticate(self) -> None:
        peer, child, parent = fixture()
        for ordinal, original in [(3, parent), (4, child)]:
            for field in dataclasses.fields(original):
                value = getattr(original, field.name)
                changed = value + 1 if type(value) is int else value + '1'
                with self.subTest(ordinal=ordinal, field=field.name):
                    reader = ReadFixture(child, parent)
                    reader.changed_at[ordinal] = dataclasses.replace(
                        original, **{field.name: changed})
                    with self.assertRaisesRegex(identity.IdentityError,
                                                '^BROKER_IDENTITY_UNVERIFIED$'):
                        self.verify(peer, child, parent, reader)

    def test_read_failure_is_sanitized_at_every_step(self) -> None:
        peer, child, parent = fixture()
        for ordinal in range(1, 5):
            with self.subTest(ordinal=ordinal):
                reader = ReadFixture(child, parent)
                reader.changed_at[ordinal] = OSError('private process path')
                try:
                    self.verify(peer, child, parent, reader)
                except identity.IdentityError as error:
                    self.assertEqual(str(error), 'BROKER_IDENTITY_UNVERIFIED')
                    self.assertNotIn('private process path', ''.join(
                        traceback.format_exception(error)))
                else:
                    self.fail('An incomplete identity read cannot verify')

    def test_self_parent_and_duplicate_unique_ids_cannot_be_expected(self) -> None:
        peer, child, parent = fixture()
        for changed in [dataclasses.replace(child, parent_pid=child.pid,
                                             parent_unique_id=child.unique_id),
                        dataclasses.replace(child, unique_id=parent.unique_id)]:
            with self.subTest(child=changed):
                reader = ReadFixture(changed, parent)
                with self.assertRaisesRegex(identity.IdentityError,
                                            '^BROKER_IDENTITY_UNVERIFIED$'):
                    self.verify(peer, changed, parent, reader)
                self.assertEqual(reader.calls, [])

    def test_invalid_expected_snapshot_is_rejected_before_adapter_calls(self) -> None:
        peer, child, parent = fixture()
        changes = [('unique_id', '0'), ('unique_id', '01'),
                   ('unique_id', '18446744073709551616'),
                   ('parent_unique_id', '0'), ('pid', True),
                   ('parent_pid', 0), ('uid', 0xffffffff),
                   ('pid_version', -1), ('pid_version', 1 << 32),
                   ('exe', 'relative'), ('exe', '/synthetic/../python3.13'),
                   ('sha256', 'bad'), ('_start_tvsec', '-1'),
                   ('_start_tvusec', '1000000')]
        for field, value in changes:
            with self.subTest(field=field, value=value):
                reader = ReadFixture(child, parent)
                changed = dataclasses.replace(child, **{field: value})
                with self.assertRaisesRegex(identity.IdentityError,
                                            '^BROKER_IDENTITY_UNVERIFIED$'):
                    self.verify(peer, changed, parent, reader)
                self.assertEqual(reader.calls, [])

    def test_dict_or_subclass_cannot_substitute_for_original_types(self) -> None:
        peer, child, parent = fixture()
        class Derived(identity.ProcessSnapshot):
            pass
        derived = Derived(**{field.name: getattr(child, field.name)
                             for field in dataclasses.fields(child)})
        for bad in [None, child.to_json(), derived]:
            reader = ReadFixture(child, parent)
            with self.assertRaisesRegex(identity.IdentityError,
                                        '^BROKER_IDENTITY_UNVERIFIED$'):
                self.verify(peer, bad, parent, reader)
            self.assertEqual(reader.calls, [])

    def test_import_does_not_load_kernel_or_inspect_files(self) -> None:
        spec = importlib.util.spec_from_file_location(
            PACKAGE + '.broker_import_fixture', ROOT / 'broker_identity.py')
        fresh = importlib.util.module_from_spec(spec)
        with (patch.object(ctypes, 'CDLL',
                           side_effect=AssertionError('no kernel')),
              patch.object(os, 'open',
                           side_effect=AssertionError('no file IO'))):
            spec.loader.exec_module(fresh)


if __name__ == '__main__':
    unittest.main()
