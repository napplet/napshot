import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Feed, status } from './feed.ts';
import type { Relays } from './relay.ts';
import type { Worker } from './worker.ts';

const POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Serve the public viewer, its read-only capture feed and redacted operator status, with no write endpoints. */
export function createSite(worker?: Worker, options: { relays?: Relays; profileRelays?: string[] } = {}) {
  const feed = new Feed(worker, options);
  const server = createServer((request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', POLICY);
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!sendApi(path, response, feed, worker)) sendStatic(path, response);
  });
  server.on('close', () => feed.close());
  return server;
}

function sendApi(path: string, response: ServerResponse, feed: Feed, worker?: Worker): boolean {
  if (path === '/api/status' || path === '/healthz') { sendStatus(path, response, worker); return true; }
  if (path === '/api/captures') { json(response, 200, feed.snapshot()); return true; }
  if (path === '/api/stream') { feed.attach(response); return true; }
  const match = /^\/api\/event\/([0-9a-f]{64})$/.exec(path);
  if (!match) return false;
  const event = feed.event(match[1]);
  json(response, event ? 200 : 404, event ?? { error: 'Unknown event' });
  return true;
}

function json(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sendStatus(path: string, response: ServerResponse, worker?: Worker): void {
  const healthy = !!worker?.lastScan && Date.now() / 1000 - worker.lastScan < 120;
  json(response, path === '/healthz' && !healthy ? 503 : 200, status(worker));
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
