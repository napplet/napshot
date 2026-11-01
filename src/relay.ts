import { randomUUID } from 'node:crypto';
import { matchFilter, verifyEvent, type Event, type Filter } from 'nostr-tools';

/** One bounded NIP-01 exchange. A timeout or CLOSED never means an empty query. */
function exchange<T>(url: string, message: unknown[], consume: (frame: unknown[]) => T | undefined,
  timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(new Error('Relay timeout')), timeoutMs);
    let settled = false;
    function finish(error?: Error, result?: T): void {
      if (settled) return; settled = true; clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(result as T);
    }
    socket.onopen = () => socket.send(JSON.stringify(message));
    socket.onerror = () => finish(new Error('Relay connection failed'));
    socket.onclose = () => finish(new Error('Relay closed before completion'));
    socket.onmessage = incoming => {
      try {
        const frame = decodeFrame(incoming.data, message[1]);
        if (!frame) return;
        const result = consume(frame);
        if (result !== undefined) finish(undefined, result);
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid relay frame')); }
    };
  });
}

function decodeFrame(data: unknown, subscription: unknown): unknown[] | undefined {
  if (typeof data !== 'string' || data.length > 1_000_000) throw new Error('Oversized relay frame');
  const frame: unknown = JSON.parse(data);
  if (!Array.isArray(frame)) return;
  if (frame[0] === 'CLOSED' && frame[1] === subscription) throw new Error('Relay refused subscription');
  return frame;
}

function streamFrame(frame: unknown[] | undefined, id: string, filter: Filter,
  onEvent: (event: Event) => void, onEose: () => void): void {
  if (!frame || frame[1] !== id) return;
  if (frame[0] === 'EOSE') onEose();
  if (frame[0] !== 'EVENT') return;
  const event = frame[2] as Event;
  if (verifyEvent(event) && matchFilter(filter, event)) onEvent(event);
}

export class Relays {
  constructor(readonly urls: string[], private readonly timeoutMs = 15000) {}
  async query(url: string, filter: Filter): Promise<Event[]> {
    const id = randomUUID(); const events = new Map<string, Event>();
    return await exchange(url, ['REQ', id, filter], frame => {
      if (frame[1] !== id) return;
      if (frame[0] === 'EOSE') return [...events.values()];
      if (frame[0] === 'EVENT') {
        const event = frame[2] as Event;
        if (verifyEvent(event) && matchFilter(filter, event)) events.set(event.id, event);
        if (events.size > 10000) throw new Error('Relay result exceeds event limit');
      }
      return;
    }, this.timeoutMs);
  }
  /**
   * Hold one REQ open past EOSE and stream verified matching events as they arrive.
   * Resolves only when `signal` aborts; any disconnect, refusal or stall rejects so the caller can resync.
   */
  subscribe(url: string, filter: Filter, handlers: { event: (event: Event) => void; eose?: () => void },
    signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = new WebSocket(url);
      let settled = false; let live = false;
      const connectTimer = setTimeout(() => finish(new Error('Relay timeout')), this.timeoutMs);
      function finish(error?: Error): void {
        if (settled) return; settled = true; clearTimeout(connectTimer);
        signal.removeEventListener('abort', abort);
        try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', id])); } catch { /* Closing anyway. */ }
        socket.close();
        if (error) reject(error); else resolve();
      }
      const abort = () => finish();
      if (signal.aborted) { finish(); return; }
      signal.addEventListener('abort', abort, { once: true });
      socket.onopen = () => socket.send(JSON.stringify(['REQ', id, filter]));
      socket.onerror = () => finish(new Error('Relay connection failed'));
      socket.onclose = () => finish(new Error('Relay subscription closed'));
      const onEose = () => { if (!live) { live = true; clearTimeout(connectTimer); handlers.eose?.(); } };
      socket.onmessage = incoming => {
        try { streamFrame(decodeFrame(incoming.data, id), id, filter, handlers.event, onEose); }
        catch (error) { finish(error instanceof Error ? error : new Error('Invalid relay frame')); }
      };
    });
  }
  async publish(event: Event): Promise<void> {
    const results = await Promise.allSettled(this.urls.map(url => this.publishTo(url, event)));
    if (!results.some(result => result.status === 'fulfilled')) throw new Error('No relay acknowledged event');
  }
  async publishTo(url: string, event: Event): Promise<void> {
    await exchange(url, ['EVENT', event], frame => {
      if (frame[0] !== 'OK' || frame[1] !== event.id) return;
      if (frame[2] !== true) throw new Error('Relay rejected publication');
      return true;
    }, this.timeoutMs);
  }
}
