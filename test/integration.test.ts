import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools';
import { sha256 } from '../src/blossom.ts';
import { capture } from '../src/capture.ts';
import type { Config } from '../src/config.ts';
import { Network } from '../src/network.ts';
import { buildLabel, parseManifest } from '../src/protocol.ts';
import { Relays } from '../src/relay.ts';
import { Store } from '../src/store.ts';
import { Worker } from '../src/worker.ts';
import { createSite } from '../src/server.ts';
import { blossomFixture, relayFixture } from './fixtures.ts';

const html = Buffer.from('<!doctype html><body style="margin:0;background:#205e47;color:white">Napshot wire test</body>');
const smallPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1EAAAAASUVORK5CYII=', 'base64');

function manifest(options: { kind?: number; name?: string; tags?: string[][]; key?: Uint8Array; createdAt?: number } = {}): Event {
  const kind = options.kind ?? 15129;
  return finalizeEvent({ kind, content: 'Test napplet', created_at: options.createdAt ?? Math.floor(Date.now() / 1000) - 1,
    tags: [['x', sha256(html)], ...(kind === 35129 ? [['d', options.name ?? 'clock']] : []), ...(options.tags ?? [])],
  }, options.key ?? generateSecretKey());
}

class DueStore extends Store {
  override next() { return super.next(Date.now() + 3_600_001); }
}

async function environment(relayTimeoutMs = 250) {
  const relay = await relayFixture();
  const first = await blossomFixture(); const second = await blossomFixture();
  const directory = await mkdtemp(join(tmpdir(), 'napshot-integration-'));
  first.blobs.set(sha256(html), html); second.blobs.set(sha256(html), html);
  const key = generateSecretKey();
  const config: Config = { key, pubkey: getPublicKey(key), relays: [relay.url],
    blossomServers: [first.origin, second.origin], trustedAuthors: [getPublicKey(key)], dataDir: directory,
    host: '127.0.0.1', port: 0, backfillSince: 0, resyncMs: 60000, concurrency: 2, minReplicas: 2,
    capture: { executablePath: Deno.env.get('CHROMIUM_PATH') ?? '/usr/bin/chromium', width: 320, height: 200,
      delayMs: 100, timeoutMs: 15000 },
  };
  const logs: unknown[] = [];
  const worker = (store: Store, render: typeof capture = () => Promise.resolve(smallPng)) => new Worker(config, store, {
    network: new Network(true), relays: new Relays(config.relays, relayTimeoutMs), capture: render,
    log: (...fields) => logs.push(fields),
  });
  return { relay, first, second, config, directory, worker, logs,
    close: async () => { await relay.close(); await first.close(); await second.close(); await rm(directory, { recursive: true }); } };
}

Deno.test('wire pipeline captures root and named revisions, uploads identical PNGs twice, signs and publishes labels', async () => {
  const env = await environment(); const store = new Store(env.directory);
  let captures = 0;
  const worker = env.worker(store, (bytes, options) => { captures++; return capture(bytes, options); });
  const root = manifest(); const named = manifest({ kind: 35129 });
  const snapshot = manifest({ kind: 5129 });
  const supplied = manifest({ tags: [['screenshot', `x ${'a'.repeat(64)}`, 'm image/png']] });
  const malformed = manifest({ tags: [['x', 'b'.repeat(64)]] });
  env.relay.events.push(root, named, snapshot, supplied, malformed); env.relay.behavior.duplicates = true;
  try {
    await worker.scan();
    assert.deepEqual(store.counts(), { pending: 2, done: 0, failed: 0 });
    assert.ok(worker.lastScan); assert.ok(store.cursor(env.relay.url));
    assert.equal(await worker.processOne(), true); assert.equal(await worker.processOne(), true);
    assert.equal(await worker.processOne(), false);
    assert.equal(captures, 2); assert.equal(env.relay.published.length, 2);
    assert.equal(env.first.uploads.length, 2); assert.equal(env.second.uploads.length, 2);
    assert.deepEqual(env.first.failures, []); assert.deepEqual(env.second.failures, []);
    for (const label of env.relay.published) {
      assert.equal(verifyEvent(label), true); assert.equal(label.kind, 1985); assert.equal(label.pubkey, env.config.pubkey);
      const target = label.tags.find(tag => tag[0] === 'e')?.[1];
      assert.ok(target === root.id || target === named.id);
      assert.ok(label.tags.some(tag => tag[0] === 'L' && tag[1] === '#screenshot'));
      const screenshot = label.tags.find(tag => tag[0] === 'screenshot')!;
      const hash = screenshot.find(field => field.startsWith('x '))!.slice(2);
      assert.ok(label.tags.some(tag => tag[0] === 'l' && tag[1] === hash && tag[2] === '#screenshot'));
      assert.ok(screenshot.includes('dim 320x200')); assert.ok(screenshot.includes('m image/png'));
      const bytes = env.first.blobs.get(hash)!;
      assert.deepEqual(bytes, env.second.blobs.get(hash));
      assert.equal(sha256(bytes), hash); assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      assert.equal(bytes.readUInt32BE(16), 320); assert.equal(bytes.readUInt32BE(20), 200);
      assert.equal(label.tags.filter(tag => tag[0] === 'server').length, 2);
    }
    await worker.scan(); assert.equal(await worker.processOne(), false);
    assert.deepEqual(store.counts(), { pending: 0, done: 2, failed: 0 });
    assert.equal(captures, 2, 'overlap and duplicate deliveries must not recapture');
  } finally { store.close(); await env.close(); }
});

