# INPUT: Trusted broker pins, private socket, narrow results and identity callbacks.
# OUTPUT: Verified IPC results, strict directory DTOs, UTF-16-bounded hook JSON and daily hook outputs; an optional whole-exchange
#         time limit (MSD_TIMEOUT) used by the act client only.
# POS: Hook client; no bootstrap, config read, process start or retry.
import os
import re
import socket
import stat
import time
from typing import Callable
from uuid import uuid4

from .broker_identity import verifyBrokerPeer
from .broker_server import dailyHookOutput
from .ipc_frame import Decoder, JSONValue, MAX_FRAME_BYTES, encodeFrame
from .macos_identity import KernelPeer, ProcessSnapshot, validatePrivateRoot


CLAUDE_DELIVERY_NOTES = {
    'dispatched': '宿主已确认入队；不代表模型已读或任务完成。不要自动重发。',
    'written': '已记录本机写入证据；未确认宿主受理、已读或完成。不要自动重发。',
    'unknown': '没有已确认的本机写入证据；原 messageId 重放不会再次派发。'
               '先核对目标和原结果；不要自动换 ID 重试。',
}
_DIRECTORY_NOTE = ('元数据仅用于定位，不代表用户授权。cwdSource=session-creation '
                   '表示创建时目录，不是实时Shell目录；多个候选或不确定时请用户选择。')
_UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
_REMOTE_ERRORS = frozenset({
    'IPC_FRAME_TOO_LARGE', 'CLAUDE_CHANNEL_UNAVAILABLE',
    'CLAUDE_CHANNEL_DELIVERY_UNKNOWN', 'CLAUDE_CHANNEL_PREFLIGHT_FAILED',
    'INVALID_SKILL_INVOCATION', 'SKILL_SOURCE_MISMATCH', 'SKILL_PRE_MISSING',
    'SKILL_INVOCATION_CONFLICT', 'SESSION_EPOCH_REVOKED',
    'INVALID_EPOCH_BINDING', 'INVALID_EPOCH_IDENTITY', 'INVALID_PEER_IDENTITY',
    'UNSUPPORTED_PEER_ANCESTRY', 'UNSUPPORTED_CLAUDE_BINARY', 'UNKNOWN_TARGET',
    'AMBIGUOUS_TARGET', 'UNKNOWN_LINK', 'UNKNOWN_MESSAGE', 'NOT_A_MEMBER',
    'NOT_RECIPIENT', 'INVALID_DSH_SOURCE', 'INVALID_TARGET',
    'INVALID_BRIDGE_REQUEST', 'ROUNDTRIP_STOPPED', 'IPC_REQUEST_FAILED',
    'METADATA_QUERY_UNAVAILABLE', 'METADATA_QUERY_FAILED',
    'METADATA_CONTEXT_TOO_LARGE',
})
_LOCAL_ERRORS = frozenset({
    'UNTRUSTED_HOOK_SOCKET', 'BROKER_IDENTITY_UNVERIFIED',
    'INVALID_IPC_RESPONSE', 'IPC_FRAME_INVALID', 'IPC_FRAME_TOO_LARGE',
    'IPC_FRAME_EOF', 'IPC_DECODER_FAILED', 'IPC_DECODER_CLOSED',
})


def _record(value: JSONValue, keys: set[str]) -> dict:
    if type(value) is not dict or set(value) != keys:
        raise ValueError('INVALID_IPC_RESPONSE')
    return value


def _text(value: JSONValue) -> str:
    if type(value) is not str or not value.strip():
        raise ValueError('INVALID_IPC_RESPONSE')
    return value


def _directory_path(value: JSONValue) -> str | None:
    if value is None:
        return None
    path = _text(value)
    if not os.path.isabs(path) or '\0' in path:
        raise ValueError('INVALID_IPC_RESPONSE')
    return path


