import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools';

export const KINDS = [15129, 35129];
export const HASH = /^[0-9a-f]{64}$/;
export interface Manifest { event: Event; hash: string; address: string; servers: string[] }
export interface Shot { hash: string; size: number; width: number; height: number; servers: string[] }

/** Parse current single-artifact NIP-5D manifests, excluding snapshots and legacy file maps. */
export function parseManifest(event: Event): Manifest | null {
  try {
    if (!KINDS.includes(event.kind) || !verifyEvent(event) || !event.content.trim()) return null;
    const hash = artifactHash(event.tags);
    const name = manifestName(event);
    if (!hash || name === undefined || event.tags.some(t => t[0] === 'f')) return null;
    return { event, hash, address: `${event.kind}:${event.pubkey}:${name}`,
      servers: event.tags.filter(t => t[0] === 'server').map(t => t[1]).filter(Boolean) };
  } catch { return null; }
}

function artifactHash(tags: string[][]): string | undefined {
  const hashes = tags.filter(t => t[0] === 'x');
  if (hashes.length !== 1 || hashes[0].length !== 2 || !HASH.test(hashes[0][1])) return;
  return hashes[0][1];
}

function manifestName(event: Event): string | undefined {
  const names = event.tags.filter(t => t[0] === 'd');
  if (event.kind === 15129) return names.length === 0 ? '' : undefined;
  if (names.length !== 1 || names[0].length !== 2 || !/^[a-z0-9-]+$/.test(names[0][1])) return;
  return names[0][1];
}

/** Parse a single usable NIP-5D screenshot, including duplicate/bare field rejection. */
function screenshotHash(tag: string[]): string | undefined {
  if (tag[0] !== 'screenshot') return;
  const hashes = tag.slice(1).filter(v => v === 'x' || v.startsWith('x '));
  const types = tag.slice(1).filter(v => v === 'm' || v.startsWith('m '));
  if (hashes.length !== 1 || !HASH.test(hashes[0].slice(2))) return;
  if (types.length && (types.length !== 1 || !/^m image\/(png|jpeg|webp)$/i.test(types[0]))) return;
  return hashes[0].slice(2);
}

/** Author-provided usable media takes precedence over generated previews. */
export function hasScreenshot(tags: string[][]): boolean {
  return tags.some(tag => screenshotHash(tag) !== undefined);
}

/** Accept only signed, trusted, revision-bound NIP-32 screenshot labels. */
export function isScreenshotLabel(event: Event, target: string, authors: string[]): boolean {
  try {
    return event.kind === 1985 && authors.includes(event.pubkey) && verifyEvent(event) &&
      event.tags.some(t => t[0] === 'e' && t[1] === target) &&
      event.tags.some(t => t[0] === 'L' && t[1] === '#screenshot') &&
      event.tags.some(t => t[0] === 'l' && t[2] === '#screenshot' &&
        event.tags.some(s => screenshotHash(s) === t[1] && HASH.test(t[1])));
  } catch { return false; }
}

/** Sign an additive annotation; the author manifest is never modified. */
export function buildLabel(manifest: Manifest, shot: Shot, key: Uint8Array, relay: string): Event {
  return finalizeEvent({ kind: 1985, created_at: Math.floor(Date.now() / 1000),
    content: 'Signed-out napplet preview captured by Napshot.',
    tags: [
      ['L', '#screenshot'], ['l', shot.hash, '#screenshot'], ['e', manifest.event.id, relay],
      ['a', manifest.address], ['p', manifest.event.pubkey],
      ['screenshot', `x ${shot.hash}`, 'm image/png', `dim ${shot.width}x${shot.height}`, `size ${shot.size}`],
      ...shot.servers.map(server => ['server', server]),
    ],
  }, key);
}
