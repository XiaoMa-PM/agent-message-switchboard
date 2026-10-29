# INPUT: Shared offline broker fixtures and controlled socket/thread barriers.
# OUTPUT: Owned quiesce send/close, strict control and concurrency regressions.
# POS: Offline quiesce tests; no real host, model, identity lookup or credentials.
import select
import socket
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from test_broker_server import Fixture, ipc, receive, response, server, snapshot


class BrokerQuiesceTests(unittest.TestCase):
    def start(self, **options) -> Fixture:
        try:
            fixture = Fixture(**options)
        except (AssertionError, TimeoutError) as error:
            self.fail(f'Valid broker must start and answer control: {error}')
        self.addCleanup(fixture.close)
        return fixture

    def quiesce(self, f: Fixture, **change) -> dict:
        value = {'schemaVersion': 1, 'operation': 'quiesce',
                 'requestId': str(uuid4()), **change}
        f.send_node(value)
        return value

    def test_quiesce_waits_after_response_until_sendall_and_client_eof(self) -> None:
        f = self.start()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original_send = socket.socket.sendall
        def gated(connection, data, *args):
            if connection.getsockname() == f.path:
                entered.set()
                if not release.wait(1):
                    raise AssertionError('Test sendall gate not released')
            return original_send(connection, data, *args)
        with patch.object(socket.socket, 'sendall', gated):
            client, original_id = f.client()
            forwarded = receive(f.node_output)
            f.send_node(response(forwarded))
            self.assertTrue(entered.wait(1))
            quiesce = self.quiesce(f)
            inspect = {'schemaVersion': 1, 'operation': 'inspect',
                       'requestId': str(uuid4()), 'pid': 99}
            f.send_node(inspect)
            checked = receive(f.node_output)
            self.assertEqual(checked['operation'], 'inspect')
            self.assertEqual(checked['snapshot'], snapshot(99).to_json())
            self.assertEqual(select.select([f.node_output], [], [], 0.03)[0], [])
            release.set()
            self.assertEqual(receive(client)['requestId'], original_id)
            self.assertEqual(client.recv(1), b'')
            self.assertEqual(receive(f.node_output), {**quiesce, 'ok': True,
                                                     'result': {'drained': True}})
        f.node_input.shutdown(socket.SHUT_WR)
        f.finish()
        self.assertEqual(f.errors, [])

    def test_quiesce_closes_unforwarded_partial_and_only_drains_forwarded(self) -> None:
        f = self.start()
        partial, _ = f.client(transmit=False)
        partial.sendall(b'\0')
        active, original_id = f.client()
        forwarded = receive(f.node_output)
        quiesce = self.quiesce(f)
        self.assertEqual(partial.recv(1), b'')
        self.assertEqual(select.select([f.node_output], [], [], 0.03)[0], [])
        f.send_node(response(forwarded))
        self.assertEqual(receive(active)['requestId'], original_id)
        self.assertEqual(active.recv(1), b'')
        self.assertEqual(receive(f.node_output), {**quiesce, 'ok': True,
                                                 'result': {'drained': True}})
        rejected = socket.socket(socket.AF_UNIX)
        self.addCleanup(rejected.close)
        with self.assertRaises(OSError):
            rejected.connect(f.path)

    def test_quiesce_strict_shape_duplicate_and_post_drain_inspect(self) -> None:
        f = self.start()
        malformed = self.quiesce(f, schemaVersion=True)
        self.assertEqual(receive(f.node_output), {
            'schemaVersion': 1, 'operation': 'quiesce',
            'requestId': malformed['requestId'], 'ok': False,
            'error': 'IPC_REQUEST_FAILED'})
        quiesce = self.quiesce(f)
        self.assertEqual(receive(f.node_output)['result'], {'drained': True})
        duplicate = self.quiesce(f)
        self.assertEqual(receive(f.node_output), {**duplicate, 'ok': False,
                                                 'error': 'IPC_REQUEST_FAILED'})
        f.send_node({'schemaVersion': 1, 'operation': 'inspect',
                     'requestId': str(uuid4()), 'pid': 88})
        f.finish()
        self.assertEqual(f.errors, ['INVALID_IPC_CONTROL'])

    def test_quiesce_send_failure_never_claims_drained(self) -> None:
        f = self.start()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original_send = socket.socket.sendall
        def failed(connection, data, *args):
            if connection.getsockname() == f.path:
                entered.set()
                release.wait(1)
                raise OSError('private send detail')
            return original_send(connection, data, *args)
        with patch.object(socket.socket, 'sendall', failed):
            client, _ = f.client()
            forwarded = receive(f.node_output)
            f.send_node(response(forwarded))
            self.assertTrue(entered.wait(1))
            quiesce = self.quiesce(f)
            release.set()
            self.assertEqual(client.recv(1), b'')
            self.assertEqual(receive(f.node_output), {**quiesce, 'ok': False,
                                                     'error': 'IPC_REQUEST_FAILED'})

    def test_stop_interrupts_quiesce_without_success(self) -> None:
        f = self.start()
        client, _ = f.client()
        receive(f.node_output)
        self.quiesce(f)
        f.stop.set()
        f.finish()
        self.assertEqual(client.recv(1), b'')
        self.assertEqual(select.select([f.node_output], [], [], 0.03)[0], [])

    def test_quiesce_does_not_admit_snapshot_in_progress_after_freeze(self) -> None:
        f = self.start()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original_snapshot = server._Broker._snapshot
        def held(broker, peer):
            entered.set()
            release.wait(1)
            return original_snapshot(broker, peer)
        with patch.object(server._Broker, '_snapshot', held):
            client, _ = f.client()
            self.assertTrue(entered.wait(1))
            quiesce = self.quiesce(f)
            self.assertEqual(receive(f.node_output), {**quiesce, 'ok': True,
                                                     'result': {'drained': True}})
            self.assertEqual(client.recv(1), b'')
            release.set()
            self.assertEqual(select.select([f.node_output], [], [], 0.03)[0], [])

    def test_quiesce_writer_order_waits_for_forward_without_state_lock_deadlock(self) -> None:
        f = self.start()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original_write = server._Broker._write_frame
        def held(broker, frame):
            decoder = ipc.Decoder()
            value = decoder.push(bytes(frame))[0]
            if 'payload' in value:
                entered.set()
                release.wait(1)
            return original_write(broker, frame)
        with patch.object(server._Broker, '_write_frame', held):
            client, original_id = f.client()
            self.assertTrue(entered.wait(1))
            quiesce = self.quiesce(f)
            self.assertEqual(select.select([f.node_output], [], [], 0.03)[0], [])
            release.set()
            forwarded = receive(f.node_output)
            f.send_node(response(forwarded))
            self.assertEqual(receive(client)['requestId'], original_id)
            self.assertEqual(client.recv(1), b'')
            self.assertEqual(receive(f.node_output), {**quiesce, 'ok': True,
                                                     'result': {'drained': True}})

    def test_duplicate_quiesce_during_drain_is_fixed_failure_not_second_success(self) -> None:
        f = self.start()
        client, _ = f.client()
        forwarded = receive(f.node_output)
        first = self.quiesce(f)
        second = self.quiesce(f)
        self.assertEqual(receive(f.node_output), {**second, 'ok': False,
                                                 'error': 'IPC_REQUEST_FAILED'})
        f.send_node(response(forwarded))
        receive(client)
        self.assertEqual(client.recv(1), b'')
        self.assertEqual(receive(f.node_output), {**first, 'ok': True,
                                                 'result': {'drained': True}})

    def test_bad_quiesce_keys_fail_without_entering_drain_and_bad_uuid_is_fatal(self) -> None:
        f = self.start()
        for change in [{'extra': True}, {'schemaVersion': 2}]:
            value = self.quiesce(f, **change)
            self.assertEqual(receive(f.node_output), {
                'schemaVersion': 1, 'operation': 'quiesce',
                'requestId': value['requestId'], 'ok': False,
                'error': 'IPC_REQUEST_FAILED'})
        client, _ = f.client()
        forwarded = receive(f.node_output)
        f.send_node(response(forwarded))
        receive(client)
        self.quiesce(f, requestId='bad-id')
        f.finish()
        self.assertEqual(f.errors, ['INVALID_IPC_CONTROL'])

    def test_quiesce_cannot_be_called_on_business_socket(self) -> None:
        f = self.start()
        direct, _ = f.client(transmit=False)
        direct.sendall(ipc.encodeFrame({'schemaVersion': 1,
            'operation': 'quiesce', 'requestId': str(uuid4())}))
        direct.shutdown(socket.SHUT_WR)
        self.assertEqual(direct.recv(1), b'')
        payload = {'schemaVersion': 1, 'operation': 'quiesce',
                   'requestId': str(uuid4())}
        client, _ = f.client(payload)
        forwarded = receive(f.node_output)
        self.assertEqual(forwarded['payload'], payload)
        self.assertNotIn('operation', forwarded)
        f.send_node(response(forwarded))
        receive(client)
        self.assertEqual(client.recv(1), b'')

    def test_duplicate_and_late_business_response_cannot_complete_quiesce(self) -> None:
        for late in [False, True]:
            with self.subTest(late=late):
                f = self.start()
                entered, release = threading.Event(), threading.Event()
                self.addCleanup(release.set)
                original_send = socket.socket.sendall
                def held(connection, data, *args):
                    if connection.getsockname() == f.path and not late:
                        entered.set()
                        release.wait(1)
                    return original_send(connection, data, *args)
                with patch.object(socket.socket, 'sendall', held):
                    client, _ = f.client()
                    forwarded = receive(f.node_output)
                    value = response(forwarded)
                    f.send_node(value)
                    if late:
                        receive(client)
                        self.assertEqual(client.recv(1), b'')
                    else:
                        self.assertTrue(entered.wait(1))
                    self.quiesce(f)
                    if late:
                        self.assertEqual(receive(f.node_output)['result'], {'drained': True})
                    f.send_node(value)
                    f.finish()
                    release.set()
                    self.assertEqual(f.errors, ['INVALID_IPC_RESPONSE'])
                    self.assertEqual(select.select([f.node_output], [], [], 0.03)[0], [])

    def test_quiesce_waits_for_connection_close_after_sendall(self) -> None:
        f = self.start()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original_close = server._close_connection
        def held(connection):
            if connection.fileno() >= 0 and connection.getsockname() == f.path:
                entered.set()
                release.wait(1)
            original_close(connection)
        with patch.object(server, '_close_connection', held):
            client, _ = f.client()
            forwarded = receive(f.node_output)
            f.send_node(response(forwarded))
            receive(client)
            self.assertTrue(entered.wait(1))
            quiesce = self.quiesce(f)
            self.assertEqual(select.select([f.node_output], [], [], 0.03)[0], [])
            release.set()
            self.assertEqual(client.recv(1), b'')
            self.assertEqual(receive(f.node_output), {**quiesce, 'ok': True,
                                                     'result': {'drained': True}})

    def test_connection_close_failure_cannot_claim_drained(self) -> None:
        f = self.start()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original_close = server._close_connection
        def failed(connection):
            if connection.fileno() >= 0 and connection.getsockname() == f.path:
                entered.set()
                release.wait(1)
                original_close(connection)
                raise OSError('private close detail')
            original_close(connection)
        with patch.object(server, '_close_connection', failed):
            client, _ = f.client()
            forwarded = receive(f.node_output)
            f.send_node(response(forwarded))
            receive(client)
            self.assertTrue(entered.wait(1))
            quiesce = self.quiesce(f)
            release.set()
            self.assertEqual(client.recv(1), b'')
            self.assertEqual(receive(f.node_output), {**quiesce, 'ok': False,
                                                     'error': 'IPC_REQUEST_FAILED'})

    def test_quiesce_waits_for_every_forwarded_connection(self) -> None:
        f = self.start()
        first, _ = f.client({'marker': 'first'})
        second, _ = f.client({'marker': 'second'})
        pending = [receive(f.node_output), receive(f.node_output)]
        quiesce = self.quiesce(f)
        by_marker = {value['payload']['marker']: value for value in pending}
        f.send_node(response(by_marker['first']))
        receive(first)
        self.assertEqual(first.recv(1), b'')
        self.assertEqual(select.select([f.node_output], [], [], 0.03)[0], [])
        f.send_node(response(by_marker['second']))
        receive(second)
        self.assertEqual(second.recv(1), b'')
        self.assertEqual(receive(f.node_output), {**quiesce, 'ok': True,
                                                 'result': {'drained': True}})


if __name__ == '__main__':
    unittest.main()
