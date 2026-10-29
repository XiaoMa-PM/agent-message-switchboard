# INPUT: Synthetic C calls/tokens and independently created test files.
# OUTPUT: Identity ABI, exact returns, immutable JSON and file trust tests.
# POS: Offline fixtures; no real PID, socket, listener, host or model probe.
import ctypes
import dataclasses
import hashlib
import importlib.util
import os
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = (Path(__file__).resolve().parents[2]
          / 'src/bridge/native/macos_identity.py')
if SOURCE.exists():
    spec = importlib.util.spec_from_file_location('macos_identity', SOURCE)
    identity = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = identity
    spec.loader.exec_module(identity)
else:
    identity = SimpleNamespace()


def bsd_bytes(pid: int = 73, parent: int = 41, uid: int = 501,
              seconds: int = 1700000000, micros: int = 123456) -> bytes:
    return struct.pack('=12I16s32s5IiQQ', 0, 0, 0, pid, parent, uid,
                       20, 502, 21, 503, 22, 0, b'unused', b'unused',
                       0, 0, 0, 0, 0, 0, seconds, micros)


def unique_bytes(unique: int = (1 << 63) + 7, parent: int = (1 << 63) + 3,
                 version: int = 11) -> bytes:
    return struct.pack('=16sQQiiQQ', bytes(16), unique, parent, version,
                       0, 0, 0)


def audit_bytes(pid: int = 73, uid: int = 501, version: int = 11) -> bytes:
    return struct.pack('=8I', 999, uid, 22, 502, 23, pid, 9, version)


class CFixture:
    def __init__(self, path: str) -> None:
        self.bsd = bsd_bytes()
        self.unique = unique_bytes()
        self.path = os.fsencode(path) + b'\0'
        self.counts = {3: 136, 17: 56}
        self.path_count = len(self.path) - 1
        self.calls: list[tuple] = []

    def pidinfo(self, pid: int, flavor: int, arg: int,
                buffer: object, size: int) -> int:
        self.calls.append((pid, flavor, arg, size))
        payload = self.bsd if flavor == 3 else self.unique
        ctypes.memmove(buffer, payload, min(len(payload), size))
        return self.counts[flavor]

    def pidpath(self, pid: int, buffer: object, size: int) -> int:
        self.calls.append((pid, 'path', size))
        ctypes.memmove(buffer, self.path, min(len(self.path), size))
        return self.path_count

    def api(self):
        return identity.KernelAPI(self.pidinfo, self.pidpath)


def ancestor_group(path: Path, gid: int):
    original = os.lstat
    def group(candidate):
        info = original(candidate)
        if str(candidate) == str(path):
            row = list(info)
            row[5] = gid
            return os.stat_result(row)
        return info
    return patch.object(identity.os, 'lstat', side_effect=group)


class IdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(
            prefix='.identity-fixture-', dir=SOURCE.parents[3])
        self.addCleanup(self.temp.cleanup)
        self.exe = Path(self.temp.name) / 'synthetic-executable'
        self.exe.write_bytes(b'not a real executable\n')
        self.exe.chmod(0o600)

    def read(self, fixture: CFixture | None = None, pid: int = 73):
        api = (fixture or CFixture(str(self.exe))).api()
        return identity.inspectPid(api, pid)

    def test_api_is_available_as_functions_not_an_import_error(self) -> None:
        for name in ['inspectPid', 'decodeAuditToken', 'auditPeer',
                     'MacIdentityInspector', 'KernelAPI',
                     'validatePrivateRoot', 'hashPrivateCode']:
            self.assertTrue(callable(getattr(identity, name, None)), name)

    def test_official_structure_sizes_and_offsets(self) -> None:
        self.assertEqual(ctypes.sizeof(identity.ProcBSDInfo), 136)
        self.assertEqual(identity.ProcBSDInfo.pbi_pid.offset, 12)
        self.assertEqual(identity.ProcBSDInfo.pbi_ppid.offset, 16)
        self.assertEqual(identity.ProcBSDInfo.pbi_uid.offset, 20)
        self.assertEqual(identity.ProcBSDInfo.pbi_start_tvsec.offset, 120)
        self.assertEqual(ctypes.sizeof(identity.ProcUniqueInfo), 56)
        self.assertEqual(identity.ProcUniqueInfo.p_uniqueid.offset, 16)
        self.assertEqual(identity.ProcUniqueInfo.p_puniqueid.offset, 24)
        self.assertEqual(identity.ProcUniqueInfo.p_idversion.offset, 32)

    def test_exact_fixture_calls_and_frozen_ts_projection(self) -> None:
        fixture = CFixture(str(self.exe))
        snapshot = self.read(fixture)
        projected = snapshot.to_json()
        self.assertEqual(projected, {
            'pid': 73, 'parentPid': 41, 'uid': 501, 'pidVersion': 11,
            'uniqueId': str((1 << 63) + 7),
            'parentUniqueId': str((1 << 63) + 3), 'exe': str(self.exe),
            'sha256': hashlib.sha256(self.exe.read_bytes()).hexdigest(),
        })
        self.assertEqual(snapshot.start_time(), ('1700000000', '123456'))
        self.assertEqual(fixture.calls, [(73, 3, 0, 136), (73, 17, 0, 56),
                                         (73, 'path', 4096)])
        with self.assertRaises(dataclasses.FrozenInstanceError):
            snapshot.pid = 9
        projected['pid'] = 9
        self.assertEqual(snapshot.to_json()['pid'], 73)

    def test_invalid_requested_pid_never_reaches_c(self) -> None:
        for pid in [None, True, '73', -1, 0, 1, 1 << 31]:
            with self.subTest(pid=pid):
                fixture = CFixture(str(self.exe))
                with self.assertRaisesRegex(
                        ValueError, '^INVALID_PROCESS_ID$'):
                    self.read(fixture, pid)
                self.assertEqual(fixture.calls, [])

    def test_kernel_info_short_or_oversized_returns_are_rejected(self) -> None:
        for flavor, size in [(3, 136), (17, 56)]:
            for result in [0, -1, size - 1, size + 1]:
                with self.subTest(flavor=flavor, result=result):
                    fixture = CFixture(str(self.exe))
                    fixture.counts[flavor] = result
                    with self.assertRaisesRegex(
                            ValueError, '^PROCESS_IDENTITY_UNAVAILABLE$'):
                        self.read(fixture)

    def test_kernel_layout_mismatch_rejects_before_c(self) -> None:
        fixture = CFixture(str(self.exe))
        with patch.object(identity.ctypes, 'sizeof', return_value=1):
            with self.assertRaisesRegex(ValueError, '^INVALID_KERNEL_LAYOUT$'):
                self.read(fixture)
        self.assertEqual(fixture.calls, [])

    def test_invalid_snapshot_fields_rejected(self) -> None:
        bad_bsd = [bsd_bytes(pid=74), bsd_bytes(parent=0),
                   bsd_bytes(parent=1 << 31), bsd_bytes(uid=0xffffffff),
                   bsd_bytes(micros=1000000)]
        for payload in bad_bsd:
            with self.subTest(payload=payload):
                fixture = CFixture(str(self.exe))
                fixture.bsd = payload
                with self.assertRaisesRegex(
                        ValueError, '^INVALID_PROCESS_IDENTITY$'):
                    self.read(fixture)
        for payload in [unique_bytes(unique=0), unique_bytes(parent=0)]:
            fixture = CFixture(str(self.exe))
            fixture.unique = payload
            with self.assertRaisesRegex(
                    ValueError, '^INVALID_PROCESS_IDENTITY$'):
                self.read(fixture)

    def test_uint64_max_and_signed_version_preserve_bit_pattern(self) -> None:
        fixture = CFixture(str(self.exe))
        fixture.unique = unique_bytes(unique=(1 << 64) - 1, version=-1)
        fixture.bsd = bsd_bytes(seconds=(1 << 64) - 1)
        snapshot = self.read(fixture)
        self.assertEqual(snapshot.to_json()['uniqueId'],
                         '18446744073709551615')
        self.assertEqual(snapshot.to_json()['pidVersion'], 0xffffffff)
        self.assertEqual(snapshot.start_time()[0], '18446744073709551615')

    def test_invalid_pidpath_size_or_content_rejected(self) -> None:
        for count in [0, -1, 4096, len(os.fsencode(self.exe)) + 1]:
            with self.subTest(count=count):
                fixture = CFixture(str(self.exe))
                fixture.path_count = count
                with self.assertRaisesRegex(
                        ValueError, '^INVALID_PROCESS_PATH$'):
                    self.read(fixture)
        for payload, count in [(b'\0', 1), (b'relative\0', 8),
                               (b'/fake\0tail\0', 10), (b'/fakeX', 5)]:
            fixture = CFixture(str(self.exe))
            fixture.path = payload
            fixture.path_count = count
            with self.assertRaisesRegex(ValueError, '^INVALID_PROCESS_PATH$'):
                self.read(fixture)

    def test_c_failure_has_fixed_code(self) -> None:
        fixture = CFixture(str(self.exe))
        api = identity.KernelAPI(lambda *_: (_ for _ in ()).throw(
            OSError('synthetic private text')), fixture.pidpath)
        with self.assertRaisesRegex(
                ValueError, '^PROCESS_IDENTITY_UNAVAILABLE$'):
            identity.inspectPid(api, 73)

    def test_executable_group_or_other_write_is_rejected(self) -> None:
        for mode in [0o620, 0o602]:
            with self.subTest(mode=mode):
                self.exe.chmod(mode)
                with self.assertRaisesRegex(
                        ValueError, '^UNTRUSTED_EXECUTABLE$'):
                    self.read()

    def test_executable_symlink_and_missing_file_are_rejected(self) -> None:
        linked = self.exe.parent / 'linked'
        linked.symlink_to(self.exe)
        for path in [linked, self.exe.parent / 'missing']:
            with self.subTest(path=path):
                with self.assertRaisesRegex(
                        ValueError, '^UNTRUSTED_EXECUTABLE$'):
                    self.read(CFixture(str(path)))

    def test_executable_global_write_allowed_symlink_rejected(self) -> None:
        child = self.exe.parent / 'child'
        child.mkdir(mode=0o700)
        target = child / 'file'
        target.write_bytes(b'synthetic')
        target.chmod(0o600)
        linked = self.exe.parent / 'linked-dir'
        linked.symlink_to(child)
        with self.assertRaisesRegex(ValueError, '^UNTRUSTED_EXECUTABLE$'):
            self.read(CFixture(str(linked / 'file')))
        # Approved scope permits group-write and sticky world-write only.
        for mode in [0o775, 0o1777]:
            child.chmod(mode)
            for gid in [0, 80]:
                with ancestor_group(child, gid):
                    snapshot = self.read(CFixture(str(target)))
                self.assertEqual(snapshot.sha256,
                                 hashlib.sha256(b'synthetic').hexdigest())

    def test_executable_rejects_other_write_without_sticky(self) -> None:
        for mode in [0o777, 0o757]:
            with self.subTest(mode=mode):
                self.exe.parent.chmod(mode)
                with self.assertRaisesRegex(
                        ValueError, '^UNTRUSTED_EXECUTABLE$'):
                    self.read()

    def test_group_write_requires_wheel_or_admin_ancestor(self) -> None:
        self.exe.parent.chmod(0o775)
        original = os.lstat
        for gid in [20, 99, 501]:
            def group(path):
                info = original(path)
                if str(path) == str(self.exe.parent):
                    row = list(info)
                    row[5] = gid
                    return os.stat_result(row)
                return info
            with self.subTest(gid=gid), patch.object(
                    identity.os, 'lstat', side_effect=group):
                with self.assertRaisesRegex(
                        ValueError, '^UNTRUSTED_EXECUTABLE$'):
                    self.read()

    def test_executable_rejects_foreign_nonroot_ancestor(self) -> None:
        original = os.lstat
        ancestor = self.exe.parent
        def foreign(path):
            info = original(path)
            if str(path) == str(ancestor):
                row = list(info)
                row[4] = os.getuid() + 1000
                return os.stat_result(row)
            return info
        with patch.object(identity.os, 'lstat', side_effect=foreign):
            with self.assertRaisesRegex(ValueError, '^UNTRUSTED_EXECUTABLE$'):
                self.read()

    def test_executable_rejects_observed_ancestor_inode_change(self) -> None:
        original_stat = os.lstat
        original_read = os.read
        changed = False
        def read(fd, count):
            nonlocal changed
            data = original_read(fd, count)
            changed = True
            return data
        def lstat(path):
            info = original_stat(path)
            if changed and str(path) == str(self.exe.parent):
                row = list(info)
                row[1] += 1
                return os.stat_result(row)
            return info
        with patch.object(identity.os, 'read', side_effect=read), \
                patch.object(identity.os, 'lstat', side_effect=lstat):
            with self.assertRaisesRegex(ValueError, '^UNTRUSTED_EXECUTABLE$'):
                self.read()

    def private_code(self, global_mode: int = 0o775) -> tuple[Path, Path, str]:
        parent = self.exe.parent / f'global-parent-{global_mode}'
        parent.mkdir(mode=0o700)
        parent.chmod(global_mode)
        self.enterContext(ancestor_group(parent, 80))
        root = parent / 'private-root'
        root.mkdir(mode=0o700)
        code = root / 'code.py'
        code.write_bytes(b'fixed synthetic bootstrap code')
        code.chmod(0o644)
        pin = hashlib.sha256(b'fixed synthetic bootstrap code').hexdigest()
        return root, code, pin

    def test_private_root_and_pin_under_writable_global_parents(self) -> None:
        for mode in [0o775, 0o1777]:
            with self.subTest(mode=mode):
                root, code, pin = self.private_code(mode)
                self.assertIsNone(identity.validatePrivateRoot(str(root)))
                with ancestor_group(root.parent, 80):
                    self.assertEqual(identity.hashPrivateCode(
                        str(root), str(code), pin), pin)
                code.unlink()
                root.rmdir()
                root.parent.rmdir()

    def test_private_root_type_mode_symlink_and_owner(self) -> None:
        root, _, _ = self.private_code()
        root.chmod(0o755)
        with self.assertRaisesRegex(ValueError, '^UNTRUSTED_PRIVATE_ROOT$'):
            identity.validatePrivateRoot(str(root))
        root.chmod(0o700)
        linked = root.parent / 'linked-root'
        linked.symlink_to(root)
        for path in [str(linked), 'relative-root', str(self.exe), None]:
            with self.assertRaisesRegex(ValueError,
                                        '^UNTRUSTED_PRIVATE_ROOT$'):
                identity.validatePrivateRoot(path)
        original = os.lstat
        def foreign(path):
            info = original(path)
            if str(path) == str(root):
                row = list(info)
                row[4] = os.getuid() + 1000
                return os.stat_result(row)
            return info
        with patch.object(identity.os, 'lstat', side_effect=foreign):
            with self.assertRaisesRegex(ValueError,
                                        '^UNTRUSTED_PRIVATE_ROOT$'):
                identity.validatePrivateRoot(str(root))

    def test_private_internal_directory_modes_and_symlink(self) -> None:
        root, _, pin = self.private_code()
        child = root / 'inside'
        child.mkdir(mode=0o700)
        code = child / 'code.py'
        code.write_bytes(b'fixed synthetic bootstrap code')
        code.chmod(0o644)
        self.assertEqual(identity.hashPrivateCode(
            str(root), str(code), pin), pin)
        for mode in [0o740, 0o720, 0o701]:
            child.chmod(mode)
            with self.assertRaisesRegex(ValueError,
                                        '^UNTRUSTED_PRIVATE_CODE$'):
                identity.hashPrivateCode(str(root), str(code), pin)
        child.chmod(0o700)
        linked = root / 'linked'
        linked.symlink_to(child)
        with self.assertRaisesRegex(ValueError, '^UNTRUSTED_PRIVATE_CODE$'):
            identity.hashPrivateCode(str(root), str(linked / 'code.py'), pin)

    def test_private_code_escape_symlink_and_pin(self) -> None:
        root, code, pin = self.private_code()
        for path in [str(self.exe), str(root / '..' / 'private-root/code.py')]:
            with self.assertRaisesRegex(ValueError,
                                        '^UNTRUSTED_PRIVATE_CODE$'):
                identity.hashPrivateCode(str(root), path, pin)
        linked = root / 'linked.py'
        linked.symlink_to(code)
        with self.assertRaisesRegex(ValueError, '^UNTRUSTED_PRIVATE_CODE$'):
            identity.hashPrivateCode(str(root), str(linked), pin)
        with self.assertRaisesRegex(ValueError, '^PRIVATE_CODE_PIN_MISMATCH$'):
            identity.hashPrivateCode(str(root), str(code), '0' * 64)
        for invalid in [None, pin.upper(), '0' * 63, 'g' * 64]:
            with self.assertRaisesRegex(ValueError,
                                        '^INVALID_PRIVATE_CODE_PIN$'):
                identity.hashPrivateCode(str(root), str(code), invalid)

    def test_private_code_keeps_leaf_owner_and_write_rules(self) -> None:
        root, code, pin = self.private_code()
        for mode in [0o620, 0o602]:
            code.chmod(mode)
            with self.assertRaisesRegex(ValueError,
                                        '^UNTRUSTED_PRIVATE_CODE$'):
                identity.hashPrivateCode(str(root), str(code), pin)
        code.chmod(0o644)
        original = os.lstat
        def foreign(path):
            info = original(path)
            if str(path) == str(code):
                row = list(info)
                row[4] = os.getuid() + 1000
                return os.stat_result(row)
            return info
        with patch.object(identity.os, 'lstat', side_effect=foreign):
            with self.assertRaisesRegex(ValueError,
                                        '^UNTRUSTED_PRIVATE_CODE$'):
                identity.hashPrivateCode(str(root), str(code), pin)

    def test_private_root_replacement_during_hash_rejected(self) -> None:
        root, code, pin = self.private_code()
        original = os.read
        replaced = False
        def replacing(fd, count):
            nonlocal replaced
            data = original(fd, count)
            if not replaced:
                moved = root.parent / 'old-root'
                root.rename(moved)
                root.mkdir(mode=0o700)
                os.link(moved / code.name, root / code.name)
                replaced = True
            return data
        with patch.object(identity.os, 'read', side_effect=replacing):
            with self.assertRaisesRegex(ValueError,
                                        '^UNTRUSTED_PRIVATE_CODE$'):
                identity.hashPrivateCode(str(root), str(code), pin)

    def test_private_tree_inode_change_rejected(self) -> None:
        root, code, pin = self.private_code()
        child = root / 'inside'
        child.mkdir(mode=0o700)
        moved = child / code.name
        code.rename(moved)
        original_stat = os.lstat
        original_read = os.read
        for changed_directory in [root, child]:
            changed = False
            def read(fd, count):
                nonlocal changed
                data = original_read(fd, count)
                changed = True
                return data
            def lstat(path):
                info = original_stat(path)
                if changed and str(path) == str(changed_directory):
                    row = list(info)
                    row[1] += 1
                    return os.stat_result(row)
                return info
            with patch.object(identity.os, 'read', side_effect=read), \
                    patch.object(identity.os, 'lstat', side_effect=lstat):
                with self.assertRaisesRegex(ValueError,
                                            '^UNTRUSTED_PRIVATE_CODE$'):
                    identity.hashPrivateCode(str(root), str(moved), pin)

    def test_fixture_foreign_owner_rejected(self) -> None:
        original = os.fstat
        def foreign(fd):
            row = list(original(fd))
            row[4] = os.getuid() + 1000
            return os.stat_result(row)
        with patch.object(identity.os, 'fstat', side_effect=foreign):
            with self.assertRaisesRegex(ValueError, '^UNTRUSTED_EXECUTABLE$'):
                self.read()

    def test_hash_does_not_accept_file_mutation_during_read(self) -> None:
        original = os.read
        modified = False
        def changing(fd, count):
            nonlocal modified
            data = original(fd, count)
            if not modified:
                self.exe.write_bytes(b'changed synthetic content')
                modified = True
            return data
        with patch.object(identity.os, 'read', side_effect=changing):
            with self.assertRaisesRegex(ValueError, '^UNTRUSTED_EXECUTABLE$'):
                self.read()

    def test_close_failure_keeps_fixed_code(self) -> None:
        original = os.close
        def failing_close(fd):
            original(fd)
            raise OSError('synthetic private close text')
        with patch.object(identity.os, 'close', side_effect=failing_close):
            with self.assertRaisesRegex(ValueError, '^UNTRUSTED_EXECUTABLE$'):
                self.read()

    def test_audit_token_fixed_indices_and_immutable_json(self) -> None:
        peer = identity.decodeAuditToken(audit_bytes())
        self.assertEqual(peer.to_json(),
                         {'pid': 73, 'uid': 501, 'pidVersion': 11})
        with self.assertRaises(dataclasses.FrozenInstanceError):
            peer.pid = 74

    def test_bad_token_length_type_pid_or_uid_is_rejected(self) -> None:
        for token in [None, 'token', bytes(31), bytes(33), audit_bytes(pid=0),
                      audit_bytes(pid=1), audit_bytes(pid=1 << 31),
                      audit_bytes(uid=0xffffffff)]:
            with self.subTest(token=token):
                with self.assertRaisesRegex(
                        ValueError, '^INVALID_AUDIT_TOKEN$'):
                    identity.decodeAuditToken(token)

    def test_production_bad_runtime_never_loads_library(self) -> None:
        for platform, version in [('linux', (3, 13, 14)),
                                  ('darwin', (3, 13, 13))]:
            with patch.object(identity.sys, 'platform', platform), \
                    patch.object(identity.sys, 'version_info', version), \
                    patch.object(identity.ctypes, 'CDLL') as load:
                inspector = identity.MacIdentityInspector()
                self.assertFalse(load.called)
                with self.assertRaisesRegex(
                        ValueError, '^UNSUPPORTED_IDENTITY_RUNTIME$'):
                    inspector.read(73)
                with self.assertRaisesRegex(
                        ValueError, '^UNSUPPORTED_IDENTITY_RUNTIME$'):
                    identity.auditPeer(SimpleNamespace())
                self.assertFalse(load.called)

    def test_identity_runtime_floor_is_3_13_14_without_ceiling(self) -> None:
        for version in [(3, 13, 14), (3, 13, 15), (3, 14, 0)]:
            with patch.object(identity.sys, 'platform', 'darwin'), \
                    patch.object(identity.sys, 'version_info', version):
                identity._require_runtime()
        for version in [(3, 13, 13), (3, 12, 20)]:
            with patch.object(identity.sys, 'platform', 'darwin'), \
                    patch.object(identity.sys, 'version_info', version):
                with self.assertRaisesRegex(
                        ValueError, '^UNSUPPORTED_IDENTITY_RUNTIME$'):
                    identity._require_runtime()

    def test_production_wrapper_uses_explicit_fixture(self) -> None:
        fixture = CFixture(str(self.exe))
        with patch.object(identity.sys, 'platform', 'darwin'), \
                patch.object(identity.sys, 'version_info', (3, 13, 14)), \
                patch.object(identity.ctypes, 'CDLL') as load:
            inspector = identity.MacIdentityInspector(fixture.api())
            self.assertEqual(inspector.read(73).to_json()['pid'], 73)
            self.assertFalse(load.called)

    def test_system_signatures_with_c_fixture(self) -> None:
        fixture = CFixture(str(self.exe))
        def info(*args):
            return fixture.pidinfo(*args)
        def path(*args):
            return fixture.pidpath(*args)
        library = SimpleNamespace(proc_pidinfo=info, proc_pidpath=path)
        with patch.object(identity.sys, 'platform', 'darwin'), \
                patch.object(identity.sys, 'version_info', (3, 13, 14)), \
                patch.object(identity.ctypes, 'CDLL',
                             return_value=library) as load:
            api = identity.KernelAPI.system()
            self.assertEqual(identity.inspectPid(api, 73).pid, 73)
        load.assert_called_once_with('/usr/lib/libproc.dylib', use_errno=True)
        self.assertEqual(info.argtypes, [ctypes.c_int, ctypes.c_int,
                                        ctypes.c_uint64, ctypes.c_void_p,
                                        ctypes.c_int])
        self.assertEqual(path.argtypes, [ctypes.c_int, ctypes.c_void_p,
                                        ctypes.c_uint32])
        self.assertIs(info.restype, ctypes.c_int)
        self.assertIs(path.restype, ctypes.c_int)

    def test_audit_peer_uses_exact_option_on_fixture(self) -> None:
        calls = []
        def getsockopt(*args):
            calls.append(args)
            return audit_bytes()
        with patch.object(identity.sys, 'platform', 'darwin'), \
                patch.object(identity.sys, 'version_info', (3, 13, 14)):
            peer = identity.auditPeer(SimpleNamespace(getsockopt=getsockopt))
        self.assertEqual(calls, [(0, 6, 32)])
        self.assertEqual(peer.to_json(),
                         {'pid': 73, 'uid': 501, 'pidVersion': 11})

    def test_import_performs_no_identity_io(self) -> None:
        spec = importlib.util.spec_from_file_location(
            'identity_import_fixture', SOURCE)
        fresh = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = fresh
        self.addCleanup(sys.modules.pop, spec.name)
        with patch.object(ctypes, 'CDLL',
                          side_effect=AssertionError('no kernel load')), \
                patch.object(os, 'open',
                             side_effect=AssertionError('no file open')):
            spec.loader.exec_module(fresh)


if __name__ == '__main__':
    unittest.main()
