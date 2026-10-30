import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Worker } from './worker.ts';
import { createSite } from './server.ts';

async function main(): Promise<void> {
  if (Deno.args.includes('--site-only')) {
    servePreview();
    return;
  }
  await runService();
}

/** Register and release native signal handlers for the lifetime of one service. */
function shutdownController() {
  const abort = new AbortController();
  const stop = () => abort.abort();
  const signals = ['SIGINT', 'SIGTERM'] as const;
  for (const signal of signals) Deno.addSignalListener(signal, stop);
  return { signal: abort.signal, dispose: () => {
    for (const signal of signals) Deno.removeSignalListener(signal, stop);
  } };
}

function servePreview(): void {
  const site = createSite();
  const shutdown = shutdownController();
  site.listen(Number(Deno.env.get('NAPSHOT_PORT') ?? 3080), Deno.env.get('NAPSHOT_HOST') ?? '127.0.0.1');
  shutdown.signal.addEventListener('abort', () => {
    site.closeAllConnections(); site.close(); shutdown.dispose();
  }, { once: true });
}

async function runService(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dataDir);
  const worker = new Worker(config, store);
  const server = createSite(worker);
  const shutdown = shutdownController();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    console.log(JSON.stringify({ level: 'info', message: 'napshot_started', pubkey: config.pubkey, port: config.port }));
    await runWorker(worker, config.pollMs, shutdown.signal);
  } finally {
    server.closeAllConnections(); server.close(); store.close(); shutdown.dispose();
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

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ level: 'fatal', message: error instanceof Error ? error.message : 'Service failed' }));
    Deno.exitCode = 1;
  }
}
