import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, verifyEvent } from 'nostr-tools';
import { Announcer } from '../src/announce.ts';
import { loadConfig } from '../src/config.ts';
import { Relays } from '../src/relay.ts';
import { Store } from '../src/store.ts';
import { relayFixture } from './fixtures.ts';

async function fixture() {
  const first = await relayFixture(); const second = await relayFixture();
  const directory = await mkdtemp(join(tmpdir(), 'napshot-announcements-'));
  const config = loadConfig({ NAPSHOT_SECRET_KEY: Buffer.from(generateSecretKey()).toString('hex'),
    NAPSHOT_RELAYS: 'wss://example.com', NAPSHOT_BLOSSOM_SERVERS: 'https://one.example,https://two.example',
    NAPSHOT_PROFILE: '{"about":"Automated napplet previews","nip05":"napshot@unresolved.invalid"}' });
  config.relays = [first.url, second.url];
  const client = new Relays(config.relays, 100);
  const logs: unknown[] = [];
  const announcer = (store: Store) => new Announcer(config, store, client, (...fields) => logs.push(fields));
  return { first, second, directory, config, logs, announcer,
    close: async () => { await first.close(); await second.close(); await rm(directory, { recursive: true }); } };
}

Deno.test('self-publication signs kind 0 and NIP-65 with existing identity and journals both before sending', async () => {
  const env = await fixture(); const store = new Store(env.directory);
  try {
    const announcer = env.announcer(store);
    const profile = store.announcement(env.config.pubkey, 0)!;
    const relays = store.announcement(env.config.pubkey, 10002)!;
    assert.equal(env.first.published.length, 0);
    assert.equal(verifyEvent(profile.event), true); assert.equal(verifyEvent(relays.event), true);
    assert.equal(profile.event.pubkey, env.config.pubkey); assert.equal(relays.event.pubkey, env.config.pubkey);
    assert.deepEqual(JSON.parse(profile.event.content), env.config.profile);
    assert.equal('website' in JSON.parse(profile.event.content), false);
    assert.equal(relays.event.content, '');
    assert.deepEqual(relays.event.tags, [...env.config.relays].sort().map(url => ['r', url]));
    await announcer.tick();
    for (const relay of [env.first, env.second]) {
      assert.deepEqual(new Set(relay.published.map(event => event.id)), new Set([profile.event.id, relays.event.id]));
      assert.ok(store.announcement(env.config.pubkey, 0)!.deliveries[relay.url].acknowledged);
      assert.ok(store.announcement(env.config.pubkey, 10002)!.deliveries[relay.url].acknowledged);
    }
    await announcer.tick(); assert.equal(env.first.published.length, 2, 'acknowledged targets are not continuously spammed');
  } finally { store.close(); await env.close(); }
});

Deno.test('partial publication persists per-relay retries and resumes identical signed events after restart', async () => {
  const env = await fixture(); let store = new Store(env.directory);
  env.second.behavior.publish = 'reject';
  try {
    let announcer = env.announcer(store); await announcer.tick();
    const pending = store.announcement(env.config.pubkey, 0)!;
    assert.equal(pending.deliveries[env.first.url].acknowledged, true);
    assert.equal(pending.deliveries[env.second.url].acknowledged, false);
    assert.equal(pending.deliveries[env.second.url].attempts, 1);
    assert.ok(pending.deliveries[env.second.url].nextAt > Date.now());
    await announcer.tick(); assert.equal(env.second.published.length, 2, 'retry backoff applies to failed relays');
    const profileId = pending.event.id; const relayId = store.announcement(env.config.pubkey, 10002)!.event.id;
    store.checkpoint(env.first.url, 1234); store.close(); store = new Store(env.directory);
    announcer = env.announcer(store);
    assert.equal(store.announcement(env.config.pubkey, 0)!.event.id, profileId);
    assert.equal(store.announcement(env.config.pubkey, 10002)!.event.id, relayId);
    assert.equal(store.cursor(env.first.url), 1234, 'announcement schema preserves existing worker state');
    env.second.behavior.publish = 'accept'; await announcer.tick(Date.now() + 6000);
    for (const relay of [env.first, env.second]) {
      assert.deepEqual(new Set(relay.published.map(event => event.id)), new Set([profileId, relayId]));
      assert.equal(store.announcement(env.config.pubkey, 0)!.deliveries[relay.url].acknowledged, true);
      assert.equal(store.announcement(env.config.pubkey, 10002)!.deliveries[relay.url].acknowledged, true);
    }
    assert.ok(JSON.stringify(env.logs).includes('instance_event_retry_scheduled'));
  } finally { store.close(); await env.close(); }
});

