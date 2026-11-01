import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { parseManifest, hasScreenshot, buildLabel, isScreenshotLabel } from '../src/protocol.ts';

const key = generateSecretKey();
const hash = 'a'.repeat(64);
const manifest = (kind = 15129, tags: string[][] = []) => finalizeEvent({
  kind, created_at: 123, content: 'A napplet', tags: [['x', hash], ...tags],
}, key);

Deno.test('only signed current root and named manifests enter the queue', () => {
  assert.ok(parseManifest(manifest()));
  assert.ok(parseManifest(manifest(35129, [['d', 'clock']])));
  for (const event of [manifest(5129), manifest(35129), manifest(15129, [['d', 'oops']]),
    manifest(35129, [['d', 'a/b']]), manifest(15129, [['x', hash]])]) assert.equal(parseManifest(event), null);
  const invalid = JSON.parse(JSON.stringify(manifest())); invalid.content = 'tampered';
  assert.equal(parseManifest(invalid), null);
});

Deno.test('only usable screenshot metadata suppresses capture', () => {
  assert.equal(hasScreenshot([['screenshot', `x ${hash}`, 'm image/png']]), true);
  assert.equal(hasScreenshot([['screenshot', `x ${hash}`]]), true);
  for (const tag of [['screenshot'], ['screenshot', 'https://a.test/a.png'],
    ['screenshot', `x ${hash}`, `x ${hash}`], ['screenshot', `x ${hash}`, 'm video/mp4']]) {
    assert.equal(hasScreenshot([tag]), false);
  }
});

Deno.test('labels carry exact revision, screenshot bytes metadata and NIP-32 namespace', () => {
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

Deno.test('malformed media cannot suppress captures through another valid screenshot tag', () => {
  const target = manifest();
  const label = finalizeEvent({kind:1985,created_at:123,content:'',tags:[
    ['L','#screenshot'],['l','b'.repeat(64),'#screenshot'],['e',target.id],
    ['screenshot',`x ${'b'.repeat(64)}`,`x ${'b'.repeat(64)}`],['screenshot',`x ${hash}`],
  ]},key);
  assert.equal(isScreenshotLabel(label,target.id,[getPublicKey(key)]),false);
  assert.equal(hasScreenshot([['screenshot',`x ${hash}`,'x']]),false);
});

Deno.test('single-file legacy maps are renderable; multi-file sites are not', () => {
  const file = (tags: string[][], content = '') => finalizeEvent({ kind: 35129, created_at: 123, content,
    tags: [['d', 'weather'], ...tags] }, key);
  const f = parseManifest(file([['f', 'index.html', hash, 'text/html']], '<!doctype html>'));
  assert.equal(f?.hash, hash); assert.equal(f?.address.endsWith(':weather'), true);
  const path = parseManifest(file([['path', '/index.html', hash], ['x', 'b'.repeat(64), 'aggregate'],
    ['requires', 'identity']]));
  assert.equal(path?.hash, hash); assert.equal(path?.identity, true);
  assert.equal(parseManifest(manifest(15129, [['O', 'identity']]))?.identity, true);
  assert.equal(parseManifest(manifest(15129, [['R', 'identity'], ['R', 'outbox']]))?.identity, true, 'required NAPs use R');
  assert.equal(parseManifest(manifest(15129, [['R', 'outbox'], ['O', 'theme']]))?.identity, false);
  assert.equal(parseManifest(manifest())?.identity, false);
  for (const tags of [
    [['f', 'index.html', hash], ['f', 'app.js', hash]], [['path', '/index.html', hash], ['path', '/a.css', hash]],
    [['f', 'app.js', hash]], [['f', 'index.html', hash, 'image/png']], [['f', 'index.html', 'nothex']],
    [['f', 'index.html', hash], ['x', hash]],
  ]) assert.equal(parseManifest(file(tags)), null, JSON.stringify(tags));
});
