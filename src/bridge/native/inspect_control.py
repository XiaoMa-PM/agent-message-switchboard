# INPUT: Owned-parent JSON control requests and the live (plain or signed) process inspection adapters.
# OUTPUT: Correlated process snapshots for inspect / inspect-signed or whitelisted short-code failures, without caching.
# POS: Helper control dispatcher only; caller must prove owned stdio and pinned runtime.
import re
from typing import Callable

from .macos_identity import IdentityError, ProcessSnapshot, SignedSnapshot

_ERRORS = frozenset({'PROCESS_IDENTITY_UNAVAILABLE', 'INVALID_PROCESS_IDENTITY',
                     'INVALID_PROCESS_PATH', 'UNTRUSTED_EXECUTABLE',
                     'CODE_SIGNING_UNAVAILABLE'})
_UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')


def inspectControl(value: object,
                   inspect: Callable[[int], ProcessSnapshot],
                   inspect_signed: Callable[[int], SignedSnapshot] | None = None) -> dict:
    readers = {'inspect': (inspect, ProcessSnapshot),
               'inspect-signed': (inspect_signed, SignedSnapshot)}
    if (type(value) is not dict
            or set(value) != {'schemaVersion', 'requestId', 'operation', 'pid'}
            or type(value['schemaVersion']) is not int
            or value['schemaVersion'] != 1
            or type(value['operation']) is not str
            or readers.get(value['operation'], (None,))[0] is None
            or type(value['requestId']) is not str
            or _UUID.fullmatch(value['requestId']) is None
            or type(value['pid']) is not int
            or not 1 < value['pid'] <= 0x7fffffff):
        raise ValueError('INVALID_IPC_CONTROL')
    read, kind = readers[value['operation']]
    header = {'schemaVersion': 1, 'requestId': value['requestId'],
              'operation': value['operation']}
    try:
        current = read(value['pid'])
        if type(current) is not kind or current.pid != value['pid']:
            raise ValueError('IPC_REQUEST_FAILED')
        return {**header, 'ok': True, 'snapshot': current.to_json()}
    except Exception as error:
        code = (str(error) if type(error) is IdentityError
                and str(error) in _ERRORS else 'IPC_REQUEST_FAILED')
        return {**header, 'ok': False, 'error': code}
