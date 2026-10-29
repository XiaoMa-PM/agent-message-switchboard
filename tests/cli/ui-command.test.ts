// INPUT: runUi with a recording output sink, a scripted browser opener, a stop promise the test resolves and a fixed snapshot.
// OUTPUT: Regressions for the ms ui terminal lines, opening the launch address, the open-failure hint, stop and port release, and
//         UI_START_FAILED.
// POS: Offline tests of src/cli/ui/command.ts; no browser, signal or msd.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { runUi } from '../../src/cli/ui/command.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const refused = (port: number) => new Promise<string>(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve('connected'); });
  socket.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'error'));
});

test('ms ui prints the launch address and the stop hint, opens that address, and stops on the signal with the port released', async () => {
  const out: string[] = []; const opened: string[] = []; const stop = deferred();
  const running = runUi({ out: text => out.push(text), open: async url => { opened.push(url); }, stopped: stop.promise, snapshot: async () => ({}) });
  while (opened.length === 0) await new Promise(resolve => setImmediate(resolve));
  assert.match(out[0], /^ms ui: http:\/\/127\.0\.0\.1:\d+\/ms-ui\/\?code=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(out.slice(1), ['Press Ctrl+C to stop.']);
  assert.equal(opened[0], out[0].slice('ms ui: '.length));
  const port = Number(new URL(opened[0]).port);
  assert.equal(await refused(port), 'connected');
  stop.resolve();
  assert.equal(await running, 'ms ui stopped');
  assert.equal(await refused(port), 'ECONNREFUSED');
});

test('a browser that will not open leaves a hint and the server keeps running until the stop', async () => {
  const out: string[] = []; const stop = deferred();
  const running = runUi({ out: text => out.push(text), open: async () => { throw new Error('open failed'); }, stopped: stop.promise,
    snapshot: async () => ({}) });
  while (out.length < 3) await new Promise(resolve => setImmediate(resolve));
  assert.equal(out[2], 'Could not open the browser; open the address above manually.');
  assert.equal(await refused(Number(new URL(out[0].slice('ms ui: '.length)).port)), 'connected');
  stop.resolve();
  assert.equal(await running, 'ms ui stopped');
});

test('a server that cannot start is UI_START_FAILED and opens nothing', async () => {
  const opened: string[] = [];
  await assert.rejects(runUi({ out: () => {}, open: async url => { opened.push(url); }, stopped: new Promise(() => {}),
    snapshot: async () => ({}), start: async () => { throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }); } }),
  { code: 'UI_START_FAILED', detail: 'EADDRINUSE' });
  assert.deepEqual(opened, []);
});
