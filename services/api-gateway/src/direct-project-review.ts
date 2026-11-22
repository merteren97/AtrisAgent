import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { excludedName, filePath, parts } from './manual-change-review';
import { reviewFileHash, replaceReviewedFile, type FileBytes } from './live-project-changes';

const git = promisify(execFile);
const fileLimit = 2 * 1024 * 1024;
const previewLimit = 160 * 1024;
const projectBudget = 128 * 1024 * 1024;
const entryLimit = 20_000;
const missing = '-';
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
type State = 'pending' | 'approved' | 'reverted';
type Entry = { path: string; revision: string; state: State; before_key: string; after_key: string; before_mode: number; previous: string | null; undoing: number };
type Head = { digest: string; stamp: string; mode: number; revision: string | null };
type Snapshot = { digest: string; stamp: string; mode: number; bytes?: Buffer };
type Project = { id: string; root: string; gitRootPath?: string; ready: Promise<void>; settled: boolean; seeded: boolean; bytes: number; tracked: number;
  queue: Promise<unknown>; pending: Set<string>; full: boolean; watcher?: fs.FSWatcher; timer?: NodeJS.Timeout;
  interval?: NodeJS.Timeout; closed: boolean; issue?: string; gitAt: number; gitFiles: Map<string, string>; gitRead?: Promise<void> };
type Selection = Array<{ path: string; revision: string }>;

