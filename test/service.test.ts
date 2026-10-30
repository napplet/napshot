import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { generateSecretKey } from 'nostr-tools';

function unusedPort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = listener.addr.port;
  listener.close();
  return port;
}

async function runtimeTrap(directory: string): Promise<Record<string, string>> {
  const bin = join(directory, 'bin');
  await Deno.mkdir(bin);
  const log = join(directory, 'forbidden-runtime.log');
  const script = '#!/bin/sh\nprintf "%s\\n" "$0" >> "$NAPSHOT_FORBIDDEN_RUNTIME_LOG"\nexit 99\n';
  for (const executable of ['node', 'nodejs', 'npm', 'npx', 'pnpm']) {
    const path = join(bin, executable);
    await Deno.writeTextFile(path, script, { mode: 0o700 });
  }
  return { PATH: `${bin}:${Deno.env.get('PATH') ?? '/usr/bin:/bin'}`, NAPSHOT_FORBIDDEN_RUNTIME_LOG: log };
}

async function readOutput(stream: ReadableStream<Uint8Array>, append: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
  append(decoder.decode());
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Service startup timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function stop(child: Deno.ChildProcess): Promise<Deno.CommandStatus> {
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }, 5000);
  try {
    try { child.kill('SIGTERM'); } catch { /* Report the status if startup already exited. */ }
    return await child.status;
  }
  finally { clearTimeout(timer); }
}

Deno.test('service process stays alive through relay outage and shuts down cleanly across restarts', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'napshot-process-' });
  const key = Buffer.from(generateSecretKey()).toString('hex');
  const relayPort = unusedPort();
  const trap = await runtimeTrap(directory);
  try {
    for (let run = 0; run < 2; run++) {
      const port = unusedPort();
      const child = new Deno.Command(Deno.execPath(), {
        args: ['run', '--no-prompt', '-A', '--frozen', 'src/main.ts'],
        env: { ...trap, NAPSHOT_SECRET_KEY: key, NAPSHOT_DATA_DIR: directory,
          NAPSHOT_HOST: '127.0.0.1', NAPSHOT_PORT: String(port), NAPSHOT_POLL_MS: '1000',
          NAPSHOT_RELAYS: `wss://127.0.0.1:${relayPort}`, NAPSHOT_BLOSSOM_SERVERS: 'https://a.example,https://b.example' },
        stdin: 'null', stdout: 'piped', stderr: 'piped',
      }).spawn();
      let output = '';
      const readers = [readOutput(child.stdout, text => { output += text; }), readOutput(child.stderr, text => { output += text; })];
      try {
        await waitUntil(() => output.includes('relay_scan_failed'), 8000);
        assert.match(output, /napshot_started/);
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        const status = await response.json();
        assert.equal(status.name, 'Napshot');
        assert.equal(status.lastScan, null);
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.equal(health.status, 503); await health.body?.cancel();
        assert.equal(JSON.stringify(status).includes(key), false);
        assert.equal(output.includes(key), false);
      } finally {
        const result = await stop(child);
        await Promise.all(readers);
        assert.equal(result.code, 0, output);
      }
      await assert.rejects(Deno.stat(join(directory, 'worker.pid')));
    }
    await assert.rejects(Deno.stat(trap.NAPSHOT_FORBIDDEN_RUNTIME_LOG));
  } finally { await Deno.remove(directory, { recursive: true }); }
});

Deno.test('Deno renders a real napplet while Node, npm and pnpm executables are blocked', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'napshot-deno-only-' });
  const trap = await runtimeTrap(directory);
  const moduleUrl = new URL('../src/capture.ts', import.meta.url).href;
  const browser = Deno.env.get('CHROMIUM_PATH') ?? '/usr/bin/chromium';
  const source = `import {Buffer} from 'node:buffer'; import {capture} from ${JSON.stringify(moduleUrl)};
    const png=await capture(Buffer.from('<body style="background:green">Deno only</body>'), {
      executablePath:${JSON.stringify(browser)},width:320,height:200,delayMs:100,timeoutMs:15000});
    console.log(JSON.stringify({signature:png.subarray(1,4).toString(),width:png.readUInt32BE(16),height:png.readUInt32BE(20)}));`;
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ['eval', '--no-prompt', '--frozen', source], env: trap, stdout: 'piped', stderr: 'piped',
    }).output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)), { signature: 'PNG', width: 320, height: 200 });
    await assert.rejects(Deno.stat(trap.NAPSHOT_FORBIDDEN_RUNTIME_LOG));
  } finally { await Deno.remove(directory, { recursive: true }); }
});
