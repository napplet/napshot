import type { ServerResponse } from 'node:http';
import { nip19, type Event } from 'nostr-tools';
import { HASH, type Manifest } from './protocol.ts';
import { Relays } from './relay.ts';
import type { Capture } from './store.ts';
import type { Worker } from './worker.ts';

/** Well-known metadata relays consulted alongside the configured relays for author profiles. */
export const PROFILE_RELAYS = ['wss://purplepag.es/', 'wss://relay.damus.io/', 'wss://relay.primal.net/'];
const PROFILE_TTL_MS = 3600000;
const PROFILE_RETRY_MS = 300000;
const PROFILE_BATCH = 100;
const MAX_CLIENTS = 256;
const STATUS_MS = 15000;
const DEBOUNCE_MS = 250;
const RECENT = 60;

export interface Profile { name?: string; picture?: string; about?: string; nip05?: string; website?: string }
interface CachedProfile { profile?: Profile; at: number; answered: boolean }

/** Strip control characters (keeping newlines) and bound untrusted metadata strings. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return;
  // deno-lint-ignore no-control-regex
  const clean = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return; }
}

/** Kind 0 content is arbitrary JSON; expose only bounded display fields and HTTPS links. */
export function parseProfile(event: Event): Profile {
  let fields: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
  } catch { /* An unreadable profile displays as the bare npub. */ }
  return { name: text(fields.display_name, 64) ?? text(fields.name, 64), picture: httpsUrl(fields.picture),
    about: text(fields.about, 500), nip05: text(fields.nip05, 100), website: httpsUrl(fields.website) };
}

function newestByAuthor(results: PromiseSettledResult<Event[]>[]): Map<string, Event> {
  const newest = new Map<string, Event>();
  for (const event of results.flatMap(result => result.status === 'fulfilled' ? result.value : [])) {
    const current = newest.get(event.pubkey);
    if (!current || event.created_at > current.created_at) newest.set(event.pubkey, event);
  }
  return newest;
}

/** Background, cached kind 0 lookups; a page view never waits on relays. */
export class Profiles {
  private readonly cache = new Map<string, CachedProfile>();
  private readonly inflight = new Set<string>();
  constructor(private readonly relays: Relays, private readonly urls: string[], private readonly updated: () => void) {}
  get(pubkey: string): Profile | undefined { return this.cache.get(pubkey)?.profile; }
  request(pubkeys: string[]): void {
    const now = Date.now();
    const due = [...new Set(pubkeys)].filter(pubkey => !this.inflight.has(pubkey) && this.stale(this.cache.get(pubkey), now));
    for (let index = 0; index < due.length; index += PROFILE_BATCH) {
      const batch = due.slice(index, index + PROFILE_BATCH);
      batch.forEach(pubkey => this.inflight.add(pubkey));
      void this.fetch(batch).finally(() => batch.forEach(pubkey => this.inflight.delete(pubkey)));
    }
  }
  private stale(entry: CachedProfile | undefined, now: number): boolean {
    return !entry || now - entry.at > (entry.answered ? PROFILE_TTL_MS : PROFILE_RETRY_MS);
  }
  private async fetch(authors: string[]): Promise<void> {
    const results = await Promise.allSettled(this.urls.map(url => this.relays.query(url, { kinds: [0], authors })));
    const newest = newestByAuthor(results);
    const answered = results.some(result => result.status === 'fulfilled');
    for (const author of authors) {
      const event = newest.get(author);
      this.cache.set(author, { profile: event ? parseProfile(event) : this.get(author), at: Date.now(), answered });
    }
    if (newest.size) this.updated();
  }
}

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find(tag => tag[0] === name)?.[1];
}

/** Screenshot metadata and resolvable mirror URLs from a label this instance signed. */
function screenshot(label: Event) {
  const fields = label.tags.find(tag => tag[0] === 'screenshot')?.slice(1) ?? [];
  const field = (key: string) => fields.find(value => value.startsWith(`${key} `))?.slice(key.length + 1);
  const hash = field('x') ?? '';
  const [width, height] = (field('dim') ?? '').split('x').map(Number);
  return { hash, mime: field('m') ?? 'image/png', width: width || null, height: height || null, size: Number(field('size')) || null,
    urls: mirrors(label, hash) };
}

function mirrors(label: Event, hash: string): string[] {
  if (!HASH.test(hash)) return [];
  const servers = label.tags.filter(tag => tag[0] === 'server').map(tag => httpsUrl(tag[1])).filter(url => url !== undefined);
  return servers.map(server => new URL(`/${hash}.png`, server).href);
}

