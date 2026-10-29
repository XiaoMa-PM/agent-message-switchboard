# INPUT: Synthetic Security.framework results, synthetic C calls and (on darwin) the real framework against this test process.
# OUTPUT: Developer ID signer rules, pidversion-bound guest lookups, signed snapshots without file hashing and fail-closed codes.
# POS: Offline code-signing identity tests; the Anthropic-signed positive case is left to real acceptance.
import ctypes
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = (Path(__file__).resolve().parents[2]
          / 'src/bridge/native/macos_identity.py')
spec = importlib.util.spec_from_file_location('macos_identity_signing', SOURCE)
identity = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = identity
spec.loader.exec_module(identity)

TEAM = 'Q6L2SF6YDW'
CLI = 'com.anthropic.claude-code'
REQUIREMENT = ('anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
               ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
               f' and certificate leaf[subject.OU] = "{TEAM}" and identifier "{CLI}"')


class FakeSigning:
    def __init__(self, guest_status: int = 0, team: str | None = TEAM,
                 identifier: str | None = CLI, flags: int = 0x10000,
                 check_status: int = 0, info_error: bool = False) -> None:
        self.guest_status, self.team, self.identifier = guest_status, team, identifier
        self.flags, self.check_status, self.info_error = flags, check_status, info_error
        self.calls: list[tuple] = []

    def guest(self, pid: int, version: int) -> tuple[int, object]:
        self.calls.append(('guest', pid, version))
        return self.guest_status, 'code'

    def info(self, code: object) -> tuple:
        self.calls.append(('info', code))
        if self.info_error:
            raise OSError('private framework detail')
        return self.team, self.identifier, self.flags

    def check(self, code: object, requirement: str) -> int:
        self.calls.append(('check', requirement))
        return self.check_status

    def release(self, code: object) -> None:
        self.calls.append(('release', code))

    def api(self):
        return identity.CodeSigningAPI(self.guest, self.info, self.check, self.release)


def bsd_bytes(pid: int = 73, parent: int = 41, uid: int = 501) -> bytes:
    import struct
    return struct.pack('=12I16s32s5IiQQ', 0, 0, 0, pid, parent, uid, 20, 502, 21, 503, 22, 0,
                       b'unused', b'unused', 0, 0, 0, 0, 0, 0, 1700000000, 123456)


def unique_bytes(unique: int = (1 << 63) + 7, version: int = 11, parent: int = (1 << 63) + 3) -> bytes:
    import struct
    return struct.pack('=16sQQiiQQ', bytes(16), unique, parent, version, 0, 0, 0)


def short_bytes(pid: int = 73, parent: int = 41, uid: int = 501, ruid: int = 501) -> bytes:
    import struct
    return struct.pack('=4I16s8I', pid, parent, 30, 2, b'unused', 0, uid, 20, ruid, 21, 22, 23, 0)


class Kernel:
    def __init__(self, path: str, uniques: list[bytes] | None = None, paths: list[str] | None = None,
                 short: bytes | None = None, short_count: int = 64) -> None:
        self.uniques = uniques or [unique_bytes()]
        self.paths = paths or [path]
        self.short, self.short_count = short, short_count
        self.calls: list[tuple] = []

    def pidinfo(self, pid: int, flavor: int, arg: int, buffer: object, size: int) -> int:
        self.calls.append((pid, flavor))
        if flavor == 3:
            payload = bsd_bytes(pid)
        elif flavor == 13:
            payload = self.short if self.short is not None else short_bytes(pid)
        else:
            payload = self.uniques[0] if len(self.uniques) == 1 else self.uniques.pop(0)
        ctypes.memmove(buffer, payload, min(len(payload), size))
        return {3: 136, 13: self.short_count}.get(flavor, 56)

    def pidpath(self, pid: int, buffer: object, size: int) -> int:
        self.calls.append((pid, 'path'))
        path = self.paths[0] if len(self.paths) == 1 else self.paths.pop(0)
        raw = os.fsencode(path) + b'\0'
        ctypes.memmove(buffer, raw, len(raw))
        return len(raw) - 1

    def api(self):
        return identity.KernelAPI(self.pidinfo, self.pidpath)


