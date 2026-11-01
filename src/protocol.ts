import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools';

export const KINDS = [15129, 35129];
export const HASH = /^[0-9a-f]{64}$/;
export interface Manifest { event: Event; hash: string; address: string; servers: string[]; identity?: boolean }
export interface Shot { hash: string; size: number; width: number; height: number; servers: string[] }

/**
 * Parse renderable single-HTML NIP-5D manifests: the current `x` shape plus legacy file maps
 * that contain exactly one HTML file. Snapshots and multi-file sites are excluded.
 */
export function parseManifest(event: Event): Manifest | null {
  try {
    if (!KINDS.includes(event.kind) || !verifyEvent(event)) return null;
    const hash = artifactHash(event.tags);
    const name = manifestName(event);
    if (!hash || name === undefined) return null;
    return { event, hash, address: `${event.kind}:${event.pubkey}:${name}`,
      servers: event.tags.filter(t => t[0] === 'server').map(t => t[1]).filter(Boolean),
      identity: requiresIdentity(event.tags) };
  } catch { return null; }
}

/** One artifact hash: a bare `x`, or the sole `f`/`path` entry of a one-file HTML map. */
function artifactHash(tags: string[][]): string | undefined {
  const files = tags.filter(t => t[0] === 'f' || t[0] === 'path');
  const bare = tags.filter(t => t[0] === 'x' && t.length === 2);
  if (files.length) return files.length === 1 && !bare.length ? htmlFileHash(files[0]) : undefined;
  const hashes = tags.filter(t => t[0] === 'x');
  if (hashes.length !== 1 || bare.length !== 1 || !HASH.test(bare[0][1])) return;
  return bare[0][1];
}

function htmlFileHash([, path = '', hash = '', type]: string[]): string | undefined {
  if (!HASH.test(hash) || !/^\/?index\.html?$/i.test(path)) return;
  return type === undefined || /^text\/html\b/i.test(type) ? hash : undefined;
}

/**
 * Napplets that declare the identity NAP render with the operator's preview account.
 * Manifests list required NAPs under `R` and optional ones under `O`; older manifests use `requires`.
 */
export function requiresIdentity(tags: string[][]): boolean {
  return tags.some(t => (t[0] === 'R' || t[0] === 'O' || t[0] === 'requires') && t[1] === 'identity');
}

export const SIGNED_OUT_CONTENT = 'Signed-out napplet preview captured by Napshot.';
export const PREVIEW_IDENTITY_CONTENT = 'Napplet preview captured by Napshot with a read-only preview identity.';

/** A label whose capture showed the napplet a preview account rather than a signed-out shell. */
export function isPreviewIdentityLabel(event: Event): boolean {
  return event.content === PREVIEW_IDENTITY_CONTENT;
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
export function buildLabel(manifest: Manifest, shot: Shot, key: Uint8Array, relay: string, signedIn = false): Event {
  return finalizeEvent({ kind: 1985, created_at: Math.floor(Date.now() / 1000),
    content: signedIn ? PREVIEW_IDENTITY_CONTENT : SIGNED_OUT_CONTENT,
    tags: [
      ['L', '#screenshot'], ['l', shot.hash, '#screenshot'], ['e', manifest.event.id, relay],
      ['a', manifest.address], ['p', manifest.event.pubkey],
      ['screenshot', `x ${shot.hash}`, 'm image/png', `dim ${shot.width}x${shot.height}`, `size ${shot.size}`],
      ...shot.servers.map(server => ['server', server]),
    ],
  }, key);
}