Deno.test('trusted exact-revision labels suppress capture while untrusted labels cannot', async () => {
  const env = await environment(); const store = new Store(env.directory);
  const trustedTarget = manifest(); const untrustedTarget = manifest();
  const revisionKey = generateSecretKey();
  const oldRevision = manifest({ key: revisionKey, createdAt: Math.floor(Date.now() / 1000) - 100 });
  const wrongRevision = manifest({ key: revisionKey });
  const shot = { hash: 'a'.repeat(64), size: 200, width: 320, height: 200, servers: env.config.blossomServers };
  env.relay.events.push(trustedTarget, untrustedTarget, wrongRevision,
    buildLabel(parseManifest(trustedTarget)!, shot, env.config.key, env.relay.url),
    buildLabel(parseManifest(untrustedTarget)!, shot, generateSecretKey(), env.relay.url),
    buildLabel(parseManifest(oldRevision)!, shot, env.config.key, env.relay.url));
  let captures = 0;
  const worker = env.worker(store, () => { captures++; return Promise.resolve(smallPng); });
  try {
    await worker.scan();
    while (await worker.processOne()) { /* Drain only immediately due work. */ }
    assert.equal(captures, 2);
    assert.equal(env.relay.published.length, 2);
    assert.equal(env.relay.published.some(event => event.tags.some(tag => tag[0] === 'e' && tag[1] === trustedTarget.id)), false);
    assert.deepEqual(store.counts(), { pending: 0, done: 2, failed: 0 });
  } finally { store.close(); await env.close(); }
});

Deno.test('partial upload stays unpublished and restart reuses the persisted capture and successful replica', async () => {
  const env = await environment(); let store: Store | undefined = new Store(env.directory);
  env.relay.events.push(manifest()); env.second.behavior.rejectUpload = true;
  let captures = 0;
  const render: typeof capture = (bytes, options) => { captures++; return capture(bytes, options); };
  try {
    let worker = env.worker(store, render); await worker.scan(); await worker.processOne();
    assert.equal(env.relay.published.length, 0); assert.equal(captures, 1);
    assert.deepEqual(store.counts(), { pending: 0, done: 0, failed: 1 });
    assert.equal(store.next(), undefined, 'failure has an actual retry delay');
    const pending = store.next(Date.now() + 6000)!;
    assert.equal(Buffer.from(pending.png!).readUInt32BE(16), 320); assert.equal(pending.label, null);
    assert.deepEqual(JSON.parse(pending.servers), [env.first.origin]);
    store.close(); store = new DueStore(env.directory); env.second.behavior.rejectUpload = false;
    env.config.capture.width = 640; env.config.capture.height = 480;
    worker = env.worker(store, render); await worker.processOne();
    assert.equal(captures, 1); assert.equal(env.first.uploads.length, 1); assert.equal(env.second.uploads.length, 1);
    assert.equal(env.relay.published.length, 1);
    assert.ok(env.relay.published[0].tags.find(tag => tag[0] === 'screenshot')!.includes('dim 320x200'),
      'persisted PNG dimensions survive capture configuration changes');
    assert.deepEqual(store.counts(), { pending: 0, done: 1, failed: 0 });
  } finally { store?.close(); await env.close(); }
});

