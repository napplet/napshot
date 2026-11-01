import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Worker } from './worker.ts';
import { createSite } from './server.ts';
import { Announcer } from './announce.ts';

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
  return { signal: abort.signal, stop, dispose: () => {
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
  const tasks: Promise<void>[] = [];
  try {
    const announcer = new Announcer(config, store);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    console.log(JSON.stringify({ level: 'info', message: 'napshot_started', pubkey: config.pubkey, port: config.port,
      concurrency: config.concurrency, backfillSince: config.backfillSince, previewIdentity: config.previewIdentity ?? null }));
    tasks.push(worker.run(shutdown.signal), announcer.run(shutdown.signal));
    await Promise.all(tasks);
  } finally {
    shutdown.stop();
    await Promise.allSettled(tasks);
    server.closeAllConnections(); server.close(); store.close(); shutdown.dispose();
  }
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ level: 'fatal', message: error instanceof Error ? error.message : 'Service failed' }));
    Deno.exitCode = 1;
  }
}
