import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { excludedName, filePath, parts } from './manual-change-review';

const git = promisify(execFile);
const maxFileBytes = 8 * 1024 * 1024;
const maxEntries = 20_000;
const previewBytes = 160 * 1024;
const modeOf = (mode: number) => process.platform === 'win32' ? 0 : mode & 0o111;
const rejected = (message: string, status = 409) => Object.assign(new Error(message), { status });
type Quality = 'pending' | 'verified' | 'failed';
type FileState = 'writing' | 'published' | 'reverting' | 'reverted';
export type LiveScope = {
  id: string;
  kind: 'manual' | 'builder';
  owner: string;
  workspaceId: string;
  target: string;
  source: string;
  baseline: string;
  gitBase?: string;
};
export function liveUndoSelection(value: unknown): Array<{ path: string; revision: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxEntries) throw rejected('Select files to undo.', 400);
  return value.map(item => {
    if (!item || typeof item.path !== 'string' || safeRelative(item.path) !== item.path
      || typeof item.revision !== 'string' || !/^[0-9a-f-]{36}$/.test(item.revision)) throw rejected('Invalid file revision.', 400);
    return { path: item.path, revision: item.revision };
  });
}
type StoredScope = { config: string; quality: Quality; active: number };
export type FileBytes = { bytes: Buffer; mode: number };
type Change = {
  path: string; revision: string; state: FileState; expected: string;
  before: Buffer | null; before_mode: number; after: Buffer | null; after_mode: number;
};
type Tracker = { scope: LiveScope; watcher?: fs.FSWatcher; timer?: NodeJS.Timeout; interval: NodeJS.Timeout;
  pending: Set<string>; full: boolean; running?: Promise<void>; stopped: boolean; fingerprints: Map<string, string>;
  issues: Map<string, string>; error?: string };

