import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { fetchArtifact, sha256 } from '../src/blossom.js';
import { parseManifest } from '../src/protocol.js';
import { Network } from '../src/network.js';

test('untrusted hint count cannot displace operator artifact fallbacks', async () => {
  const html = Buffer.from('<body>Valid</body>');
  const badHints = Array.from({length:20}, (_,i) => `https://bad${i}.example`);
  const event = finalizeEvent({kind:15129, created_at:1, content:'Fixture',
    tags:[['x',sha256(html)],...badHints.map(s=>['server',s])]}, generateSecretKey());
  const visited: string[] = [];
  class FixtureNetwork extends Network {
    override async request(url:string):Promise<Buffer> {
      visited.push(url);
      if (url.startsWith('https://operator.example/')) return html;
      throw new Error('Unavailable');
    }
  }
  const result = await fetchArtifact(parseManifest(event)!, ['https://operator.example'], new FixtureNetwork());
  assert.deepEqual(result,html);
  assert.ok(visited.length <= 17);
});
