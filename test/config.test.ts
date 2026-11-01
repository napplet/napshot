import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { generateSecretKey } from 'nostr-tools';
import { loadConfig } from '../src/config.ts';

const env = {
  NAPSHOT_SECRET_KEY: Buffer.from(generateSecretKey()).toString('hex'),
  NAPSHOT_RELAYS: 'wss://relay.example',
  NAPSHOT_BLOSSOM_SERVERS: 'https://one.example,https://two.example',
};
Deno.test('operator configuration keeps quorum, key and URL invariants', () => {
  const config = loadConfig(env);
  assert.equal(config.minReplicas, 2);
  assert.deepEqual(config.trustedAuthors, [config.pubkey]);
  assert.equal(config.capture.width, 1200);
  for (const patch of [
    { NAPSHOT_SECRET_KEY: '' }, { NAPSHOT_SECRET_KEY: '0'.repeat(64) }, { NAPSHOT_RELAYS: '' },
    { NAPSHOT_RELAYS: 'http://relay.example' }, { NAPSHOT_RELAYS: 'wss://user:pass@relay.example' },
    { NAPSHOT_BLOSSOM_SERVERS: 'https://same.example,https://same.example/' },
    { NAPSHOT_BLOSSOM_SERVERS: 'http://one.example,https://two.example' },
    { NAPSHOT_BLOSSOM_SERVERS: 'https://one.example/path,https://two.example' },
    { NAPSHOT_MIN_REPLICAS: '1' }, { NAPSHOT_MIN_REPLICAS: '3' },
    { NAPSHOT_PORT: 'NaN' }, { NAPSHOT_WIDTH: '999999' }, { NAPSHOT_TRUSTED_AUTHORS: 'bad' },
  ]) assert.throws(() => loadConfig({ ...env, ...patch }));
});

Deno.test('one optional profile setting enables metadata without a pubkey or NIP-05 resolution', () => {
  assert.equal(loadConfig(env).profile, undefined);
  const profile = loadConfig({ ...env, NAPSHOT_PROFILE: '{"nip05":"napshot@unresolved.invalid"}' }).profile;
  assert.deepEqual(profile, { name: 'napshot', display_name: 'Napshot', bot: true, nip05: 'napshot@unresolved.invalid' });
  assert.equal('website' in profile!, false);
  for (const raw of ['oops', 'null', '[]', 'true', '{"name":12}', '{"bot":"true"}', ' '.repeat(16384) + '{}']) {
    assert.throws(() => loadConfig({ ...env, NAPSHOT_PROFILE: raw }), /Invalid NAPSHOT_PROFILE/);
  }
});

Deno.test('queue settings default to full backfill, parallel capture and anonymous previews', () => {
  const config = loadConfig(env);
  assert.equal(config.backfillSince, 0);
  assert.equal(config.concurrency, 3);
  assert.equal(config.previewIdentity, undefined);
  const hex = 'e771af0b05c8e95fcdf6feb3500544d2fb1ccd384788e9f490bb3ee28e8ed66f';
  const npub = 'npub1uac67zc9er54ln0kl6e4qp2y6ta3enfcg7ywnayshvlw9r5w6ehsqq99rx';
  assert.equal(loadConfig({ ...env, NAPSHOT_PREVIEW_IDENTITY: npub }).previewIdentity, hex);
  assert.equal(loadConfig({ ...env, NAPSHOT_PREVIEW_IDENTITY: hex }).previewIdentity, hex);
  for (const patch of [{ NAPSHOT_PREVIEW_IDENTITY: 'nsec1abc' }, { NAPSHOT_PREVIEW_IDENTITY: 'ABC' },
    { NAPSHOT_CONCURRENCY: '0' }, { NAPSHOT_BACKFILL_SINCE: '-1' }, { NAPSHOT_RESYNC_MS: '5' }]) {
    assert.throws(() => loadConfig({ ...env, ...patch }));
  }
});