const value = (bytes: Buffer | null, mode: number): FileBytes | null => bytes === null ? null : { bytes, mode };
const hash = (file: FileBytes | null) => file === null ? '-' : createHash('sha256').update(`${modeOf(file.mode)}:`).update(file.bytes).digest('hex');
export { hash as reviewFileHash, replace as replaceReviewedFile };
function safeRelative(raw: string): string | undefined {
  const relative = raw.split(path.sep).join('/');
  try { parts(relative); return relative; } catch { return undefined; }
}
function file(root: string, relative: string): FileBytes | null {
  const name = filePath(root, relative);
  let fd: number;
  try { fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const a = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(name, { bigint: true });
    if (!a.isFile() || !current.isFile() || a.ino !== current.ino || a.dev !== current.dev) throw rejected('The file moved during the read.');
    if (a.size > BigInt(maxFileBytes)) throw rejected('File exceeds the live-history size limit.');
    const bytes = Buffer.alloc(Number(a.size) + 1);
    let offset = 0;
    for (let count; offset < bytes.length && (count = fs.readSync(fd, bytes, offset, bytes.length - offset, null));) offset += count;
    const b = fs.fstatSync(fd, { bigint: true });
    if (offset !== Number(a.size) || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs) throw rejected('The file is still being written.');
    return { bytes: bytes.subarray(0, offset), mode: Number(a.mode) & 0o777 };
  } finally { fs.closeSync(fd); }
}
function replace(root: string, relative: string, next: FileBytes | null, expected: string) {
  const verify = () => { if (hash(file(root, relative)) !== expected) throw rejected('The project file changed.'); };
  verify();
  const dest = filePath(root, relative, Boolean(next));
  if (!next) { if (expected !== '-') fs.unlinkSync(dest); return; }
  const tmp = path.join(path.dirname(dest), `.atris-live-${randomUUID()}`);
  const fd = fs.openSync(tmp, 'wx', next.mode);
  try {
    try {
      fs.writeFileSync(fd, next.bytes);
      if (process.platform !== 'win32') fs.fchmodSync(fd, next.mode);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    verify();
    if (expected === '-') fs.linkSync(tmp, dest);
    else fs.renameSync(tmp, dest);
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function runGit(cwd: string, args: string[]) {
  return (await git('git', args, { cwd, encoding: 'buffer', maxBuffer: maxFileBytes + 256 * 1024, timeout: 10_000, windowsHide: true })).stdout;
}
export async function liveGitBase(source: string): Promise<string> {
  const dir = (await runGit(source, ['rev-parse', '--absolute-git-dir'])).toString().trim();
  const revision = (await fs.promises.readFile(path.join(dir, 'atris-review-base'), 'utf8')).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw rejected('Builder baseline is unavailable.');
  return revision;
}
async function baseFile(scope: LiveScope, relative: string): Promise<FileBytes | null> {
  if (!scope.gitBase) return file(scope.baseline, relative);
  const record = (await runGit(scope.source, ['ls-tree', '-z', scope.gitBase, '--', `:(literal)${relative}`])).toString();
  if (!record) return null;
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t/.exec(record);
  if (!match) throw rejected('Only regular project files are supported.');
  const bytes = await runGit(scope.source, ['cat-file', 'blob', match[2]]);
  if (bytes.length > maxFileBytes) throw rejected('File exceeds the live-history size limit.');
  return { bytes, mode: parseInt(match[1], 8) & 0o777 };
}
function sameBaseline(project: FileBytes | null, baseline: FileBytes | null, gitBase?: string) {
  if (hash(project) === hash(baseline)) return true;
  return Boolean(gitBase && project && baseline && modeOf(project.mode) === modeOf(baseline.mode)
    && !project.bytes.includes(0) && !baseline.bytes.includes(0)
    && Buffer.from(project.bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1').equals(baseline.bytes));
}

async function inventory(root: string): Promise<Map<string, string>> {
  if (await fs.promises.realpath(root) !== root) throw rejected('The original directory is unavailable.');
  const directories = [''];
  const files = new Map<string, string>();
  let entries = 0;
  while (directories.length) {
    const folder = directories.pop()!;
    for (const dirent of await fs.promises.readdir(path.join(root, folder), { withFileTypes: true })) {
      if (++entries > maxEntries) throw rejected('Project exceeds the live change tracking limit.');
      if (excludedName(dirent.name)) continue;
      const relative = safeRelative(folder ? `${folder}/${dirent.name}` : dirent.name);
      if (!relative) continue;
      if (dirent.isDirectory()) { directories.push(relative); continue; }
      if (!dirent.isFile()) continue;
      const stat = await fs.promises.lstat(path.join(root, relative), { bigint: true }).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (stat?.isFile()) files.set(relative, `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    }
  }
  return files;
}

/** Publishes settled file saves independently of the panel and journals before touching the project. */
export class LiveProjectChanges {
  private trackers = new Map<string, Tracker>();
  constructor(private db: Database.Database, private checkOwnership: (scope: LiveScope) => boolean = () => true,
    private canPublish: (scope: LiveScope) => boolean = () => true) {
    db.exec(`CREATE TABLE IF NOT EXISTS live_project_scopes (
      id TEXT PRIMARY KEY, config TEXT NOT NULL, quality TEXT NOT NULL DEFAULT 'pending', active INTEGER NOT NULL DEFAULT 1
    ); CREATE TABLE IF NOT EXISTS live_project_files (
      scope_id TEXT NOT NULL REFERENCES live_project_scopes(id) ON DELETE CASCADE,
      path TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL, expected TEXT NOT NULL,
      before BLOB, before_mode INTEGER NOT NULL, after BLOB, after_mode INTEGER NOT NULL,
      PRIMARY KEY(scope_id, path)
    )`);
  }
  private allowed(scope: LiveScope) { try { return this.checkOwnership(scope); } catch { return false; } }
  private mayPublish(scope: LiveScope) { return this.allowed(scope) && this.canPublish(scope); }
  private record(id: string) { return this.db.prepare('SELECT * FROM live_project_scopes WHERE id = ?').get(id) as StoredScope | undefined; }
  get(id: string): LiveScope | undefined { const row = this.record(id); return row && JSON.parse(row.config); }
  private row(id: string, relative: string) {
    return this.db.prepare('SELECT * FROM live_project_files WHERE scope_id = ? AND path = ?').get(id, relative) as Change | undefined;
  }
  private paths(id: string) {
    return (this.db.prepare('SELECT path FROM live_project_files WHERE scope_id = ?').all(id) as { path: string }[]).map(item => item.path);
  }
  private state(id: string, relative: string, state: FileState) {
    this.db.prepare('UPDATE live_project_files SET state = ? WHERE scope_id = ? AND path = ?').run(state, id, relative);
  }
  register(scope: LiveScope) {
    if (!this.allowed(scope)) throw rejected('The project is unavailable.');
    const config = JSON.stringify(scope);
    const existing = this.record(scope.id);
    if (existing && existing.config !== config) throw rejected('Live change ownership has changed.');
    if (!existing) this.db.prepare('INSERT INTO live_project_scopes (id, config, active) VALUES (?, ?, 0)').run(scope.id, config);
  }
  start(scope: LiveScope) {
    this.register(scope);
    if (this.trackers.has(scope.id)) return;
    this.db.prepare("UPDATE live_project_scopes SET active = 1, quality = 'pending' WHERE id = ? AND active = 0").run(scope.id);
    const tracker: Tracker = { scope, pending: new Set(), full: true, stopped: false, fingerprints: new Map(), issues: new Map(),
      interval: setInterval(() => { tracker.full = true; this.schedule(tracker); }, 25_000).unref() };
    this.trackers.set(scope.id, tracker);
    try {
      tracker.watcher = fs.watch(scope.source, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) tracker.full = true;
        else {
          const relative = safeRelative(filename);
          if (!relative) return;
          tracker.pending.add(relative);
          if (tracker.pending.size > 1024) { tracker.pending.clear(); tracker.full = true; }
        }
        this.schedule(tracker);
      });
      tracker.watcher.on('error', () => { tracker.watcher?.close(); tracker.full = true; this.schedule(tracker); });
    } catch { /* Reconciliation still covers unavailable native notifications. */ }
    this.schedule(tracker);
  }
  resume() {
    const operations = this.db.prepare("SELECT scope_id, path, state FROM live_project_files WHERE state IN ('writing','reverting')").all() as Array<{ scope_id: string; path: string; state: FileState }>;
    for (const operation of operations) {
      const scope = this.get(operation.scope_id);
      if (!scope || !this.allowed(scope) || operation.state === 'writing' && !this.mayPublish(scope)) continue;
      const row = this.row(scope.id, operation.path);
      try { if (row) this.recover(scope, row); } catch { /* The recorded operation and snapshots remain available for reconciliation. */ }
    }
    for (const row of this.db.prepare('SELECT config FROM live_project_scopes WHERE active = 1').all() as StoredScope[]) {
      const scope = JSON.parse(row.config) as LiveScope;
      if (this.mayPublish(scope)) this.start(scope);
    }
  }
  stop(id: string) {
    const tracker = this.trackers.get(id);
    if (tracker) {
      tracker.stopped = true; tracker.watcher?.close(); clearTimeout(tracker.timer); clearInterval(tracker.interval);
      this.trackers.delete(id);
    }
    this.db.prepare('UPDATE live_project_scopes SET active = 0 WHERE id = ?').run(id);
  }
  async close() {
    const ongoing = [...this.trackers.values()];
    for (const tracker of ongoing) {
      tracker.stopped = true; tracker.watcher?.close(); clearTimeout(tracker.timer); clearInterval(tracker.interval);
    }
    this.trackers.clear();
    await Promise.allSettled(ongoing.map(item => item.running));
  }
  quality(id: string, next: Quality) { this.db.prepare('UPDATE live_project_scopes SET quality = ? WHERE id = ?').run(next, id); }
  private schedule(tracker: Tracker) {
    if (tracker.stopped || tracker.timer) return;
    tracker.timer = setTimeout(() => { tracker.timer = undefined; void this.drain(tracker); }, 220).unref();
  }
  private drain(tracker: Tracker): Promise<void> {
    if (tracker.running) return tracker.running;
    tracker.running = this.process(tracker).catch(error => { tracker.error = error instanceof Error ? error.message : 'Tracking unavailable.'; })
      .finally(() => { tracker.running = undefined; if (tracker.pending.size || tracker.full) this.schedule(tracker); });
    return tracker.running;
  }
  private async process(tracker: Tracker) {
    const { scope } = tracker;
    const queued = tracker.pending;
    tracker.pending = new Set();
    const full = tracker.full;
    tracker.full = false;
    if (tracker.stopped) return;
    if (!this.mayPublish(scope)) { this.stop(scope.id); return; }
    if (full || scope.gitBase) {
      if (scope.gitBase) {
        queued.clear(); // Git decides which untracked paths are excluded, even on a watch notification.
        const [changed, untracked] = await Promise.all([
          runGit(scope.source, ['diff', '--name-only', '--no-renames', '-z', scope.gitBase, '--']),
          runGit(scope.source, ['ls-files', '--others', '--exclude-standard', '-z']),
        ]);
        for (const name of `${changed.toString()}\0${untracked.toString()}`.split('\0')) {
          const relative = safeRelative(name); if (relative) queued.add(relative);
        }
      } else {
        const current = await inventory(scope.source);
        if (!tracker.fingerprints.size) for (const relative of (await inventory(scope.baseline)).keys()) queued.add(relative);
        for (const [relative, revision] of current) if (revision !== tracker.fingerprints.get(relative)) queued.add(relative);
        for (const relative of tracker.fingerprints.keys()) if (!current.has(relative)) queued.add(relative);
        tracker.fingerprints = current;
      }
      for (const relative of this.paths(scope.id)) queued.add(relative);
      for (const relative of tracker.issues.keys()) queued.add(relative);
    }
    tracker.error = undefined;
    for (const relative of queued) {
      if (tracker.stopped || !this.mayPublish(scope)) return;
      try {
        const info = await fs.promises.lstat(path.join(scope.source, relative)).catch(error => {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        });
        if (info?.isDirectory()) { if (!full) tracker.full = true; continue; }
        if (!info && !full && [...tracker.fingerprints.keys()].some(name => name.startsWith(`${relative}/`))) tracker.full = true;
        await this.publish(tracker, relative);
        tracker.issues.delete(relative);
      } catch (error) { tracker.issues.set(relative, error instanceof Error ? error.message : 'Could not publish this file.'); }
    }
  }
  private recover(scope: LiveScope, row: Change) {
    if (row.state !== 'writing' && row.state !== 'reverting') return;
    const next = row.state === 'writing' ? value(row.after, row.after_mode) : value(row.before, row.before_mode);
    if (hash(file(scope.target, row.path)) !== hash(next)) replace(scope.target, row.path, next, row.expected);
    this.state(scope.id, row.path, row.state === 'writing' ? 'published' : 'reverted');
  }
  private async publish(tracker: Tracker, relative: string) {
    const { scope } = tracker;
    let row = this.row(scope.id, relative);
    if (row) { this.recover(scope, row); row = this.row(scope.id, relative); }
    if (row?.state === 'reverted') return; // An explicit undo holds this path for this scope.
    const baseline = row ? value(row.after, row.after_mode) : await baseFile(scope, relative);
    if (tracker.stopped || !this.mayPublish(scope)) return;
    const source = file(scope.source, relative);
    if (row ? hash(source) === hash(baseline) : sameBaseline(source, baseline, scope.gitBase)) return;
    const target = file(scope.target, relative);
    const matches = row ? hash(target) === hash(baseline) : sameBaseline(target, baseline, scope.gitBase);
    if (!matches) throw rejected('The project has a different version. Your edits were kept.');
    const before = row ? value(row.before, row.before_mode) : target;
    const after = source && { ...source, mode: target ? (target.mode & ~0o111) | modeOf(source.mode) : source.mode };
    const expected = hash(target);
    this.db.prepare(`INSERT INTO live_project_files VALUES (?, ?, ?, 'writing', ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id, path) DO UPDATE SET revision=excluded.revision, state='writing', expected=excluded.expected,
        after=excluded.after, after_mode=excluded.after_mode`)
      .run(scope.id, relative, randomUUID(), expected, before?.bytes ?? null, before?.mode ?? 0, after?.bytes ?? null, after?.mode ?? 0);
    replace(scope.target, relative, after, expected);
    this.state(scope.id, relative, 'published');
  }

  async finalize(id: string) {
    const tracker = this.trackers.get(id);
    if (!tracker) return;
    if (!this.mayPublish(tracker.scope)) throw rejected('This Builder can no longer publish to the project.');
    await tracker.running;
    tracker.full = true;
    await this.drain(tracker);
    if (tracker.error || tracker.issues.size) throw rejected('Some project changes could not be published. Review the Changes panel.');
    for (const relative of this.paths(id)) {
      const item = this.row(id, relative);
      if (item?.state === 'published' && hash(file(tracker.scope.target, relative)) !== hash(value(item.after, item.after_mode))) {
        tracker.issues.set(relative, 'The project changed after publication. Your edits were kept.');
        throw rejected('Some project files changed after publication. Review the Changes panel.');
      }
    }
    this.stop(id);
  }

  async pauseManualWhenEmpty(id: string, stillEmpty: () => boolean) {
    const tracker = this.trackers.get(id);
    if (!tracker || tracker.scope.kind !== 'manual' || !stillEmpty()) return;
    await tracker.running;
    if (this.trackers.get(id) !== tracker || !stillEmpty()) return;
    tracker.full = true;
    for (let pass = 0; pass < 3; pass++) {
      await this.drain(tracker);
      // A conflict still needs to be visible in Changes. A concurrent add must
      // not lose the watcher created/retained for that agent.
      if (this.trackers.get(id) !== tracker || !stillEmpty() || tracker.error || tracker.issues.size) return;
      if (!tracker.full && !tracker.pending.size) { this.stop(id); return; }
    }
  }
  list(id: string) {
    const row = this.record(id);
    if (!row) return undefined;
    const tracker = this.trackers.get(id);
    const rows = this.db.prepare(`SELECT path, revision, state, before IS NULL AS added, after IS NULL AS deleted
      FROM live_project_files WHERE scope_id = ? ORDER BY path`).all(id) as Array<{ path: string; revision: string; state: FileState; added: number; deleted: number }>;
    const files = rows.map(item => ({ path: item.path, revision: item.revision,
      status: item.added ? 'added' : item.deleted ? 'deleted' : 'modified',
      state: tracker?.issues.has(item.path) ? 'conflict' : item.state, issue: tracker?.issues.get(item.path) }));
    const seen = new Set(files.map(item => item.path));
    for (const [relative, issue] of tracker?.issues || []) {
      if (!seen.has(relative)) files.push({ path: relative, revision: '', status: 'modified', state: 'conflict', issue });
    }
    return { mode: 'live' as const, quality: row.quality, files, error: tracker?.error };
  }
  preview(id: string, relative: string, revision: string) {
    const row = this.row(id, relative);
    if (!row || row.revision !== revision) throw rejected('This file changed. Refresh the file list.');
    if (Math.max(row.before?.length ?? 0, row.after?.length ?? 0) > previewBytes) return { unavailable: 'large' };
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    try {
      if (row.before?.includes(0) || row.after?.includes(0)) return { unavailable: 'binary' };
      return { before: row.before === null ? null : decoder.decode(row.before), after: row.after === null ? null : decoder.decode(row.after) };
    } catch { return { unavailable: 'binary' }; }
  }
  undo(id: string, selection: Array<{ path: string; revision: string }>) {
    const scope = this.get(id);
    if (!scope || !this.allowed(scope)) throw rejected('The project is unavailable.');
    if (!selection.length || selection.length > maxEntries || new Set(selection.map(item => item.path)).size !== selection.length) throw rejected('Select different files to undo.', 400);
    const completed: string[] = [], conflicts: Array<{ path: string; reason: string }> = [];
    for (const item of selection) {
      try {
        const row = this.row(id, item.path);
        if (!row || row.revision !== item.revision || (row.state !== 'published' && row.state !== 'reverting')) throw rejected('This revision is no longer available for undo.');
        if (row.state === 'reverting') { this.recover(scope, row); completed.push(row.path); continue; }
        const expected = hash(value(row.after, row.after_mode));
        if (hash(file(scope.target, row.path)) !== expected) throw rejected('The file was edited after publication. Your edits were kept.');
        this.db.prepare("UPDATE live_project_files SET state='reverting', expected=? WHERE scope_id=? AND path=?").run(expected, id, row.path);
        this.recover(scope, { ...row, expected, state: 'reverting' });
        completed.push(row.path);
      } catch (error) { conflicts.push({ path: item.path, reason: error instanceof Error ? error.message : 'Undo failed.' }); }
    }
    return { completed, conflicts };
  }
}
