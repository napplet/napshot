import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { generateSecretKey } from 'nostr-tools';

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(done => probe.close(() => done()));
  return address.port;
}

test('service process stays alive through relay outage and shuts down cleanly across restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'napshot-process-'));
  const key = Buffer.from(generateSecretKey()).toString('hex');
  const relayPort = await unusedPort();
  try {
    for (let run = 0; run < 2; run++) {
      const port = await unusedPort();
      const child = spawn(process.execPath, ['dist/src/main.js'], {
        env: { ...process.env, NAPSHOT_SECRET_KEY: key, NAPSHOT_DATA_DIR: directory,
          NAPSHOT_HOST: '127.0.0.1', NAPSHOT_PORT: String(port), NAPSHOT_POLL_MS: '1000',
          NAPSHOT_RELAYS: `wss://127.0.0.1:${relayPort}`, NAPSHOT_BLOSSOM_SERVERS: 'https://a.example,https://b.example' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exited = once(child, 'exit');
      try {
        const deadline = Date.now() + 8000;
        while (!output.includes('relay_scan_failed') && Date.now() < deadline) await sleep(20);
        assert.match(output, /napshot_started/);
        assert.match(output, /relay_scan_failed/);
        assert.equal(child.exitCode, null);
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        const status = await response.json();
        assert.equal(status.name, 'Napshot');
        assert.equal(status.lastScan, null);
        assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 503);
        assert.equal(JSON.stringify(status).includes(key), false);
        assert.equal(output.includes(key), false);
        child.kill('SIGTERM');
        const result = await Promise.race([exited, sleep(5000).then(() => { throw new Error('Shutdown timeout'); })]);
        assert.equal(result[0], 0);
        await assert.rejects(access(join(directory, 'worker.pid')));
      } finally {
        if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
      }
    }
  } finally { await rm(directory, {recursive:true,force:true}); }
});
