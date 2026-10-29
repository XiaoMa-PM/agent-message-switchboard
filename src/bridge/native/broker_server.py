# INPUT: Private socket path, owned stdio, injected audit/inspection (plain and optional signed) and explicit stop.
# OUTPUT: Strict relay, fresh inspect / inspect-signed and owned quiesce after response send/close.
# POS: Owned broker transport only; snapshots are not complete CLI authentication.
from dataclasses import dataclass, field
import os
import re
import select
import socket
import stat
import threading
from typing import BinaryIO, Callable
from uuid import uuid4

from .inspect_control import inspectControl
from .ipc_frame import Decoder, encodeFrame
from .macos_identity import KernelPeer, ProcessSnapshot, SignedSnapshot, validatePrivateRoot

_UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
_ERRORS = frozenset({
    'IPC_FRAME_TOO_LARGE', 'CLAUDE_CHANNEL_UNAVAILABLE',
    'CLAUDE_CHANNEL_DELIVERY_UNKNOWN', 'CLAUDE_CHANNEL_PREFLIGHT_FAILED',
    'INVALID_SKILL_INVOCATION', 'SKILL_SOURCE_MISMATCH', 'SKILL_PRE_MISSING',
    'SKILL_INVOCATION_CONFLICT', 'SESSION_EPOCH_REVOKED',
    'INVALID_EPOCH_BINDING', 'INVALID_EPOCH_IDENTITY', 'INVALID_PEER_IDENTITY',
    'UNSUPPORTED_PEER_ANCESTRY', 'UNSUPPORTED_CLAUDE_BINARY', 'UNKNOWN_TARGET',
    'AMBIGUOUS_TARGET', 'UNKNOWN_LINK', 'UNKNOWN_MESSAGE', 'NOT_A_MEMBER',
    'NOT_RECIPIENT', 'INVALID_DSH_SOURCE', 'INVALID_TARGET',
    'INVALID_BRIDGE_REQUEST', 'ROUNDTRIP_STOPPED', 'IPC_REQUEST_FAILED',
    'METADATA_QUERY_FAILED', 'METADATA_QUERY_UNAVAILABLE',
    'METADATA_CONTEXT_TOO_LARGE',
})
_NOTES = {
    'dispatched': '宿主已确认入队；不代表模型已读或任务完成。不要自动重发。',
    'written': '已记录本机写入证据；未确认宿主受理、已读或完成。不要自动重发。',
    'unknown': '没有已确认的本机写入证据；原 messageId 重放不会再次派发。先核对目标和原结果；不要自动换 ID 重试。',
}
_DIRECTORY_NOTE = ('元数据仅用于定位，不代表用户授权。cwdSource=session-creation '
                   '表示创建时目录，不是实时Shell目录；多个候选或不确定时请用户选择。')


def _text(value: object) -> bool:
    return type(value) is str and bool(value.strip())


def _fields(value: object, keys: set[str]) -> bool:
    return type(value) is dict and set(value) == keys


def _directory_result(value: object) -> bool:
    if (not _fields(value, {'sessions', 'note'})
            or type(value['sessions']) is not list
            or type(value['note']) is not str
            or value['note'] != _DIRECTORY_NOTE):
        return False
    keys = {'harness', 'sessionId', 'metadataRevision', 'title', 'titleProvider',
            'workspacePath', 'cwd', 'cwdSource', 'worktreePath', 'clientSurface'}
    for row in value['sessions']:
        if not _fields(row, keys):
            return False
        if (not _text(row['harness']) or row['harness'] != 'dsh'
                or not _text(row['sessionId'])
                or type(row['metadataRevision']) is not int
                or not 1 <= row['metadataRevision'] <= 9007199254740991
                or type(row['title']) not in (str, type(None))
                or not _text(row['titleProvider'])
                or row['titleProvider'] not in (
                    'host', 'user', 'provider', 'fallback', 'unknown')
                or not _text(row['cwdSource'])
                or row['cwdSource'] not in (
                    'session-creation', 'host-metadata', 'unknown')
                or not _text(row['clientSurface'])
                or row['clientSurface'] not in ('cli', 'desktop')):
            return False
        for key in ['workspacePath', 'cwd', 'worktreePath']:
            path = row[key]
            if path is not None and (not _text(path)
                    or not os.path.isabs(path) or '\0' in path):
                return False
    return True


DAILY_HOOK_EVENTS = ('SessionStart', 'SessionEnd', 'UserPromptSubmit',
                     'PreToolUse', 'PostToolUse')