Deno.test('lost relay acknowledgement resumes the exact persisted signed event after restart', async () => {
  const env = await environment(); let store: Store | undefined = new Store(env.directory);
  env.relay.events.push(manifest()); env.relay.behavior.publish = 'silent';
  let captures = 0;
  const render = () => { captures++; return Promise.resolve(smallPng); };
  try {
    let worker = env.worker(store, render); await worker.scan(); await worker.processOne();
    assert.equal(env.relay.published.length, 1); const first = env.relay.published[0];
    assert.equal(store.next(Date.now() + 6000)?.label, JSON.stringify(first));
    store.close(); store = new DueStore(env.directory); env.relay.behavior.publish = 'accept';
    worker = env.worker(store, render); await worker.processOne();
    assert.equal(env.relay.published.length, 2); assert.deepEqual(env.relay.published[1], first);
    assert.equal(captures, 1); assert.equal(env.first.uploads.length, 1); assert.equal(env.second.uploads.length, 1);
    assert.deepEqual(store.counts(), { pending: 0, done: 1, failed: 0 });
  } finally { store?.close(); await env.close(); }
});

Deno.test('corrupt readback cannot satisfy replica quorum', async () => {
  const env = await environment(); const store = new Store(env.directory);
  env.relay.events.push(manifest()); env.second.behavior.corruptReadback = true;
  try {
    const worker = env.worker(store); await worker.scan(); await worker.processOne();
    assert.equal(env.relay.published.length, 0); assert.deepEqual(store.counts(), { pending: 0, done: 0, failed: 1 });
    assert.equal(env.second.uploads.length, 1);
    assert.deepEqual(JSON.parse(store.next(Date.now() + 6000)!.servers), [env.first.origin]);
  } finally { store.close(); await env.close(); }
});

Deno.test('store locks one owner, supersedes old queued revisions and preserves checkpoints', async () => {
  const env = await environment(); let store: Store | undefined = new Store(env.directory);
  const key = generateSecretKey();
  const old = parseManifest(manifest({ key, createdAt: 100 }))!;
  const fresh = parseManifest(manifest({ key, createdAt: 101 }))!;
  try {
    assert.throws(() => new Store(env.directory), /Another worker/);
    store.enqueue(old, false); store.enqueue(fresh, false); store.enqueue(old, false);
    assert.equal(store.next()?.id, fresh.event.id); assert.deepEqual(store.counts(), { pending: 1, done: 0, failed: 0 });
    store.checkpoint(env.relay.url, 1234); store.close(); store = new Store(env.directory);
    assert.equal(store.cursor(env.relay.url), 1234); assert.equal(store.next()?.id, fresh.event.id);
    store.finish(fresh.event.id); assert.equal(store.next(), undefined);
  } finally { store?.close(); await env.close(); }
});

Deno.test('claimed jobs are invisible to other processors and resume after an interrupted owner', async () => {
  const env = await environment(); let store: Store | undefined = new Store(env.directory);
  const job = parseManifest(manifest())!;
  try {
    assert.equal(store.enqueue(job, false), true); assert.equal(store.enqueue(job, false), false);
    assert.equal(store.claim()?.id, job.event.id);
    assert.equal(store.claim(), undefined, 'a running job cannot be claimed twice');
    assert.deepEqual(store.counts(), { pending: 1, done: 0, failed: 0 });
    store.close(); store = new Store(env.directory);
    assert.equal(store.claim()?.id, job.event.id, 'restart returns in-flight work to the queue');
  } finally { store?.close(); await env.close(); }
});

Deno.test('relay timeout and CLOSED are errors; negative OK never completes publication', async () => {
  const relay = await relayFixture(); const client = new Relays([relay.url], 100);
  try {
    relay.behavior.query = 'silent'; await assert.rejects(client.query(relay.url, { kinds: [15129] }), /timeout/);
    relay.behavior.query = 'closed'; await assert.rejects(client.query(relay.url, { kinds: [15129] }), /refused/);
    relay.behavior.publish = 'reject'; await assert.rejects(client.publish(manifest()), /acknowledged/);
  } finally { await relay.close(); }
});

