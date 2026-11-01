import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools';
import type { Network } from './network.ts';
import type { Manifest } from './protocol.ts';

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
/** Dimensions come from persisted PNG bytes, not configuration that may change on restart. */
export function pngDimensions(data: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.subarray(12, 16).toString() !== 'IHDR') {
    throw new Error('Capture is not a PNG');
  }
  const width = data.readUInt32BE(16); const height = data.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error('Invalid PNG dimensions');
  return { width, height };
}

export function serverOrigin(input: string): string {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Blossom server must be an HTTP(S) origin');
  }
  return url.origin;
}

/** Retrieve exactly the signed artifact bytes, trying manifest hints then operator mirrors. */
export async function fetchArtifact(manifest: Manifest, fallback: string[], network: Network): Promise<Buffer> {
  const servers = [...new Set([...manifest.servers.slice(0, 16), ...fallback])];
  for (const input of servers) {
    try {
      // Content is hash-verified below, so CDN redirects and slow large artifacts are acceptable.
      const bytes = await network.request(`${serverOrigin(input)}/${manifest.hash}`,
        { maxBytes: 25_000_000, timeoutMs: 60000, redirects: 3 });
      if (sha256(bytes) !== manifest.hash) continue;
      return bytes;
    } catch { /* Try the next independently validated server. */ }
  }
  throw new Error('No server returned the verified napplet artifact');
}

/** Upload and read back identical PNG bytes before advertising a Blossom replica. */
export async function uploadScreenshot(data: Buffer, server: string, key: Uint8Array, network: Network): Promise<void> {
  const hash = sha256(data);
  try { await upload(data, hash, { server, key, network }); }
  catch (error) {
    // A server may refuse a duplicate (e.g. 409) of bytes it already serves; the readback proves the replica.
    if (!await serves(data, hash, server, network)) throw error;
    return;
  }
  // Read the canonical content-addressed path, never an arbitrary upload response URL.
  if (!await serves(data, hash, server, network)) throw new Error('Blossom readback hash mismatch');
}

async function serves(data: Buffer, hash: string, server: string, network: Network): Promise<boolean> {
  try { return sha256(await network.request(`${server}/${hash}`, { maxBytes: data.length })) === hash; }
  catch { return false; }
}

interface UploadTarget { server: string; key: Uint8Array; network: Network }

async function upload(data: Buffer, hash: string, target: UploadTarget, scope = new URL(target.server).hostname): Promise<void> {
  const { server, key, network } = target;
  const now = Math.floor(Date.now() / 1000);
  const auth = finalizeEvent({ kind: 24242, created_at: now - 1, content: 'Upload a Napshot screenshot',
    tags: [['t', 'upload'], ['x', hash], ['server', scope], ['expiration', String(now + 300)]],
  }, key);
  let response: Buffer;
  try {
    response = await network.request(`${server}/upload`, { method: 'PUT', body: data, maxBytes: 65536,
      headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64url')}`,
        'content-type': 'image/png', 'content-length': String(data.length), 'x-sha-256': hash },
    });
  } catch (error) {
    // BUD-11 scopes tokens by domain name, but some servers compare the tag against their full URL instead.
    if (scope !== server && error instanceof Error && error.message === 'HTTP 401') return upload(data, hash, target, server);
    throw error;
  }
  const descriptor = JSON.parse(response.toString()) as { sha256?: string; size?: number; type?: string; url?: string };
  if (descriptor.sha256 !== hash || descriptor.size !== data.length || descriptor.type !== 'image/png') {
    throw new Error('Blossom descriptor does not match screenshot');
  }
}