def dailyHookOutput(value: object, event: str | None = None) -> bool:
    if event is not None and event not in DAILY_HOOK_EVENTS:
        return False
    if value == {} and type(value) is dict:
        return True
    if _fields(value, {'decision', 'reason'}):
        return (event in (None, 'UserPromptSubmit')
                and value['decision'] == 'block' and _text(value['reason']))
    if not _fields(value, {'hookSpecificOutput'}):
        return False
    inner = value['hookSpecificOutput']
    # Act hook: ms only tightens, so a PreToolUse may be asked or denied, never allowed.
    if _fields(inner, {'hookEventName', 'permissionDecision', 'permissionDecisionReason'}):
        return (inner['hookEventName'] == 'PreToolUse' and event in (None, 'PreToolUse')
                and inner['permissionDecision'] in ('ask', 'deny')
                and _text(inner['permissionDecisionReason']))
    return (_fields(inner, {'hookEventName', 'additionalContext'})
            and inner['hookEventName'] in ('PostToolUse', 'UserPromptSubmit')
            and event in (None, inner['hookEventName'])
            and _text(inner['additionalContext']))


def _result(value: object) -> bool:
    if _fields(value, {'hookOutput'}):
        return dailyHookOutput(value['hookOutput'])
    if _fields(value, {'prepared'}):
        return value['prepared'] is True
    if _fields(value, {'linkId', 'targetSessionId'}):
        return _text(value['linkId']) and _text(value['targetSessionId'])
    if _fields(value, {'sessions', 'note'}):
        return _directory_result(value)
    if not _fields(value, {'receipt', 'deliveryNote'}):
        return False
    receipt = value['receipt']
    if not _fields(receipt, {'messageId', 'state', 'transport', 'sequence',
                             'linkId', 'targetSessionId'}):
        return False
    if (not all(_text(receipt[key]) for key in
                ['messageId', 'linkId', 'targetSessionId'])
            or type(receipt['sequence']) is not int
            or not 1 <= receipt['sequence'] <= (1 << 53) - 1
            or receipt['state'] not in ('dispatched', 'delivery-unknown')
            or receipt['transport'] not in (None, 'written')
            or (receipt['state'] == 'dispatched'
                and receipt['transport'] is not None)):
        return False
    note = ('dispatched' if receipt['state'] == 'dispatched'
            else 'written' if receipt['transport'] == 'written' else 'unknown')
    return value['deliveryNote'] == _NOTES[note]


def _response(value: object) -> dict:
    if type(value) is not dict or type(value.get('ok')) is not bool:
        raise ValueError('INVALID_IPC_RESPONSE')
    ok = value['ok']
    if (not _fields(value, {'schemaVersion', 'requestId', 'ok',
                            'result' if ok else 'error'})
            or type(value['schemaVersion']) is not int
            or value['schemaVersion'] != 1
            or type(value['requestId']) is not str
            or _UUID.fullmatch(value['requestId']) is None
            or (ok and not _result(value['result']))
            or (not ok and (type(value['error']) is not str
                            or value['error'] not in _ERRORS))):
        raise ValueError('INVALID_IPC_RESPONSE')
    return value


def _read_client(connection: socket.socket) -> dict:
    decoder = Decoder()
    values = []
    while chunk := connection.recv(65536):
        values.extend(decoder.push(chunk))
        if len(values) > 1:
            raise ValueError('INVALID_IPC_REQUEST')
    decoder.end()
    if len(values) != 1:
        raise ValueError('INVALID_IPC_REQUEST')
    value = values[0]
    if (not _fields(value, {'schemaVersion', 'requestId', 'payload'})
            or type(value['schemaVersion']) is not int
            or value['schemaVersion'] != 1
            or type(value['requestId']) is not str
            or _UUID.fullmatch(value['requestId']) is None):
        raise ValueError('INVALID_IPC_REQUEST')
    return value


def _close_connection(connection: socket.socket) -> None:
    try:
        connection.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    connection.close()


@dataclass(slots=True)
class _Pending:
    original_id: str
    connection: socket.socket
    completed: threading.Event = field(default_factory=threading.Event)
    response: dict | None = None