Deno.test('failed relay scan retains cursor and failed label lookup cannot trigger capture', async () => {
  const env = await environment(); const store = new Store(env.directory);
  let captures = 0;
  const worker = env.worker(store, () => { captures++; return Promise.resolve(smallPng); });
  const event = manifest();
  try {
    env.relay.events.push(event); await worker.scan(); const cursor = store.cursor(env.relay.url);
    env.relay.behavior.query = 'closed'; await worker.scan(); await worker.processOne();
    assert.equal(store.cursor(env.relay.url), cursor); assert.equal(captures, 0);
    assert.equal(env.relay.published.length, 0); assert.equal(store.counts().failed, 1);
  } finally { store.close(); await env.close(); }
});


Deno.test('scan paginates a full page without dropping equal-timestamp boundary events', async () => {
  const env = await environment(10000); const store = new Store(env.directory);
  const key = generateSecretKey(); const createdAt = Math.floor(Date.now() / 1000) - 5;
  for (let index = 0; index < 501; index++) {
    env.relay.events.push(manifest({ kind: 35129, name: `clock-${index}`, key, createdAt }));
  }
  try {
    const worker = env.worker(store); await worker.scan();
    assert.equal(store.counts().pending, 501);
    assert.ok(env.relay.queries.some(filter => filter.since === createdAt && filter.until === createdAt && filter.limit === 10000));
    assert.ok(store.cursor(env.relay.url));
  } finally { store.close(); await env.close(); }
});

Deno.test('first-scan outage keeps the full backfill pending across restart until it completes', async () => {
  const env = await environment(); let store: Store | undefined = new Store(env.directory);
  env.relay.behavior.query = 'closed';
  env.relay.events.push(manifest({ createdAt: Math.floor(Date.now() / 1000) - 400 * 86400 }));
  try {
    let worker = env.worker(store); await worker.scan();
    assert.equal(env.relay.queries[0].since, 0, 'history is backfilled from the configured floor');
    assert.equal(store.cursor(env.relay.url), undefined); assert.equal(store.floor(env.relay.url), undefined);
    assert.equal(worker.lastScan, null);
    store.close(); store = new Store(env.directory);
    worker = env.worker(store); env.relay.behavior.query = 'normal'; await worker.scan();
    assert.equal(env.relay.queries.at(-1)?.since, 0);
    assert.equal(store.counts().pending, 1, 'a year-old napplet is still captured');
    assert.equal(store.floor(env.relay.url), 0); assert.ok(store.cursor(env.relay.url));
    assert.ok(worker.lastScan);
    await worker.scan();
    assert.ok(env.relay.queries.at(-1)!.since! > 0, 'after backfill, scans resume from the cursor');
  } finally { store?.close(); await env.close(); }
});

Deno.test('a database with a cursor but no backfill floor walks the history it never saw (issue #4)', async () => {
  const env = await environment(); const store = new Store(env.directory);
  const now = Math.floor(Date.now() / 1000);
  store.checkpoint(env.relay.url, now - 10);
  env.relay.events.push(manifest({ createdAt: now - 30 * 86400 }), manifest({ kind: 35129, createdAt: now - 2 }));
  try {
    const worker = env.worker(store); await worker.scan();
    assert.equal(store.counts().pending, 2);
    assert.equal(store.floor(env.relay.url), 0);
  } finally { store.close(); await env.close(); }
});

Deno.test('lowering NAPSHOT_BACKFILL_SINCE extends the scanned history backwards', async () => {
  const env = await environment(); const store = new Store(env.directory);
  const now = Math.floor(Date.now() / 1000);
  env.config.backfillSince = now - 3600;
  env.relay.events.push(manifest({ createdAt: now - 7200 }));
  try {
    const worker = env.worker(store); await worker.scan();
    assert.equal(store.counts().pending, 0); assert.equal(store.floor(env.relay.url), now - 3600);
    env.config.backfillSince = 0; await worker.scan();
    assert.equal(store.counts().pending, 1); assert.equal(store.floor(env.relay.url), 0);
  } finally { store.close(); await env.close(); }
});

Deno.test('a relay that caps results below the page size is still paged to the end', async () => {
  const env = await environment(); const store = new Store(env.directory);
  env.relay.behavior.maxLimit = 3;
  const now = Math.floor(Date.now() / 1000);
  for (let index = 0; index < 10; index++) env.relay.events.push(manifest({ createdAt: now - 100 * index - 1 }));
  try {
    const worker = env.worker(store); await worker.scan();
    assert.equal(store.counts().pending, 10);
  } finally { store.close(); await env.close(); }
});

