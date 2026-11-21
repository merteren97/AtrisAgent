import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const maxFiles = 20_000;
const maxBytes = 256 * 1024 * 1024;
const previewBytes = 160 * 1024;
const excluded = new Set(['.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'target', 'out', 'vendor', 'coverage', '__pycache__', '.next', '.venv', '.cache', '.turbo', '.npmrc']);
const conflict = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function excludedName(name: string): boolean {
  const normalized = name.toLowerCase();
  return excluded.has(normalized) || normalized === '.cargo-target' || normalized.startsWith('.cargo-target-') || normalized.startsWith('.atris-') || (normalized.startsWith('.env') && normalized !== '.env.example')
    || /\.(?:pem|key|pfx|p12|sqlite3?|db|credentials|secrets?)$/i.test(name);
}

export function parts(relative: string): string[] {
  const items = relative.split('/');
  if (relative.length > 2048 || items.some(name => !name || name === '.' || name === '..' || /[\\:\x00-\x1f]/.test(name) || excludedName(name)
    || process.platform === 'win32' && (/[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)))) {
    return conflict('This path is outside the review scope.', 400);
  }
  return items;
}

function stat(filename: string): fs.Stats | undefined {
  try { return fs.lstatSync(filename); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}

/** Resolve every component without traversing links or special files. */
export function filePath(root: string, relative: string, createParents = false): string {
  if (!stat(root)?.isDirectory() || fs.realpathSync(root) !== root) return conflict('The original review directory has moved or is unavailable.');
  const names = parts(relative);
  let current = root;
  for (const name of names.slice(0, -1)) {
    current = path.join(current, name);
    const info = stat(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) return conflict(`A parent path has changed: ${relative}`);
    if (!info && createParents) fs.mkdirSync(current);
  }
  const filename = path.join(current, names.at(-1)!);
  const info = stat(filename);
  if (info && !info.isFile()) return conflict(`Cannot replace a link, directory or special file: ${relative}`);
  return filename;
}

type Version = { hash: string; size: number; mode: number; permissions: number };
function version(filename: string, info = stat(filename)): Version | undefined {
  if (!info) return undefined;
  if (!info.isFile()) return conflict('A path became a link, directory or special file. Refresh and try again.');
  if (info.size > maxBytes) return conflict('A file exceeds the conversation review size limit.', 413);
  const mode = process.platform === 'win32' ? 0 : info.mode & 0o111;
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = fs.fstatSync(fd);
    if (!actual.isFile() || actual.size !== info.size || actual.ino !== info.ino || actual.dev !== info.dev) return conflict('A file changed during the scan. Refresh and try again.');
    const hash = createHash('sha256').update(String(mode));
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, info.size)));
    let total = 0;
    for (let count; (count = fs.readSync(fd, chunk)) > 0;) {
      total += count;
      if (total > info.size) return conflict('A file changed during the scan. Refresh and try again.');
      hash.update(chunk.subarray(0, count));
    }
    if (total !== info.size || fs.fstatSync(fd).mtimeMs !== info.mtimeMs) return conflict('A file changed during the scan. Refresh and try again.');
    return { hash: hash.digest('hex'), size: total, mode, permissions: actual.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}

function scan(root: string, skip?: string): { files: Map<string, Version>; omitted: number } {
  if (!stat(root)?.isDirectory() || fs.realpathSync(root) !== root) return conflict('The review directory is unavailable.');
  const files = new Map<string, Version>();
  const queue = [''];
  let omitted = 0, bytes = 0, entries = 0;
  while (queue.length) {
    const prefix = queue.pop()!;
    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
      if (++entries > maxFiles) return conflict(`This project exceeds the ${maxFiles.toLocaleString()} entry review limit.`, 413);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(root, relative);
      if (excludedName(entry.name) || filename === skip || !entry.isFile() && !entry.isDirectory()) { omitted++; continue; }
      parts(relative);
      if (entry.isDirectory()) { queue.push(relative); continue; }
      const info = stat(filename);
      if (!info?.isFile()) return conflict('A file changed during the scan. Refresh and try again.');
      bytes += info.size;
      if (bytes > maxBytes) return conflict('The working files exceed the 256 MB review limit.', 413);
      // Equal-length writes can share timestamps. Always hash the bytes so the
      // revision offered by the list agrees with preview and approval.
      files.set(relative, version(filename, info)!);
    }
  }
  return { files, omitted };
}

