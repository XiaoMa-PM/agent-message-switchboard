# INPUT: Fixed macOS C calls, Security.framework dynamic code lookups, peer token and executable/private-code trees.
# OUTPUT: Frozen snapshots (hashed, or signed with a pidversion-bound Developer ID signer, read via the short BSD info so
#         other users' ancestors such as a root login are readable), hashes and private-code pins.
# POS: Native primitives; no ancestry, sender or listener proof; a signer proves the running image, not its behavior.
import ctypes
from dataclasses import dataclass
import hashlib
import os
import re
import stat
import struct
import sys
from typing import Callable, Protocol


# ABI reference: Apple xnu-12377.121.6, bsd/sys/proc_info{,_private}.h,
# bsd/kern/kern_prot.c and libsyscall/wrappers/libproc/libproc.c.
class ProcBSDInfo(ctypes.Structure):
    _fields_ = [
        ('pbi_flags', ctypes.c_uint32), ('pbi_status', ctypes.c_uint32),
        ('pbi_xstatus', ctypes.c_uint32), ('pbi_pid', ctypes.c_uint32),
        ('pbi_ppid', ctypes.c_uint32), ('pbi_uid', ctypes.c_uint32),
        ('pbi_gid', ctypes.c_uint32), ('pbi_ruid', ctypes.c_uint32),
        ('pbi_rgid', ctypes.c_uint32), ('pbi_svuid', ctypes.c_uint32),
        ('pbi_svgid', ctypes.c_uint32), ('rfu_1', ctypes.c_uint32),
        ('pbi_comm', ctypes.c_char * 16), ('pbi_name', ctypes.c_char * 32),
        ('pbi_nfiles', ctypes.c_uint32), ('pbi_pgid', ctypes.c_uint32),
        ('pbi_pjobc', ctypes.c_uint32), ('e_tdev', ctypes.c_uint32),
        ('e_tpgid', ctypes.c_uint32), ('pbi_nice', ctypes.c_int32),
        ('pbi_start_tvsec', ctypes.c_uint64),
        ('pbi_start_tvusec', ctypes.c_uint64),
    ]


class ProcBSDShortInfo(ctypes.Structure):
    # PROC_PIDT_SHORTBSDINFO; unlike PROC_PIDTBSDINFO the kernel serves it for
    # other users' processes (a root-owned /usr/bin/login between terminal and shell).
    _fields_ = [
        ('pbsi_pid', ctypes.c_uint32), ('pbsi_ppid', ctypes.c_uint32),
        ('pbsi_pgid', ctypes.c_uint32), ('pbsi_status', ctypes.c_uint32),
        ('pbsi_comm', ctypes.c_char * 16), ('pbsi_flags', ctypes.c_uint32),
        ('pbsi_uid', ctypes.c_uint32), ('pbsi_gid', ctypes.c_uint32),
        ('pbsi_ruid', ctypes.c_uint32), ('pbsi_rgid', ctypes.c_uint32),
        ('pbsi_svuid', ctypes.c_uint32), ('pbsi_svgid', ctypes.c_uint32),
        ('pbsi_rfu', ctypes.c_uint32),
    ]


class ProcUniqueInfo(ctypes.Structure):
    _fields_ = [
        ('p_uuid', ctypes.c_uint8 * 16), ('p_uniqueid', ctypes.c_uint64),
        ('p_puniqueid', ctypes.c_uint64), ('p_idversion', ctypes.c_int32),
        ('p_orig_ppidversion', ctypes.c_int32),
        ('p_reserve2', ctypes.c_uint64), ('p_reserve3', ctypes.c_uint64),
    ]


class IdentityError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class KernelPeer:
    pid: int
    uid: int
    pid_version: int

    def to_json(self) -> dict[str, int]:
        return {'pid': self.pid, 'uid': self.uid,
                'pidVersion': self.pid_version}


@dataclass(frozen=True, slots=True)
class ProcessSnapshot:
    pid: int
    parent_pid: int
    uid: int
    pid_version: int
    unique_id: str
    parent_unique_id: str
    exe: str
    sha256: str
    _start_tvsec: str
    _start_tvusec: str

    def to_json(self) -> dict[str, int | str]:
        return {
            'pid': self.pid, 'parentPid': self.parent_pid, 'uid': self.uid,
            'pidVersion': self.pid_version, 'uniqueId': self.unique_id,
            'parentUniqueId': self.parent_unique_id, 'exe': self.exe,
            'sha256': self.sha256,
        }

    def start_time(self) -> tuple[str, str]:
        return self._start_tvsec, self._start_tvusec


