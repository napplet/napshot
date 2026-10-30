import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { capture } from '../src/capture.ts';

const options = {
  executablePath: Deno.env.get('CHROMIUM_PATH') ?? '/usr/bin/chromium',
  width: 320, height: 200, delayMs: 200, timeoutMs: 15_000,
};

Deno.test('capture renders through the real Paja shim and crops to the napplet', async () => {
  const html = Buffer.from(`<!doctype html><html><body style="margin:0;min-height:100vh;background:rgb(220,10,10)">
    <script>if (window.napplet) document.body.style.background = 'rgb(20,180,80)';</script>
    </body></html>`);
  const png = await capture(html, options);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), options.width);
  assert.equal(png.readUInt32BE(20), options.height);
  const browser = await chromium.launch({ executablePath: options.executablePath, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    const pixel = await page.evaluate(async (encoded) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(160, 100, 1, 1).data);
    }, png.toString('base64'));
    assert.deepEqual(pixel, [20, 180, 80, 255], 'real shim-backed napplet pixels, without shell chrome');
  } finally {
    await browser.close();
  }
});

Deno.test('capture blocks HTTP and WebSocket egress from a hostile artifact', async () => {
  let requests = 0;
  const sink = createServer((_request, response) => { requests++; response.end('leaked'); });
  sink.on('upgrade', (_request, socket) => { requests++; socket.destroy(); });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const port = (sink.address() as AddressInfo).port;
  try {
    const html = Buffer.from(`<!doctype html><html><body>Offline
      <img src="http://127.0.0.1:${port}/image">
      <script>
        fetch('http://127.0.0.1:${port}/fetch').catch(() => {});
        new WebSocket('ws://127.0.0.1:${port}/socket');
        const frame = document.createElement('iframe');
        frame.src = 'http://127.0.0.1:${port}/frame'; document.body.append(frame);
      </script></body></html>`);
    const png = await capture(html, options);
    assert.ok(png.length > 100);
    assert.equal(requests, 0);
  } finally {
    sink.closeAllConnections();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
  }
});

Deno.test('a runaway renderer times out and the next capture succeeds', async () => {
  const started = Date.now();
  await assert.rejects(capture(Buffer.from('<body><script>while(true){}</script></body>'), {
    ...options, timeoutMs: 1500,
  }), /timed out|Timeout/);
  assert.ok(Date.now() - started < 8000, 'timeout also closes Chromium');
  const next = await capture(Buffer.from('<body style="background:green">Recovered</body>'), options);
  assert.equal(next.subarray(1, 4).toString(), 'PNG');
});

Deno.test('self-navigation cannot escape the network boundary or produce a browser error screenshot', async () => {
  let requests = 0;
  const sink = createServer((_request, response) => { requests++; response.end('<body>Remote</body>'); });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const port = (sink.address() as AddressInfo).port;
  try {
    const html = Buffer.from(`<body>Leaving<script>setTimeout(() => {
      location.href = 'http://127.0.0.1:${port}/escape';
    }, 10)</script></body>`);
    const result = await capture(html, { ...options, timeoutMs: 2000 }).catch(() => null);
    assert.equal(requests, 0, 'even frame navigation must pass the egress boundary');
    assert.equal(result, null, 'do not publish an error page as the napplet');
  } finally {
    sink.closeAllConnections();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
  }
});

Deno.test('invalid dimensions fail before launching Chromium', async () => {
  await assert.rejects(capture(Buffer.from('<body>Bad options</body>'), { ...options, width: 0 }), /width/);
});