function napplet(manifest: Manifest, relays: string[]) {
  const event = manifest.event;
  const identifier = manifest.address.split(':').slice(2).join(':');
  return { id: event.id, kind: event.kind, address: manifest.address, identifier, createdAt: event.created_at,
    title: text(tagValue(event, 'title') ?? tagValue(event, 'name'), 80) ?? (identifier || 'Root napplet'),
    summary: text(tagValue(event, 'summary') ?? tagValue(event, 'description'), 300) ?? null,
    nevent: nip19.neventEncode({ id: event.id, author: event.pubkey, kind: event.kind, relays }),
    naddr: nip19.naddrEncode({ kind: event.kind, pubkey: event.pubkey, identifier, relays }) };
}

/** Public view of one capture. Full events are served separately by id to keep live pushes small. */
export function captureView(capture: Capture, relays: string[], profile?: Profile) {
  const { label, manifest } = capture;
  const target = label.tags.find(tag => tag[0] === 'e')?.[2];
  const hints = [...new Set([target, ...relays].filter(url => /^wss?:\/\//.test(url ?? '')))].slice(0, 2) as string[];
  return {
    id: label.id, capturedAt: label.created_at, screenshot: screenshot(label),
    label: { id: label.id, nevent: nip19.neventEncode({ id: label.id, author: label.pubkey, kind: label.kind, relays: hints }) },
    napplet: napplet(manifest, hints),
    author: { pubkey: manifest.event.pubkey, npub: nip19.npubEncode(manifest.event.pubkey), profile: profile ?? null },
  };
}

/** Redacted operator status; never includes keys or relay credentials. */
export function status(worker?: Worker) {
  const config = worker?.config;
  return { name: 'Napshot', pubkey: config?.pubkey ?? null,
    relays: config?.relays ?? [], blossomServers: config?.blossomServers ?? [],
    counts: worker?.store.counts() ?? { pending: 0, done: 0, failed: 0 }, lastScan: worker?.lastScan ?? null,
    relayErrors: worker?.relayErrors ?? {} };
}

/** Recent captures plus a Server-Sent Events stream that pushes queue changes as they happen. */
export class Feed {
  readonly profiles: Profiles;
  private readonly clients = new Set<ServerResponse>();
  private debounce?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private sent = '';
  constructor(private readonly worker?: Worker, options: { relays?: Relays; profileRelays?: string[] } = {}) {
    const urls = [...new Set([...(worker?.config.relays ?? []), ...(options.profileRelays ?? PROFILE_RELAYS)])];
    this.profiles = new Profiles(options.relays ?? new Relays(urls, 8000), urls, () => this.schedule());
  }
  captures() {
    const recent = this.worker?.store.recent(RECENT) ?? [];
    this.profiles.request(recent.map(capture => capture.manifest.event.pubkey));
    const relays = this.worker?.config.relays ?? [];
    return recent.map(capture => captureView(capture, relays, this.profiles.get(capture.manifest.event.pubkey)));
  }
  snapshot() { return { status: status(this.worker), captures: this.captures() }; }
  /** Raw signed event (napplet manifest or label) for a capture this instance published. */
  event(id: string): Event | undefined { return HASH.test(id) ? this.worker?.store.capturedEvent(id) : undefined; }
  attach(response: ServerResponse): void {
    if (this.clients.size >= MAX_CLIENTS) { response.writeHead(503, { 'retry-after': '30' }).end(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const captures = JSON.stringify(this.captures());
    response.write(`retry: 3000\n\n${frame('status', JSON.stringify(status(this.worker)))}${frame('captures', captures)}`);
    // Existing viewers get the same news immediately so one shared "last sent" stays accurate.
    if (captures !== this.sent) for (const client of this.clients) client.write(frame('captures', captures));
    this.sent = captures;
    this.clients.add(response);
    this.start();
    response.on('close', () => { this.clients.delete(response); if (!this.clients.size) this.stop(); });
  }
  close(): void { for (const client of this.clients) client.end(); this.clients.clear(); this.stop(); }
  private start(): void {
    if (this.ticker) return;
    this.unsubscribe = this.worker?.store.subscribe(() => this.schedule());
    this.ticker = setInterval(() => this.push(false), STATUS_MS);
  }
  private stop(): void {
    clearInterval(this.ticker); clearTimeout(this.debounce);
    this.unsubscribe?.(); this.ticker = this.debounce = this.unsubscribe = undefined;
  }
  private schedule(): void {
    if (!this.clients.size || this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = undefined; this.push(true); }, DEBOUNCE_MS);
  }
  private push(changed: boolean): void {
    let message = frame('status', JSON.stringify(status(this.worker)));
    const captures = changed ? JSON.stringify(this.captures()) : this.sent;
    if (captures !== this.sent) { message += frame('captures', captures); this.sent = captures; }
    for (const client of this.clients) client.write(message);
  }
}

function frame(name: string, data: string): string { return `event: ${name}\ndata: ${data}\n\n`; }
