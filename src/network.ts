import { Buffer } from 'node:buffer';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked.addSubnet(ip, prefix, 'ipv4');
}
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(ip, prefix, 'ipv6');
}
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export interface RequestOptions {
  method?: string; body?: Buffer; headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number;
  /** GET only: follow up to this many redirects, re-validating every hop. Default 0. */
  redirects?: number;
}

/**
 * Bounded HTTP with pinned DNS. Redirects are refused unless a caller that verifies content by
 * hash opts in; each hop is then checked against the same HTTPS and public-address policy.
 * Private access is available only to injected test clients.
 */
export class Network {
  constructor(private readonly allowPrivate = false) {}
  async request(input: string, options: RequestOptions = {}): Promise<Buffer> {
    let url = input;
    for (let hop = 0; ; hop++) {
      try { return await this.once(url, options); }
      catch (error) { url = followable(error, url, hop, options); }
    }
  }
  private async once(input: string, options: RequestOptions): Promise<Buffer> {
    const url = requestUrl(input, this.allowPrivate);
    const addresses = await resolveAddresses(url.hostname.replace(/^\[|\]$/g, ''), this.allowPrivate);
    const address = addresses[0];
    return new Promise<Buffer>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(url, {
        method: options.method ?? 'GET', headers: options.headers, agent: false,
        lookup: (_name, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, address.address, address.family);
        },
      }, response => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          const location = response.headers.location;
          reject(location && [301, 302, 303, 307, 308].includes(response.statusCode ?? 0)
            ? new Redirect(response.statusCode!, location) : new Error(`HTTP ${response.statusCode}`));
          response.destroy(); request.destroy(); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 10_000_000)) {
            reject(new Error('Response exceeds size limit')); response.destroy(); request.destroy();
          }
          else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      });
      const timer = setTimeout(() => { reject(new Error('HTTP timeout')); request.destroy(); }, options.timeoutMs ?? 15000);
      request.once('close', () => clearTimeout(timer));
      request.once('error', reject);
      request.end(options.body);
    });
  }
}

class Redirect extends Error {
  constructor(readonly status: number, readonly location: string) { super(`HTTP ${status}`); }
}

/** Next hop for an opted-in GET redirect; otherwise rethrow as a plain HTTP error. */
function followable(error: unknown, url: string, hop: number, options: RequestOptions): string {
  if (!(error instanceof Redirect)) throw error;
  if (hop >= (options.redirects ?? 0) || (options.method ?? 'GET') !== 'GET') throw new Error(`HTTP ${error.status}`);
  return new URL(error.location, url).href;
}

function requestUrl(input: string, allowPrivate: boolean): URL {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Unsafe URL');
  if (!allowPrivate && url.protocol !== 'https:') throw new Error('HTTPS required');
  return url;
}

async function resolveAddresses(hostname: string, allowPrivate: boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 10000); }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || (!allowPrivate && addresses.some(a => !isPublicAddress(a.address)))) {
    throw new Error('Non-public network destination rejected');
  }
  return addresses;
}
