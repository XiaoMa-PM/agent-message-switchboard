// INPUT: The page assets (loadUiAssets reads src/cli/ui/assets once), a snapshot reader and an optional secret source for tests.
// OUTPUT: startUiServer → {address, port, launchUrl, close}: a GET-only HTTP server on 127.0.0.1 that checks Host, method and the
//         session cookie in that order and sends the fixed security headers on every response; loadUiAssets.
// POS: ms ui HTTP layer; it writes no logs and has no route that changes anything.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { createUiAuth, UI_BASE, type UiAuth } from './auth.ts';

export type UiAsset = Readonly<{ type: string; body: Buffer }>;
export type UiAssets = ReadonlyMap<string, UiAsset>;
export type UiServerOptions = Readonly<{ assets: UiAssets; snapshot: () => Promise<unknown>; newSecret?: () => string }>;
export type UiServer = Readonly<{ address: string; port: number; launchUrl: string; close: () => Promise<void> }>;

const SCRIPT = 'text/javascript; charset=utf-8';
const ASSET_TYPES: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']], ['app.css', ['app.css', 'text/css; charset=utf-8']],
  ['main.js', ['main.js', SCRIPT]], ['app.js', ['app.js', SCRIPT]], ['view.js', ['view.js', SCRIPT]],
  ['icon.svg', ['icon.svg', 'image/svg+xml']],
]);
const HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; "
    + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin',
});
const TEXT = 'text/plain; charset=utf-8';
const SENTENCES: Readonly<Record<number, string>> = Object.freeze({
  401: '本页的登录已失效，请重新运行 ms ui。', 403: '只能从本机地址打开本页。', 404: '没有这个页面。', 405: '本页只读，只接受 GET。',
  500: '状态页出错了。',
});
const STATE_PATH = `${UI_BASE}api/state`;

export async function loadUiAssets(dir: URL = new URL('./assets/', import.meta.url)): Promise<UiAssets> {
  const entries = await Promise.all([...ASSET_TYPES].map(async ([key, [file, type]]) =>
    [key, Object.freeze({ type, body: await readFile(new URL(file, dir)) })] as const));
  return new Map(entries);
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  response.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)), ...extra });
  response.end(body);
}

function refuse(response: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  send(response, status, TEXT, SENTENCES[status], extra);
}

function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host?.toLowerCase() === `localhost:${port}`;
}

async function handle(request: IncomingMessage, response: ServerResponse, port: number, auth: UiAuth, options: UiServerOptions) {
  if (!hostAllowed(request.headers.host, port)) return refuse(response, 403);
  if (request.method !== 'GET') return refuse(response, 405, { Allow: 'GET' });
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const signedIn = auth.signedIn(request.headers.cookie);
  // A restored tab or a reload of the launch address must not read as expired, so a signed-in browser skips the code entirely.
  if (url.pathname === UI_BASE && url.searchParams.has('code')) {
    if (signedIn) return send(response, 303, TEXT, '', { Location: UI_BASE });
    if (!auth.redeem(url.searchParams.get('code'))) return refuse(response, 401);
    return send(response, 303, TEXT, '', { Location: UI_BASE, 'Set-Cookie': auth.setCookie });
  }
  if (!signedIn) return refuse(response, 401);
  if (url.pathname === STATE_PATH) return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(await options.snapshot()));
  const asset = url.pathname.startsWith(UI_BASE) ? options.assets.get(url.pathname.slice(UI_BASE.length)) : undefined;
  return asset === undefined ? refuse(response, 404) : send(response, 200, asset.type, asset.body);
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  let ready: Readonly<{ port: number; auth: UiAuth }> | null = null;
  // requireHostHeader off: a request without Host gets this server's own 403 and headers, not Node's bare 400.
  const server = createServer({ requireHostHeader: false }, (request, response) => {
    if (ready === null) { response.destroy(); return; }
    handle(request, response, ready.port, ready.auth, options).catch(() => {
      if (response.headersSent) response.destroy(); else refuse(response, 500);
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const { address, port } = server.address() as AddressInfo;
  const auth = createUiAuth(port, options.newSecret);
  ready = Object.freeze({ port, auth });
  return Object.freeze({
    address, port, launchUrl: `http://127.0.0.1:${port}${UI_BASE}?code=${auth.launchCode}`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  });
}
