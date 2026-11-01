import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { fetchArtifact, sha256, uploadScreenshot } from '../src/blossom.ts';
import { parseManifest } from '../src/protocol.ts';
import { Network } from '../src/network.ts';
import { blossomFixture } from './fixtures.ts';

Deno.test('untrusted hint count cannot displace operator artifact fallbacks', async () => {
  const html = Buffer.from('<body>Valid</body>');
  const badHints = Array.from({length:20}, (_,i) => `https://bad${i}.example`);
  const event = finalizeEvent({kind:15129, created_at:1, content:'Fixture',
    tags:[['x',sha256(html)],...badHints.map(s=>['server',s])]}, generateSecretKey());
  const visited: string[] = [];
  class FixtureNetwork extends Network {
    override request(url:string):Promise<Buffer> {
      visited.push(url);
      if (url.startsWith('https://operator.example/')) return Promise.resolve(html);
      return Promise.reject(new Error('Unavailable'));
    }
  }
  const result = await fetchArtifact(parseManifest(event)!, ['https://operator.example'], new FixtureNetwork());
  assert.deepEqual(result,html);
  assert.ok(visited.length <= 17);
});

Deno.test('a refused duplicate upload counts only when the server already serves the exact bytes', async () => {
  const png = Buffer.from('png bytes'); const key = generateSecretKey();
  const fixture = (served: Buffer | null) => new class extends Network {
    override request(_url: string, options: { method?: string } = {}): Promise<Buffer> {
      if (options.method === 'PUT') return Promise.reject(new Error('HTTP 409'));
      return served ? Promise.resolve(served) : Promise.reject(new Error('HTTP 404'));
    }
  }();
  await uploadScreenshot(png, 'https://dup.example', key, fixture(png));
  await assert.rejects(uploadScreenshot(png, 'https://dup.example', key, fixture(null)), /HTTP 409/);
  await assert.rejects(uploadScreenshot(png, 'https://dup.example', key, fixture(Buffer.from('other'))), /HTTP 409/);
});

Deno.test('a server that scopes tokens by its full URL gets a second authorization in that form', async () => {
  const server = await blossomFixture();
  server.behavior.serverScope = 'origin';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1EAAAAASUVORK5CYII=', 'base64');
  const key = generateSecretKey();
  try {
    await uploadScreenshot(png, server.origin, key, new Network(true));
    assert.equal(server.uploads.length, 1);
    assert.deepEqual(server.failures, []);
    const scopes = server.authorizations.map(event => event.tags.find(tag => tag[0] === 'server')?.[1]);
    assert.deepEqual(scopes, [server.origin], 'the retry carries the full origin instead of the domain name');
    assert.deepEqual(server.blobs.get(sha256(png)), png);
  } finally { await server.close(); }
});