Deno.test('live subscription captures a newly published napplet within moments, without polling', async () => {
  const env = await environment(1000); const store = new Store(env.directory);
  const worker = env.worker(store); const stop = new AbortController();
  const running = worker.run(stop.signal);
  try {
    await waitFor(() => env.relay.subscriptions.size > 0 && worker.lastScan !== null);
    const queries = env.relay.queries.filter(filter => filter.kinds?.includes(15129)).length;
    const published = Date.now();
    env.relay.deliver(manifest());
    await waitFor(() => env.relay.published.length === 1);
    assert.ok(Date.now() - published < 3000, `captured in ${Date.now() - published}ms`);
    assert.equal(env.relay.queries.filter(filter => filter.kinds?.includes(15129)).length, queries,
      'the new manifest arrived over the open subscription, not a rescan');
    assert.deepEqual(store.counts(), { pending: 0, done: 1, failed: 0 });
  } finally { stop.abort(); await running; store.close(); await env.close(); }
});

Deno.test('a dropped live subscription reconnects and catches up on what it missed', async () => {
  const env = await environment(1000); const store = new Store(env.directory);
  const worker = env.worker(store); const stop = new AbortController();
  const running = worker.run(stop.signal);
  try {
    await waitFor(() => env.relay.subscriptions.size > 0 && worker.lastScan !== null);
    env.relay.disconnect();
    env.relay.events.push(manifest()); // Stored while nobody is subscribed.
    await waitFor(() => env.relay.published.length === 1, 8000);
    await waitFor(() => env.relay.subscriptions.size > 0);
    env.relay.deliver(manifest({ kind: 35129 }));
    await waitFor(() => env.relay.published.length === 2);
  } finally { stop.abort(); await running; store.close(); await env.close(); }
});

Deno.test('parallel processors capture distinct jobs concurrently, each exactly once', async () => {
  const env = await environment(1000); const store = new Store(env.directory);
  env.config.concurrency = 3;
  let active = 0; let peak = 0; const seen: string[] = [];
  const worker = env.worker(store, async bytes => {
    active++; peak = Math.max(peak, active); seen.push(sha256(bytes));
    await new Promise(resolve => setTimeout(resolve, 300)); active--;
    return smallPng;
  });
  for (let index = 0; index < 6; index++) env.relay.events.push(manifest({ kind: 35129, name: `app-${index}` }));
  const stop = new AbortController(); const running = worker.run(stop.signal);
  try {
    await waitFor(() => store.counts().done === 6, 10000);
    assert.equal(peak, 3); assert.equal(seen.length, 6);
    assert.equal(env.relay.published.length, 6);
  } finally { stop.abort(); await running; store.close(); await env.close(); }
});

