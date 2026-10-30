import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Event } from 'nostr-tools';
import type { Manifest } from './protocol.js';

export interface Job {
  id: string; manifest: string; status: string; attempts: number; next_at: number;
  png: Uint8Array | null; servers: string; label: string | null;
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
        CREATE INDEX IF NOT EXISTS due ON jobs(status,next_at);
      `);
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
  enqueue(manifest: Manifest, skip: boolean): void {
    this.db.prepare(`INSERT OR IGNORE INTO jobs (id,address,created_at,manifest,status)
      VALUES (?,?,?,?,?)`).run(manifest.event.id, manifest.address, manifest.event.created_at,
      JSON.stringify(manifest), skip ? 'skipped' : 'pending');
    // NIP-01 replacement ordering: newest timestamp, lowest id on ties.
    this.db.prepare(`UPDATE jobs SET status='superseded', png=NULL WHERE address=? AND status IN ('pending','failed')
      AND id != (SELECT id FROM jobs WHERE address=? ORDER BY created_at DESC,id ASC LIMIT 1)`)
      .run(manifest.address, manifest.address);
  }
  cursor(relay: string): number | undefined {
    return (this.db.prepare('SELECT timestamp FROM cursors WHERE relay=?').get(relay) as { timestamp: number } | undefined)?.timestamp;
  }
  checkpoint(relay: string, timestamp: number): void {
    this.db.prepare('INSERT OR REPLACE INTO cursors VALUES (?,?)').run(relay, timestamp);
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
      if (row.status === 'pending' || row.status === 'done' || row.status === 'failed') counts[row.status] = Number(row.count);
    }
    return counts;
  }
  close(): void { this.db.close(); unlinkSync(this.lock); }
}
