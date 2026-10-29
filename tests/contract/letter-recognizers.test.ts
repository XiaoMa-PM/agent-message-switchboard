// INPUT: The shared inbound header generator, the Claude packets, every letter recognizer and the shared prompt fixture.
// OUTPUT: Contract: each generated header is recognized on every path its recipient reads; fixture letters equal the generator output.
// POS: Guards the letter header across a rename; a recognizer left on an old prefix fails here instead of silently in a host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeInboxPush } from '../../src/adapters/claude/inbox.ts';
import { LETTER_PREFIXES as CODEX_LETTER_PREFIXES } from '../../src/adapters/codex/bridge.ts';
import { isLetterPrompt } from '../../src/daemon/claude-skill.ts';
import { actSenderOf } from '../../src/protocol/act-text.ts';
import { inboundText, parseInboundText, REPLY_TOOLS } from '../../src/protocol/inbound-header.ts';
import type { Envelope, Harness } from '../../src/protocol/message.ts';
import { Router } from '../../src/router/router.ts';
import { endpoint, session } from '../helpers/session.ts';

const PROMPTS = JSON.parse(await readFile(new URL('./daily-prompts.json', import.meta.url), 'utf8')) as { letters: string[] };
const frame = (harness: Harness, sessionId: string, messageId: string) => ({ messageId, body: '正文', source: 'peer',
  authority: 'none', sender: { harness, nativeSessionId: sessionId } }) as unknown as Envelope;
// The prefix check each recipient runs before anything else: msd for Claude (claude-hooks), the bridge for Codex. DSH reads the
// peer source kind instead, so only the shared parsers apply to it.
const RECOGNIZERS: Readonly<Record<Harness, ((text: string) => boolean) | null>> = {
  'claude-code': isLetterPrompt, codex: text => CODEX_LETTER_PREFIXES.some(prefix => text.startsWith(prefix)), dsh: null,
};
const HARNESSES: readonly Harness[] = ['claude-code', 'dsh', 'codex'];

test('every header the generator writes is a letter to its recipient, parses back and names its sender for act prompts', () => {
  for (const recipient of HARNESSES) {
    for (const sender of HARNESSES.filter(harness => harness !== recipient)) {
      for (const replyHint of [true, false]) {
        for (const senderLabel of ['评审', null]) {
          const text = inboundText(frame(sender, 'S-1', 'm-1'), { replyTool: REPLY_TOOLS[recipient], replyHint, senderLabel });
          const label = `${sender} to ${recipient}, replyHint ${replyHint}, label ${senderLabel}`;
          if (RECOGNIZERS[recipient] !== null) assert.equal(RECOGNIZERS[recipient]!(text), true, label);
          assert.equal(parseInboundText(text)?.sender, sender, label);
          assert.equal(actSenderOf(text)?.harness, sender, label);
        }
      }
    }
  }
});

test('the fixture letters the Python daily client also reads are exactly what the generator writes', () => {
  const later = (sender: Harness, sessionId: string, messageId: string, senderLabel: string | null) =>
    inboundText(frame(sender, sessionId, messageId), { replyTool: REPLY_TOOLS['claude-code'], replyHint: false, senderLabel });
  assert.ok(PROMPTS.letters.includes(later('dsh', 'D1', 'm-1', '评审')));
  assert.ok(PROMPTS.letters.includes(later('codex', 't-1', 'm-2', null)));
  for (const letter of PROMPTS.letters) assert.equal(isLetterPrompt(letter), true, letter);
});

test('the Claude adapter writes headers msd recognizes, with and without a delivery', async () => {
  const root = await mkdtemp('/tmp/ms-letters-');
  await chmod(root, 0o700);
  const path = join(root, 'inbox.sock');
  const packets: string[] = [];
  const server = net.createServer(socket => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => { packets.push(data); socket.end(); });
  });
  try {
    server.listen(path);
    await once(server, 'listening');
    const router = new Router();
    const dsh = session(router, endpoint('a'));
    const target = endpoint('b', 'claude-code');
    const push = createNativeInboxPush(target, path, ['dsh', 'codex']);
    router.register(target, push);
    const receipt = await dsh.connection.send({ schemaVersion: 1, messageId: 'm1', linkId: dsh.connection.connect('b'), body: '正文' });
    await push(receipt.envelope, { replyHint: true, senderLabel: '评审' });
    await push(receipt.envelope, { replyHint: false, senderLabel: null });
    assert.equal(packets.length, 3);
    for (const packet of packets) assert.equal(isLetterPrompt(JSON.parse(packet).message.content), true, packet);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