class SignerTests(unittest.TestCase):
    def test_developer_id_signer_is_bound_to_pid_version_and_uses_the_strict_requirement(self) -> None:
        fake = FakeSigning()
        signer = identity.codeSigner(fake.api(), 73, 11)
        self.assertEqual(signer.to_json(), {'teamId': TEAM, 'identifier': CLI, 'runtime': True})
        self.assertEqual(fake.calls, [('guest', 73, 11), ('info', 'code'), ('check', REQUIREMENT), ('release', 'code')])

    def test_missing_hardened_runtime_is_reported_not_hidden(self) -> None:
        self.assertEqual(identity.codeSigner(FakeSigning(flags=0x2).api(), 73, 11).runtime, False)

    def test_adhoc_platform_or_malformed_signers_are_none_without_interpolation(self) -> None:
        for fake in [FakeSigning(team=None), FakeSigning(identifier=None), FakeSigning(team='bad'),
                     FakeSigning(identifier='com.x" or anchor apple'), FakeSigning(identifier='')]:
            with self.subTest(team=fake.team, identifier=fake.identifier):
                self.assertIsNone(identity.codeSigner(fake.api(), 73, 11))
                self.assertFalse([call for call in fake.calls if call[0] == 'check'])
                self.assertEqual(fake.calls[-1], ('release', 'code'))

    def test_requirement_failures_mean_not_developer_id(self) -> None:
        for status in [-67050, -67062]:
            self.assertIsNone(identity.codeSigner(FakeSigning(check_status=status).api(), 73, 11))

    def test_stale_process_and_framework_failures_fail_closed_with_fixed_codes(self) -> None:
        cases = [(FakeSigning(guest_status=-67065), 'INVALID_PROCESS_IDENTITY'),
                 (FakeSigning(guest_status=-1), 'CODE_SIGNING_UNAVAILABLE'),
                 (FakeSigning(check_status=-67065), 'INVALID_PROCESS_IDENTITY'),
                 (FakeSigning(check_status=-67030), 'CODE_SIGNING_UNAVAILABLE'),
                 (FakeSigning(info_error=True), 'CODE_SIGNING_UNAVAILABLE')]
        for fake, code in cases:
            with self.subTest(code=code, calls=fake.calls):
                with self.assertRaisesRegex(ValueError, f'^{code}$'):
                    identity.codeSigner(fake.api(), 73, 11)
                if fake.guest_status == 0:
                    self.assertEqual(fake.calls[-1], ('release', 'code'))


class SignedSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix='.signing-fixture-', dir=SOURCE.parents[3])
        self.addCleanup(self.temp.cleanup)
        self.exe = Path(self.temp.name) / 'synthetic-executable'
        self.exe.write_bytes(b'not a real executable\n')
        self.exe.chmod(0o600)

    def test_signed_process_is_not_hashed_and_projects_signing(self) -> None:
        kernel, fake = Kernel('/missing/claude-code/2.1.306'), FakeSigning()
        snapshot = identity.inspectSignedPid(kernel.api(), fake.api(), 73)
        self.assertEqual(snapshot.to_json(), {
            'pid': 73, 'parentPid': 41, 'uid': 501, 'pidVersion': 11, 'uniqueId': str((1 << 63) + 7),
            'parentUniqueId': str((1 << 63) + 3), 'exe': '/missing/claude-code/2.1.306', 'sha256': None,
            'signing': {'teamId': TEAM, 'identifier': CLI, 'runtime': True}})
        self.assertEqual(kernel.calls, [(73, 13), (73, 17), (73, 'path'), (73, 17), (73, 'path')])
        self.assertEqual(fake.calls[0], ('guest', 73, 11))

    def test_another_users_ancestor_is_read_without_the_same_user_flavor(self) -> None:
        # A root-owned /usr/bin/login: PROC_PIDTBSDINFO would be EPERM, the short BSD info is not.
        kernel = Kernel(str(self.exe), short=short_bytes(73, 41, uid=0, ruid=501))
        snapshot = identity.inspectSignedPid(kernel.api(), FakeSigning(team=None).api(), 73)
        self.assertEqual((snapshot.uid, snapshot.parent_pid), (0, 41))
        self.assertNotIn((73, 3), kernel.calls)

    def test_short_bsd_info_failures_and_bad_fields_fail_closed(self) -> None:
        cases = [(Kernel('/x', short_count=0), 'PROCESS_IDENTITY_UNAVAILABLE'),
                 (Kernel('/x', short_count=63), 'PROCESS_IDENTITY_UNAVAILABLE'),
                 (Kernel('/x', short_count=65), 'PROCESS_IDENTITY_UNAVAILABLE'),
                 (Kernel('/x', short=short_bytes(pid=74)), 'INVALID_PROCESS_IDENTITY'),
                 (Kernel('/x', short=short_bytes(parent=0)), 'INVALID_PROCESS_IDENTITY'),
                 (Kernel('/x', short=short_bytes(uid=0xffffffff)), 'INVALID_PROCESS_IDENTITY'),
                 (Kernel('/x', uniques=[unique_bytes(unique=0)]), 'INVALID_PROCESS_IDENTITY'),
                 (Kernel('/x', uniques=[unique_bytes(parent=0)]), 'INVALID_PROCESS_IDENTITY')]
        for kernel, code in cases:
            with self.subTest(code=code, calls=kernel.calls):
                with self.assertRaisesRegex(ValueError, f'^{code}$'):
                    identity.inspectSignedPid(kernel.api(), FakeSigning().api(), 73)

    def test_short_bsd_layout_is_guarded_before_c(self) -> None:
        kernel = Kernel('/x')
        with patch.object(identity, '_check_layout', side_effect=identity.IdentityError('INVALID_KERNEL_LAYOUT')):
            with self.assertRaisesRegex(ValueError, '^INVALID_KERNEL_LAYOUT$'):
                identity.inspectSignedPid(kernel.api(), FakeSigning().api(), 73)
        self.assertEqual(kernel.calls, [])
        self.assertEqual((ctypes.sizeof(identity.ProcBSDShortInfo), identity.ProcBSDShortInfo.pbsi_ppid.offset,
                          identity.ProcBSDShortInfo.pbsi_uid.offset), (64, 4, 36))

    def test_legacy_inspect_keeps_the_full_bsd_info(self) -> None:
        kernel = Kernel(str(self.exe))
        identity.inspectPid(kernel.api(), 73)
        self.assertEqual(kernel.calls, [(73, 3), (73, 17), (73, 'path')])

    def test_unsigned_process_keeps_the_sha256_of_its_executable(self) -> None:
        snapshot = identity.inspectSignedPid(Kernel(str(self.exe)).api(), FakeSigning(team=None).api(), 73)
        self.assertEqual(snapshot.to_json()['sha256'], hashlib.sha256(self.exe.read_bytes()).hexdigest())
        self.assertIsNone(snapshot.to_json()['signing'])

    def test_exec_or_reuse_between_the_reads_is_rejected(self) -> None:
        for kernel in [Kernel('/x', uniques=[unique_bytes(version=11), unique_bytes(version=12)]),
                       Kernel('/x', uniques=[unique_bytes(), unique_bytes(unique=(1 << 63) + 9)]),
                       Kernel('/x', paths=['/x', '/y'])]:
            with self.assertRaisesRegex(ValueError, '^INVALID_PROCESS_IDENTITY$'):
                identity.inspectSignedPid(kernel.api(), FakeSigning().api(), 73)

    def test_inspector_reads_signed_with_injected_apis_and_rejects_bad_runtime(self) -> None:
        with patch.object(identity.sys, 'platform', 'darwin'), patch.object(identity.sys, 'version_info', (3, 13, 14)):
            inspector = identity.MacIdentityInspector(Kernel('/x').api(), FakeSigning().api())
            self.assertEqual(inspector.read_signed(73).to_json()['signing']['identifier'], CLI)
        with patch.object(identity.sys, 'platform', 'linux'), patch.object(identity.ctypes, 'CDLL') as load:
            with self.assertRaisesRegex(ValueError, '^UNSUPPORTED_IDENTITY_RUNTIME$'):
                identity.MacIdentityInspector().read_signed(73)
            self.assertFalse(load.called)