Deno.test('single-file manifests render inline HTML, and identity napplets get the preview account', async () => {
  const env = await environment(); const store = new Store(env.directory);
  env.config.previewIdentity = 'e771af0b05c8e95fcdf6feb3500544d2fb1ccd384788e9f490bb3ee28e8ed66f';
  const inline = Buffer.from('<!doctype html><body>inline only</body>');
  const legacy = finalizeEvent({ kind: 35129, created_at: Math.floor(Date.now() / 1000) - 1, content: inline.toString(),
    tags: [['d', 'weather'], ['f', 'index.html', sha256(inline), 'text/html'], ['requires', 'identity']] }, generateSecretKey());
  const plain = manifest();
  env.relay.events.push(legacy, plain);
  const renders: { html: string; identity?: string }[] = [];
  const worker = env.worker(store, (bytes, options) => {
    renders.push({ html: bytes.toString(), identity: options.identity }); return Promise.resolve(smallPng);
  });
  try {
    await worker.scan();
    while (await worker.processOne()) { /* Drain. */ }
    assert.deepEqual(renders.find(render => render.html === inline.toString())?.identity, env.config.previewIdentity,
      'inline artifact is used without Blossom, with the preview identity');
    assert.equal(renders.find(render => render.html === html.toString())?.identity, undefined);
    const label = env.relay.published.find(event => event.tags.some(tag => tag[0] === 'e' && tag[1] === legacy.id))!;
    assert.match(label.content, /preview identity/);
  } finally { store.close(); await env.close(); }
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

for (const failure of ['closed', 'silent']) {
  Deno.test(`one ${failure} relay cannot veto healthy scans, capture or acknowledged publication`, async () => {
    const env = await environment(100); const bad = await relayFixture(); const store = new Store(env.directory);
    env.config.relays.unshift(bad.url); bad.behavior.query = failure; bad.behavior.publish = 'reject';
    const checkpoint = Math.floor(Date.now() / 1000) - 30;
    store.checkpoint(bad.url, checkpoint); env.relay.events.push(manifest());
    let captures = 0;
    const worker = env.worker(store, () => { captures++; return Promise.resolve(smallPng); });
    try {
      await worker.scan();
      assert.equal(store.cursor(bad.url), checkpoint, 'failed relay must retain its own cursor');
      assert.ok(worker.lastScan, 'a complete healthy relay scan must establish readiness');
      assert.ok(worker.relayErrors[bad.url], 'the failed relay remains visible as degraded');
      assert.equal(store.counts().pending, 1);
      await worker.processOne();
      assert.equal(captures, 1);
      assert.equal(env.first.uploads.length, 1); assert.equal(env.second.uploads.length, 1);
      assert.equal(env.relay.published.length, 1, 'healthy relay must acknowledge the persisted label');
      assert.deepEqual(store.counts(), { pending: 0, done: 1, failed: 0 });
      assert.ok(JSON.stringify(env.logs).includes('relay_label_query_failed'));
      bad.behavior.query = 'normal'; await worker.scan();
      assert.ok(store.cursor(bad.url)! > checkpoint, 'recovered relay resumes its own scan');
      assert.equal(worker.relayErrors[bad.url], undefined, 'recovery clears that relay failure');
      assert.equal(await worker.processOne(), false, 'recovery cannot recapture the completed manifest');
    } finally { store.close(); await bad.close(); await env.close(); }
  });
}

Deno.test('a trusted exact-revision label on a reachable relay still suppresses capture during another relay outage', async () => {
  const env = await environment(); const bad = await relayFixture(); const store = new Store(env.directory);
  env.config.relays.unshift(bad.url); bad.behavior.query = 'closed';
  const target = manifest(); const shot = { hash: 'a'.repeat(64), size: 200, width: 320, height: 200,
    servers: env.config.blossomServers };
  env.relay.events.push(target, buildLabel(parseManifest(target)!, shot, env.config.key, env.relay.url));
  let captures = 0;
  const worker = env.worker(store, () => { captures++; return Promise.resolve(smallPng); });
  try {
    await worker.scan(); await worker.processOne();
    assert.equal(captures, 0); assert.equal(env.first.uploads.length, 0);
    assert.equal(env.relay.published.length, 0);
    assert.deepEqual(store.counts(), { pending: 0, done: 0, failed: 0 }, 'trusted existing label must skip the job');
  } finally { store.close(); await bad.close(); await env.close(); }
});

Deno.test('total relay outage defers capture and readiness until one relay recovers', async () => {
  const env = await environment(); const bad = await relayFixture(); const store = new DueStore(env.directory);
  env.config.relays.push(bad.url); env.relay.behavior.query = 'closed'; bad.behavior.query = 'closed';
  const target = manifest(); store.enqueue(parseManifest(target)!, false); env.relay.events.push(target);
  let captures = 0;
  const worker = env.worker(store, () => { captures++; return Promise.resolve(smallPng); });
  const site = createSite(worker);
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const address = site.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/healthz`;
  try {
    await worker.scan(); await worker.processOne();
    assert.equal(captures, 0); assert.equal(store.counts().failed, 1);
    let response = await fetch(url); assert.equal(response.status, 503);
    let status = await response.json(); assert.equal(Object.keys(status.relayErrors).length, 2);
    env.relay.behavior.query = 'normal'; await worker.scan();
    response = await fetch(url); assert.equal(response.status, 200);
    status = await response.json(); assert.deepEqual(Object.keys(status.relayErrors), [bad.url]);
    await worker.processOne();
    assert.equal(captures, 1); assert.equal(env.relay.published.length, 1);
    assert.deepEqual(store.counts(), { pending: 0, done: 1, failed: 0 });
  } finally {
    site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve()));
    store.close(); await bad.close(); await env.close();
  }
});
