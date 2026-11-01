import process from 'node:process';
import type { Buffer } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
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

/** Single-owner SQLite queue. Capture and signed publication survive process restarts. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly lock: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = join(directory, 'worker.pid');
    this.claimLock();
    try {
      const filename = join(directory, 'napshot.sqlite');
      this.db = new DatabaseSync(filename);
      chmodSync(filename, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, address TEXT NOT NULL, created_at INTEGER NOT NULL, manifest TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
          png BLOB, servers TEXT NOT NULL DEFAULT '[]', label TEXT, error TEXT);
        CREATE TABLE IF NOT EXISTS cursors (relay TEXT PRIMARY KEY, timestamp INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS floors (relay TEXT PRIMARY KEY, timestamp INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS announcements (pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
          state TEXT NOT NULL, PRIMARY KEY (pubkey,kind));
        CREATE INDEX IF NOT EXISTS due ON jobs(status,next_at);
      `);
      // A previous owner stopped mid-job; persisted capture/replica/label progress lets it resume.
      this.db.exec("UPDATE jobs SET status='pending' WHERE status='running'");
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  private claimLock(): void {
    try { writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(this.lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid worker lock; inspect data directory');
      try { process.kill(pid, 0); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure;
        unlinkSync(this.lock);
        writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 }); return;
      }
      throw new Error('Another worker owns this data directory');
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
  cursor(relay: string): number | undefined {
    return (this.db.prepare('SELECT timestamp FROM cursors WHERE relay=?').get(relay) as { timestamp: number } | undefined)?.timestamp;
  }
  checkpoint(relay: string, timestamp: number): void {
    this.db.prepare('INSERT OR REPLACE INTO cursors VALUES (?,?)').run(relay, timestamp);
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
  }
  fail(job: Job, error: string): void {
    const attempts = job.attempts + 1;
    const delay = Math.min(3600000, 5000 * 2 ** Math.min(attempts - 1, 10));
    this.db.prepare("UPDATE jobs SET status='failed',attempts=?,next_at=?,error=? WHERE id=?")
      .run(attempts, Date.now() + delay, error.slice(0, 300), job.id);
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
  close(): void { this.db.close(); unlinkSync(this.lock); }
}