async function versionAsync(filename: string, budget: number): Promise<Version> {
  const fd = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = await fd.stat({ bigint: true });
    const named = await fs.promises.lstat(filename, { bigint: true });
    if (!info.isFile() || !named.isFile() || named.ino !== info.ino || named.dev !== info.dev) return conflict('A file changed during the scan. Refresh and try again.');
    const size = Number(info.size);
    if (size > budget) return conflict('The working files exceed the 256 MB review limit.', 413);
    const permissions = Number(info.mode) & 0o777;
    const mode = process.platform === 'win32' ? 0 : permissions & 0o111;
    const hash = createHash('sha256').update(String(mode));
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
    let total = 0;
    for (;;) {
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > size) return conflict('A file changed during the scan. Refresh and try again.');
      hash.update(chunk.subarray(0, bytesRead));
    }
    const latest = await fd.stat({ bigint: true });
    if (total !== size || latest.mtimeNs !== info.mtimeNs || latest.ctimeNs !== info.ctimeNs) return conflict('A file changed during the scan. Refresh and try again.');
    return { hash: hash.digest('hex'), size, mode, permissions };
  } finally { await fd.close(); }
}

/** Inventory without monopolizing the gateway's event loop. */
async function scanForList(root: string, skip?: string): Promise<{ files: Map<string, Version>; omitted: number }> {
  if (await fs.promises.realpath(root) !== root) return conflict('The review directory is unavailable.');
  const files = new Map<string, Version>();
  const pending = [''];
  let omitted = 0, bytes = 0, entries = 0;
  while (pending.length) {
    const prefix = pending.pop()!;
    const folder = path.join(root, prefix);
    if (await fs.promises.realpath(folder) !== folder) {
      if (skip) return conflict('A project directory changed during workspace preparation. Try again.');
      continue;
    }
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (++entries > maxFiles) return conflict('This project exceeds the entry review limit.', 413);
      if (excludedName(entry.name) || path.join(folder, entry.name) === skip || (!entry.isFile() && !entry.isDirectory())) { omitted++; continue; }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      parts(relative);
      if (entry.isDirectory()) { pending.push(relative); continue; }
      const entryVersion = await versionAsync(path.join(folder, entry.name), maxBytes - bytes);
      bytes += entryVersion.size;
      files.set(relative, entryVersion);
    }
  }
  return { files, omitted };
}

