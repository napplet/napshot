import type { Buffer } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Event } from 'nostr-tools';
import type { Manifest } from './protocol.ts';

export interface Job {
  id: string; manifest: string; status: string; attempts: number; next_at: number;
  png: Uint8Array | null; servers: string; label: string | null;
}

export interface Announcement {
  event: Event;
  deliveries: Record<string, { acknowledged: boolean; attempts: number; nextAt: number }>;
}

export interface Capture { manifest: Manifest; label: Event }

/**
 * Single-owner SQLite queue. Capture and signed publication survive process restarts.
 * Ownership is SQLite's exclusive file lock, which the kernel releases when the owner dies, so a
 * container killed mid-job never leaves a stale lock behind for its replacement.
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, 'napshot.sqlite');
    this.db = new DatabaseSync(filename);
    try {
      chmodSync(filename, 0o600);
      this.claimLock();
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, address TEXT NOT NULL, created_at INTEGER NOT NULL, manifest TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
          png BLOB, servers TEXT NOT NULL DEFAULT '[]', label TEXT, error TEXT);
        CREATE TABLE IF NOT EXISTS cursors (relay TEXT PRIMARY KEY, timestamp INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS scan_cursors (relay TEXT PRIMARY KEY, timestamp INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS floors (relay TEXT PRIMARY KEY, timestamp INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS announcements (pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
          state TEXT NOT NULL, PRIMARY KEY (pubkey,kind));
        CREATE INDEX IF NOT EXISTS due ON jobs(status,next_at);
        CREATE INDEX IF NOT EXISTS published ON jobs(status, json_extract(label,'$.created_at'));
      `);
      // A previous owner stopped mid-job; persisted capture/replica/label progress lets it resume.
      this.db.exec("UPDATE jobs SET status='pending' WHERE status='running'");
      // A restart usually means a fix or a new build: give failed jobs one prompt retry before backoff resumes.
      this.db.exec("UPDATE jobs SET next_at=0 WHERE status='failed'");
    } catch (error) { this.db.close(); throw error; }
  }
  /** Take the database's exclusive lock for the life of this connection; fail fast if another owner holds it. */
  private claimLock(): void {
    try {
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=0; BEGIN IMMEDIATE; COMMIT;');
    } catch (error) {
      if (/SQLITE_BUSY|database is locked/i.test(error instanceof Error ? error.message : '')) {
        throw new Error('Another worker owns this data directory');
      }
      throw error;
    }
  }
  /** Returns true when a new capturable job entered the queue. */
  enqueue(manifest: Manifest, skip: boolean): boolean {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO jobs (id,address,created_at,manifest,status)
      VALUES (?,?,?,?,?)`).run(manifest.event.id, manifest.address, manifest.event.created_at,
      JSON.stringify(manifest), skip ? 'skipped' : 'pending').changes > 0;
    // NIP-01 replacement ordering: newest timestamp, lowest id on ties.
    this.db.prepare(`UPDATE jobs SET status='superseded', png=NULL WHERE address=? AND status IN ('pending','failed')
      AND id != (SELECT id FROM jobs WHERE address=? ORDER BY created_at DESC,id ASC LIMIT 1)`)
      .run(manifest.address, manifest.address);
    if (inserted) this.changed();
    return inserted && !skip;
  }
  /**
   * Return finished or skipped current revisions to the queue when `select` wants them recaptured.
   * Progress from the earlier capture (PNG, replicas, label) is discarded; superseded revisions stay put.
   */
  requeue(select: (manifest: Manifest, label: Event | null) => boolean): number {
    const rows = this.db.prepare(`SELECT id,manifest,label FROM jobs AS job WHERE status IN ('done','skipped')
      AND id = (SELECT id FROM jobs WHERE address=job.address ORDER BY created_at DESC,id ASC LIMIT 1)`)
      .all() as unknown as { id: string; manifest: string; label: string | null }[];
    const reset = this.db.prepare(`UPDATE jobs SET status='pending',attempts=0,next_at=0,png=NULL,servers='[]',label=NULL,error=NULL
      WHERE id=?`);
    let count = 0;
    for (const row of rows) {
      const manifest = JSON.parse(row.manifest) as Manifest;
      const label = row.label ? JSON.parse(row.label) as Event : null;
      if (select(manifest, label)) count += Number(reset.run(row.id).changes);
    }
    return count;
  }
  /** Only completed finite scans may advance this watermark; legacy heartbeat cursors are not trusted. */
  cursor(relay: string): number | undefined {
    return (this.db.prepare('SELECT timestamp FROM scan_cursors WHERE relay=?').get(relay) as { timestamp: number } | undefined)?.timestamp;
  }
  checkpoint(relay: string, timestamp: number): void {
    this.db.prepare('INSERT OR REPLACE INTO scan_cursors VALUES (?,?)').run(relay, timestamp);
  }
  /** Oldest timestamp a complete backfill has covered for this relay. */
  floor(relay: string): number | undefined {
    return (this.db.prepare('SELECT timestamp FROM floors WHERE relay=?').get(relay) as { timestamp: number } | undefined)?.timestamp;
  }
  setFloor(relay: string, timestamp: number): void {
    this.db.prepare('INSERT OR REPLACE INTO floors VALUES (?,?)').run(relay, timestamp);
  }
  /** Atomically take the next due job so parallel processors never share one. */
  claim(now = Date.now()): Job | undefined {
    const job = this.next(now);
    if (job) this.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
    return job;
  }
  /** Earliest retry time among waiting jobs, for sleeping exactly until work is due. */
  nextDueAt(): number | undefined {
    const row = this.db.prepare("SELECT min(next_at) AS at FROM jobs WHERE status IN ('pending','failed')").get() as { at: number | null };
    return row.at ?? undefined;
  }
  next(now = Date.now()): Job | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE status IN ('pending','failed') AND next_at<=?
      ORDER BY next_at,created_at DESC LIMIT 1`).get(now) as unknown as Job | undefined;
  }
  capture(id: string, png: Buffer): void { this.db.prepare('UPDATE jobs SET png=? WHERE id=?').run(png, id); }
  replicas(id: string, servers: string[]): void {
    this.db.prepare('UPDATE jobs SET servers=? WHERE id=?').run(JSON.stringify(servers), id);
  }
  label(id: string, event: Event): void { this.db.prepare('UPDATE jobs SET label=? WHERE id=?').run(JSON.stringify(event), id); }
  finish(id: string, status = 'done'): void {
    this.db.prepare('UPDATE jobs SET status=?,png=NULL,error=NULL WHERE id=?').run(status, id);
    this.changed();
  }
  fail(job: Job, error: string): void {
    const attempts = job.attempts + 1;
    const delay = Math.min(3600000, 5000 * 2 ** Math.min(attempts - 1, 10));
    this.db.prepare("UPDATE jobs SET status='failed',attempts=?,next_at=?,error=? WHERE id=?")
      .run(attempts, Date.now() + delay, error.slice(0, 300), job.id);
    this.changed();
  }
  /** Newest published screenshot labels with their exact target manifests. */
  recent(limit = 60): Capture[] {
    const rows = this.db.prepare(`SELECT manifest,label FROM jobs WHERE status='done' AND label IS NOT NULL
      ORDER BY json_extract(label,'$.created_at') DESC, id LIMIT ?`).all(limit) as { manifest: string; label: string }[];
    return rows.map(row => ({ manifest: JSON.parse(row.manifest) as Manifest, label: JSON.parse(row.label) as Event }));
  }
  /** A published capture's napplet manifest (by job id) or its signed label (by label id). */
  capturedEvent(id: string): Event | undefined {
    const row = this.db.prepare(`SELECT id,manifest,label FROM jobs WHERE status='done' AND label IS NOT NULL
      AND (id=? OR json_extract(label,'$.id')=?) LIMIT 1`).get(id, id) as { id: string; manifest: string; label: string } | undefined;
    if (!row) return;
    return row.id === id ? (JSON.parse(row.manifest) as Manifest).event : JSON.parse(row.label) as Event;
  }
  /** Observe queue changes (new manifests, finished or failed jobs); returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* Observers never break queue writes. */ }
    }
  }
  counts(): { pending: number; done: number; failed: number } {
    const counts = { pending: 0, done: 0, failed: 0 };
    for (const row of this.db.prepare('SELECT status,count(*) AS count FROM jobs GROUP BY status').all()) {
      // In-flight work is still outstanding from the operator's point of view.
      const status = row.status === 'running' ? 'pending' : row.status;
      if (status === 'pending' || status === 'done' || status === 'failed') counts[status] += Number(row.count);
    }
    return counts;
  }
  announcement(pubkey: string, kind: number): Announcement | undefined {
    const row = this.db.prepare('SELECT state FROM announcements WHERE pubkey=? AND kind=?')
      .get(pubkey, kind) as { state: string } | undefined;
    return row ? JSON.parse(row.state) as Announcement : undefined;
  }
  saveAnnouncement(state: Announcement): void {
    this.db.prepare('INSERT OR REPLACE INTO announcements VALUES (?,?,?)')
      .run(state.event.pubkey, state.event.kind, JSON.stringify(state));
  }
  close(): void { this.db.close(); }
}