function stamp(stat: fs.BigIntStats) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`; }
function relativePath(value: string) {
  try { parts(value); return value; } catch { return undefined; }
}
const absent: Snapshot = { digest: missing, stamp: missing, mode: 0 };
const present = ({ before_key, after_key }: Pick<Entry, 'before_key' | 'after_key'>) => before_key === missing ? 'added' : after_key === missing ? 'deleted' : 'modified';

/** Background filesystem notifications are observations, not proof of which process wrote a file. */
export class DirectProjectReview {
  private projects = new Map<string, Project>();
  private closed = false;
  constructor(private db: Database.Database, private dataDir: string, private registeredPath: (id: string) => string | undefined) {
    db.exec(`CREATE TABLE IF NOT EXISTS direct_review_project (
      id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, root TEXT NOT NULL, seeded INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS direct_review_blob (
      project TEXT NOT NULL REFERENCES direct_review_project(id) ON DELETE CASCADE, digest TEXT NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY(project, digest)
    ); CREATE TABLE IF NOT EXISTS direct_review_head (
      project TEXT NOT NULL REFERENCES direct_review_project(id) ON DELETE CASCADE, path TEXT NOT NULL,
      digest TEXT NOT NULL, stamp TEXT NOT NULL, mode INTEGER NOT NULL, revision TEXT, PRIMARY KEY(project, path)
    ); CREATE TABLE IF NOT EXISTS direct_review_entry (
      project TEXT NOT NULL REFERENCES direct_review_project(id) ON DELETE CASCADE, revision TEXT NOT NULL, path TEXT NOT NULL,
      before_key TEXT NOT NULL, after_key TEXT NOT NULL, before_mode INTEGER NOT NULL, previous TEXT,
      state TEXT NOT NULL DEFAULT 'pending', undoing INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project, revision)
    )`);
  }

  private guard(project: Project) {
    const registered = this.registeredPath(project.id);
    if (project.closed || !registered || fs.realpathSync(registered) !== project.root) throw fail('This project folder is no longer available.');
  }

  private async project(id: string): Promise<Project> {
    const existing = this.projects.get(id);
    if (existing) { this.guard(existing); return existing; }
    const rootPath = this.registeredPath(id);
    if (!rootPath || this.closed) throw fail('This project folder is no longer available.');
    const root = await fs.promises.realpath(rootPath);
    const other = this.projects.get(id);
    if (other) { this.guard(other); return other; }
    if (this.closed) throw fail('Project review is closing.');
    if (this.projects.size >= 12) throw fail('Too many active project review folders.', 503);
    const saved = this.db.prepare('SELECT root, seeded FROM direct_review_project WHERE id = ?').get(id) as {root: string; seeded: number} | undefined;
    if (saved && saved.root !== root) throw fail('The registered project folder changed. Earlier review history was kept.');
    const project: Project = { id, root, seeded: Boolean(saved?.seeded), bytes: 0, tracked: 0, pending: new Set(), full: false, closed: false,
      settled: false, ready: Promise.resolve(), queue: Promise.resolve(), gitAt: 0, gitFiles: new Map() };
    this.guard(project);
    if (path.relative(path.resolve(this.dataDir), root) === '' || root.startsWith(`${path.resolve(this.dataDir)}${path.sep}`)) throw fail('The app data folder cannot be reviewed as a project.');
    this.db.prepare('INSERT OR IGNORE INTO direct_review_project (id,root) VALUES (?, ?)').run(id, root);
    const size = this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM direct_review_blob WHERE project = ?').get(id) as {bytes: number};
    project.bytes = size.bytes;
    project.tracked = (this.db.prepare('SELECT COUNT(*) AS count FROM direct_review_head WHERE project=?').get(id) as {count: number}).count;
    this.projects.set(id, project);
    try {
      project.watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, name) => {
        if (!name) project.full = true;
        else {
          const normalized = name.split(path.sep).join('/');
          if (normalized.split('/').some(segment => segment && excludedName(segment))) return;
          const relative = relativePath(normalized);
          if (!relative || this.isAppData(project, relative)) return;
          project.pending.add(relative);
          if (project.pending.size > 512) { project.pending.clear(); project.full = true; }
        }
        this.schedule(project);
      });
      project.watcher.on('error', () => { project.watcher?.close(); project.watcher = undefined; project.full = true; this.schedule(project); });
    } catch { /* Reconcile on a timer where recursive notifications are unavailable. */ }
    project.ready = this.enqueue(project, async () => {
      try { await this.reconcile(project, !project.seeded); }
      catch (error) { if (!project.closed) project.issue = error instanceof Error ? error.message : 'File history is limited.'; }
      finally { project.settled = true; this.schedule(project); }
    });
    const intervalMs = project.watcher ? 180_000 : 30_000;
    project.interval = setInterval(() => { project.full = true; this.schedule(project); }, intervalMs).unref();
    return project;
  }

  async ready(id: string) { await (await this.project(id)).ready; }
  async prepareLaunch(id: string) {
    const project = await this.project(id);
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([project.ready, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]); }
    finally { clearTimeout(timer); }
  }
  async deactivate(id: string, stillIdle: () => boolean) {
    const project = this.projects.get(id);
    if (!project || project.closed || !stillIdle()) return;
    // Stop immediately so deletion never blocks behind a queued 20k-file reconcile.
    this.stop(project);
  }
  async close() {
    this.closed = true;
    const queues = [...this.projects.values()].map(project => project.queue);
    for (const project of [...this.projects.values()]) this.stop(project);
    await Promise.allSettled(queues);
  }
  private stop(project: Project) {
    project.closed = true;
    project.watcher?.close(); clearTimeout(project.timer); clearInterval(project.interval);
    this.projects.delete(project.id);
  }
  private enqueue<T>(project: Project, run: () => Promise<T>): Promise<T> {
    const job = project.queue.then(run);
    project.queue = job.catch(() => {});
    return job;
  }
  private schedule(project: Project) {
    if (project.closed || !project.settled || project.timer || (!project.full && !project.pending.size)) return;
    project.timer = setTimeout(() => {
      project.timer = undefined;
      void this.enqueue(project, async () => {
        try {
          this.guard(project);
          const full = project.full, paths = [...project.pending];
          project.full = false; project.pending.clear();
          if (full) await this.reconcile(project, false);
          else for (const relative of paths) {
            if (project.closed) break;
            const info = await fs.promises.lstat(path.join(project.root, relative)).catch(error => {
              if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
            });
            if (info?.isDirectory() || (!info && this.hasChildren(project, relative))) project.full = true;
            else await this.observe(project, relative, false);
          }
        } catch {
          try { this.guard(project); project.issue = 'Some files could not be recorded. Refresh to retry.'; }
          catch { this.stop(project); }
        } finally { this.schedule(project); }
      });
    }, 250).unref();
  }

  private hasChildren(project: Project, relative: string) {
    return this.db.prepare('SELECT 1 FROM direct_review_head WHERE project=? AND path>=? AND path<? LIMIT 1').get(project.id, `${relative}/`, `${relative}0`);
  }
  private isAppData(project: Project, relative: string) {
    const filename = path.join(project.root, relative);
    const fromData = path.relative(path.resolve(this.dataDir), filename);
    return fromData === '' || !path.isAbsolute(fromData) && fromData !== '..' && !fromData.startsWith(`..${path.sep}`);
  }
  private head(project: Project, relative: string) {
    return this.db.prepare('SELECT digest, stamp, mode, revision FROM direct_review_head WHERE project = ? AND path = ?').get(project.id, relative) as Head | undefined;
  }
  private writeHead(project: Project, relative: string, value: Snapshot, revision: string | null) {
    if (!this.head(project, relative)) project.tracked++;
    this.db.prepare(`INSERT INTO direct_review_head VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project,path) DO UPDATE SET digest=excluded.digest, stamp=excluded.stamp, mode=excluded.mode, revision=excluded.revision`)
      .run(project.id, relative, value.digest, value.stamp, value.mode, revision);
  }
  private blob(project: Project, digest: string): Buffer | null | undefined {
    return digest === missing ? null : (this.db.prepare('SELECT bytes FROM direct_review_blob WHERE project=? AND digest=?').get(project.id, digest) as {bytes: Buffer} | undefined)?.bytes;
  }
  private storeBlob(project: Project, value: Snapshot) {
    if (!value.bytes || project.bytes + value.bytes.length > projectBudget) return;
    if (this.db.prepare('INSERT OR IGNORE INTO direct_review_blob VALUES (?, ?, ?)').run(project.id, value.digest, value.bytes).changes) project.bytes += value.bytes.length;
  }

  private async readFile(project: Project, relative: string): Promise<Snapshot> {
    let fd: fs.promises.FileHandle | undefined;
    try {
      const filename = filePath(project.root, relative);
      fd = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const start = await fd.stat({ bigint: true });
      const mode = Number(start.mode) & 0o777;
      const named = await fs.promises.lstat(filePath(project.root, relative), { bigint: true });
      if (!start.isFile() || !named.isFile() || stamp(named) !== stamp(start)) throw fail('The file changed during capture.');
      if (start.nlink !== 1n || start.size > BigInt(fileLimit)) return { digest: `opaque:${stamp(start)}`, stamp: stamp(start), mode };
      const bytes = Buffer.alloc(Number(start.size));
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw fail('The file changed during capture.');
        offset += bytesRead;
      }
      if (stamp(await fd.stat({ bigint: true })) !== stamp(start) ||
        stamp(await fs.promises.lstat(filePath(project.root, relative), { bigint: true })) !== stamp(start)) throw fail('The file changed during capture.');
      return { digest: reviewFileHash({ bytes, mode }), stamp: stamp(start), mode, bytes };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return absent;
      throw error;
    } finally { await fd?.close(); }
  }

  private async reconcile(project: Project, seed: boolean) {
    this.guard(project);
    project.issue = undefined;
    const headRows = this.db.prepare('SELECT path, digest, stamp, mode, revision FROM direct_review_head WHERE project = ?').all(project.id) as Array<Head & { path: string }>;
    const headCache = new Map<string, Head>(headRows.map(row => [row.path, { digest: row.digest, stamp: row.stamp, mode: row.mode, revision: row.revision }]));
    const undoingRevisions = new Set<string>(
      (this.db.prepare('SELECT revision FROM direct_review_entry WHERE project = ? AND undoing = 1').all(project.id) as Array<{ revision: string }>).map(row => row.revision),
    );
    const pendingWrites: Array<{ relative: string; old: Head | undefined; next: Snapshot; seed: boolean }> = [];
    const flushWrites = () => {
      if (!pendingWrites.length || project.closed) { pendingWrites.length = 0; return; }
      this.guard(project);
      this.db.transaction(() => {
        for (const item of pendingWrites) {
          this.commitObserved(project, item.relative, item.old, item.next, item.seed);
        }
      })();
      pendingWrites.length = 0;
    };
    const dirs = [''], seen = new Set<string>();
    let entries = 0;
    while (dirs.length && !project.closed) {
      const dir = dirs.pop()!;
      const folder = path.join(project.root, dir);
      if (path.relative(folder, await fs.promises.realpath(folder)) !== '') continue;
      for (const item of await fs.promises.readdir(folder, { withFileTypes: true })) {
        if (project.closed) break;
        if (excludedName(item.name)) continue;
        const relative = relativePath(dir ? `${dir}/${item.name}` : item.name);
        if (!relative || this.isAppData(project, relative)) continue;
        if (++entries > entryLimit) throw fail('This project exceeds the file history limit. Only captured versions can be undone.');
        if (entries % 100 === 0) {
          flushWrites();
          await new Promise<void>(resolve => setImmediate(resolve));
          if (project.closed) break;
        }
        if (item.isDirectory()) dirs.push(relative);
        else if (item.isFile()) {
          seen.add(relative);
          try {
            const old = headCache.get(relative);
            if (old && (!old.revision || !undoingRevisions.has(old.revision))) {
              const current = await fs.promises.lstat(path.join(project.root, relative), { bigint: true });
              if (stamp(current) === old.stamp) continue;
            }
            const next = await this.readFile(project, relative);
            if (project.closed) break;
            if (!old && next.digest === missing) continue;
            if (!old && project.tracked + pendingWrites.length >= entryLimit) {
              project.issue = 'The project history limit was reached. Only captured versions can be undone.';
              continue;
            }
            if (old?.digest === next.digest && old.stamp === next.stamp) continue;
            pendingWrites.push({ relative, old, next, seed });
            if (pendingWrites.length >= 128) flushWrites();
          } catch { project.issue = 'Some files could not be recorded. Only captured versions can be undone.'; }
        } else if (seed && !headCache.has(relative) && project.tracked + pendingWrites.length < entryLimit) {
          pendingWrites.push({ relative, old: undefined, next: { digest: 'unavailable', stamp: '', mode: 0 }, seed: true });
          if (pendingWrites.length >= 128) flushWrites();
        }
      }
    }
    flushWrites();
    if (project.closed) return;
    if (!seed) {
      for (const [relative, old] of headCache) {
        if (project.closed) break;
        if (old.digest !== missing && !seen.has(relative)) {
          try { await this.observe(project, relative, false); }
          catch { project.issue = 'Some files could not be recorded. Only captured versions can be undone.'; }
        }
      }
    }
    if (seed && !project.issue) {
      this.db.prepare('UPDATE direct_review_project SET seeded=1 WHERE id=?').run(project.id);
      project.seeded = true;
    }
    this.trim(project);
  }

  private commitObserved(project: Project, relative: string, old: Head | undefined, next: Snapshot, seed: boolean) {
    this.storeBlob(project, next);
    if (old?.revision) {
      const interrupted = this.entry(project, relative, old.revision);
      if (interrupted?.undoing) {
        this.db.prepare("UPDATE direct_review_entry SET undoing=0, state=CASE WHEN before_key=? THEN 'reverted' ELSE state END WHERE project=? AND revision=?")
          .run(next.digest, project.id, interrupted.revision);
        if (next.digest === interrupted.before_key) { this.writeHead(project, relative, next, this.undoHead(project, interrupted)); return; }
      }
    }
    if ((seed && !old) || old?.digest === next.digest) { this.writeHead(project, relative, next, old?.revision ?? null); return; }
    // Missing history after a partial baseline is unknown, not proof of a new file.
    const before = old?.digest ?? (project.seeded ? missing : 'unavailable');
    const revision = randomUUID();
    this.db.prepare('INSERT INTO direct_review_entry (project,revision,path,before_key,after_key,before_mode,previous) VALUES (?,?,?,?,?,?,?)')
      .run(project.id, revision, relative, before, next.digest, old?.mode ?? 0, old?.revision ?? null);
    this.writeHead(project, relative, next, revision);
  }

  private async observe(project: Project, relative: string, seed: boolean, skipUnchanged = false) {
    const old = this.head(project, relative);
    if (skipUnchanged && old && (!old.revision || !this.entry(project, relative, old.revision)?.undoing)) {
      const current = await fs.promises.lstat(path.join(project.root, relative), { bigint: true });
      if (stamp(current) === old.stamp) return;
    }
    const next = await this.readFile(project, relative);
    this.guard(project);
    if (!old && next.digest === missing) return;
    if (!old && project.tracked >= entryLimit) { project.issue = 'The project history limit was reached. Only captured versions can be undone.'; return; }
    if (old?.digest === next.digest && old.stamp === next.stamp) return;
    this.db.transaction(() => {
      this.commitObserved(project, relative, old, next, seed);
    })();
  }

  private trim(project: Project) {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM direct_review_entry WHERE project=? AND undoing=0 AND revision NOT IN
        (SELECT revision FROM direct_review_head WHERE project=? AND revision IS NOT NULL) AND rowid NOT IN
        (SELECT rowid FROM direct_review_entry WHERE project=? ORDER BY rowid DESC LIMIT 1000)`).run(project.id, project.id, project.id);
      this.db.prepare(`DELETE FROM direct_review_blob WHERE project=? AND digest NOT IN (SELECT digest FROM direct_review_head WHERE project=?)
        AND digest NOT IN (SELECT before_key FROM direct_review_entry WHERE project=?) AND digest NOT IN (SELECT after_key FROM direct_review_entry WHERE project=?)`)
        .run(project.id, project.id, project.id, project.id);
      project.bytes = (this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM direct_review_blob WHERE project=?').get(project.id) as {bytes: number}).bytes;
    })();
  }

  private async refreshGit(project: Project, force: boolean) {
    if (project.gitRead) return project.gitRead;
    if (!force && Date.now() - project.gitAt < 5000) return;
    project.gitRead = git('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '-uall', '--no-renames', '--ignore-submodules=all', '--', '.'],
      { cwd: project.root, windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }).then(({ stdout }) => {
      const files = new Map<string, string>();
      const gitRoot = project.gitRootPath ?? (project.gitRootPath = this.gitRoot(project.root));
      for (const item of stdout.split('\0')) {
        const relative = relativePath(path.relative(project.root, path.resolve(gitRoot, item.slice(3))).split(path.sep).join('/'));
        if (item.length < 4 || !relative || this.isAppData(project, relative)) continue;
        const status = item.slice(0, 2);
        files.set(relative, status.includes('D') ? 'deleted' : status === '??' || status.includes('A') ? 'added' : 'modified');
      }
      project.gitFiles = files;
    }).catch(() => { /* Non-Git projects use the observed history. */ }).finally(() => { project.gitAt = Date.now(); project.gitRead = undefined; });
    return project.gitRead;
  }
  private gitRoot(root: string) {
    for (let candidate = root; ; candidate = path.dirname(candidate)) {
      if (fs.existsSync(path.join(candidate, '.git')) || path.dirname(candidate) === candidate) return candidate;
    }
  }

  async list(id: string, refresh = false) {
    const project = await this.project(id);
    if (refresh) await this.enqueue(project, async () => {
      try { await this.reconcile(project, false); }
      catch { project.issue = 'Some files could not be refreshed. Only captured versions can be undone.'; }
    });
    await this.refreshGit(project, refresh);
    this.guard(project);
    const entries = this.db.prepare(`SELECT e.*,
      (e.before_key='-' OR b.digest IS NOT NULL) AND (e.after_key='-' OR a.digest IS NOT NULL) AS restorable
      FROM direct_review_head h JOIN direct_review_entry e ON e.project=h.project AND e.revision=h.revision
      LEFT JOIN direct_review_blob b ON b.project=e.project AND b.digest=e.before_key
      LEFT JOIN direct_review_blob a ON a.project=e.project AND a.digest=e.after_key WHERE h.project=? ORDER BY e.path`)
      .all(id) as Array<Entry & { restorable: number }>;
    const files: Array<{ path: string; revision: string; status: string; state: State | 'project'; restorable: boolean; issue?: string }> = entries.map(entry => ({ path: entry.path, revision: entry.revision, status: present(entry), state: entry.state,
      restorable: Boolean(entry.restorable) && entry.state !== 'reverted',
      ...(entry.restorable ? {} : { issue: 'This version has no complete undo record.' }) }));
    const observed = new Set(files.map(file => file.path));
    for (const [relative, status] of project.gitFiles) if (!observed.has(relative)) {
      files.push({ path: relative, status, revision: '', state: 'project', restorable: false, issue: 'This change was not recorded with an earlier version.' });
    }
    return { mode: 'project' as const, files, preparing: !project.settled, notice: project.issue };
  }

  private entry(project: Project, relative: string, revision: string) {
    return this.db.prepare('SELECT * FROM direct_review_entry WHERE project=? AND path=? AND revision=?').get(project.id, relative, revision) as Entry | undefined;
  }
  private undoHead(project: Project, entry: Entry) {
    const previous = entry.previous && this.entry(project, entry.path, entry.previous);
    return previous && previous.state !== 'reverted' && previous.after_key === entry.before_key ? previous.revision : entry.revision;
  }
  async preview(id: string, relative: string, revision: string) {
    const project = await this.project(id);
    if (!relativePath(relative) || this.isAppData(project, relative)) throw fail('Invalid review file.', 400);
    if (!revision) {
      if (!project.gitFiles.has(relative)) throw fail('Refresh the project changes before opening this file.');
      const difference = await git('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', `:(literal)${relative}`],
        { cwd: project.root, windowsHide: true, timeout: 5000, maxBuffer: previewLimit }).catch(() => undefined);
      this.guard(project);
      if (difference?.stdout) return { diff: difference.stdout };
      if (project.gitFiles.get(relative) !== 'added') return { unavailable: 'history' };
      const current = await this.readFile(project, relative);
      return this.textPreview(null, current.bytes);
    }
    const entry = this.entry(project, relative, revision);
    if (!entry) throw fail('This file revision is unavailable.');
    return this.textPreview(this.blob(project, entry.before_key), this.blob(project, entry.after_key));
  }
  private textPreview(before: Buffer | null | undefined, after: Buffer | null | undefined) {
    if (before === undefined || after === undefined) return { unavailable: 'history' };
    if (Math.max(before?.length ?? 0, after?.length ?? 0) > previewLimit) return { unavailable: 'large' };
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    try {
      if (before?.includes(0) || after?.includes(0)) return { unavailable: 'binary' };
      return { before: before === null ? null : decoder.decode(before), after: after === null ? null : decoder.decode(after) };
    } catch { return { unavailable: 'binary' }; }
  }

  async resolve(id: string, action: 'approve' | 'undo', selection: Selection) {
    if (!selection.length || selection.length > 200 || new Set(selection.map(file => file.path)).size !== selection.length) throw fail('Choose up to 200 different files.', 400);
    const project = await this.project(id);
    return this.enqueue(project, async () => {
      const completed: string[] = [], conflicts: Array<{path: string; reason: string}> = [];
      for (const { path: relative, revision } of selection) {
        try {
          this.guard(project);
          if (!relativePath(relative) || this.isAppData(project, relative)) throw fail('Invalid review file.');
          const entry = this.entry(project, relative, revision);
          if (!entry || entry.state === 'reverted' || this.head(project, relative)?.revision !== revision) throw fail('This revision is no longer current. Refresh and review the latest difference.');
          const disk = await this.readFile(project, relative);
          this.guard(project);
          if (disk.digest !== entry.after_key) throw fail('The file was edited after this revision. Your edits were kept.');
          if (action === 'approve') {
            if (disk.digest.startsWith('opaque:')) throw fail('This version could not be verified for approval.');
            this.db.prepare("UPDATE direct_review_entry SET state='approved', undoing=0 WHERE project=? AND revision=?").run(id, revision);
          } else {
            const before = this.blob(project, entry.before_key);
            if (before === undefined || this.blob(project, entry.after_key) === undefined) throw fail('There is no complete undo record for this version.');
            const value: FileBytes | null = before === null ? null : { bytes: before, mode: entry.before_mode };
            this.db.prepare('UPDATE direct_review_entry SET undoing=1 WHERE project=? AND revision=?').run(id, revision);
            replaceReviewedFile(project.root, relative, value, entry.after_key);
            this.db.transaction(() => {
              this.db.prepare("UPDATE direct_review_entry SET state='reverted',undoing=0 WHERE project=? AND revision=?").run(id, revision);
              this.writeHead(project, relative, { digest: entry.before_key, stamp: '', mode: entry.before_mode }, this.undoHead(project, entry));
            })();
          }
          completed.push(relative);
        } catch (error) { conflicts.push({ path: relative, reason: error instanceof Error ? error.message : 'Could not update this review.' }); }
      }
      project.gitAt = 0;
      return { completed, conflicts };
    });
  }
}