@unittest.skipUnless(sys.platform == 'darwin' and tuple(sys.version_info[:3]) >= (3, 13, 14),
                     'real Security.framework lookup needs macOS and the pinned runtime')
class RealFrameworkTests(unittest.TestCase):
    def test_this_process_and_a_platform_binary_are_not_anthropic_and_stale_versions_fail(self) -> None:
        signing = identity.CodeSigningAPI.system()
        kernel = identity.KernelAPI.system()
        child = subprocess.Popen(['/bin/sleep', '5'])
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        for pid in [os.getpid(), child.pid]:
            version = identity.inspectSignedPid(kernel, signing, pid).pid_version
            signer = identity.codeSigner(signing, pid, version)
            self.assertTrue(signer is None or signer.team_id != TEAM, signer)
            with self.assertRaisesRegex(ValueError, '^INVALID_PROCESS_IDENTITY$'):
                identity.codeSigner(signing, pid, (version + 1) & 0xffffffff)

    def test_signed_and_legacy_reads_agree_on_the_effective_uid_and_parent(self) -> None:
        kernel, signing = identity.KernelAPI.system(), identity.CodeSigningAPI.system()
        signed = identity.inspectSignedPid(kernel, signing, os.getpid())
        legacy = identity.inspectPid(kernel, os.getpid())
        self.assertEqual((signed.uid, signed.parent_pid, signed.unique_id, signed.pid_version),
                         (legacy.uid, legacy.parent_pid, legacy.unique_id, legacy.pid_version))
        self.assertEqual(signed.uid, os.geteuid())

    @unittest.skipIf(os.geteuid() == 0, 'root may read every process with the full BSD info')
    def test_a_live_root_process_is_readable_although_the_full_bsd_info_is_denied(self) -> None:
        kernel, signing = identity.KernelAPI.system(), identity.CodeSigningAPI.system()
        rows = subprocess.run(['/bin/ps', '-axo', 'pid=,uid='], capture_output=True, text=True, check=True).stdout
        roots = [int(pid) for pid, uid in (line.split() for line in rows.splitlines()) if uid == '0' and int(pid) > 1]
        for pid in roots:
            try:
                snapshot = identity.inspectSignedPid(kernel, signing, pid)
            except identity.IdentityError:
                continue  # exited meanwhile or an unreadable unsigned binary; try the next one
            self.assertEqual(snapshot.uid, 0)
            with self.assertRaisesRegex(ValueError, '^PROCESS_IDENTITY_UNAVAILABLE$'):
                identity.inspectPid(kernel, pid)
            return
        self.fail('no live root process could be read')


if __name__ == '__main__':
    unittest.main()
