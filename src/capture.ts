import { Buffer } from 'node:buffer';
/** Adapted from napplet's MIT-licensed Paja screenshot runner; see THIRD_PARTY_NOTICES.md. */
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startPajaServer } from '@kehto/paja';
import { chromium, type Browser, type Page } from 'playwright';

const PREVIEW_PATHS = new Set(['/', '/__kehto/config.json', '/__kehto/browser-host.js',
  '/__kehto/target.html', '/__kehto/target-cors.json']);

export interface CaptureOptions {
  executablePath?: string;
  width: number;
  height: number;
  delayMs: number;
  timeoutMs: number;
}

/** Render verified HTML in a fresh, anonymous Paja shell and return only its iframe PNG. */
export async function capture(html: Buffer, options: CaptureOptions): Promise<Buffer> {
  validateOptions(options);
  // Paja's development iframe allows network by default. Apply policy before any artifact bytes.
  const policy = ["default-src 'none'", "script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:",
    "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:', 'media-src data: blob:',
    "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'"];
  const isolatedHtml = Buffer.concat([
    Buffer.from(`<meta http-equiv="Content-Security-Policy" content="${policy.join('; ')}">`), html,
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
        identity: { mode: 'anonymous' }, relay: { mode: 'memory' }, storage: { mode: 'memory' },
        upload: { mode: 'disabled' }, media: { enabled: false }, notifications: { enabled: false },
        intent: { enabled: false }, cvm: { enabled: false },
      },
    } });
    if (ended) { await started.close(); expired(); }
    preview = started;
    proxy = createPreviewProxy(new URL(preview.url).origin);
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
    return renderFrame(browser, preview.url, options);
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

async function renderFrame(browser: Browser, url: string, options: CaptureOptions): Promise<Buffer> {
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
  await context.routeWebSocket('**/*', (socket) => socket.close());
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
  const location = await content.locator('body').evaluate(() => globalThis.location.href);
  if (location !== 'about:srcdoc') throw new Error('Napplet navigated away during capture');
  return frame.screenshot({ type: 'png', timeout: options.timeoutMs });
}

/** Chromium must proxy even loopback requests; only the fixed local Paja endpoints are forwarded. */
function createPreviewProxy(origin: string): Server {
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
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  return server;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function validateOptions(options: CaptureOptions): void {
  const bounds = { width: [1, 4096], height: [1, 4096], delayMs: [0, 30_000], timeoutMs: [1, 120_000] };
  for (const [name, [min, max]] of Object.entries(bounds)) {
    const value = options[name as keyof typeof bounds];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid capture ${name}`);
  }
}
