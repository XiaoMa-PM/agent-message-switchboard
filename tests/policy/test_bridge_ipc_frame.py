# INPUT: Fixed Node hex frames, synthetic JSON values and fragmented byte streams.
# OUTPUT: Cross-language framing, Unicode preservation and permanent failure tests.
# POS: Pure Python IPC framing fixtures; no socket, host, credentials or model.
import importlib.util
import math
from pathlib import Path
import struct
import traceback
import unittest
from unittest.mock import patch


SOURCE = (Path(__file__).resolve().parents[2]
          / 'src/bridge/native/ipc_frame.py')
SPEC = importlib.util.spec_from_file_location('bridge_ipc_frame', SOURCE)
ipc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ipc)

# Captured from this repository's Node24.16 encodeIpcFrame; no stdout newline.
HEX_FRAMES = [
    ({'body': 'Hello 中文😀\n', 'n': 1.5},
     '000000257b22626f6479223a2248656c6c6f20e4b8ade69687f09f98805c6e22'
     '2c226e223a312e357d'),
    (['\0', '\b\t\n\f\r', '\\"'],
     '0000001e5b225c7530303030222c225c625c745c6e5c665c72222c225c5c5c22225d'),
    ({'value': 7, 'ok': True, 'no': None},
     '0000001f7b2276616c7565223a372c226f6b223a747275652c226e6f223a6e756c6c7d'),
    ('\ud800x\udc00', '0000000f225c7564383030785c756463303022'),
    ('😀', '0000000622f09f988022'),
]


def raw_frame(payload: bytes) -> bytes:
    return struct.pack('>I', len(payload)) + payload


def decode(frame: bytes) -> list:
    decoder = ipc.Decoder()
    result = decoder.push(frame)
    decoder.end()
    return result