@dataclass(frozen=True, slots=True)
class KernelAPI:
    proc_pidinfo: Callable[[int, int, int, object, int], int]
    proc_pidpath: Callable[[int, object, int], int]

    @classmethod
    def system(cls) -> 'KernelAPI':
        _require_runtime()
        _check_layout()
        try:
            library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
            info = library.proc_pidinfo
            path = library.proc_pidpath
            info.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                             ctypes.c_void_p, ctypes.c_int]
            path.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
            info.restype = path.restype = ctypes.c_int
            return cls(info, path)
        except (OSError, AttributeError):
            raise IdentityError('PROCESS_IDENTITY_UNAVAILABLE') from None


@dataclass(frozen=True, slots=True)
class Signer:
    team_id: str
    identifier: str
    runtime: bool

    def to_json(self) -> dict[str, str | bool]:
        return {'teamId': self.team_id, 'identifier': self.identifier,
                'runtime': self.runtime}


@dataclass(frozen=True, slots=True)
class SignedSnapshot:
    pid: int
    parent_pid: int
    uid: int
    pid_version: int
    unique_id: str
    parent_unique_id: str
    exe: str
    sha256: str | None
    signing: Signer | None

    def to_json(self) -> dict:
        return {
            'pid': self.pid, 'parentPid': self.parent_pid, 'uid': self.uid,
            'pidVersion': self.pid_version, 'uniqueId': self.unique_id,
            'parentUniqueId': self.parent_unique_id, 'exe': self.exe,
            'sha256': self.sha256,
            'signing': None if self.signing is None else self.signing.to_json(),
        }


# Security.framework: errSecCSNoSuchCode means the pid no longer carries this
# pidversion (exit, reuse or exec); ReqFailed/Unsigned mean "not Developer ID".
_NO_SUCH_CODE = -67065
_NOT_DEVELOPER_ID = frozenset({-67050, -67062})
_RUNTIME_FLAG = 0x10000
_TEAM = re.compile(r'[A-Z0-9]{10}')
_IDENTIFIER = re.compile(r'[A-Za-z0-9][A-Za-z0-9.-]{0,127}')


@dataclass(frozen=True, slots=True)
class CodeSigningAPI:
    guest: Callable[[int, int], tuple[int, object]]
    info: Callable[[object], tuple[str | None, str | None, int]]
    check: Callable[[object, str], int]
    release: Callable[[object], None]

    @classmethod
    def system(cls) -> 'CodeSigningAPI':
        _require_runtime()
        try:
            return _SecurityFramework().api()
        except (OSError, AttributeError, ValueError):
            raise IdentityError('CODE_SIGNING_UNAVAILABLE') from None


def _developer_id(team: str, identifier: str) -> str:
    return ('anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
            ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
            f' and certificate leaf[subject.OU] = "{team}" and identifier "{identifier}"')


def codeSigner(api: CodeSigningAPI, pid: int, pid_version: int) -> Signer | None:
    status, code = api.guest(pid, pid_version)
    if status == _NO_SUCH_CODE:
        raise IdentityError('INVALID_PROCESS_IDENTITY')
    if status != 0:
        raise IdentityError('CODE_SIGNING_UNAVAILABLE')
    try:
        try:
            team, identifier, flags = api.info(code)
        except Exception:
            raise IdentityError('CODE_SIGNING_UNAVAILABLE') from None
        if (type(team) is not str or type(identifier) is not str
                or not _TEAM.fullmatch(team) or not _IDENTIFIER.fullmatch(identifier)):
            return None
        checked = api.check(code, _developer_id(team, identifier))
        if checked in _NOT_DEVELOPER_ID:
            return None
        if checked == _NO_SUCH_CODE:
            raise IdentityError('INVALID_PROCESS_IDENTITY')
        if checked != 0:
            raise IdentityError('CODE_SIGNING_UNAVAILABLE')
        return Signer(team, identifier, bool(flags & _RUNTIME_FLAG))
    finally:
        api.release(code)


