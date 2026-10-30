import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { parseManifest, hasScreenshot, buildLabel, isScreenshotLabel } from '../src/protocol.js';

const key = generateSecretKey();
const hash = 'a'.repeat(64);
const manifest = (kind = 15129, tags: string[][] = []) => finalizeEvent({
  kind, created_at: 123, content: 'A napplet', tags: [['x', hash], ...tags],
}, key);

test('only signed current root and named manifests enter the queue', () => {
  assert.ok(parseManifest(manifest()));
  assert.ok(parseManifest(manifest(35129, [['d', 'clock']])));
  for (const event of [manifest(5129), manifest(35129), manifest(15129, [['d', 'oops']]),
    manifest(35129, [['d', 'a/b']]), manifest(15129, [['x', hash]])]) assert.equal(parseManifest(event), null);
  const invalid = JSON.parse(JSON.stringify(manifest())); invalid.content = 'tampered';
  assert.equal(parseManifest(invalid), null);
});

test('only usable screenshot metadata suppresses capture', () => {
  assert.equal(hasScreenshot([['screenshot', `x ${hash}`, 'm image/png']]), true);
  assert.equal(hasScreenshot([['screenshot', `x ${hash}`]]), true);
  for (const tag of [['screenshot'], ['screenshot', 'https://a.test/a.png'],
    ['screenshot', `x ${hash}`, `x ${hash}`], ['screenshot', `x ${hash}`, 'm video/mp4']]) {
    assert.equal(hasScreenshot([tag]), false);
  }
});

test('labels carry exact revision, screenshot bytes metadata and NIP-32 namespace', () => {
  const event = manifest(35129, [['d', 'clock']]);
  const parsed = parseManifest(event)!;
  const label = buildLabel(parsed, { hash, size: 300, width: 1200, height: 750,
    servers: ['https://a.test', 'https://b.test'] }, key, 'wss://relay.test');
  assert.ok(label.tags.some(t => t[0] === 'screenshot' && t[1] === `x ${hash}`));
  assert.ok(label.tags.some(t => t[0] === 'a' && t[1] === `35129:${event.pubkey}:clock`));
  assert.equal(isScreenshotLabel(label, event.id, [getPublicKey(key)]), true);
  assert.equal(isScreenshotLabel(label, 'b'.repeat(64), [getPublicKey(key)]), false);
  assert.equal(isScreenshotLabel(label, event.id, []), false);
});

test('malformed media cannot suppress captures through another valid screenshot tag', () => {
  const target = manifest();
  const label = finalizeEvent({kind:1985,created_at:123,content:'',tags:[
    ['L','#screenshot'],['l','b'.repeat(64),'#screenshot'],['e',target.id],
    ['screenshot',`x ${'b'.repeat(64)}`,`x ${'b'.repeat(64)}`],['screenshot',`x ${hash}`],
  ]},key);
  assert.equal(isScreenshotLabel(label,target.id,[getPublicKey(key)]),false);
  assert.equal(hasScreenshot([['screenshot',`x ${hash}`,'x']]),false);
});
