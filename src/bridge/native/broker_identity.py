# INPUT: Kernel peer, trusted pinned broker/DSH snapshots and an injected read adapter.
# OUTPUT: A frozen broker snapshot only after complete stable identity verification.
# POS: Client identity check only; no private-description trust proof or socket operation.
from dataclasses import replace
import os
import re
from typing import Callable

from .macos_identity import IdentityError, KernelPeer, ProcessSnapshot


def _integer(value: int, minimum: int, maximum: int) -> bool:
    return type(value) is int and minimum <= value <= maximum


def _decimal(value: str, minimum: int, maximum: int) -> bool:
    return (type(value) is str and len(value) <= 20
            and re.fullmatch(r'0|[1-9][0-9]*', value) is not None
            and minimum <= int(value) <= maximum)


def _snapshot(raw: ProcessSnapshot) -> ProcessSnapshot:
    if type(raw) is not ProcessSnapshot:
        raise ValueError('BROKER_IDENTITY_UNVERIFIED')
    value = replace(raw)
    if (not _integer(value.pid, 2, 0x7fffffff)
            or not _integer(value.parent_pid, 1, 0x7fffffff)
            or not _integer(value.uid, 0, 0xfffffffe)
            or not _integer(value.pid_version, 0, 0xffffffff)
            or not _decimal(value.unique_id, 1, 0xffffffffffffffff)
            or not _decimal(value.parent_unique_id, 1, 0xffffffffffffffff)
            or type(value.exe) is not str or not os.path.isabs(value.exe)
            or os.path.normpath(value.exe) != value.exe
            or type(value.sha256) is not str
            or re.fullmatch(r'[a-f0-9]{64}', value.sha256) is None
            or not _decimal(value._start_tvsec, 0, 0xffffffffffffffff)
            or not _decimal(value._start_tvusec, 0, 999999)):
        raise ValueError('BROKER_IDENTITY_UNVERIFIED')
    return value


def verifyBrokerPeer(peer: KernelPeer, expected_broker: ProcessSnapshot,
                     expected_parent: ProcessSnapshot,
                     inspect: Callable[[int], ProcessSnapshot]) -> ProcessSnapshot:
    try:
        broker = _snapshot(expected_broker)
        parent = _snapshot(expected_parent)
        if (type(peer) is not KernelPeer
                or not _integer(peer.pid, 2, 0x7fffffff)
                or not _integer(peer.uid, 0, 0xfffffffe)
                or not _integer(peer.pid_version, 0, 0xffffffff)
                or (peer.pid, peer.uid, peer.pid_version)
                != (broker.pid, broker.uid, broker.pid_version)
                or broker.pid == parent.pid
                or broker.unique_id == parent.unique_id
                or broker.parent_pid != parent.pid
                or broker.parent_unique_id != parent.unique_id):
            raise ValueError('BROKER_IDENTITY_UNVERIFIED')
        observed_broker = _snapshot(inspect(broker.pid))
        if observed_broker != broker:
            raise ValueError('BROKER_IDENTITY_UNVERIFIED')
        observed_parent = _snapshot(inspect(parent.pid))
        if observed_parent != parent:
            raise ValueError('BROKER_IDENTITY_UNVERIFIED')
        if (_snapshot(inspect(parent.pid)) != observed_parent
                or _snapshot(inspect(broker.pid)) != observed_broker):
            raise ValueError('BROKER_IDENTITY_UNVERIFIED')
        return replace(observed_broker)
    except Exception:
        raise IdentityError('BROKER_IDENTITY_UNVERIFIED') from None
