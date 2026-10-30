import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools';
import { sha256 } from '../src/blossom.js';
import { capture } from '../src/capture.js';
import type { Config } from '../src/config.js';
import { Network } from '../src/network.js';
import { buildLabel, parseManifest } from '../src/protocol.js';
import { Relays } from '../src/relay.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { blossomFixture, relayFixture } from './fixtures.js';

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
    host: '127.0.0.1', port: 0, pollMs: 1000, lookbackSeconds: 86400, minReplicas: 2,
    capture: { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', width: 320, height: 200,
      delayMs: 100, timeoutMs: 15000 },
  };
  const logs: unknown[] = [];
  const worker = (store: Store, render: typeof capture = async () => smallPng) => new Worker(config, store, {
    network: new Network(true), relays: new Relays(config.relays, relayTimeoutMs), capture: render,
    log: (...fields) => logs.push(fields),
  });
  return { relay, first, second, config, directory, worker, logs,
    close: async () => { await relay.close(); await first.close(); await second.close(); await rm(directory, { recursive: true }); } };
}

test('wire pipeline captures root and named revisions, uploads identical PNGs twice, signs and publishes labels', async () => {
  const env = await environment(); const store = new Store(env.directory);
  let captures = 0;
  const worker = env.worker(store, async (bytes, options) => { captures++; return capture(bytes, options); });
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

test('trusted exact-revision labels suppress capture while untrusted labels cannot', async () => {
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
  const worker = env.worker(store, async () => { captures++; return smallPng; });
  try {
    await worker.scan();
    while (await worker.processOne()) { /* Drain only immediately due work. */ }
    assert.equal(captures, 2);
    assert.equal(env.relay.published.length, 2);
    assert.equal(env.relay.published.some(event => event.tags.some(tag => tag[0] === 'e' && tag[1] === trustedTarget.id)), false);
    assert.deepEqual(store.counts(), { pending: 0, done: 2, failed: 0 });
  } finally { store.close(); await env.close(); }
});

test('partial upload stays unpublished and restart reuses the persisted capture and successful replica', async () => {
  const env = await environment(); let store: Store | undefined = new Store(env.directory);
  env.relay.events.push(manifest()); env.second.behavior.rejectUpload = true;
  let captures = 0;
  const render: typeof capture = async (bytes, options) => { captures++; return capture(bytes, options); };
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

test('lost relay acknowledgement resumes the exact persisted signed event after restart', async () => {
  const env = await environment(); let store: Store | undefined = new Store(env.directory);
  env.relay.events.push(manifest()); env.relay.behavior.publish = 'silent';
  let captures = 0;
  const render = async () => { captures++; return smallPng; };
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

test('corrupt readback cannot satisfy replica quorum', async () => {
  const env = await environment(); const store = new Store(env.directory);
  env.relay.events.push(manifest()); env.second.behavior.corruptReadback = true;
  try {
    const worker = env.worker(store); await worker.scan(); await worker.processOne();
    assert.equal(env.relay.published.length, 0); assert.deepEqual(store.counts(), { pending: 0, done: 0, failed: 1 });
    assert.equal(env.second.uploads.length, 1);
    assert.deepEqual(JSON.parse(store.next(Date.now() + 6000)!.servers), [env.first.origin]);
  } finally { store.close(); await env.close(); }
});

test('store locks one owner, supersedes old queued revisions and preserves checkpoints', async () => {
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

test('relay timeout and CLOSED are errors; negative OK never completes publication', async () => {
  const relay = await relayFixture(); const client = new Relays([relay.url], 100);
  try {
    relay.behavior.query = 'silent'; await assert.rejects(client.query(relay.url, { kinds: [15129] }), /timeout/);
    relay.behavior.query = 'closed'; await assert.rejects(client.query(relay.url, { kinds: [15129] }), /refused/);
    relay.behavior.publish = 'reject'; await assert.rejects(client.publish(manifest()), /acknowledged/);
  } finally { await relay.close(); }
});

test('failed relay scan retains cursor and failed label lookup cannot trigger capture', async () => {
  const env = await environment(); const store = new Store(env.directory);
  let captures = 0;
  const worker = env.worker(store, async () => { captures++; return smallPng; });
  const event = manifest();
  try {
    env.relay.events.push(event); await worker.scan(); const cursor = store.cursor(env.relay.url);
    env.relay.behavior.query = 'closed'; await worker.scan(); await worker.processOne();
    assert.equal(store.cursor(env.relay.url), cursor); assert.equal(captures, 0);
    assert.equal(env.relay.published.length, 0); assert.equal(store.counts().failed, 1);
  } finally { store.close(); await env.close(); }
});


test('scan paginates a full page without dropping equal-timestamp boundary events', async () => {
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

test('first-scan outage preserves its initial backfill boundary across configuration changes and restart', async () => {
  const env = await environment(); let store: Store | undefined = new Store(env.directory);
  env.relay.behavior.query = 'closed'; env.config.lookbackSeconds = 3600;
  try {
    let worker = env.worker(store); await worker.scan();
    const baseline = store.cursor(env.relay.url);
    const firstSince = env.relay.queries[0].since;
    assert.equal(typeof baseline, 'number', 'initial boundary must be durable before the first query succeeds');
    assert.equal(firstSince, baseline! - 60);
    assert.equal(worker.lastScan, null);
    store.close(); store = new Store(env.directory); env.config.lookbackSeconds = 0;
    worker = env.worker(store); await worker.scan();
    assert.equal(env.relay.queries.at(-1)?.since, firstSince, 'outage cannot slide the initial backfill window');
    assert.equal(store.cursor(env.relay.url), baseline);
    env.relay.behavior.query = 'normal'; await worker.scan();
    assert.ok(store.cursor(env.relay.url)! > baseline!);
    assert.ok(worker.lastScan);
  } finally { store?.close(); await env.close(); }
});