Deno.test('configuration changes replace only changed events with strictly newer timestamps', async () => {
  const env = await fixture(); const store = new Store(env.directory);
  try {
    env.announcer(store);
    const original = store.announcement(env.config.pubkey, 0)!.event;
    const originalRelays = store.announcement(env.config.pubkey, 10002)!.event;
    env.config.profile = { nip05: 'napshot@unresolved.invalid', bot: true, display_name: 'Napshot', name: 'napshot',
      about: 'Automated napplet previews' };
    env.config.relays.reverse(); env.announcer(store);
    assert.equal(store.announcement(env.config.pubkey, 0)!.event.id, original.id, 'metadata property order is irrelevant');
    assert.equal(store.announcement(env.config.pubkey, 10002)!.event.id, originalRelays.id, 'relay order is irrelevant');
    env.config.profile.about = 'Updated preview bot'; env.announcer(store);
    const updated = store.announcement(env.config.pubkey, 0)!.event;
    assert.notEqual(updated.id, original.id); assert.ok(updated.created_at > original.created_at);
    assert.equal(store.announcement(env.config.pubkey, 10002)!.event.id, originalRelays.id);
    env.config.relays.pop(); env.announcer(store);
    assert.equal(store.announcement(env.config.pubkey, 0)!.event.id, updated.id);
    const relays = store.announcement(env.config.pubkey, 10002)!.event;
    assert.ok(relays.created_at > originalRelays.created_at); assert.equal(relays.tags.length, 1);
  } finally { store.close(); await env.close(); }
});

Deno.test('unconfigured instances do not publish metadata and total outage remains retryable', async () => {
  const env = await fixture(); const store = new Store(env.directory);
  try {
    const profile = env.config.profile; env.config.profile = undefined;
    await env.announcer(store).tick(); assert.equal(store.announcement(env.config.pubkey, 0), undefined);
    env.config.profile = profile;
    env.first.behavior.publish = 'silent'; env.second.behavior.publish = 'reject';
    await env.announcer(store).tick();
    for (const kind of [0, 10002]) {
      const state = store.announcement(env.config.pubkey, kind)!;
      assert.equal(verifyEvent(state.event), true);
      assert.ok(Object.values(state.deliveries).every(delivery => !delivery.acknowledged && delivery.nextAt > 0));
    }
    assert.deepEqual(store.counts(), { pending: 0, done: 0, failed: 0 }, 'announcement failures are separate from screenshot jobs');
  } finally { store.close(); await env.close(); }
});

Deno.test('profile refusal cannot veto NIP-65 and recovery retries only the pending event kind', async () => {
  const env = await fixture(); const store = new Store(env.directory);
  env.config.relays = [env.first.url]; env.first.behavior.rejectKinds.push(0);
  try {
    const announcer = env.announcer(store); await announcer.tick();
    const profile = store.announcement(env.config.pubkey, 0)!;
    assert.equal(profile.deliveries[env.first.url].acknowledged, false);
    assert.equal(store.announcement(env.config.pubkey, 10002)!.deliveries[env.first.url].acknowledged, true);
    env.first.behavior.rejectKinds.length = 0; await announcer.tick(Date.now() + 6000);
    assert.equal(store.announcement(env.config.pubkey, 0)!.deliveries[env.first.url].acknowledged, true);
    assert.equal(env.first.published.filter(event => event.kind === 10002).length, 1);
    assert.deepEqual(new Set(env.first.published.filter(event => event.kind === 0).map(event => event.id)), new Set([profile.event.id]));
  } finally { store.close(); await env.close(); }
});