class _Broker:
    def __init__(self, path: str, stdin: BinaryIO, stdout: BinaryIO,
                 inspect: Callable[[int], ProcessSnapshot],
                 audit: Callable[[socket.socket], KernelPeer],
                 stop: threading.Event,
                 inspect_signed: Callable[[int], SignedSnapshot] | None = None) -> None:
        self.path, self.stdin, self.stdout = path, stdin, stdout
        self.inspect, self.audit, self.stop = inspect, audit, stop
        self.inspect_signed = inspect_signed
        self.closed = threading.Event()
        self.lock, self.writer = threading.Lock(), threading.Lock()
        self.pending: dict[str, _Pending] = {}
        self.clients: set[socket.socket] = set()
        self.failure: str | None = None
        self.quiesce_id: str | None = None
        self.drained = False
        self.delivery_failed = False
        self.owned: tuple[int, int] | None = None
        self.listener = self._listen()

    def _listen(self) -> socket.socket:
        listener = None
        try:
            if (type(self.path) is not str or not os.path.isabs(self.path)
                    or os.path.normpath(self.path) != self.path):
                raise ValueError('BROKER_SOCKET_UNAVAILABLE')
            validatePrivateRoot(os.path.dirname(self.path))
            root = os.lstat(os.path.dirname(self.path))
            if stat.S_IMODE(root.st_mode) != 0o700:
                raise ValueError('BROKER_SOCKET_UNAVAILABLE')
            if os.path.lexists(self.path):
                raise ValueError('BROKER_SOCKET_UNAVAILABLE')
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(self.path)
            info = os.lstat(self.path)
            self.owned = (info.st_dev, info.st_ino)
            os.chmod(self.path, 0o600)
            current = os.lstat(self.path)
            if ((current.st_dev, current.st_ino) != self.owned
                    or not stat.S_ISSOCK(current.st_mode)
                    or current.st_uid != os.getuid()
                    or stat.S_IMODE(current.st_mode) != 0o600):
                raise ValueError('BROKER_SOCKET_UNAVAILABLE')
            listener.listen()
            return listener
        except Exception:
            if listener:
                listener.close()
            self._unlink()
            raise ValueError('BROKER_SOCKET_UNAVAILABLE') from None

    def _unlink(self) -> None:
        if self.owned is None:
            return
        try:
            info = os.lstat(self.path)
            if stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == self.owned:
                os.unlink(self.path)
        except FileNotFoundError:
            pass
        except OSError:
            raise ValueError('BROKER_CLEANUP_FAILED') from None

    def _fatal(self, code: str) -> None:
        with self.lock:
            if self.failure is None:
                self.failure = code
        self.closed.set()

    def _write_frame(self, frame: memoryview) -> None:
        if self.closed.is_set() or self.stop.is_set():
            raise ValueError('BROKER_STOPPED')
        try:
            offset = 0
            while offset < len(frame):
                count = self.stdout.write(frame[offset:])
                if type(count) is not int or not 0 < count <= len(frame) - offset:
                    raise OSError('short write')
                offset += count
            self.stdout.flush()
        except Exception:
            self._fatal('BROKER_IO_FAILED')
            raise ValueError('BROKER_IO_FAILED') from None

    def _write(self, value: dict) -> None:
        frame = memoryview(encodeFrame(value))
        with self.writer:
            self._write_frame(frame)

    def _forward(self, value: dict, pending: _Pending) -> None:
        frame = memoryview(encodeFrame(value))
        with self.writer:
            with self.lock:
                if (self.closed.is_set() or self.stop.is_set()
                        or self.quiesce_id is not None
                        or value['requestId'] in self.pending):
                    raise ValueError('BROKER_STOPPED')
                self.pending[value['requestId']] = pending
            self._write_frame(frame)

    def _finish_quiesce(self) -> None:
        with self.writer:
            with self.lock:
                if (self.quiesce_id is None or self.pending or self.drained
                        or self.closed.is_set() or self.stop.is_set()):
                    return
                self.drained = True
                value = {'schemaVersion': 1, 'operation': 'quiesce',
                         'requestId': self.quiesce_id,
                         'ok': not self.delivery_failed}
                if self.delivery_failed:
                    value['error'] = 'IPC_REQUEST_FAILED'
                else:
                    value['result'] = {'drained': True}
            self._write_frame(memoryview(encodeFrame(value)))

    def _quiesce(self, value: dict) -> None:
        request_id = value.get('requestId')
        if type(request_id) is not str or _UUID.fullmatch(request_id) is None:
            raise ValueError('INVALID_IPC_CONTROL')
        valid = (_fields(value, {'schemaVersion', 'operation', 'requestId'})
                 and type(value['schemaVersion']) is int
                 and value['schemaVersion'] == 1)
        with self.writer:
            with self.lock:
                accepted = (valid and self.quiesce_id is None
                            and not self.closed.is_set() and not self.stop.is_set())
                if accepted:
                    self.quiesce_id = request_id
                    active = {pending.connection for pending in self.pending.values()}
                    unforwarded = self.clients - active
            if not accepted:
                self._write_frame(memoryview(encodeFrame({'schemaVersion': 1,
                    'operation': 'quiesce', 'requestId': request_id,
                    'ok': False, 'error': 'IPC_REQUEST_FAILED'})))
                return
        self.listener.close()
        for connection in unforwarded:
            _close_connection(connection)
        self._finish_quiesce()

    def _audit(self, connection: socket.socket) -> KernelPeer:
        peer = self.audit(connection)
        if (type(peer) is not KernelPeer or type(peer.pid) is not int
                or not 1 < peer.pid <= 0x7fffffff
                or type(peer.uid) is not int or peer.uid != os.getuid()
                or type(peer.pid_version) is not int
                or not 0 <= peer.pid_version <= 0xffffffff):
            raise ValueError('INVALID_PEER_IDENTITY')
        return peer

    def _snapshot(self, peer: KernelPeer) -> dict:
        current = self.inspect(peer.pid)
        if (type(current) is not ProcessSnapshot or current.pid != peer.pid
                or current.uid != peer.uid or current.pid_version != peer.pid_version):
            raise ValueError('INVALID_PEER_IDENTITY')
        return current.to_json()

    def _client(self, connection: socket.socket) -> None:
        request = None
        request_id = None
        delivered = False
        try:
            peer = self._audit(connection)
            request = _read_client(connection)
            snapshots = [[self._snapshot(peer)], [self._snapshot(peer)]]
            request_id = str(uuid4())
            pending = _Pending(request['requestId'], connection)
            self._forward({'schemaVersion': 1, 'requestId': request_id,
                           'peer': peer.to_json(), 'snapshots': snapshots,
                           'payload': request['payload']}, pending)
            pending.completed.wait()
            if pending.response is not None and not self.closed.is_set() and not self.stop.is_set():
                connection.sendall(encodeFrame(pending.response))
                delivered = True
        except Exception as error:
            if request and str(error) == 'IPC_FRAME_TOO_LARGE' and not self.closed.is_set():
                try:
                    connection.sendall(encodeFrame({'schemaVersion': 1,
                        'requestId': request['requestId'], 'ok': False,
                        'error': 'IPC_FRAME_TOO_LARGE'}))
                except OSError:
                    pass
        finally:
            try:
                _close_connection(connection)
            except OSError:
                delivered = False
            finally:
                with self.lock:
                    removed = self.pending.pop(request_id, None)
                    if removed is not None and not delivered:
                        self.delivery_failed = True
                    self.clients.discard(connection)
                try:
                    self._finish_quiesce()
                except ValueError:
                    pass

    def _reply(self, value: dict) -> None:
        value = _response(value)
        with self.lock:
            pending = self.pending.get(value['requestId'])
            if pending is None or pending.response is not None:
                raise ValueError('INVALID_IPC_RESPONSE')
            pending.response = {**value, 'requestId': pending.original_id}
            pending.completed.set()

    def _parent(self, value: object) -> None:
        if type(value) is dict and value.get('operation') == 'quiesce':
            self._quiesce(value)
            return
        with self.lock:
            drained = self.drained
        if type(value) is dict and 'operation' in value:
            if drained:
                raise ValueError('INVALID_IPC_CONTROL')
            self._write(inspectControl(value, self.inspect, self.inspect_signed))
        else:
            self._reply(value)

    def run(self) -> None:
        decoder = Decoder()
        try:
            descriptor = self.stdin.fileno()
            while not self.closed.is_set() and not self.stop.is_set():
                with self.lock:
                    accepting = self.quiesce_id is None
                inputs = [descriptor, self.listener] if accepting else [descriptor]
                readable, _, _ = select.select(inputs, [], [], 0.05)
                if descriptor in readable:
                    data = os.read(descriptor, 65536)
                    if not data:
                        decoder.end()
                        break
                    for value in decoder.push(data):
                        self._parent(value)
                if (self.listener in readable and self.quiesce_id is None
                        and not self.closed.is_set() and not self.stop.is_set()):
                    connection, _ = self.listener.accept()
                    with self.lock:
                        self.clients.add(connection)
                    threading.Thread(target=self._client, args=(connection,), daemon=True).start()
        except ValueError as error:
            codes = {'INVALID_IPC_RESPONSE', 'INVALID_IPC_CONTROL',
                     'IPC_FRAME_INVALID', 'IPC_FRAME_TOO_LARGE', 'IPC_FRAME_EOF'}
            self._fatal(str(error) if str(error) in codes else 'BROKER_IO_FAILED')
        except Exception:
            self._fatal('BROKER_IO_FAILED')
        finally:
            self.close()
        if self.failure:
            raise ValueError(self.failure) from None

    def close(self) -> None:
        self.closed.set()
        self.listener.close()
        with self.lock:
            for pending in self.pending.values():
                pending.completed.set()
            clients = list(self.clients)
        for connection in clients:
            _close_connection(connection)
        self._unlink()


def serveBroker(socket_path: str, stdin: BinaryIO, stdout: BinaryIO,
                inspect: Callable[[int], ProcessSnapshot],
                audit: Callable[[socket.socket], KernelPeer],
                stop_event: threading.Event,
                inspect_signed: Callable[[int], SignedSnapshot] | None = None) -> None:
    broker = _Broker(socket_path, stdin, stdout, inspect, audit, stop_event, inspect_signed)
    broker.run()
