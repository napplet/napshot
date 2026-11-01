import { Buffer } from 'node:buffer';
/** Adapted from napplet's MIT-licensed Paja screenshot runner; see THIRD_PARTY_NOTICES.md. */
import { lookup } from 'node:dns/promises';
import { createServer, get, type Server } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { startPajaServer } from '@kehto/paja';
import { chromium, type Browser, type Page } from 'playwright';
import { isPublicAddress } from './network.ts';

const PREVIEW_PATHS = new Set(['/', '/__kehto/config.json', '/__kehto/browser-host.js',
  '/__kehto/target.html', '/__kehto/target-cors.json']);

export interface CaptureOptions {
  executablePath?: string;
  width: number;
  height: number;
  /** Minimum time the napplet runs before any screenshot. */
  delayMs: number;
  /** Quiet period on the shell bus (no messages reaching the napplet) that counts as settled. */
  idleMs: number;
  /** Upper bound on waiting for the bus to settle, after `delayMs`. */
  settleMs: number;
  timeoutMs: number;
  /** Read-only public key presented to napplets that ask for identity; no signer is exposed. */
  identity?: string;
  /** Relays the shell may read from on the napplet's behalf; nothing else leaves the sandbox. */
  relays?: string[];
}

/**
 * Observes shell traffic from inside the napplet so the screenshot waits for data, not a stopwatch.
 * Window messages and transferred MessagePorts are the only channels across the Kehto boundary.
 */
const BUS_PROBE = `<script>(() => {
  const bus = { count: 0, last: performance.now() };
  const bump = () => { bus.count++; bus.last = performance.now(); };
  addEventListener('message', bump, true);
  const port = MessagePort.prototype;
  const onmessage = Object.getOwnPropertyDescriptor(port, 'onmessage');
  if (onmessage?.set) Object.defineProperty(port, 'onmessage', { ...onmessage,
    set(handler) { onmessage.set.call(this, handler); this.addEventListener('message', bump); } });
  const add = port.addEventListener;
  port.addEventListener = function (type, ...rest) {
    if (type === 'message') add.call(this, 'message', bump);
    return add.call(this, type, ...rest);
  };
  Object.defineProperty(globalThis, '__napshotBus', { value: bus });
})()</script>`;

/** Render verified HTML in a fresh Paja shell and return only its iframe PNG. */
export async function capture(html: Buffer, options: CaptureOptions): Promise<Buffer> {
  validateOptions(options);
  const relays = (options.relays ?? []).map(relayOrigin);
  // Paja's development iframe allows network by default. Apply policy before any artifact bytes.
  const policy = ["default-src 'none'", "script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:",
    "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:', 'media-src data: blob:',
    "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'"];
  const isolatedHtml = Buffer.concat([
    Buffer.from(`<meta http-equiv="Content-Security-Policy" content="${policy.join('; ')}">${BUS_PROBE}`), html,
  ]);
  const target = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
    response.end(isolatedHtml);
  });
  let preview: Awaited<ReturnType<typeof startPajaServer>> | undefined;
  let browser: Browser | undefined;
  let proxy: Server | undefined;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = () => { if (ended) throw new Error('Capture timed out'); };
  const render = async () => {
    await listen(target);
    expired();
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
    const started = await startPajaServer({ options: {
      host: '127.0.0.1', port: 0, targetUrl,
      simulation: {
        identity: options.identity ? { mode: 'fixed', pubkey: options.identity } : { mode: 'anonymous' },
        // Paja advertises relay and outbox only in live mode; memory mode leaves data-driven napplets empty.
        relay: relays.length ? { mode: 'live', urls: options.relays } : { mode: 'memory' }, storage: { mode: 'memory' },
        upload: { mode: 'disabled' }, media: { enabled: false }, notifications: { enabled: false },
        intent: { enabled: false }, cvm: { enabled: false },
      },
    } });
    if (ended) { await started.close(); expired(); }
    preview = started;
    proxy = createPreviewProxy(new URL(preview.url).origin, relays);
    await listen(proxy);
    expired();
    const launched = await chromium.launch({
      executablePath: options.executablePath, chromiumSandbox: true, timeout: options.timeoutMs,
      env: { PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      proxy: { server: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, bypass: '<-loopback>' },
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    if (ended) { await launched.close(); expired(); }
    browser = launched;
    return renderFrame(browser, preview.url, options, relays);
  };
  try {
    return await Promise.race([
      render(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { ended = true; reject(new Error('Capture timed out')); }, options.timeoutMs);
      }),
    ]);
  } finally {
    ended = true;
    clearTimeout(timer);
    try { await browser?.close(); } finally {
      try { if (proxy) await close(proxy); } finally {
        try { await preview?.close(); } finally { await close(target); }
      }
    }
  }
}

async function renderFrame(browser: Browser, url: string, options: CaptureOptions, relays: string[]): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    serviceWorkers: 'block', acceptDownloads: false, permissions: [],
  });
  const page = await context.newPage();
  const origin = new URL(url).origin;
  await context.route('**/*', (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const safe = request.method() === 'GET' && target.origin === origin && PREVIEW_PATHS.has(target.pathname)
      && !target.search && request.frame() === page.mainFrame();
    return safe ? route.continue() : route.abort('blockedbyclient');
  });
  // The napplet frame cannot open sockets (connect-src 'none'); only the shell reaches the listed relays.
  await context.routeWebSocket('**/*', (socket) => {
    if (relays.includes(relayOrigin(socket.url()))) socket.connectToServer(); else socket.close();
  });
  context.on('page', (popup) => { void popup.close(); });
  page.on('dialog', (dialog) => { void dialog.dismiss(); });
  page.setDefaultTimeout(options.timeoutMs);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  await page.waitForFunction(() => Boolean(document.querySelector<HTMLIFrameElement>('#napplet-frame')?.srcdoc));
  return screenshotFrame(page, options);
}

