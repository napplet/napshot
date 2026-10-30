import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import { createSite } from './server.js';

async function main(): Promise<void> {
  if (process.argv.includes('--site-only')) {
    servePreview();
    return;
  }
  await runService();
}

function servePreview(): void {
  const site = createSite(); site.listen(Number(process.env.NAPSHOT_PORT ?? 3080), process.env.NAPSHOT_HOST ?? '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => site.close());
}

async function runService(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dataDir);
  const worker = new Worker(config, store);
  const server = createSite(worker);
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    console.log(JSON.stringify({ level: 'info', message: 'napshot_started', pubkey: config.pubkey, port: config.port }));
    await runWorker(worker, config.pollMs, abort.signal);
  } finally {
    server.closeAllConnections(); server.close(); store.close();
  }
}

async function runWorker(worker: Worker, pollMs: number, signal: AbortSignal): Promise<void> {
  let nextScan = 0;
  while (!signal.aborted) {
    if (Date.now() >= nextScan) { await worker.scan(); nextScan = Date.now() + pollMs; }
    if (signal.aborted) break;
    if (!await worker.processOne()) await sleep(500, undefined, { signal }).catch(() => {});
  }
}

main().catch(error => { console.error(JSON.stringify({ level: 'fatal', message: error.message })); process.exitCode = 1; });
