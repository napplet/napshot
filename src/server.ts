import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Worker } from './worker.ts';

/** Serve the public explainer and redacted operator status, with no write endpoints. */
export function createSite(worker?: Worker) {
  return createServer((request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    const policy = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'";
    response.setHeader('content-security-policy', policy);
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/api/status' || path === '/healthz') {
      sendStatus(path, response, worker);
      return;
    }
    sendStatic(path, response);
  });
}

function sendStatus(path: string, response: ServerResponse, worker?: Worker): void {
  const healthy = !!worker?.lastScan && Date.now() / 1000 - worker.lastScan < Math.max(120, worker.config.pollMs / 1000 * 3);
  response.writeHead(path === '/healthz' && !healthy ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(status(worker)));
}

function status(worker?: Worker) {
  const config = worker?.config;
  return { name: 'Napshot', pubkey: config?.pubkey ?? null,
    relays: config?.relays ?? [], blossomServers: config?.blossomServers ?? [],
    counts: worker?.store.counts() ?? { pending: 0, done: 0, failed: 0 }, lastScan: worker?.lastScan ?? null };
}

function sendStatic(path: string, response: ServerResponse): void {
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'],
    '/skill': ['../skills/napshot-shell/SKILL.md', 'text/plain; charset=utf-8'],
  };
  const file = files[path];
  if (!file) { response.writeHead(404).end('Not found'); return; }
  void readFile(new URL(`../public/${file[0]}`, import.meta.url)).then(bytes => {
    response.writeHead(200, { 'content-type': file[1] }); response.end(bytes);
  }).catch(() => response.writeHead(500).end('Static file unavailable'));
}
