import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { matchFilter, verifyEvent, type Event, type Filter } from 'nostr-tools';
import { sha256 } from '../src/blossom.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (body.length < 126) header[1] = body.length;
  else { header[1] = 126; header.writeUInt16BE(body.length, 2); }
  return Buffer.concat([header, body]);
}

/** Minimal local WebSocket relay, exercising the production client's actual wire exchange. */
export async function relayFixture() {
  const events: Event[] = [];
  const published: Event[] = [];
  const queries: Filter[] = [];
  const sockets = new Set<Duplex>();
  const behavior = { query: 'normal', publish: 'accept', duplicates: false };
  const server = createServer((_request, response) => response.writeHead(426).end());
  const handle = (socket: Duplex, frame: unknown[]) => {
    if (frame[0] === 'REQ') {
      const id = frame[1]; const filter = frame[2] as Filter;
      queries.push(filter);
      if (behavior.query === 'silent') return;
      if (behavior.query === 'closed') { socket.write(encode(['CLOSED', id, 'unavailable'])); return; }
      const matched = events.filter(event => matchFilter(filter, event))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, filter.limit ?? 500);
      for (const event of matched) {
        socket.write(encode(['EVENT', id, event]));
        if (behavior.duplicates) socket.write(encode(['EVENT', id, event]));
      }
      socket.write(encode(['EOSE', id]));
    }
    if (frame[0] === 'EVENT') {
      const event = frame[1] as Event;
      published.push(event);
      if (behavior.publish !== 'reject' && verifyEvent(event)) events.push(event);
      if (behavior.publish !== 'silent') socket.write(encode(['OK', event.id, behavior.publish === 'accept', 'fixture']));
    }
  };
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffered: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15; const masked = Boolean(buffered[1] & 128);
        let length = buffered[1] & 127; let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10;
        }
        if (buffered.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffered.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        const body = Buffer.from(buffered.subarray(offset, offset + length));
        if (mask) for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
        buffered = buffered.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode === 1) handle(socket, JSON.parse(body.toString()) as unknown[]);
      }
    });
  });
  const port = await listen(server);
  return { url: `ws://127.0.0.1:${port}`, events, published, queries, behavior,
    close: async () => { for (const socket of sockets) socket.destroy(); await close(server); } };
}

/** BUD-02 fixture validates BUD-11 signatures and preserves exact uploaded bytes. */
export async function blossomFixture() {
  const blobs = new Map<string, Buffer>();
  const uploads: Buffer[] = [];
  const authorizations: Event[] = [];
  const failures: string[] = [];
  const behavior = { rejectUpload: false, corruptReadback: false };
  let origin = '';
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      const data = blobs.get(request.url?.slice(1) ?? '');
      if (!data) { response.writeHead(404).end(); return; }
      response.writeHead(200).end(behavior.corruptReadback ? Buffer.from('corrupt') : data); return;
    }
    if (request.method !== 'PUT' || request.url !== '/upload') { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (behavior.rejectUpload) { response.writeHead(503).end(); return; }
      try {
        const data = Buffer.concat(chunks); const hash = sha256(data);
        const authorization = request.headers.authorization ?? '';
        assert.match(authorization, /^Nostr [A-Za-z0-9_-]+$/);
        const event = JSON.parse(Buffer.from(authorization.slice(6), 'base64url').toString()) as Event;
        assert.equal(verifyEvent(event), true);
        assert.equal(event.kind, 24242);
        assert.ok(event.content.length > 0);
        const now = Math.floor(Date.now() / 1000);
        assert.ok(event.created_at <= now);
        assert.ok(Number(event.tags.find(tag => tag[0] === 'expiration')?.[1]) > now);
        assert.ok(event.tags.some(tag => tag[0] === 'x' && tag[1] === hash));
        assert.ok(event.tags.some(tag => tag[0] === 't' && tag[1] === 'upload'));
        assert.ok(event.tags.some(tag => tag[0] === 'server' && tag[1] === new URL(origin).hostname));
        assert.equal(request.headers['x-sha-256'], hash);
        assert.equal(request.headers['content-type'], 'image/png');
        assert.equal(Number(request.headers['content-length']), data.length);
        blobs.set(hash, data); uploads.push(data); authorizations.push(event);
        response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({
          sha256: hash, size: data.length, type: 'image/png', url: `${origin}/${hash}.png`, uploaded: now,
        }));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        response.writeHead(400).end('Invalid upload');
      }
    });
  });
  origin = `http://127.0.0.1:${await listen(server)}`;
  return { origin, blobs, uploads, authorizations, failures, behavior, close: () => close(server) };
}
