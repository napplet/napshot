import { Buffer } from 'node:buffer';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Event } from 'nostr-tools';
import { fetchArtifact, pngDimensions, sha256, uploadScreenshot } from './blossom.ts';
import { capture } from './capture.ts';
import type { Config } from './config.ts';
import { Network } from './network.ts';
import { deliverToAuthor } from './outbox.ts';
import { buildLabel, buildRetraction, captureProfile, hasScreenshot, isCurrentCapture, isScreenshotLabel, KINDS,
  parseManifest, type CaptureFeature, type Manifest } from './protocol.ts';
import { Relays } from './relay.ts';
import type { Store, Job } from './store.ts';

export type Log = (level: string, message: string, fields?: Record<string, unknown>) => void;
const defaultLog: Log = (level, message, fields) => console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));

const PAGE = 500;
const BOUNDARY = 10000;
const HEARTBEAT_MS = 30000;
const IDLE_MS = 60000;

/**
 * Live relay subscriptions feed a durable SQLite queue that parallel processors drain immediately.
 * History is backfilled once per relay down to `backfillSince`; checkpoints advance only after
 * complete, persisted ingestion or while a live subscription is known to be covering new events.
 */
export class Worker {
  lastScan: number | null = null;
  readonly relayErrors: Record<string, string> = {};
  private readonly waiters = new Set<() => void>();
  constructor(readonly config: Config, readonly store: Store,
    private readonly dependencies: { relays?: Relays; network?: Network; capture?: typeof capture; log?: Log } = {}) {}
  private get relays(): Relays { return this.dependencies.relays ?? new Relays(this.config.relays); }
  private get network(): Network { return this.dependencies.network ?? new Network(); }
  private get log(): Log { return this.dependencies.log ?? defaultLog; }

  /** Run live ingestion, periodic safety resyncs and `concurrency` processors until aborted. */
  async run(signal: AbortSignal): Promise<void> {
    this.refreshCaptures();
    const tasks = [
      ...this.config.relays.map(relay => this.watch(relay, signal)),
      ...Array.from({ length: this.config.concurrency }, () => this.drain(signal)),
      this.resync(signal),
    ];
    signal.addEventListener('abort', () => this.wake(), { once: true });
    await Promise.all(tasks);
  }

  /**
   * Napplets captured with fewer shell features than the current configuration grants (no preview
   * identity, no relay reads), or labeled before `recaptureBefore`, are queued again so shells get
   * a preview with real data from the current renderer.
   */
  refreshCaptures(): number {
    const requeued = this.store.requeue((manifest, label) => {
      const tags = manifest.event.tags;
      if (hasScreenshot(tags)) return false;
      if (label && label.created_at < this.config.recaptureBefore) return true;
      return this.profileFor(manifest).length > 0 && !(label && isCurrentCapture(label, tags, this.identityConfigured));
    });
    if (requeued) { this.log('info', 'recapture_queued', { count: requeued }); this.wake(); }
    return requeued;
  }

  /** One complete catch-up pass over every relay. */
  async scan(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await Promise.all(this.config.relays.map(relay => this.syncRelay(relay, now)));
  }

  private async syncRelay(relay: string, now: number): Promise<boolean> {
    try {
      await this.scanRelay(relay, now);
      this.healthy(relay);
      return true;
    } catch (error) {
      this.relayErrors[relay] = message(error);
      this.log('error', 'relay_scan_failed', { relay, error: message(error) });
      return false;
    }
  }

  private healthy(relay: string): void {
    this.lastScan = Math.floor(Date.now() / 1000);
    delete this.relayErrors[relay];
  }

  private async scanRelay(relay: string, now: number): Promise<void> {
    const target = this.config.backfillSince;
    const floor = this.store.floor(relay);
    const cursor = this.store.cursor(relay);
    // A relay whose history has never been walked down to the target gets a full backfill,
    // including databases created before backfill existed and operators lowering the target.
    const backfill = floor === undefined || cursor === undefined || floor > target;
    const since = backfill ? target : Math.max(target, cursor - 60);
    const queued = await this.walk(relay, since, now);
    this.store.checkpoint(relay, now);
    this.store.setFloor(relay, Math.min(floor ?? target, target));
    if (backfill) this.log('info', 'relay_backfill_complete', { relay, since, queued });
  }