async function screenshotFrame(page: Page, options: CaptureOptions): Promise<Buffer> {
  const frame = page.locator('#napplet-frame');
  await frame.waitFor({ state: 'attached' });
  await frame.evaluate((element, size) => {
    Object.assign((element as HTMLElement).style, {
      width: `${size.width}px`, height: `${size.height}px`, maxWidth: 'none', maxHeight: 'none',
      boxSizing: 'border-box', position: 'fixed', left: '0', top: '0', border: '0', zIndex: '2147483647',
    });
  }, { width: options.width, height: options.height });
  const content = frame.contentFrame();
  await content.locator('body').waitFor({ state: 'visible' });
  await content.locator('body').evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(options.delayMs);
  await settle(page, options);
  const location = await content.locator('body').evaluate(() => globalThis.location.href);
  if (location !== 'about:srcdoc') throw new Error('Napplet navigated away during capture');
  return frame.screenshot({ type: 'png', timeout: options.timeoutMs });
}

/** Wait until shell traffic into the napplet has been quiet for `idleMs`, or `settleMs` has elapsed. */
async function settle(page: Page, options: CaptureOptions): Promise<void> {
  const deadline = Date.now() + options.settleMs;
  const body = page.locator('#napplet-frame').contentFrame().locator('body');
  while (Date.now() < deadline) {
    const quiet = await body.evaluate(() => {
      const bus = (globalThis as { __napshotBus?: { last: number } }).__napshotBus;
      return bus ? performance.now() - bus.last : Infinity;
    });
    if (quiet >= options.idleMs) return;
    await page.waitForTimeout(Math.min(250, Math.max(50, options.idleMs - quiet)));
  }
}

/** Canonical `scheme://host:port` for relay allow-listing. */
function relayOrigin(input: string): string {
  const url = new URL(input);
  const port = url.port || (url.protocol === 'wss:' || url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${url.hostname}:${port}`;
}

/**
 * Chromium must proxy even loopback requests; only the fixed local Paja endpoints are forwarded,
 * plus WebSocket connections to the allow-listed relays (CONNECT for wss, upgrade for ws).
 */
function createPreviewProxy(origin: string, relays: string[]): Server {
  const server = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? ''); } catch { response.writeHead(403).end(); return; }
    if (request.method !== 'GET' || url.origin !== origin || !PREVIEW_PATHS.has(url.pathname) || url.search) {
      response.writeHead(403).end();
      return;
    }
    const upstream = get(url, { timeout: 5000 }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => upstream.destroy());
  });
  // Browsers tunnel every WebSocket, ws:// included, through CONNECT.
  server.on('connect', (request, socket, head) => {
    const target = relayTarget(request.url ?? '', relays);
    if (!target) { socket.destroy(); return; }
    void tunnel(socket, head, target, tunnelsOf(server));
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  return server;
}

interface RelayTarget { hostname: string; port: number; plain: boolean }

/** The allow-listed relay a CONNECT `host:port` names, or undefined when it is not permitted. */
function relayTarget(destination: string, relays: string[]): RelayTarget | undefined {
  for (const relay of relays) {
    const url = new URL(relay);
    const port = Number(relay.split(':').pop());
    const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
    if (destination === `${host}:${port}`) return { hostname: url.hostname, port, plain: url.protocol === 'ws:' };
  }
}

const LOOPBACK = new Map([['127.0.0.1', '127.0.0.1'], ['::1', '::1'], ['localhost', '127.0.0.1']]);

/** Resolve a relay host once and refuse private destinations, except loopback for `ws://` test relays. */
async function relayAddress(target: RelayTarget): Promise<string> {
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const loopback = target.plain ? LOOPBACK.get(host) : undefined;
  if (loopback) return loopback;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error('Non-public relay rejected');
  return addresses[0].address;
}

/** Sockets handed to CONNECT tunnels leave the HTTP server's bookkeeping; track them so close() can end them. */
const TUNNELS = new WeakMap<Server, Set<Duplex>>();
function tunnelsOf(server: Server): Set<Duplex> {
  let sockets = TUNNELS.get(server);
  if (!sockets) TUNNELS.set(server, sockets = new Set());
  return sockets;
}

async function tunnel(client: Duplex, head: Buffer, target: RelayTarget, open: Set<Duplex>): Promise<void> {
  let upstream: Socket | undefined;
  const track = (socket: Duplex) => { open.add(socket); socket.once('close', () => open.delete(socket)); };
  track(client);
  try {
    const address = await relayAddress(target);
    upstream = connect({ host: address, port: target.port });
    track(upstream);
    await new Promise<void>((resolve, reject) => { upstream!.once('connect', resolve); upstream!.once('error', reject); });
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream?.destroy());
  } catch { upstream?.destroy(); client.destroy(); }
}


function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

function close(server: Server): Promise<void> {
  for (const socket of TUNNELS.get(server) ?? []) socket.destroy();
  server.closeAllConnections();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function validateOptions(options: CaptureOptions): void {
  const bounds = { width: [1, 4096], height: [1, 4096], delayMs: [0, 30_000], idleMs: [50, 30_000],
    settleMs: [0, 120_000], timeoutMs: [1, 120_000] };
  for (const [name, [min, max]] of Object.entries(bounds)) {
    if (!inRange(options[name as keyof typeof bounds], min, max)) throw new Error(`Invalid capture ${name}`);
  }
  if (options.identity !== undefined && !/^[0-9a-f]{64}$/.test(options.identity)) throw new Error('Invalid capture identity');
  if (!(options.relays ?? []).every(isRelayUrl)) throw new Error('Invalid capture relay');
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password;
  } catch { return false; }
}