class MacIdentityInspector:
    def __init__(self, kernel: KernelAPI | None = None,
                 signing: CodeSigningAPI | None = None) -> None:
        self._kernel = kernel
        self._signing = signing

    def read(self, pid: int) -> ProcessSnapshot:
        _require_runtime()
        if self._kernel is None:
            self._kernel = KernelAPI.system()
        return inspectPid(self._kernel, pid)

    def read_signed(self, pid: int) -> SignedSnapshot:
        _require_runtime()
        if self._kernel is None:
            self._kernel = KernelAPI.system()
        if self._signing is None:
            self._signing = CodeSigningAPI.system()
        return inspectSignedPid(self._kernel, self._signing, pid)


class AuditSocket(Protocol):
    def getsockopt(self, level: int, option: int, size: int) -> bytes: ...


def auditPeer(connected_socket: AuditSocket) -> KernelPeer:
    _require_runtime()
    try:
        token = connected_socket.getsockopt(0, 6, 32)
    except OSError:
        raise IdentityError('INVALID_AUDIT_TOKEN') from None
    return decodeAuditToken(token)


def decodeAuditToken(token: bytes) -> KernelPeer:
    if type(token) is not bytes or len(token) != 32:
        raise IdentityError('INVALID_AUDIT_TOKEN')
    values = (ctypes.c_uint32 * 8).from_buffer_copy(token)
    if not 1 < values[5] <= 0x7fffffff or values[1] == 0xffffffff:
        raise IdentityError('INVALID_AUDIT_TOKEN')
    return KernelPeer(values[5], values[1], values[7])


def _read_process(kernel: KernelAPI, pid: int) -> tuple:
    if type(pid) is not int or not 1 < pid <= 0x7fffffff:
        raise IdentityError('INVALID_PROCESS_ID')
    _check_layout()
    bsd = _read_info(kernel, pid, 3, ProcBSDInfo)
    unique = _read_info(kernel, pid, 17, ProcUniqueInfo)
    if (bsd.pbi_pid != pid or not 1 <= bsd.pbi_ppid <= 0x7fffffff
            or bsd.pbi_uid == 0xffffffff or unique.p_uniqueid == 0
            or unique.p_puniqueid == 0 or bsd.pbi_start_tvusec >= 1000000):
        raise IdentityError('INVALID_PROCESS_IDENTITY')
    return bsd, unique, _read_path(kernel, pid)


def inspectPid(kernel: KernelAPI, pid: int) -> ProcessSnapshot:
    bsd, unique, path = _read_process(kernel, pid)
    return ProcessSnapshot(
        pid, bsd.pbi_ppid, bsd.pbi_uid,
        ctypes.c_uint32(unique.p_idversion).value,
        str(unique.p_uniqueid), str(unique.p_puniqueid), path,
        _hash_executable(path), str(bsd.pbi_start_tvsec),
        str(bsd.pbi_start_tvusec),
    )


def _read_signed_process(kernel: KernelAPI, pid: int) -> tuple:
    if type(pid) is not int or not 1 < pid <= 0x7fffffff:
        raise IdentityError('INVALID_PROCESS_ID')
    _check_layout()
    short = _read_info(kernel, pid, 13, ProcBSDShortInfo)
    unique = _read_info(kernel, pid, 17, ProcUniqueInfo)
    if (short.pbsi_pid != pid or not 1 <= short.pbsi_ppid <= 0x7fffffff
            or short.pbsi_uid == 0xffffffff or unique.p_uniqueid == 0
            or unique.p_puniqueid == 0):
        raise IdentityError('INVALID_PROCESS_IDENTITY')
    return short, unique, _read_path(kernel, pid)


def inspectSignedPid(kernel: KernelAPI, signing: CodeSigningAPI,
                     pid: int) -> SignedSnapshot:
    short, unique, path = _read_signed_process(kernel, pid)
    version = ctypes.c_uint32(unique.p_idversion).value
    signer = codeSigner(signing, pid, version)
    after = _read_info(kernel, pid, 17, ProcUniqueInfo)
    if (after.p_idversion != unique.p_idversion
            or after.p_uniqueid != unique.p_uniqueid
            or _read_path(kernel, pid) != path):
        raise IdentityError('INVALID_PROCESS_IDENTITY')
    return SignedSnapshot(
        pid, short.pbsi_ppid, short.pbsi_uid, version,
        str(unique.p_uniqueid), str(unique.p_puniqueid), path,
        None if signer is not None else _hash_executable(path), signer,
    )