  /**
   * Page newest-to-oldest until a page comes back empty. Relays cap `limit` at their own maximum,
   * so a short page never proves completeness. Each page's oldest second is re-read alone so
   * events sharing that timestamp are not lost when the page boundary splits them.
   */
  private async walk(relay: string, since: number, now: number): Promise<number> {
    let until = now; let queued = 0;
    for (let page = 0; page < 10000; page++) {
      const events = await this.relays.query(relay, { kinds: KINDS, since, until, limit: PAGE });
      queued += this.ingest(events);
      if (!events.length) return queued;
      const oldest = Math.min(...events.map(event => event.created_at));
      const boundary = await this.relays.query(relay, { kinds: KINDS, since: oldest, until: oldest, limit: BOUNDARY });
      if (boundary.length >= BOUNDARY) throw new Error('Relay timestamp page saturated; checkpoint retained');
      queued += this.ingest(boundary);
      until = oldest - 1;
      if (until < since) return queued;
    }
    throw new Error('Relay backlog exceeds scan limit; checkpoint retained');
  }

  /** Keep a live REQ open per relay; reconnect with catch-up after any drop. */
  private async watch(relay: string, signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      const started = Math.floor(Date.now() / 1000);
      const connection = new AbortController();
      const stop = () => connection.abort();
      signal.addEventListener('abort', stop, { once: true });
      let synced = false;
      const heartbeat = setInterval(() => {
        // Everything newer than `started - 60` streams live, so a completed catch-up plus an open
        // subscription means the relay is covered up to now.
        if (!synced) return;
        this.store.checkpoint(relay, Math.floor(Date.now() / 1000));
        this.healthy(relay);
      }, HEARTBEAT_MS);
      try {
        const subscription = this.relays.subscribe(relay, { kinds: KINDS, since: started - 60 }, {
          event: event => { if (this.ingest([event])) this.log('info', 'manifest_queued', { relay, id: event.id }); },
        }, connection.signal);
        subscription.catch(() => {}); // Observed below; avoid an unhandled rejection during catch-up.
        // Catch up from the stored cursor (or backfill history) while the live stream is already open.
        synced = await this.syncRelay(relay, started);
        if (synced) backoff = 1000;
        else connection.abort(); // Reconnect and retry catch-up rather than stream past a gap.
        await subscription;
      } catch (error) {
        if (signal.aborted) break;
        this.relayErrors[relay] = message(error);
        this.log('warn', 'relay_subscription_lost', { relay, error: message(error), retryMs: backoff });
      } finally {
        clearInterval(heartbeat); connection.abort(); signal.removeEventListener('abort', stop);
      }
      await sleep(backoff, undefined, { signal }).catch(() => {});
      backoff = Math.min(backoff * 2, 60000);
    }
  }

  /** Safety net for relays that drop live deliveries; live subscriptions do the real work. */
  private async resync(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(this.config.resyncMs, undefined, { signal }).catch(() => {});
      if (!signal.aborted) await this.scan();
    }
  }

  private async drain(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (await this.processOne()) continue;
      const due = this.store.nextDueAt();
      await this.idle(due === undefined ? IDLE_MS : Math.min(IDLE_MS, Math.max(50, due - Date.now())), signal);
    }
  }

  private idle(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      if (signal.aborted) done();
    });
  }

  private wake(): void { for (const waiter of [...this.waiters]) waiter(); }

  private ingest(events: Event[]): number {
    let queued = 0;
    for (const event of events) {
      const manifest = parseManifest(event);
      if (manifest && this.store.enqueue(manifest, hasScreenshot(event.tags))) queued++;
    }
    if (queued) this.wake();
    return queued;
  }

  async processOne(): Promise<boolean> {
    const job = this.store.claim();
    if (!job) return false;
    const started = Date.now();
    try {
      await this.process(job);
      this.log('info', 'job_finished', { id: job.id, ms: Date.now() - started });
    } catch (error) {
      this.store.fail(job, message(error));
      this.log('error', 'job_retry_scheduled', { id: job.id, error: message(error), attempt: job.attempts + 1 });
    }
    return true;
  }
  /** Every trusted screenshot label for this manifest revision currently on the configured relays. */
  private async trustedLabels(manifest: Manifest): Promise<Event[]> {
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
    const seen = new Set<string>();
    return replies.flat().filter(event => isScreenshotLabel(event, manifest.event.id, this.config.trustedAuthors)
      && !seen.has(event.id) && seen.add(event.id));
  }
  /** Retract this instance's earlier labels for a revision it has just re-captured. Best effort. */
  private async retract(labels: Event[], replacement: Event): Promise<void> {
    const stale = labels.filter(label => label.pubkey === this.config.pubkey && label.id !== replacement.id).map(label => label.id);
    if (!stale.length) return;
    try {
      await this.relays.publish(buildRetraction(stale, this.config.key));
      this.log('info', 'labels_retracted', { id: replacement.id, retracted: stale });
    } catch (error) { this.log('warn', 'label_retraction_failed', { id: replacement.id, error: message(error) }); }
  }
  private async process(job: Job): Promise<void> {
    const manifest: Manifest = JSON.parse(job.manifest);
    if (job.label) {
      const label = JSON.parse(job.label) as Event;
      await this.relays.publish(label);
      this.store.finish(job.id);
      await this.notifyAuthor(label, manifest); return;
    }
    const labels = await this.trustedLabels(manifest);
    // A label from a lesser capture (signed out, no relays) does not settle a napplet that now gets more.
    const existing = labels.find(label => label.created_at >= this.config.recaptureBefore
      && isCurrentCapture(label, manifest.event.tags, this.identityConfigured));
    // Keep the settling label so a later refresh can see what that capture already had.
    if (existing) { this.store.label(job.id, existing); this.store.finish(job.id, 'skipped'); return; }
    const png = job.png ? Buffer.from(job.png) : await this.makeCapture(manifest);
    const dimensions = pngDimensions(png);
    if (!job.png) this.store.capture(job.id, png);
    const active = await this.uploadReplicas(job, png);
    const label = buildLabel(manifest, { hash: sha256(png), size: png.length,
      ...dimensions, servers: active }, this.config.key, this.config.relays[0], this.profileFor(manifest));
    this.store.label(job.id, label);
    await this.relays.publish(label);
    this.store.finish(job.id);
    await this.retract(labels, label);
    await this.notifyAuthor(label, manifest);
  }
  /** Best effort after the job is durably finished; failures here never retry or fail the job. */
  private notifyAuthor(label: Event, manifest: Manifest): Promise<void> {
    return deliverToAuthor(label, manifest.event.pubkey,
      { relays: this.relays, network: this.network, configured: this.config.relays, log: this.log });
  }
  private async uploadReplicas(job: Job, png: Buffer): Promise<string[]> {
    const servers: string[] = JSON.parse(job.servers);
    await Promise.all(this.config.blossomServers.filter(server => !servers.includes(server)).map(async server => {
      try {
        await uploadScreenshot(png, server, this.config.key, this.network);
        servers.push(server); this.store.replicas(job.id, servers);
      } catch (error) { this.log('warn', 'upload_failed', { id: job.id, server, error: message(error) }); }
    }));
    const active = this.config.blossomServers.filter(server => servers.includes(server));
    if (active.length < this.config.minReplicas) throw new Error(`Only ${active.length}/${this.config.minReplicas} verified replicas`);
    return active;
  }
  private get identityConfigured(): boolean { return Boolean(this.config.previewIdentity); }
  /** Derived from the signed tags rather than a stored flag, so jobs queued under an older rule follow the current one. */
  private profileFor(manifest: Manifest): CaptureFeature[] {
    return captureProfile(manifest.event.tags, this.identityConfigured);
  }
  private async makeCapture(manifest: Manifest): Promise<Buffer> {
    // Legacy single-file manifests often inline the exact artifact; use it when the hash proves it.
    const inline = Buffer.from(manifest.event.content, 'utf8');
    const html = inline.length && sha256(inline) === manifest.hash
      ? inline : await fetchArtifact(manifest, this.config.blossomServers, this.network);
    const profile = this.profileFor(manifest);
    return (this.dependencies.capture ?? capture)(html, { ...this.config.capture,
      identity: profile.includes('identity') ? this.config.previewIdentity : undefined,
      relays: profile.includes('relays') ? this.config.relays : [] });
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'Operation failed'; }
