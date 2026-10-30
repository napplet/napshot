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
}

/** Bounded HTTP with pinned DNS and no redirects. Private access is available only to injected test clients. */
export class Network {
  constructor(private readonly allowPrivate = false) {}
  async request(input: string, options: RequestOptions = {}): Promise<Buffer> {
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
          reject(new Error(`HTTP ${response.statusCode}`)); response.destroy(); request.destroy(); return;
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
