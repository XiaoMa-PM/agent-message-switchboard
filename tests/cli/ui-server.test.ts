// INPUT: A real ms ui HTTP server on 127.0.0.1 (system port) with fixed secrets, synthetic assets and a scripted snapshot.
// OUTPUT: Regressions for Host, method and cookie checks, the launch-code redirect, fixed refusal bodies, security headers, content
//         types, the real asset set and port release.
// POS: Offline tests of src/cli/ui/server.ts; no browser, msd or host.
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { loadUiAssets, startUiServer, type UiServer } from '../../src/cli/ui/server.ts';

type Reply = Readonly<{ status: number; headers: IncomingHttpHeaders; body: string }>;

const ASSETS = new Map([
  ['', { type: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><p>page</p>') }],
  ['app.js', { type: 'text/javascript; charset=utf-8', body: Buffer.from('export {};') }],
]);
const SNAPSHOT = { daemon: { state: 'down' }, installed: null, title: '<img src=x onerror=alert(1)>' };
const TOKEN = 'token-abcdef';
const COOKIE = `ms_ui_PORT=${TOKEN}`;

async function serve(snapshot: () => Promise<unknown> = async () => SNAPSHOT): Promise<UiServer & { cookie: string }> {
  const values = ['code-123', TOKEN];
  const server = await startUiServer({ assets: ASSETS, snapshot, newSecret: () => values.shift()! });
  return { ...server, cookie: COOKIE.replace('PORT', String(server.port)) };
}

function get(server: UiServer, path: string, options: { method?: string; host?: string | null; cookie?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: server.port, path, method: options.method ?? 'GET', headers, setHost: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const host = options.host === undefined ? `127.0.0.1:${server.port}` : options.host;
    if (host !== null) outgoing.setHeader('host', host);
    outgoing.on('error', reject);
    outgoing.end();
  });
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; "
  + "form-action 'none'; frame-ancestors 'none'";

function assertHardened(reply: Reply, label: string): void {
  assert.equal(reply.headers['content-security-policy'], CSP, label);
  assert.doesNotMatch(String(reply.headers['content-security-policy']), /unsafe-/, label);
  assert.equal(reply.headers['x-content-type-options'], 'nosniff', label);
  assert.equal(reply.headers['referrer-policy'], 'no-referrer', label);
  assert.equal(reply.headers['cache-control'], 'no-store', label);
  assert.equal(reply.headers['x-frame-options'], 'DENY', label);
  assert.equal(reply.headers['cross-origin-resource-policy'], 'same-origin', label);
  assert.equal(reply.headers['cross-origin-opener-policy'], 'same-origin', label);
  assert.deepEqual(Object.keys(reply.headers).filter(name => name.startsWith('access-control-')), [], label);
}

test('the server listens on 127.0.0.1 with a system port and hands out the launch address', async () => {
  const server = await serve();
  try {
    assert.equal(server.address, '127.0.0.1');
    assert.notEqual(server.port, 0);
    assert.equal(server.launchUrl, `http://127.0.0.1:${server.port}/ms-ui/?code=code-123`);
  } finally { await server.close(); }
});

test('the launch code sets the session cookie once and redirects to the page without the code', async () => {
  const server = await serve();
  try {
    const first = await get(server, '/ms-ui/?code=code-123');
    assert.equal(first.status, 303);
    assert.equal(first.headers.location, '/ms-ui/');
    assert.deepEqual(first.headers['set-cookie'], [`${server.cookie}; Path=/ms-ui/; HttpOnly; SameSite=Strict`]);
    assertHardened(first, 'redirect');
    const page = await get(server, '/ms-ui/', { cookie: server.cookie });
    assert.deepEqual([page.status, page.headers['content-type'], page.body], [200, 'text/html; charset=utf-8', '<!doctype html><p>page</p>']);
    const script = await get(server, '/ms-ui/app.js', { cookie: server.cookie });
    assert.deepEqual([script.status, script.headers['content-type']], [200, 'text/javascript; charset=utf-8']);
    const state = await get(server, '/ms-ui/api/state', { cookie: server.cookie });
    assert.deepEqual([state.status, state.headers['content-type'], JSON.parse(state.body)], [200, 'application/json; charset=utf-8', SNAPSHOT]);
    for (const reply of [page, script, state]) assertHardened(reply, 'ok');
  } finally { await server.close(); }
});

test('with a valid cookie any address that carries a code redirects to the page, used or wrong', async () => {
  const server = await serve();
  try {
    await get(server, '/ms-ui/?code=code-123');
    for (const code of ['code-123', 'nope', '']) {
      const reply = await get(server, `/ms-ui/?code=${code}`, { cookie: server.cookie });
      assert.deepEqual([reply.status, reply.headers.location, reply.headers['set-cookie']], [303, '/ms-ui/', undefined], code);
    }
  } finally { await server.close(); }
});

test('missing, wrong or reused secrets get the fixed 401 sentence and no data', async () => {
  const server = await serve();
  try {
    const refusals = [
      await get(server, '/ms-ui/'),
      await get(server, '/ms-ui/api/state'),
      await get(server, '/ms-ui/api/state', { cookie: `ms_ui_${server.port}=wrong` }),
      await get(server, '/ms-ui/api/state', { cookie: `ms_ui_${server.port + 1}=${TOKEN}` }),
      await get(server, '/ms-ui/?code=wrong'),
    ];
    assert.equal((await get(server, '/ms-ui/?code=code-123')).status, 303);
    refusals.push(await get(server, '/ms-ui/?code=code-123'));
    for (const [index, reply] of refusals.entries()) {
      assert.deepEqual([reply.status, reply.headers['content-type'], reply.body],
        [401, 'text/plain; charset=utf-8', '本页的登录已失效，请重新运行 ms ui。'], String(index));
      assert.equal(reply.headers['set-cookie'], undefined);
      assertHardened(reply, `401 ${index}`);
    }
  } finally { await server.close(); }
});

test('a foreign or missing Host is 403 before anything else, even with a valid cookie', async () => {
  const server = await serve();
  try {
    await get(server, '/ms-ui/?code=code-123');
    const port = server.port;
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `127.0.0.1`, `localhost.evil:${port}`, '', null]) {
      const reply = await get(server, '/ms-ui/api/state', { host, cookie: server.cookie });
      assert.deepEqual([reply.status, reply.body], [403, '只能从本机地址打开本页。'], String(host));
      assertHardened(reply, `403 ${host}`);
    }
    for (const host of [`localhost:${port}`, `LocalHost:${port}`]) {
      assert.equal((await get(server, '/ms-ui/api/state', { host })).status, 401, host);
    }
    assert.equal((await get(server, '/ms-ui/api/state', { host: `127.0.0.1:${port}`, cookie: server.cookie })).status, 200);
  } finally { await server.close(); }
});