function replace(root: string, relative: string, from: string | undefined, expected: Version | undefined, source?: Version): void {
  const destination = filePath(root, relative, Boolean(from));
  const verifyDestination = () => {
    if (version(filePath(root, relative))?.hash !== expected?.hash) return conflict(`Changed since review: ${relative}`);
  };
  if (!from) {
    verifyDestination();
    if (expected) fs.unlinkSync(destination);
    return;
  }
  const temp = path.join(path.dirname(destination), `.atris-review-${randomUUID()}`);
  try {
    fs.copyFileSync(from, temp, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32' && source) fs.chmodSync(temp, ((expected || source).permissions & ~0o111) | source.mode);
    if (version(temp)?.hash !== source?.hash) return conflict(`Changed since review: ${relative}`);
    verifyDestination();
    // An added path must not replace a file created after the comparison.
    if (expected) fs.renameSync(temp, destination);
    else fs.linkSync(temp, destination);
  } finally { fs.rmSync(temp, { force: true }); }
}

export class ManualChangeReview {
  constructor(private dataDir: string) {}

  private pendingLists = new Map<string, Promise<ReturnType<ManualChangeReview['list']>>>();
  private recentLists = new Map<string, { expires: number; data: ReturnType<ManualChangeReview['list']> }>();

  private directory(id: string): string {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) return conflict('Invalid conversation identity.', 400);
    const dir = path.join(fs.realpathSync(this.dataDir), 'manual-change-workspaces');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(dir) !== dir) return conflict('The review storage directory has moved.');
    return path.join(dir, id);
  }

  async initialize(id: string, project: string, validate: () => void = () => {}, commit: () => void = () => {}): Promise<void> {
    const root = this.directory(id);
    if (stat(root)) { this.scope(id, project); validate(); commit(); return; }
    const source = fs.realpathSync(project);
    const storage = path.dirname(root);
    if (source === fs.realpathSync(this.dataDir) || source === storage || source.startsWith(`${storage}${path.sep}`)) return conflict('Choose a project outside AtrisAgent review storage.', 400);
    const sourceFiles = await scanForList(source, fs.realpathSync(this.dataDir));
    const temp = await fs.promises.mkdtemp(path.join(storage, '.creating-'));
    let published = false;
    try {
      const baseline = path.join(temp, 'baseline');
      const work = path.join(temp, 'work');
      await fs.promises.mkdir(baseline); await fs.promises.mkdir(work);
      for (const [relative, entry] of sourceFiles.files) {
        // The two destinations are private until publication. Keep the source path
        // checks and verify both copies against the inventory, including mode.
        const before = path.join(baseline, relative), after = path.join(work, relative);
        await fs.promises.mkdir(path.dirname(before), { recursive: true });
        await fs.promises.mkdir(path.dirname(after), { recursive: true });
        const copy = async (from: string, to: string) => {
          await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
          if (process.platform !== 'win32') await fs.promises.chmod(to, entry.permissions);
          if ((await versionAsync(to, maxBytes)).hash !== entry.hash) conflict(`Changed during workspace preparation: ${relative}`);
        };
        await copy(filePath(source, relative), before);
        await copy(before, after);
      }
      await fs.promises.writeFile(path.join(temp, 'owner.json'), JSON.stringify({ source, omitted: sourceFiles.omitted }), { flag: 'wx' });
      validate();
      fs.renameSync(temp, root);
      published = true;
      commit();
    } catch (error) {
      // Roll back only the directory this job published, inside the app-owned
      // storage root. The caller-provided conversation ID never selects an
      // arbitrary recursive removal target.
      if (published) {
        const candidate = path.resolve(storage, id);
        if (!candidate.startsWith(`${storage}${path.sep}`) || path.dirname(candidate) !== storage || candidate !== root) throw error;
        await fs.promises.rm(candidate, { recursive: true, force: true });
      } else await fs.promises.rm(temp, { recursive: true, force: true });
      throw error;
    }
  }

  scope(id: string, project: string) {
    const root = this.directory(id);
    if (!stat(root)?.isDirectory() || fs.realpathSync(root) !== root) return conflict('The conversation copy is unavailable.');
    const owner = JSON.parse(fs.readFileSync(filePath(root, 'owner.json'), 'utf8')) as { source: string; omitted: number };
    if (fs.realpathSync(project) !== owner.source) return conflict('The registered project no longer matches this conversation.');
    return { root, project: owner.source, omitted: owner.omitted, work: path.join(root, 'work'), baseline: path.join(root, 'baseline') };
  }

  private changes(scope: ReturnType<ManualChangeReview['scope']>) {
    const base = scan(scope.baseline).files;
    const current = scan(scope.work);
    return this.compare(base, current);
  }

  private compare(base: Map<string, Version>, current: { files: Map<string, Version>; omitted: number }) {
    const files = [...new Set([...base.keys(), ...current.files.keys()])].sort().flatMap(relative => {
      const before = base.get(relative), after = current.files.get(relative);
      if (before?.hash === after?.hash) return [];
      return [{ path: relative, status: !before ? 'added' : !after ? 'deleted' : 'modified', before, after,
        revision: digest(JSON.stringify([relative, before?.hash, after?.hash])) }];
    });
    return { files, omitted: current.omitted };
  }

  list(id: string, project: string) {
    const scope = this.scope(id, project);
    const result = this.changes(scope);
    return { mode: 'isolated' as const, omitted: Math.max(scope.omitted, result.omitted),
      files: result.files.map(({ before: _before, after: _after, ...file }) => file) };
  }

  async listAsync(id: string, project: string, summary = false) {
    const scope = this.scope(id, project);
    const recent = this.recentLists.get(id);
    if (summary && recent && recent.expires > Date.now()) return recent.data;
    const existing = this.pendingLists.get(id);
    if (existing) return existing;
    const request = Promise.all([scanForList(scope.baseline), scanForList(scope.work)]).then(([baseline, current]) => {
      const result = this.compare(baseline.files, current);
      const data = { mode: 'isolated' as const, omitted: Math.max(scope.omitted, result.omitted),
        files: result.files.map(({ before: _before, after: _after, ...file }) => file) };
      this.recentLists.delete(id);
      this.recentLists.set(id, { expires: Date.now() + 10_000, data });
      if (this.recentLists.size > 16) this.recentLists.delete(this.recentLists.keys().next().value!);
      return data;
    }).finally(() => this.pendingLists.delete(id));
    this.pendingLists.set(id, request);
    return request;
  }

  preview(id: string, project: string, relative: string, revision: string) {
    const scope = this.scope(id, project);
    const left = filePath(scope.baseline, relative), right = filePath(scope.work, relative);
    const before = version(left), after = version(right);
    if (before?.hash === after?.hash || digest(JSON.stringify([relative, before?.hash, after?.hash])) !== revision) return conflict('This file changed. Refresh the file list.');
    if (Math.max(before?.size || 0, after?.size || 0) > previewBytes) return { unavailable: 'large' };
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const read = (filename: string, expected: Version | undefined) => {
      if (!expected) return null;
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        if (!fs.fstatSync(fd).isFile()) return conflict('The file is no longer available for preview.');
        const bytes = Buffer.alloc(expected.size + 1);
        let offset = 0;
        while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; }
        const value = bytes.subarray(0, offset);
        if (createHash('sha256').update(String(expected.mode)).update(value).digest('hex') !== expected.hash) return conflict('This file changed. Refresh the file list.');
        return value;
      } finally { fs.closeSync(fd); }
    };
    const a = read(left, before), b = read(right, after);
    try {
      if (a?.includes(0) || b?.includes(0)) return { unavailable: 'binary' };
      return { before: a ? decoder.decode(a) : null, after: b ? decoder.decode(b) : null };
    } catch { return { unavailable: 'binary' }; }
  }

  resolve(id: string, project: string, action: 'apply' | 'discard', selection: Array<{ path: string; revision: string }>) {
    const scope = this.scope(id, project);
    this.recentLists.delete(id);
    if (!selection.length || new Set(selection.map(item => item.path)).size !== selection.length) return conflict('Choose a valid, non-empty set of files.', 400);
    // Every selected revision must still match. Never silently include a newly changed file.
    const review = new Map(this.changes(scope).files.map(file => [file.path, file]));
    const planned = selection.map(item => {
      const file = review.get(item.path);
      if (!file || file.revision !== item.revision) return conflict(`Changed since review: ${item.path}`);
      filePath(scope.baseline, file.path);
      filePath(scope.work, file.path);
      const target = action === 'apply' ? version(filePath(scope.project, file.path)) : file.after;
      if (action === 'apply' && target?.hash !== file.before?.hash && target?.hash !== file.after?.hash) {
        return conflict(`The project already has different changes: ${file.path}`);
      }
      return { file, target };
    });
    const completed: string[] = [];
    try {
      for (const { file, target } of planned) {
        const oldPath = filePath(scope.baseline, file.path), newPath = filePath(scope.work, file.path);
        if (version(oldPath)?.hash !== file.before?.hash || version(newPath)?.hash !== file.after?.hash) return conflict(`Changed since review: ${file.path}`);
        if (action === 'discard') replace(scope.work, file.path, file.before ? oldPath : undefined, file.after, file.before);
        else {
          // Write identical reviewed bytes to the project and the baseline, even
          // if a running agent edits the working file again during approval.
          const staging = file.after ? fs.mkdtempSync(path.join(scope.root, '.approval-')) : undefined;
          try {
            const approved = staging ? path.join(staging, 'file') : undefined;
            if (staging) replace(staging, 'file', newPath, undefined, file.after);
            if (target?.hash !== file.after?.hash) replace(scope.project, file.path, approved, target, file.after);
            replace(scope.baseline, file.path, approved, file.before, file.after);
          } finally { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
        }
        completed.push(file.path);
      }
    } catch (error) {
      return { completed, error: error instanceof Error ? error.message : 'Could not finish updating the selected files.' };
    }
    return { completed };
  }
}