class _SecurityFramework:
    """ctypes binding for the four dynamic code-signing calls; CF objects are released here."""

    def __init__(self) -> None:
        void = ctypes.c_void_p
        cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        sec = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
        cf.CFDataCreate.restype = void
        cf.CFDataCreate.argtypes = [void, ctypes.c_char_p, ctypes.c_long]
        cf.CFDictionaryCreate.restype = void
        cf.CFDictionaryCreate.argtypes = [void, ctypes.POINTER(void), ctypes.POINTER(void),
                                          ctypes.c_long, void, void]
        cf.CFDictionaryGetValue.restype = void
        cf.CFDictionaryGetValue.argtypes = [void, void]
        cf.CFStringCreateWithCString.restype = void
        cf.CFStringCreateWithCString.argtypes = [void, ctypes.c_char_p, ctypes.c_uint32]
        cf.CFStringGetCString.restype = ctypes.c_bool
        cf.CFStringGetCString.argtypes = [void, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
        cf.CFNumberGetValue.restype = ctypes.c_bool
        cf.CFNumberGetValue.argtypes = [void, ctypes.c_long, void]
        cf.CFGetTypeID.restype = cf.CFStringGetTypeID.restype = ctypes.c_ulong
        cf.CFNumberGetTypeID.restype = ctypes.c_ulong
        cf.CFGetTypeID.argtypes = [void]
        cf.CFRelease.argtypes = [void]
        for name, arguments in (('SecCodeCopyGuestWithAttributes', [void, void, ctypes.c_uint32, ctypes.POINTER(void)]),
                                ('SecCodeCopySigningInformation', [void, ctypes.c_uint32, ctypes.POINTER(void)]),
                                ('SecRequirementCreateWithString', [void, ctypes.c_uint32, ctypes.POINTER(void)]),
                                ('SecCodeCheckValidity', [void, ctypes.c_uint32, void])):
            getattr(sec, name).argtypes = arguments
            getattr(sec, name).restype = ctypes.c_int32
        self.cf, self.sec = cf, sec
        self.audit = void.in_dll(sec, 'kSecGuestAttributeAudit').value
        self.team_key = void.in_dll(sec, 'kSecCodeInfoTeamIdentifier').value
        self.identifier_key = void.in_dll(sec, 'kSecCodeInfoIdentifier').value
        self.flags_key = void.in_dll(sec, 'kSecCodeInfoFlags').value
        self.key_callbacks = ctypes.addressof(ctypes.c_char.in_dll(cf, 'kCFTypeDictionaryKeyCallBacks'))
        self.value_callbacks = ctypes.addressof(ctypes.c_char.in_dll(cf, 'kCFTypeDictionaryValueCallBacks'))
        if not all((self.audit, self.team_key, self.identifier_key, self.flags_key)):
            raise ValueError('CODE_SIGNING_UNAVAILABLE')

    def guest(self, pid: int, pid_version: int) -> tuple[int, object]:
        # Only val[5] (pid) and val[7] (pidversion) of an audit token select the guest.
        token = struct.pack('=8I', 0, 0, 0, 0, 0, pid, 0, pid_version)
        data = self.cf.CFDataCreate(None, token, len(token))
        if not data:
            return -1, None
        keys = (ctypes.c_void_p * 1)(self.audit)
        values = (ctypes.c_void_p * 1)(data)
        attributes = self.cf.CFDictionaryCreate(None, keys, values, 1, self.key_callbacks, self.value_callbacks)
        self.cf.CFRelease(data)
        if not attributes:
            return -1, None
        code = ctypes.c_void_p()
        try:
            status = self.sec.SecCodeCopyGuestWithAttributes(None, attributes, 0, ctypes.byref(code))
        finally:
            self.cf.CFRelease(attributes)
        return (status, code.value) if status != 0 or code.value else (-1, None)

    def info(self, code: object) -> tuple[str | None, str | None, int]:
        out = ctypes.c_void_p()
        if self.sec.SecCodeCopySigningInformation(code, 2, ctypes.byref(out)) != 0 or not out.value:
            raise OSError('CODE_SIGNING_UNAVAILABLE')
        try:
            return (self._string(self.cf.CFDictionaryGetValue(out, self.team_key)),
                    self._string(self.cf.CFDictionaryGetValue(out, self.identifier_key)),
                    self._number(self.cf.CFDictionaryGetValue(out, self.flags_key)))
        finally:
            self.cf.CFRelease(out)

    def _string(self, ref: object) -> str | None:
        if not ref or self.cf.CFGetTypeID(ref) != self.cf.CFStringGetTypeID():
            return None
        buffer = ctypes.create_string_buffer(256)
        if not self.cf.CFStringGetCString(ref, buffer, 256, 0x08000100):
            return None
        return buffer.value.decode('utf-8')

    def _number(self, ref: object) -> int:
        value = ctypes.c_int64()
        if (not ref or self.cf.CFGetTypeID(ref) != self.cf.CFNumberGetTypeID()
                or not self.cf.CFNumberGetValue(ref, 4, ctypes.byref(value))):
            return 0
        return value.value

    def check(self, code: object, requirement: str) -> int:
        text = self.cf.CFStringCreateWithCString(None, requirement.encode('utf-8'), 0x08000100)
        if not text:
            return -1
        compiled = ctypes.c_void_p()
        try:
            status = self.sec.SecRequirementCreateWithString(text, 0, ctypes.byref(compiled))
        finally:
            self.cf.CFRelease(text)
        if status != 0 or not compiled.value:
            return -1
        try:
            return self.sec.SecCodeCheckValidity(code, 0, compiled)
        finally:
            self.cf.CFRelease(compiled)

    def release(self, code: object) -> None:
        self.cf.CFRelease(code)

    def api(self) -> CodeSigningAPI:
        return CodeSigningAPI(self.guest, self.info, self.check, self.release)


def _require_runtime() -> None:
    if sys.platform != 'darwin' or tuple(sys.version_info[:3]) < (3, 13, 14):
        raise IdentityError('UNSUPPORTED_IDENTITY_RUNTIME')


def _check_layout() -> None:
    expected = (
        ctypes.sizeof(ProcBSDInfo) == 136,
        ProcBSDInfo.pbi_pid.offset == 12, ProcBSDInfo.pbi_ppid.offset == 16,
        ProcBSDInfo.pbi_uid.offset == 20,
        ProcBSDInfo.pbi_start_tvsec.offset == 120,
        ProcBSDInfo.pbi_start_tvusec.offset == 128,
        ctypes.sizeof(ProcBSDShortInfo) == 64,
        ProcBSDShortInfo.pbsi_ppid.offset == 4,
        ProcBSDShortInfo.pbsi_uid.offset == 36,
        ctypes.sizeof(ProcUniqueInfo) == 56,
        ProcUniqueInfo.p_uniqueid.offset == 16,
        ProcUniqueInfo.p_puniqueid.offset == 24,
        ProcUniqueInfo.p_idversion.offset == 32,
    )
    if not all(expected):
        raise IdentityError('INVALID_KERNEL_LAYOUT')


def _read_info(kernel: KernelAPI, pid: int, flavor: int,
               structure: type[ctypes.Structure]) -> ctypes.Structure:
    value = structure()
    size = ctypes.sizeof(value)
    try:
        result = kernel.proc_pidinfo(pid, flavor, 0, ctypes.byref(value), size)
    except (OSError, ctypes.ArgumentError):
        raise IdentityError('PROCESS_IDENTITY_UNAVAILABLE') from None
    if type(result) is not int or result != size:
        raise IdentityError('PROCESS_IDENTITY_UNAVAILABLE')
    return value


def _read_path(kernel: KernelAPI, pid: int) -> str:
    buffer = ctypes.create_string_buffer(4096)
    try:
        size = kernel.proc_pidpath(pid, buffer, 4096)
    except (OSError, ctypes.ArgumentError):
        raise IdentityError('INVALID_PROCESS_PATH') from None
    raw = bytes(buffer)
    if (type(size) is not int or not 0 < size < 4096
            or raw.find(b'\0') != size):
        raise IdentityError('INVALID_PROCESS_PATH')
    try:
        path = raw[:size].decode('utf-8')
    except UnicodeError:
        raise IdentityError('INVALID_PROCESS_PATH') from None
    if not os.path.isabs(path):
        raise IdentityError('INVALID_PROCESS_PATH')
    return path


def _trusted_mode(info: os.stat_result, directory: bool) -> None:
    valid_type = (stat.S_ISDIR(info.st_mode) if directory
                  else stat.S_ISREG(info.st_mode))
    if (not valid_type or info.st_uid not in (0, os.getuid())
            or info.st_mode & 0o022):
        raise IdentityError('UNTRUSTED_EXECUTABLE')


def _file_signature(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _executable_tree(path: str) -> tuple:
    rows = []
    directory = os.path.dirname(path)
    while True:
        info = os.lstat(directory)
        if (os.path.realpath(directory) != directory
                or not stat.S_ISDIR(info.st_mode)
                or info.st_uid not in (0, os.getuid())
                or (info.st_mode & 0o020 and info.st_gid not in (0, 80))
                or (info.st_mode & 0o002 and not info.st_mode & stat.S_ISVTX)):
            raise IdentityError('UNTRUSTED_EXECUTABLE')
        rows.append((directory, (info.st_dev, info.st_ino,
                                 info.st_mode, info.st_uid, info.st_gid)))
        parent = os.path.dirname(directory)
        if parent == directory:
            return tuple(rows)
        directory = parent


def _hash_executable(path: str) -> str:
    descriptor = None
    try:
        if (not os.path.isabs(path) or os.path.normpath(path) != path
                or os.path.realpath(path) != path):
            raise IdentityError('UNTRUSTED_EXECUTABLE')
        tree_before = _executable_tree(path)
        before = os.lstat(path)
        _trusted_mode(before, False)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        opened = os.fstat(descriptor)
        _trusted_mode(opened, False)
        expected = _file_signature(before)
        if _file_signature(opened) != expected:
            raise IdentityError('UNTRUSTED_EXECUTABLE')
        digest = hashlib.sha256()
        while chunk := os.read(descriptor, 65536):
            digest.update(chunk)
        if (_file_signature(os.fstat(descriptor)) != expected
                or _file_signature(os.lstat(path)) != expected
                or _executable_tree(path) != tree_before):
            raise IdentityError('UNTRUSTED_EXECUTABLE')
        return digest.hexdigest()
    except (OSError, ValueError):
        raise IdentityError('UNTRUSTED_EXECUTABLE') from None
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                raise IdentityError('UNTRUSTED_EXECUTABLE') from None


def validatePrivateRoot(root: str) -> None:
    _private_root_stat(root)


def _private_root_stat(root: str) -> os.stat_result:
    try:
        if (type(root) is not str or not os.path.isabs(root)
                or os.path.normpath(root) != root
                or os.path.realpath(root) != root):
            raise IdentityError('UNTRUSTED_PRIVATE_ROOT')
        info = os.lstat(root)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077):
            raise IdentityError('UNTRUSTED_PRIVATE_ROOT')
        return info
    except (OSError, ValueError):
        raise IdentityError('UNTRUSTED_PRIVATE_ROOT') from None


def _private_tree(root: str, path: str) -> tuple:
    rows = []
    directory = os.path.dirname(path)
    while True:
        info = _private_root_stat(directory)
        rows.append((directory, (info.st_dev, info.st_ino,
                                 info.st_mode, info.st_uid, info.st_gid)))
        if directory == root:
            return tuple(rows)
        directory = os.path.dirname(directory)


def hashPrivateCode(root: str, path: str, expectedSha256: str) -> str:
    if (type(expectedSha256) is not str or len(expectedSha256) != 64
            or any(char not in '0123456789abcdef' for char in expectedSha256)):
        raise IdentityError('INVALID_PRIVATE_CODE_PIN')
    validatePrivateRoot(root)
    try:
        if (type(path) is not str or not os.path.isabs(path)
                or os.path.normpath(path) != path
                or os.path.realpath(path) != path or path == root
                or os.path.commonpath([root, path]) != root):
            raise IdentityError('UNTRUSTED_PRIVATE_CODE')
        before = _private_tree(root, path)
        file_before = os.lstat(path)
        if file_before.st_uid != os.getuid():
            raise IdentityError('UNTRUSTED_PRIVATE_CODE')
        digest = _hash_executable(path)
        if (before != _private_tree(root, path)
                or _file_signature(file_before)
                != _file_signature(os.lstat(path))):
            raise IdentityError('UNTRUSTED_PRIVATE_CODE')
    except (OSError, ValueError):
        raise IdentityError('UNTRUSTED_PRIVATE_CODE') from None
    if digest != expectedSha256:
        raise IdentityError('PRIVATE_CODE_PIN_MISMATCH')
    return digest