test('every method but GET is 405 with Allow: GET and no CORS headers', async () => {
  const server = await serve();
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
      const reply = await get(server, '/ms-ui/api/state', { method, cookie: server.cookie });
      assert.deepEqual([reply.status, reply.headers.allow], [405, 'GET'], method);
      if (method !== 'HEAD') assert.equal(reply.body, '本页只读，只接受 GET。', method);
      assertHardened(reply, method);
    }
  } finally { await server.close(); }
});

test('unknown paths, write-looking paths and prototype keys are 404 with a fixed sentence', async () => {
  const server = await serve();
  try {
    await get(server, '/ms-ui/?code=code-123');
    for (const path of ['/', '/favicon.ico', '/ms-ui/api/config.set', '/ms-ui/api/links.resume', '/ms-ui/constructor', '/ms-ui/app.css',
      '/ms-ui/api/state/x', '/ms-ui']) {
      const reply = await get(server, path, { cookie: server.cookie });
      assert.deepEqual([reply.status, reply.body], [404, '没有这个页面。'], path);
      assertHardened(reply, path);
    }
  } finally { await server.close(); }
});

test('a failing snapshot is a bare 500 and the server keeps serving', async () => {
  let fail = true;
  const server = await serve(async () => { if (fail) throw new Error('boom /Users/someone/secret'); return SNAPSHOT; });
  try {
    await get(server, '/ms-ui/?code=code-123');
    const reply = await get(server, '/ms-ui/api/state', { cookie: server.cookie });
    assert.deepEqual([reply.status, reply.body], [500, '状态页出错了。']);
    assertHardened(reply, '500');
    fail = false;
    assert.equal((await get(server, '/ms-ui/api/state', { cookie: server.cookie })).status, 200);
  } finally { await server.close(); }
});

test('closing the server releases the port, also with an idle keep-alive connection open', async () => {
  const server = await serve();
  const idle = net.connect(server.port, '127.0.0.1');
  idle.on('error', () => undefined);
  await new Promise(resolve => idle.once('connect', resolve));
  await server.close();
  const refused = await new Promise<string>(resolve => {
    const socket = net.connect(server.port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'error'));
  });
  assert.equal(refused, 'ECONNREFUSED');
  idle.destroy();
});

test('the real asset set loads with fixed types and keeps scripts and styles out of the HTML', async () => {
  const assets = await loadUiAssets();
  assert.deepEqual([...assets.keys()].sort(), ['', 'app.css', 'app.js', 'icon.svg', 'main.js', 'view.js']);
  assert.deepEqual(Object.fromEntries([...assets].map(([key, asset]) => [key, asset.type])), {
    '': 'text/html; charset=utf-8', 'app.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8',
    'icon.svg': 'image/svg+xml', 'main.js': 'text/javascript; charset=utf-8', 'view.js': 'text/javascript; charset=utf-8',
  });
  const html = assets.get('')!.body.toString('utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=|javascript:/i);
  assert.match(html, /<script type="module" src="main\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="app\.css">/);
  for (const name of ['app.js', 'main.js', 'view.js']) {
    assert.doesNotMatch(assets.get(name)!.body.toString('utf8'),
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|setHTMLUnsafe|\beval\(|new Function|createContextualFragment/, name);
  }
});
