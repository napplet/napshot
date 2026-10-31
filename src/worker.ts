import { Buffer } from 'node:buffer';
import type { Event } from 'nostr-tools';
import { fetchArtifact, pngDimensions, sha256, uploadScreenshot } from './blossom.ts';
import { capture } from './capture.ts';
import type { Config } from './config.ts';
import { Network } from './network.ts';
import { buildLabel, hasScreenshot, isScreenshotLabel, KINDS, parseManifest, type Manifest } from './protocol.ts';
import { Relays } from './relay.ts';
import type { Store, Job } from './store.ts';

export type Log = (level: string, message: string, fields?: Record<string, unknown>) => void;
const defaultLog: Log = (level, message, fields) => console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));

/** Poll durable relay windows and advance checkpoints only after complete, persisted ingestion. */
export class Worker {
  lastScan: number | null = null;
  readonly relayErrors: Record<string, string> = {};
  constructor(readonly config: Config, readonly store: Store,
    private readonly dependencies: { relays?: Relays; network?: Network; capture?: typeof capture; log?: Log } = {}) {}
  private get relays(): Relays { return this.dependencies.relays ?? new Relays(this.config.relays); }
  private get network(): Network { return this.dependencies.network ?? new Network(); }
  private get log(): Log { return this.dependencies.log ?? defaultLog; }

  async scan(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await Promise.all(this.config.relays.map(async relay => {
      try {
        await this.scanRelay(relay, now);
        this.lastScan = Math.floor(Date.now() / 1000);
        delete this.relayErrors[relay];
      } catch (error) {
        this.relayErrors[relay] = message(error);
        this.log('error', 'relay_scan_failed', { relay, error: message(error) });
      }
    }));
  }
  private async scanRelay(relay: string, now: number): Promise<void> {
    let baseline = this.store.cursor(relay);
    if (baseline === undefined) {
      baseline = Math.max(0, now - this.config.lookbackSeconds);
      this.store.checkpoint(relay, baseline);
    }
    const since = Math.max(0, baseline - 60);
    let until = now;
    for (let page = 0; page < 1000; page++) {
      const events = await this.relays.query(relay, { kinds: KINDS, since, until, limit: 500 });
      this.ingest(events);
      if (events.length < 500) { this.store.checkpoint(relay, now); return; }
      const oldest = Math.min(...events.map(event => event.created_at));
      // Repeat boundary second once at a higher limit so equal timestamps are not silently lost.
      const boundary = await this.relays.query(relay, { kinds: KINDS, since: oldest, until: oldest, limit: 10000 });
      if (boundary.length >= 10000) throw new Error('Relay timestamp page saturated; checkpoint retained');
      this.ingest(boundary);
      until = oldest - 1;
      if (until < since) { this.store.checkpoint(relay, now); return; }
    }
    throw new Error('Relay backlog exceeds scan limit; checkpoint retained');
  }
  private ingest(events: Event[]): void {
    for (const event of events) {
      const manifest = parseManifest(event);
      if (manifest) this.store.enqueue(manifest, hasScreenshot(event.tags));
    }
  }
  async processOne(): Promise<boolean> {
    const job = this.store.next();
    if (!job) return false;
    try {
      await this.process(job);
      this.log('info', 'job_finished', { id: job.id });
    } catch (error) {
      this.store.fail(job, message(error));
      this.log('error', 'job_retry_scheduled', { id: job.id, error: message(error), attempt: job.attempts + 1 });
    }
    return true;
  }
  private async alreadyLabeled(manifest: Manifest): Promise<boolean> {
    const results = await Promise.allSettled(this.config.relays.map(relay => this.relays.query(relay, {
      kinds: [1985], '#e': [manifest.event.id], '#L': ['#screenshot'], authors: this.config.trustedAuthors, limit: 500,
    })));
    const replies = results.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value];
      this.log('warn', 'relay_label_query_failed', {
        relay: this.config.relays[index], id: manifest.event.id, error: message(result.reason),
      });
      return [];
    });
    if (!replies.length) throw new Error('No relay answered screenshot label lookup');
    return replies.flat().some(event => isScreenshotLabel(event, manifest.event.id, this.config.trustedAuthors));
  }
  private async process(job: Job): Promise<void> {
    if (job.label) {
      await this.relays.publish(JSON.parse(job.label) as Event);
      this.store.finish(job.id); return;
    }
    const manifest: Manifest = JSON.parse(job.manifest);
    if (await this.alreadyLabeled(manifest)) { this.store.finish(job.id, 'skipped'); return; }
    const png = job.png ? Buffer.from(job.png) : await this.makeCapture(manifest);
    const dimensions = pngDimensions(png);
    if (!job.png) this.store.capture(job.id, png);
    const active = await this.uploadReplicas(job, png);
    const label = buildLabel(manifest, { hash: sha256(png), size: png.length,
      ...dimensions, servers: active }, this.config.key, this.config.relays[0]);
    this.store.label(job.id, label);
    await this.relays.publish(label);
    this.store.finish(job.id);
  }
  private async uploadReplicas(job: Job, png: Buffer): Promise<string[]> {
    const servers: string[] = JSON.parse(job.servers);
    for (const server of this.config.blossomServers) {
      if (servers.includes(server)) continue;
      try {
        await uploadScreenshot(png, server, this.config.key, this.network);
        servers.push(server); this.store.replicas(job.id, servers);
      } catch (error) { this.log('warn', 'upload_failed', { id: job.id, server, error: message(error) }); }
    }
    const active = servers.filter(server => this.config.blossomServers.includes(server));
    if (active.length < this.config.minReplicas) throw new Error(`Only ${active.length}/${this.config.minReplicas} verified replicas`);
    return active;
  }
  private async makeCapture(manifest: Manifest): Promise<Buffer> {
    const html = await fetchArtifact(manifest, this.config.blossomServers, this.network);
    return (this.dependencies.capture ?? capture)(html, this.config.capture);
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'Operation failed'; }