class FramingTests(unittest.TestCase):
    def test_available_api_is_callable_without_import_failure(self) -> None:
        self.assertEqual(ipc.MAX_FRAME_BYTES, 1048576)
        self.assertTrue(callable(ipc.encodeFrame))
        self.assertTrue(callable(ipc.Decoder))

    def test_fixed_node_hex_frames_decode_and_python_encode_identically(self) -> None:
        for value, hexadecimal in HEX_FRAMES:
            with self.subTest(hexadecimal=hexadecimal):
                try:
                    encoded = ipc.encodeFrame(value)
                except ValueError as error:
                    self.fail(f'Valid JSON must encode: {error}')
                self.assertEqual(encoded.hex(), hexadecimal)
                self.assertEqual(decode(bytes.fromhex(hexadecimal)), [value])
                self.assertEqual(encoded[:4], struct.pack('>I', len(encoded) - 4))
                self.assertEqual(len(encoded), len(bytes.fromhex(hexadecimal)))

    def test_unicode_shell_control_and_literal_escape_text_is_never_changed(self) -> None:
        value = {'body': ' \n中文😀 $HOME $(touch canary) `echo marker` '
                 '\u2028\u2029 \ud800 \\ud800 " \\ ', 'empty': ''}
        self.assertEqual(decode(ipc.encodeFrame(value)), [value])
        text = ipc.encodeFrame(value)[4:].decode('utf-8')
        self.assertIn('中文😀', text)
        self.assertIn('\\ud800', text)

    def test_valid_surrogate_pair_is_a_scalar_and_lone_surrogates_are_escaped(self) -> None:
        self.assertEqual(ipc.encodeFrame('\ud83d\ude00').hex(), HEX_FRAMES[-1][1])
        self.assertEqual(decode(ipc.encodeFrame('\ud83d\ude00')), ['😀'])
        for value in ['\ud800', '\udc00', '\ud800before\udc00', '\ud800\ud800',
                      '\udc00\ud800', {'\ud800': '\udc00'}]:
            with self.subTest(value=repr(value)):
                self.assertEqual(decode(ipc.encodeFrame(value)), [value])

    def test_primitives_finite_numbers_and_shared_noncyclic_values(self) -> None:
        shared = {'text': 'original'}
        values = [None, True, False, 0, -0.0, 1, 1.0, 1.5, 1e-7,
                  1e20, 1.7976931348623157e308, 10 ** 308,
                  '', [], ['a', None], {'a': shared, 'b': shared}]
        for value in values:
            with self.subTest(value=repr(value)):
                self.assertEqual(decode(ipc.encodeFrame(value)), [value])

    def test_every_header_and_multibyte_split_is_accepted(self) -> None:
        value = {'body': '中文😀\nsecond line'}
        frame = ipc.encodeFrame(value)
        for split in range(len(frame) + 1):
            with self.subTest(split=split):
                decoder = ipc.Decoder()
                self.assertEqual(decoder.push(frame[:split])
                                 + decoder.push(frame[split:]), [value])
                decoder.end()

    def test_one_byte_fragments_and_concatenated_frames_preserve_order(self) -> None:
        values = [{'body': '甲😀'}, {'body': '乙\n'}, None]
        stream = b''.join(ipc.encodeFrame(value) for value in values)
        decoder = ipc.Decoder()
        observed = []
        for byte in stream:
            observed.extend(decoder.push(bytes([byte])))
        decoder.end()
        self.assertEqual(observed, values)
        self.assertEqual(decode(stream), values)

    def test_maximum_frame_includes_header_and_next_byte_is_rejected(self) -> None:
        value = 'a' * (ipc.MAX_FRAME_BYTES - 6)
        encoded = ipc.encodeFrame(value)
        self.assertEqual(len(encoded), ipc.MAX_FRAME_BYTES)
        self.assertEqual(decode(encoded), [value])
        with self.assertRaisesRegex(ValueError, '^IPC_FRAME_TOO_LARGE$'):
            ipc.encodeFrame(value + 'a')

    def test_invalid_size_fails_from_header_before_payload_allocation(self) -> None:
        for length in [0, ipc.MAX_FRAME_BYTES - 3, 0xffffffff]:
            with self.subTest(length=length):
                decoder = ipc.Decoder()
                header = struct.pack('>I', length)
                self.assertEqual(decoder.push(header[:3]), [])
                expected = 'IPC_FRAME_INVALID' if length == 0 else 'IPC_FRAME_TOO_LARGE'
                with self.assertRaisesRegex(ValueError, '^' + expected + '$'):
                    decoder.push(header[3:])
                with self.assertRaisesRegex(ValueError, '^IPC_DECODER_FAILED$'):
                    decoder.push(b'')
                with self.assertRaisesRegex(ValueError, '^IPC_DECODER_FAILED$'):
                    decoder.end()

    def test_oversized_prefix_cannot_request_an_oversized_allocation(self) -> None:
        allocations = []

        def allocate(length: int) -> bytearray:
            allocations.append(length)
            if length > ipc.MAX_FRAME_BYTES - 4:
                self.fail('Untrusted length must be checked before allocation')
            return bytearray(length)

        with patch.object(ipc, 'bytearray', allocate, create=True):
            decoder = ipc.Decoder()
            with self.assertRaisesRegex(ValueError, '^IPC_FRAME_TOO_LARGE$'):
                decoder.push(struct.pack('>I', 0xffffffff))
        self.assertEqual(allocations, [4])

    def test_partial_prefix_or_payload_eof_permanently_fails(self) -> None:
        frame = ipc.encodeFrame({'body': 'text'})
        for cut in [1, 2, 3, 4, len(frame) - 1]:
            with self.subTest(cut=cut):
                decoder = ipc.Decoder()
                self.assertEqual(decoder.push(frame[:cut]), [])
                with self.assertRaisesRegex(ValueError, '^IPC_FRAME_EOF$'):
                    decoder.end()
                with self.assertRaisesRegex(ValueError, '^IPC_DECODER_FAILED$'):
                    decoder.push(frame)

    def test_strict_utf8_json_and_nonfinite_numbers_have_no_raw_error_data(self) -> None:
        bad = [b'\xc3(', b'\xed\xa0\x80', b'{"private-body":', b'true false',
               b'1e400', str(10 ** 309).encode(), b'NaN', b'Infinity',
               b'-Infinity', b'{"x":NaN,"x":2}', b'\xef\xbb\xbfnull',
               b'"raw\nline"']
        for payload in bad:
            with self.subTest(payload=repr(payload)):
                decoder = ipc.Decoder()
                try:
                    decoder.push(raw_frame(payload))
                except ValueError as error:
                    self.assertEqual(str(error), 'IPC_FRAME_INVALID')
                    self.assertNotIn('private-body', ''.join(traceback.format_exception(error)))
                else:
                    self.fail('Malformed input must be rejected')
                with self.assertRaisesRegex(ValueError, '^IPC_DECODER_FAILED$'):
                    decoder.push(b'')

    def test_duplicate_keys_use_final_value_without_invented_key_rules(self) -> None:
        self.assertEqual(decode(raw_frame(b'{"value":1,"value":2}')), [{'value': 2}])
        self.assertEqual(decode(raw_frame(b'{"value":1e400,"value":2}')), [{'value': 2}])

    def test_encoder_rejects_non_json_types_cycles_and_nonfinite_numbers(self) -> None:
        class Custom:
            def toJSON(self) -> None:
                raise AssertionError('custom conversion must not execute')

        class CustomDict(dict):
            pass

        class CustomString(str):
            pass

        class CustomInt(int):
            pass

        class CustomList(list):
            pass

        class CustomFloat(float):
            pass

        cycle = []
        cycle.append(cycle)
        values = [math.nan, math.inf, -math.inf, 10 ** 309, (), (1,), set(),
                  b'bytes', Custom(), CustomDict(), CustomString('text'),
                  CustomInt(2), CustomList(), CustomFloat(1.5),
                  {'x': Custom()}, {1: 'wrong-key'},
                  {CustomString('key'): 'wrong-key'}, cycle]
        for value in values:
            with self.subTest(value=type(value).__name__):
                with self.assertRaisesRegex(ValueError, '^IPC_FRAME_INVALID$'):
                    ipc.encodeFrame(value)

    def test_json_booleans_keep_boolean_types_even_though_bool_is_int(self) -> None:
        self.assertIs(decode(ipc.encodeFrame(True))[0], True)
        self.assertIs(decode(ipc.encodeFrame(False))[0], False)
        self.assertIs(type(decode(ipc.encodeFrame(1))[0]), int)

    def test_wrong_byte_input_permanently_fails(self) -> None:
        for chunk in [None, 'bytes', [], bytearray(), memoryview(b'')]:
            with self.subTest(chunk=type(chunk).__name__):
                decoder = ipc.Decoder()
                with self.assertRaisesRegex(ValueError, '^IPC_FRAME_INVALID$'):
                    decoder.push(chunk)
                with self.assertRaisesRegex(ValueError, '^IPC_DECODER_FAILED$'):
                    decoder.end()

    def test_completed_and_empty_decoders_close_permanently(self) -> None:
        for populated in [False, True]:
            decoder = ipc.Decoder()
            if populated:
                self.assertEqual(decoder.push(ipc.encodeFrame('done')), ['done'])
            decoder.end()
            with self.assertRaisesRegex(ValueError, '^IPC_DECODER_CLOSED$'):
                decoder.push(b'')
            with self.assertRaisesRegex(ValueError, '^IPC_DECODER_CLOSED$'):
                decoder.end()

    def test_invalid_frame_discards_earlier_results_from_the_same_batch(self) -> None:
        decoder = ipc.Decoder()
        stream = ipc.encodeFrame('valid') + raw_frame(b'invalid')
        with self.assertRaisesRegex(ValueError, '^IPC_FRAME_INVALID$'):
            decoder.push(stream)
        with self.assertRaisesRegex(ValueError, '^IPC_DECODER_FAILED$'):
            decoder.push(ipc.encodeFrame('later'))


if __name__ == '__main__':
    unittest.main()
