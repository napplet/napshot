import { setTimeout as sleep } from 'node:timers/promises';
import { finalizeEvent, verifyEvent } from 'nostr-tools';
import type { Config } from './config.ts';
import { Relays } from './relay.ts';
import type { Announcement, Store } from './store.ts';

type Log = (level: string, message: string, fields: Record<string, unknown>) => void;
const log: Log = (level, message, fields) => console.log(JSON.stringify({
  time: new Date().toISOString(), level, message, ...fields,
}));

/** Durable instance identity publication; each relay retries independently of screenshot work. */
export class Announcer {
  private readonly states: Announcement[] = [];
  constructor(private readonly config: Config, private readonly store: Store,
    private readonly relays = new Relays(config.relays), private readonly logger: Log = log) {
    if (!config.profile) return;
    const profile = Object.fromEntries(Object.entries(config.profile).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    this.prepare(0, JSON.stringify(profile), []);
    this.prepare(10002, '', [...config.relays].sort().map(relay => ['r', relay]));
  }

  private prepare(kind: number, content: string, tags: string[][]): void {
    const previous = this.store.announcement(this.config.pubkey, kind);
    if (previous && (!verifyEvent(previous.event) || previous.event.pubkey !== this.config.pubkey || previous.event.kind !== kind)) {
      throw new Error('Invalid stored instance announcement');
    }
    const unchanged = previous?.event.content === content && JSON.stringify(previous.event.tags) === JSON.stringify(tags);
    const event = unchanged ? previous.event : finalizeEvent({ kind, content, tags,
      created_at: Math.max(Math.floor(Date.now() / 1000), (previous?.event.created_at ?? 0) + 1) }, this.config.key);
    const deliveries = Object.fromEntries(this.config.relays.map(relay => {
      const prior = unchanged ? previous.deliveries[relay] : undefined;
      return [relay, prior && !prior.acknowledged ? prior : { acknowledged: false, attempts: 0, nextAt: 0 }];
    }));
    const state = { event, deliveries };
    this.store.saveAnnouncement(state);
    this.states.push(state);
  }

  async tick(now = Date.now()): Promise<void> {
    const tasks = this.states.flatMap(state => this.config.relays
      .filter(relay => !state.deliveries[relay].acknowledged && state.deliveries[relay].nextAt <= now)
      .map(relay => this.deliver(state, relay, now)));
    const results = await Promise.allSettled(tasks);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private async deliver(state: Announcement, relay: string, now: number): Promise<void> {
    const delivery = state.deliveries[relay];
    delivery.attempts++;
    try {
      await this.relays.publishTo(relay, state.event);
      delivery.acknowledged = true;
      this.logger('info', 'instance_event_published', { kind: state.event.kind, id: state.event.id, relay });
    } catch (error) {
      const delay = Math.min(3600000, 5000 * 2 ** Math.min(delivery.attempts - 1, 10));
      delivery.nextAt = Math.max(now, Date.now()) + delay;
      this.logger('warn', 'instance_event_retry_scheduled', { kind: state.event.kind, id: state.event.id,
        relay, attempt: delivery.attempts, error: error instanceof Error ? error.message : 'Publication failed' });
    }
    this.store.saveAnnouncement(state);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.states.length) return;
    while (!signal.aborted) {
      await this.tick();
      await sleep(500, undefined, { signal }).catch(() => {});
    }
  }
}
