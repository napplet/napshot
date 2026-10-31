import { Buffer } from 'node:buffer';
import { getPublicKey } from 'nostr-tools';
import { serverOrigin } from './blossom.ts';
import { HASH } from './protocol.ts';

export interface Config {
  key: Uint8Array; pubkey: string; relays: string[]; blossomServers: string[]; trustedAuthors: string[];
  dataDir: string; host: string; port: number; pollMs: number; lookbackSeconds: number; minReplicas: number;
  capture: { executablePath?: string; width: number; height: number; delayMs: number; timeoutMs: number };
  profile?: Record<string, unknown>;
}
function integer(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected ${min}..${max}`);
  return value;
}
function list(value: string | undefined): string[] { return [...new Set((value ?? '').split(',').map(v => v.trim()).filter(Boolean))]; }

/** Parse operator configuration once. Keys stay in the server process and never enter status responses. */
export function loadConfig(env: Record<string, string | undefined> = Deno.env.toObject()): Config {
  const key = secretKey(env);
  const pubkey = getPublicKey(key);
  const relays = list(env.NAPSHOT_RELAYS).map(value => {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || url.username || url.password || url.hash) throw new Error('Relays must use wss://');
    return url.href;
  });
  const blossomServers = [...new Set(list(env.NAPSHOT_BLOSSOM_SERVERS).map(serverOrigin))];
  if (!relays.length) throw new Error('Set NAPSHOT_RELAYS');
  if (blossomServers.length < 2 || blossomServers.some(s => !s.startsWith('https://'))) {
    throw new Error('Configure at least two distinct HTTPS Blossom servers');
  }
  const trustedAuthors = [...new Set([pubkey, ...list(env.NAPSHOT_TRUSTED_AUTHORS)])];
  if (trustedAuthors.some(author => !HASH.test(author))) throw new Error('Trusted authors must be hex public keys');
  return {
    key, pubkey, relays: [...new Set(relays)], blossomServers, trustedAuthors,
    dataDir: env.NAPSHOT_DATA_DIR ?? './data', host: env.NAPSHOT_HOST ?? '127.0.0.1',
    port: integer(env, 'NAPSHOT_PORT', 3080, 1, 65535), pollMs: integer(env, 'NAPSHOT_POLL_MS', 30000, 1000, 3600000),
    lookbackSeconds: integer(env, 'NAPSHOT_LOOKBACK_SECONDS', 86400, 0, 31536000),
    minReplicas: integer(env, 'NAPSHOT_MIN_REPLICAS', 2, 2, blossomServers.length),
    capture: captureConfig(env), profile: profileConfig(env.NAPSHOT_PROFILE),
  };
}

function profileConfig(raw: string | undefined): Config['profile'] {
  if (!raw?.trim()) return undefined;
  const invalid = () => new Error('Invalid NAPSHOT_PROFILE: expected a JSON metadata object, at most 16 KiB');
  if (Buffer.byteLength(raw, 'utf8') > 16384) throw invalid();
  let profile: unknown;
  try { profile = JSON.parse(raw); } catch { throw invalid(); }
  if (!isProfileObject(profile)) throw invalid();
  const fields = profile as Record<string, unknown>;
  const strings = ['name', 'display_name', 'about', 'picture', 'banner', 'website', 'nip05', 'lud16', 'lud06'];
  if (strings.some(field => field in fields && typeof fields[field] !== 'string')) throw invalid();
  if ('bot' in fields && typeof fields.bot !== 'boolean') throw invalid();
  return { name: 'napshot', display_name: 'Napshot', bot: true, ...fields };
}

function isProfileObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secretKey(env: Record<string, string | undefined>): Uint8Array {
  if (!HASH.test(env.NAPSHOT_SECRET_KEY ?? '')) throw new Error('NAPSHOT_SECRET_KEY must be a 64-character hex secret key');
  return Uint8Array.from(Buffer.from(env.NAPSHOT_SECRET_KEY!, 'hex'));
}

function captureConfig(env: Record<string, string | undefined>): Config['capture'] {
  return {
    executablePath: env.NAPSHOT_CHROMIUM ?? '/usr/bin/chromium',
    width: integer(env, 'NAPSHOT_WIDTH', 1200, 200, 4096), height: integer(env, 'NAPSHOT_HEIGHT', 750, 160, 4096),
    delayMs: integer(env, 'NAPSHOT_CAPTURE_DELAY_MS', 1500, 0, 10000),
    timeoutMs: integer(env, 'NAPSHOT_CAPTURE_TIMEOUT_MS', 45000, 1000, 120000),
  };
}
