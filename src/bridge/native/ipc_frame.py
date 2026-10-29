# INPUT: Exact JSON builtins and fragmented four-byte-prefixed IPC bytes.
# OUTPUT: Bounded JSON frames and a permanently failed/closed decoder with fixed codes.
# POS: Standard-library framing only; no socket, authentication or dispatch.
import json
import math
from typing import NoReturn


type JSONValue = (bool | int | float | str | None
                  | list[JSONValue] | dict[str, JSONValue])
MAX_FRAME_BYTES = 1048576
_MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - 4


def _validate_json(value: JSONValue) -> None:
    active: set[int] = set()
    pending: list[tuple[JSONValue, bool]] = [(value, False)]
    while pending:
        current, exiting = pending.pop()
        if exiting:
            active.remove(id(current))
            continue
        kind = type(current)
        if current is None or kind in (str, bool):
            continue
        if kind in (int, float):
            if math.isfinite(float(current)):
                continue
            raise ValueError('IPC_FRAME_INVALID')
        if kind not in (list, dict) or id(current) in active:
            raise ValueError('IPC_FRAME_INVALID')
        if kind is dict and any(type(key) is not str for key in current):
            raise ValueError('IPC_FRAME_INVALID')
        active.add(id(current))
        pending.append((current, True))
        children = current.values() if kind is dict else current
        pending.extend((child, False) for child in children)


def _reject_constant(_value: str) -> NoReturn:
    raise ValueError('IPC_FRAME_INVALID')


def encodeFrame(value: JSONValue) -> bytes:
    try:
        _validate_json(value)
        text = json.dumps(value, ensure_ascii=False, allow_nan=False,
                          separators=(',', ':'))
        text = text.encode('utf-16-le', 'surrogatepass').decode(
            'utf-16-le', 'surrogatepass')
        payload = text.encode('utf-8', 'backslashreplace')
    except Exception:
        raise ValueError('IPC_FRAME_INVALID') from None
    if len(payload) > _MAX_PAYLOAD_BYTES:
        raise ValueError('IPC_FRAME_TOO_LARGE')
    return len(payload).to_bytes(4, 'big') + payload


class Decoder:
    def __init__(self) -> None:
        self._header = bytearray(4)
        self._header_bytes = 0
        self._payload: bytearray | None = None
        self._payload_bytes = 0
        self._failed = False
        self._closed = False

    def _ready(self) -> None:
        if self._failed:
            raise ValueError('IPC_DECODER_FAILED')
        if self._closed:
            raise ValueError('IPC_DECODER_CLOSED')

    def _fail(self, code: str) -> NoReturn:
        self._failed = True
        self._payload = None
        raise ValueError(code) from None

    def _read_header(self, chunk: bytes, offset: int) -> int:
        count = min(4 - self._header_bytes, len(chunk) - offset)
        self._header[self._header_bytes:self._header_bytes + count] = (
            chunk[offset:offset + count])
        self._header_bytes += count
        if self._header_bytes == 4:
            length = int.from_bytes(self._header, 'big')
            if length == 0:
                self._fail('IPC_FRAME_INVALID')
            if length > _MAX_PAYLOAD_BYTES:
                self._fail('IPC_FRAME_TOO_LARGE')
            self._payload = bytearray(length)
            self._payload_bytes = 0
        return offset + count

    def _read_payload(self, chunk: bytes, offset: int,
                      result: list[JSONValue]) -> int:
        payload = self._payload
        assert payload is not None
        count = min(len(payload) - self._payload_bytes, len(chunk) - offset)
        payload[self._payload_bytes:self._payload_bytes + count] = (
            chunk[offset:offset + count])
        self._payload_bytes += count
        if self._payload_bytes == len(payload):
            try:
                value = json.loads(payload.decode('utf-8', 'strict'),
                                   parse_constant=_reject_constant)
                _validate_json(value)
                result.append(value)
            except Exception:
                self._fail('IPC_FRAME_INVALID')
            self._payload = None
            self._header_bytes = 0
        return offset + count

    def push(self, chunk: bytes) -> list[JSONValue]:
        self._ready()
        if type(chunk) is not bytes:
            self._fail('IPC_FRAME_INVALID')
        result: list[JSONValue] = []
        offset = 0
        while offset < len(chunk):
            if self._payload is None:
                offset = self._read_header(chunk, offset)
            else:
                offset = self._read_payload(chunk, offset, result)
        return result

    def end(self) -> None:
        self._ready()
        if self._header_bytes or self._payload is not None:
            self._fail('IPC_FRAME_EOF')
        self._closed = True
