import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Event } from 'nostr-tools';
import { buildLabel, parseManifest } from '../src/protocol.ts';
import { Relays } from '../src/relay.ts';
import { createSite } from '../src/server.ts';
import { Store } from '../src/store.ts';
import type { Worker } from '../src/worker.ts';
import { relayFixture } from './fixtures.ts';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0));
const BLOSSOM = 'https://blossom.example';
const signerKey = generateSecretKey();
const authorKey = generateSecretKey();
const author = getPublicKey(authorKey);

function chromiumPath(): string | undefined {
  return Deno.env.get('CHROMIUM_PATH') ?? (Deno.build.os === 'linux' ? '/usr/bin/chromium' : undefined);
}

/** A finished job exactly as the worker leaves it: manifest plus signed, stored label. */
function addCapture(store: Store, relay: string, name: string, title: string): { manifest: Event; label: Event } {
  const manifest = finalizeEvent({ kind: 35129, created_at: Math.floor(Date.now() / 1000), content: '',
    tags: [['d', name], ['x', 'b'.repeat(64)], ['title', title], ['summary', `About ${title}`]] }, authorKey);
  const parsed = parseManifest(manifest)!;
  store.enqueue(parsed, false);
  const job = store.claim()!;
  const label = buildLabel(parsed, { hash: 'c'.repeat(64), size: 2048, width: 1200, height: 750, servers: [BLOSSOM] }, signerKey, relay);
  store.label(job.id, label);
  store.finish(job.id);
  return { manifest, label };
}

async function fixture(profile: Record<string, unknown>) {
  const relay = await relayFixture();
  relay.deliver(finalizeEvent({ kind: 0, created_at: 1, content: JSON.stringify(profile), tags: [] }, authorKey));
  const store = new Store(await Deno.makeTempDir());
  const worker = { config: { pubkey: getPublicKey(signerKey), relays: [relay.url], blossomServers: [BLOSSOM] }, store,
    lastScan: Math.floor(Date.now() / 1000), relayErrors: {} } as unknown as Worker;
  const server = createSite(worker, { relays: new Relays([relay.url], 3000), profileRelays: [] });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return {
    relay, store, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => (error ? reject(error) : done())));
      store.close(); await relay.close();
    },
  };
}

async function openPage(url: string, browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('Content Security Policy')) errors.push(message.text()); });
  await page.route(`${BLOSSOM}/**`, route => route.fulfill({ body: Buffer.from(PNG), contentType: 'image/png' }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (value: string) => { document.documentElement.dataset.copied = value; return Promise.resolve(); } },
    });
  });
  await page.goto(url);
  return { page, errors };
}

const plain = (event: Event) => JSON.parse(JSON.stringify(event));
const copied = (page: Page) => page.locator('html').getAttribute('data-copied');
const noPageScroll = (page: Page) => page.evaluate(() =>
  document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth);

Deno.test('viewer is a full-viewport live app with event inspection, NIP-19 copies, profiles and install bar', async () => {
  const site = await fixture({ name: 'alice', display_name: 'Alice Builder', picture: `${BLOSSOM}/avatar.png`, about: 'Builds napplets.' });
  const first = addCapture(site.store, site.relay.url, 'calendar', 'Calendar');
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  try {
    const { page, errors } = await openPage(site.url, browser);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#live[data-state="live"]').waitFor();
    await page.locator('.card').first().waitFor();
    assert.equal(await page.locator('#done-count').textContent(), '1');
    // Profiles arrive from relays in the background and are pushed without a reload.
    await page.locator('.author-card', { hasText: 'Alice Builder' }).waitFor();
    assert.equal(await page.locator('#detail .detail-title').textContent(), 'Calendar');
    assert.ok(await noPageScroll(page));
    assert.ok(await page.locator('#install-command').isVisible());
    assert.equal(await page.locator('.repo').getAttribute('href'), 'https://github.com/napplet/napshot');

    const nevents = page.locator('#detail .code-row button');
    await nevents.nth(0).click();
    assert.deepEqual(nip19.decode((await copied(page))!).data, { id: first.manifest.id, author, kind: 35129, relays: [site.relay.url] });
    await nevents.nth(1).click();
    assert.deepEqual(nip19.decode((await copied(page))!).data, { kind: 35129, pubkey: author, identifier: 'calendar', relays: [site.relay.url] });
    await nevents.nth(2).click();
    assert.equal((nip19.decode((await copied(page))!).data as { id: string }).id, first.label.id);

    await page.getByRole('button', { name: 'View event JSON' }).nth(1).click();
    await page.waitForFunction(() => document.querySelector('#json-body')?.textContent?.startsWith('{'));
    assert.deepEqual(JSON.parse((await page.locator('#json-body').textContent())!), plain(first.label));
    await page.locator('#json-copy').click();
    assert.deepEqual(JSON.parse((await copied(page))!), plain(first.label));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'View event JSON' }).nth(0).click();
    await page.waitForFunction(() => document.querySelector('#json-body')?.textContent?.startsWith('{'));
    assert.deepEqual(JSON.parse((await page.locator('#json-body').textContent())!), plain(first.manifest));
    await page.keyboard.press('Escape');

    await page.locator('.author-card').click();
    assert.equal(await page.locator('#profile-name').textContent(), 'Alice Builder');
    assert.equal(await page.locator('#profile-open').getAttribute('href'), `https://njump.me/${nip19.npubEncode(author)}`);
    await page.locator('#profile-copy').click();
    assert.equal(await copied(page), nip19.npubEncode(author));
    await page.keyboard.press('Escape');

    // A capture finishing on the server shows up live.
    addCapture(site.store, site.relay.url, 'notes', 'Notes');
    await page.locator('.card', { hasText: 'Notes' }).waitFor();
    assert.equal(await page.locator('.card').count(), 2);
    assert.equal(await page.locator('.card').first().textContent().then(text => text?.includes('Notes')), true);

    await page.locator('#copy-command').click();
    assert.equal(await copied(page), 'npx skills add napplet/napshot');
    await page.getByRole('tab', { name: 'About' }).click();
    assert.ok(await page.locator('#view-about').isVisible());
    assert.equal(await page.locator('#signer-key').textContent(), getPublicKey(signerKey));
    assert.ok(await page.locator('#install-command').isVisible());
    assert.ok(await noPageScroll(page));
    await mkdir('/tmp/napshot-ui', { recursive: true });
    await page.screenshot({ path: '/tmp/napshot-ui/about.png' });
    await page.getByRole('tab', { name: 'Captures' }).click();
    await page.screenshot({ path: '/tmp/napshot-ui/desktop.png' });

    await page.setViewportSize({ width: 360, height: 740 });
    await page.reload();
    await page.locator('.card').first().waitFor();
    assert.ok(await noPageScroll(page));
    assert.ok(await page.locator('#install-command').isVisible());
    await page.screenshot({ path: '/tmp/napshot-ui/mobile.png' });
    await page.locator('.card-button').first().click();
    await page.locator('#detail .back').waitFor();
    assert.ok(await noPageScroll(page));
    await page.screenshot({ path: '/tmp/napshot-ui/mobile-detail.png' });
    await page.locator('#detail .back').click();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await site.close();
  }
});