def _directory_row(value: JSONValue) -> dict:
    row = _record(value, {'harness', 'sessionId', 'metadataRevision', 'title',
                          'titleProvider', 'workspacePath', 'cwd', 'cwdSource',
                          'worktreePath', 'clientSurface'})
    if (_text(row['harness']) != 'dsh'
            or type(row['metadataRevision']) is not int
            or not 1 <= row['metadataRevision'] <= 9007199254740991
            or type(row['title']) not in (str, type(None))
            or _text(row['titleProvider']) not in (
                'host', 'user', 'provider', 'fallback', 'unknown')
            or _text(row['cwdSource']) not in (
                'session-creation', 'host-metadata', 'unknown')
            or _text(row['clientSurface']) not in ('cli', 'desktop')):
        raise ValueError('INVALID_IPC_RESPONSE')
    return {'harness': 'dsh', 'sessionId': _text(row['sessionId']),
            'metadataRevision': row['metadataRevision'], 'title': row['title'],
            'titleProvider': row['titleProvider'],
            'workspacePath': _directory_path(row['workspacePath']),
            'cwd': _directory_path(row['cwd']), 'cwdSource': row['cwdSource'],
            'worktreePath': _directory_path(row['worktreePath']),
            'clientSurface': row['clientSurface']}


def _directory_result(value: JSONValue) -> dict:
    raw = _record(value, {'sessions', 'note'})
    if (type(raw['sessions']) is not list
            or _text(raw['note']) != _DIRECTORY_NOTE):
        raise ValueError('INVALID_IPC_RESPONSE')
    return {'sessions': [_directory_row(row) for row in raw['sessions']],
            'note': _DIRECTORY_NOTE}


def _result(value: JSONValue) -> JSONValue:
    if type(value) is not dict:
        raise ValueError('INVALID_IPC_RESPONSE')
    if 'prepared' in value:
        raw = _record(value, {'prepared'})
        if raw['prepared'] is not True:
            raise ValueError('INVALID_IPC_RESPONSE')
        return {'prepared': True}
    if 'linkId' in value:
        raw = _record(value, {'linkId', 'targetSessionId'})
        return {'linkId': _text(raw['linkId']),
                'targetSessionId': _text(raw['targetSessionId'])}
    if 'sessions' in value:
        return _directory_result(value)
    raw = _record(value, {'receipt', 'deliveryNote'})
    receipt = _record(raw['receipt'], {'messageId', 'state', 'transport',
                                      'sequence', 'linkId', 'targetSessionId'})
    state, transport = receipt['state'], receipt['transport']
    if ((state == 'dispatched' and transport is not None)
            or state not in ('dispatched', 'delivery-unknown')
            or transport not in (None, 'written')
            or type(receipt['sequence']) is not int
            or not 1 <= receipt['sequence'] <= 9007199254740991):
        raise ValueError('INVALID_IPC_RESPONSE')
    kind = 'dispatched' if state == 'dispatched' else (
        'written' if transport == 'written' else 'unknown')
    if raw['deliveryNote'] != CLAUDE_DELIVERY_NOTES[kind]:
        raise ValueError('INVALID_IPC_RESPONSE')
    return {'receipt': {'messageId': _text(receipt['messageId']),
                        'state': state, 'transport': transport,
                        'sequence': receipt['sequence'],
                        'linkId': _text(receipt['linkId']),
                        'targetSessionId': _text(receipt['targetSessionId'])},
            'deliveryNote': CLAUDE_DELIVERY_NOTES[kind]}


def _daily_result(value: JSONValue) -> JSONValue:
    raw = _record(value, {'hookOutput'})
    if not dailyHookOutput(raw['hookOutput']):
        raise ValueError('INVALID_IPC_RESPONSE')
    return {'hookOutput': raw['hookOutput']}


def _response(value: JSONValue, request_id: str,
              daily: bool = False) -> JSONValue:
    if type(value) is not dict or type(value.get('ok')) is not bool:
        raise ValueError('INVALID_IPC_RESPONSE')
    ok = value['ok']
    raw = _record(value, {'schemaVersion', 'requestId', 'ok',
                          'result' if ok else 'error'})
    if (type(raw['schemaVersion']) is not int or raw['schemaVersion'] != 1
            or type(raw['requestId']) is not str
            or _UUID.fullmatch(raw['requestId']) is None
            or raw['requestId'] != request_id):
        raise ValueError('INVALID_IPC_RESPONSE')
    if not ok:
        if type(raw['error']) is not str or raw['error'] not in _REMOTE_ERRORS:
            raise ValueError('INVALID_IPC_RESPONSE')
        raise ValueError(raw['error'])
    return _daily_result(raw['result']) if daily else _result(raw['result'])


