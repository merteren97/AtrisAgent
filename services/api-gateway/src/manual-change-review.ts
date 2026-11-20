import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const maxFiles = 20_000;
const maxBytes = 256 * 1024 * 1024;
const previewBytes = 160 * 1024;
const excluded = new Set(['.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'target', 'out', 'vendor', 'coverage', '__pycache__', '.next', '.venv', '.cache', '.turbo', '.npmrc']);
const conflict = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function excludedName(name: string): boolean {
  const normalized = name.toLowerCase();
  return excluded.has(normalized) || normalized.startsWith('.atris-') || (normalized.startsWith('.env') && normalized !== '.env.example')
    || /\.(?:pem|key|pfx|p12|sqlite3?|db|credentials|secrets?)$/i.test(name);
}

function parts(relative: string): string[] {
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
function filePath(root: string, relative: string, createParents = false): string {
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

type ScanCache = Map<string, { stamp: string; version: Version }>;
function scan(root: string, skip?: string, previous?: ScanCache): { files: Map<string, Version>; omitted: number; cache: ScanCache } {
  if (!stat(root)?.isDirectory() || fs.realpathSync(root) !== root) return conflict('The review directory is unavailable.');
  const files = new Map<string, Version>();
  const cache: ScanCache = new Map();
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
      const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mode}:${info.mtimeMs}:${info.ctimeMs}`;
      const cached = previous?.get(relative);
      const value = cached?.stamp === stamp ? cached : { stamp, version: version(filename, info)! };
      files.set(relative, value.version);
      if (previous) cache.set(relative, value);
    }
  }
  return { files, omitted, cache };
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
  // The visible conversation polls for additions. Keep at most one directory
  // pair cached and rehash all requested file contents before any mutation.
  private lastScan?: { root: string; baseline: ScanCache; work: ScanCache };
  constructor(private dataDir: string) {}

  private directory(id: string): string {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) return conflict('Invalid conversation identity.', 400);
    const dir = path.join(fs.realpathSync(this.dataDir), 'manual-change-workspaces');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(dir) !== dir) return conflict('The review storage directory has moved.');
    return path.join(dir, id);
  }

  initialize(id: string, project: string): void {
    const root = this.directory(id);
    if (stat(root)) { this.scope(id, project); return; }
    const source = fs.realpathSync(project);
    const storage = path.dirname(root);
    if (source === fs.realpathSync(this.dataDir) || source === storage || source.startsWith(`${storage}${path.sep}`)) return conflict('Choose a project outside AtrisAgent review storage.', 400);
    const sourceFiles = scan(source, fs.realpathSync(this.dataDir));
    const temp = fs.mkdtempSync(path.join(storage, '.creating-'));
    try {
      const baseline = path.join(temp, 'baseline');
      const work = path.join(temp, 'work');
      fs.mkdirSync(baseline); fs.mkdirSync(work);
      for (const [relative, entry] of sourceFiles.files) {
        replace(baseline, relative, filePath(source, relative), undefined, entry);
        replace(work, relative, filePath(baseline, relative), undefined, entry);
      }
      fs.writeFileSync(path.join(temp, 'owner.json'), JSON.stringify({ source, omitted: sourceFiles.omitted }), { flag: 'wx' });
      fs.renameSync(temp, root);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }

  scope(id: string, project: string) {
    const root = this.directory(id);
    if (!stat(root)?.isDirectory() || fs.realpathSync(root) !== root) return conflict('The conversation copy is unavailable.');
    const owner = JSON.parse(fs.readFileSync(filePath(root, 'owner.json'), 'utf8')) as { source: string; omitted: number };
    if (fs.realpathSync(project) !== owner.source) return conflict('The registered project no longer matches this conversation.');
    return { root, project: owner.source, omitted: owner.omitted, work: path.join(root, 'work'), baseline: path.join(root, 'baseline') };
  }

  private changes(scope: ReturnType<ManualChangeReview['scope']>, allowCache = false) {
    const previous = this.lastScan?.root === scope.root ? this.lastScan : undefined;
    const baseline = scan(scope.baseline, undefined, allowCache ? previous?.baseline || new Map() : undefined);
    const current = scan(scope.work, undefined, allowCache ? previous?.work || new Map() : undefined);
    if (allowCache) this.lastScan = { root: scope.root, baseline: baseline.cache, work: current.cache };
    const base = baseline.files;
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
    const result = this.changes(scope, true);
    return { mode: 'isolated' as const, omitted: Math.max(scope.omitted, result.omitted),
      files: result.files.map(({ before: _before, after: _after, ...file }) => file) };
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