Deno.test('untrusted profile and napplet strings render as text, unsafe links are dropped', async () => {
  const site = await fixture({ name: '<img src=x onerror="window.injected=true">', picture: 'javascript:alert(1)' });
  addCapture(site.store, site.relay.url, 'evil', '<script>window.injected=true</script>');
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  try {
    const { page, errors } = await openPage(site.url, browser);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('.author-card', { hasText: '<img src=x' }).waitFor();
    assert.equal(await page.locator('#detail .detail-title').textContent(), '<script>window.injected=true</script>');
    assert.equal(await page.evaluate(() => 'injected' in window), false);
    assert.equal(await page.locator('.avatar img').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await site.close();
  }
});

Deno.test('server serves the app, live feed, captured events and exact skill with security headers', async () => {
  const site = await fixture({ name: 'alice' });
  const { label, manifest } = addCapture(site.store, site.relay.url, 'calendar', 'Calendar');
  try {
    for (const [path, filename, contentType] of [
      ['/', 'public/index.html', 'text/html'], ['/style.css', 'public/style.css', 'text/css'],
      ['/app.js', 'public/app.js', 'text/javascript'], ['/skill', 'skills/napshot-shell/SKILL.md', 'text/plain'],
    ]) {
      const response = await fetch(site.url + path);
      assert.equal(response.status, 200, path);
      assert.ok(response.headers.get('content-type')?.startsWith(contentType), path);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(response.headers.get('content-security-policy')?.includes("script-src 'self'"));
      assert.equal(await response.text(), await readFile(resolve(filename), 'utf8'));
    }
    const snapshot = await (await fetch(site.url + '/api/captures')).json();
    assert.equal(snapshot.captures.length, 1);
    assert.equal(snapshot.captures[0].napplet.title, 'Calendar');
    assert.deepEqual(snapshot.captures[0].screenshot.urls, [`${BLOSSOM}/${'c'.repeat(64)}.png`]);
    assert.deepEqual(await (await fetch(`${site.url}/api/event/${label.id}`)).json(), plain(label));
    assert.deepEqual(await (await fetch(`${site.url}/api/event/${manifest.id}`)).json(), plain(manifest));
    const stream = await fetch(site.url + '/api/stream');
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = stream.body!.getReader();
    let text = '';
    while (!text.includes('event: captures')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    for (const [path, method, expectedStatus] of [
      ['/healthz', 'GET', 200], ['/.env', 'GET', 404], ['/api/status', 'POST', 405],
      [`/api/event/${'d'.repeat(64)}`, 'GET', 404], ['/api/event/not-hex', 'GET', 404],
    ] as const) {
      const response = await fetch(site.url + path, { method });
      assert.equal(response.status, expectedStatus, path);
      await response.body?.cancel();
    }
  } finally {
    await site.close();
  }
});

Deno.test('status contract without a worker stays redacted and empty', async () => {
  const server = createSite(undefined, { profileRelays: [] });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(url + '/api/status')).json(), {
      name: 'Napshot', pubkey: null, relays: [], blossomServers: [],
      counts: { pending: 0, done: 0, failed: 0 }, lastScan: null, relayErrors: {},
    });
    assert.deepEqual((await (await fetch(url + '/api/captures')).json()).captures, []);
    const health = await fetch(url + '/healthz');
    assert.equal(health.status, 503);
    await health.body?.cancel();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