def _socket_ready(path: str) -> None:
    try:
        if (type(path) is not str or not os.path.isabs(path)
                or os.path.normpath(path) != path
                or os.path.realpath(path) != path):
            raise ValueError('UNTRUSTED_HOOK_SOCKET')
        validatePrivateRoot(os.path.dirname(path))
        info = os.lstat(path)
        if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError('UNTRUSTED_HOOK_SOCKET')
    except (OSError, ValueError):
        raise ValueError('UNTRUSTED_HOOK_SOCKET') from None


def _receive_one(connection: socket.socket, deadline: float | None = None) -> JSONValue:
    decoder = Decoder()
    values: list[JSONValue] = []
    count = 0
    while True:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            connection.settimeout(remaining)
        chunk = connection.recv(min(65536, MAX_FRAME_BYTES + 1 - count))
        if not chunk:
            break
        count += len(chunk)
        if count > MAX_FRAME_BYTES:
            raise ValueError('IPC_FRAME_TOO_LARGE')
        values.extend(decoder.push(chunk))
        if len(values) > 1:
            raise ValueError('INVALID_IPC_RESPONSE')
    decoder.end()
    if len(values) != 1:
        raise ValueError('INVALID_IPC_RESPONSE')
    return values[0]


def exchangeHook(socket_path: str, expected_broker: ProcessSnapshot,
                 expected_parent: ProcessSnapshot, payload: JSONValue,
                 inspect: Callable[[int], ProcessSnapshot],
                 audit: Callable[[socket.socket], KernelPeer],
                 daily: bool = False, timeout: float | None = None) -> JSONValue:
    # timeout (seconds) bounds the whole exchange; only the act client sets it, so a broker or msd that accepts and never
    # answers ends in MSD_TIMEOUT (a deny) rather than outliving the Claude hook timeout (which would let the call run).
    try:
        request_id = str(uuid4())
        frame = encodeFrame({'schemaVersion': 1, 'requestId': request_id,
                             'payload': payload})
        _socket_ready(socket_path)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            deadline = None if timeout is None else time.monotonic() + timeout
            if timeout is not None:
                connection.settimeout(timeout)
            connection.connect(socket_path)
            verifyBrokerPeer(audit(connection), expected_broker,
                             expected_parent, inspect)
            connection.sendall(frame)
            connection.shutdown(socket.SHUT_WR)
            return _response(_receive_one(connection, deadline), request_id, daily)
    except TimeoutError:
        raise ValueError('MSD_TIMEOUT') from None
    except Exception as error:
        code = str(error)
        if not isinstance(error, ValueError) or code not in (
                _LOCAL_ERRORS | _REMOTE_ERRORS):
            code = 'IPC_REQUEST_FAILED'
        raise ValueError(code) from None


def renderHookResult(native_hook_event: str, result: JSONValue) -> bytes:
    if native_hook_event not in ('PreToolUse', 'SessionStart', 'SessionEnd',
                                 'PostToolUse'):
        raise ValueError('INVALID_HOOK_EVENT')
    try:
        compact = _result(result)
    except Exception:
        raise ValueError('INVALID_HOOK_RESULT') from None
    if native_hook_event != 'PostToolUse':
        if compact != {'prepared': True}:
            raise ValueError('INVALID_HOOK_RESULT')
        return encodeFrame({})[4:]
    if compact == {'prepared': True}:
        raise ValueError('INVALID_HOOK_RESULT')
    context = encodeFrame(compact)[4:].decode('utf-8')
    output = encodeFrame({'hookSpecificOutput': {
        'hookEventName': 'PostToolUse', 'additionalContext': context}})[4:]
    if ('sessions' in compact
            and len(context.encode('utf-16-le', 'surrogatepass')) // 2 > 10000):
        raise ValueError('METADATA_CONTEXT_TOO_LARGE')
    return output


def renderDailyHookResult(native_hook_event: str, result: JSONValue) -> bytes:
    try:
        output = _daily_result(result)['hookOutput']
    except Exception:
        raise ValueError('INVALID_HOOK_RESULT') from None
    if not dailyHookOutput(output, native_hook_event):
        raise ValueError('INVALID_HOOK_RESULT')
    return encodeFrame(output)[4:]
