import type { Event } from 'nostr-tools';
import type { Network } from './network.ts';
import type { Relays } from './relay.ts';

type Log = (level: string, message: string, fields?: Record<string, unknown>) => void;

/** Upper bound on foreign relays contacted per label; author lists are untrusted input. */
export const MAX_INBOXES = 8;

/** NIP-65 inbox relays: `r` tags that are unmarked or marked `read`, deduplicated, in list order. */
export function inboxRelays(list: Event): string[] {
  const urls = new Set<string>();
  for (const [name, value, marker] of list.tags) {
    if (name !== 'r' || !value || (marker !== undefined && marker !== 'read')) continue;
    try { urls.add(new URL(value).href); } catch { /* Ignore malformed entries. */ }
  }
  return [...urls];
}

/**
 * Opportunistically copy a published label to the napplet author's NIP-65 inbox relays so the
 * author sees it. Never throws: lookup, vetting and publication failures are only logged.
 */
export async function deliverToAuthor(label: Event, author: string,
  deps: { relays: Relays; network: Network; configured: string[]; log: Log }): Promise<void> {
  try {
    const list = await relayList(author, deps.relays, deps.configured);
    if (!list) return;
    const configured = new Set(deps.configured.map(url => new URL(url).href));
    const targets = inboxRelays(list).filter(url => !configured.has(url)).slice(0, MAX_INBOXES);
    await Promise.all(targets.map(url => publishInbox(label, url, deps)));
  } catch (error) {
    deps.log('warn', 'author_inbox_lookup_failed', { id: label.id, author, error: message(error) });
  }
}

/** Newest kind-10002 for `author` across the configured relays, if any answered with one. */
async function relayList(author: string, relays: Relays, configured: string[]): Promise<Event | undefined> {
  const results = await Promise.allSettled(configured.map(url => relays.query(url, { kinds: [10002], authors: [author], limit: 1 })));
  const lists = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  return lists.filter(event => event.pubkey === author).sort((a, b) => b.created_at - a.created_at)[0];
}

async function publishInbox(label: Event, url: string, deps: { relays: Relays; network: Network; log: Log }): Promise<void> {
  try {
    const relay = await deps.network.relayUrl(url);
    await deps.relays.publishTo(relay, label);
    deps.log('info', 'author_inbox_published', { id: label.id, relay });
  } catch (error) {
    deps.log('warn', 'author_inbox_publish_failed', { id: label.id, relay: url, error: message(error) });
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'Operation failed'; }
