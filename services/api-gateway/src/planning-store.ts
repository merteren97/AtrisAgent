import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateConversations, type PlanningConversation } from './planning-conversations';

export const MAX_PLANNING_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MAX_PLANNING_ASSET_BYTES = 512 * 1024 * 1024;
export const MAX_PLANNING_CHAT_REQUEST_BYTES = 1024 * 1024;
const CHAT_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Shared by store instances in this gateway; a cancelled turn may still be spawning.
const activeChatRequests = new Set<string>();
const MAX_FILES = 2000;
const MAX_CHAT_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
export interface PlanningDocument {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'ready';
  pinned: boolean;
  archivedAt: string | null;
}
export interface PlanningMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
  turnId?: string;
  catalogId?: string;
  /** Versioned planning-controller journal data; never native provider credentials. */
  planningChat?: Record<string, unknown>;
}
export interface PlanningFile { path: string; byteSize: number; mimeType: string; }
export interface PlanningExecution {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  planId: string;
  target: 'manual' | 'orchestrator';
  createdAt: string;
  status: 'prepared' | 'linked';
  targetId?: string;
  files: Array<PlanningFile & { sha256: string }>;
}
export class PlanningError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'INVALID_PLANNING_REQUEST') { super(message); }
}
function fail(message: string, status = 400, code?: string): never { throw new PlanningError(message, status, code); }
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const now = () => new Date().toISOString();
function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) fail('Invalid identifier.');
  return value;
}
function safeName(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 180 || /[\\/:<>"|?*\x00-\x1f\x7f]/.test(value)
    || value.startsWith('.') || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail('Expected a safe filename.');
  return value;
}
export function validatePlanningPath(value: string, documentsOnly = false): string {
  if (typeof value !== 'string' || value.length > 512 || value.includes('\\')) fail('Invalid planning file path.');
  const parts = value.split('/');
  parts.forEach(safeName);
  if (value !== 'plan.md' && !(parts.length >= 2 && (parts[0] === 'research' || (!documentsOnly && parts[0] === 'assets')))) fail('Only plan.md, research and assets files are accessible.');
  if (parts.length > 8 || (documentsOnly && !/\.md$/i.test(value))) fail('Expected a Markdown document path.');
  return value;
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

/** Walk every component; never follow descendant symlinks/junctions or hard-linked files. */
function contained(root: string, relative: string, makeParents = false): string {
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) fail('Unsafe planning root.', 409, 'UNSAFE_PLANNING_PATH');
  const parts = relative.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === '.' || part === '..' || /[\\/:\x00-\x1f]/.test(part)) fail('Unsafe planning path.');
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (!missing(error)) throw error;
      if (i === parts.length - 1) return current;
      if (!makeParents) fail('Planning file not found.', 404, 'PLANNING_FILE_NOT_FOUND');
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || fs.realpathSync(current) !== current || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
      || (i < parts.length - 1 && !stat.isDirectory())) fail('Unsafe planning path.', 409, 'UNSAFE_PLANNING_PATH');
  }
  return current;
}
function directory(root: string, relative: string): string {
  const result = contained(root, relative, true);
  if (!fs.existsSync(result)) fs.mkdirSync(result, { mode: 0o700 });
  if (!fs.lstatSync(result).isDirectory()) fail('Expected planning directory.', 409);
  return result;
}
function readBytes(root: string, relative: string, max: number): Buffer {
  const filename = contained(root, relative);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filename); } catch (error) { if (missing(error)) fail('Planning file not found.', 404, 'PLANNING_FILE_NOT_FOUND'); throw error; }
  if (!stat.isFile()) fail('Expected a planning file.', 409);
  if (stat.size > max) fail('Planning file exceeds the size limit.', 413);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) fail('Unsafe planning file.', 409);
    if (opened.size > max) fail('Planning file exceeds the size limit.', 413);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, max + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > max) fail('Planning file exceeds the size limit.', 413);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } finally { fs.closeSync(fd); }
}
function text(data: Buffer): string {
  if (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) fail('Document must be UTF-8 without NUL bytes.');
  return data.toString('utf8');
}
function atomic(root: string, relative: string, data: string | Buffer): void {
  const filename = contained(root, relative, true);
  if (fs.existsSync(filename) && !fs.lstatSync(filename).isFile()) fail('Expected a planning file.', 409);
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    contained(root, relative);
    fs.renameSync(temporary, filename);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function json<T>(root: string, relative: string, max = 1024 * 1024): T {
  try { return JSON.parse(text(readBytes(root, relative, max))) as T; }
  catch (error) { if (error instanceof SyntaxError) fail('Planning JSON is invalid; existing files were preserved.', 409, 'INVALID_PLANNING_DATA'); throw error; }
}
function writeJson(root: string, relative: string, value: unknown): void { atomic(root, relative, `${JSON.stringify(value, null, 2)}\n`); }
function fileDigest(filename: string, maximum: number): { byteSize: number; sha256: string } {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) fail('Unsafe or oversized snapshot file.', 409, 'EXECUTION_CHANGED');
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let byteSize = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      byteSize += count;
      if (byteSize > maximum) fail('Snapshot changed during read.', 409, 'EXECUTION_CHANGED');
      digest.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    if (stat.size !== byteSize || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail('Snapshot changed during read.', 409, 'EXECUTION_CHANGED');
    return { byteSize, sha256: digest.digest('hex') };
  } finally { fs.closeSync(fd); }
}
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
};
export function planningMime(filename: string): string { return MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream'; }
function validateMime(sample: Buffer, mime: string): void {
  const ascii = (start: number, end: number) => sample.subarray(start, end).toString('ascii');
  const checks: Record<string, boolean> = {
    'image/png': sample.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': sample[0] === 255 && sample[1] === 216 && sample[2] === 255,
    'image/gif': /^GIF8[79]a$/.test(ascii(0, 6)),
    'image/webp': ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP',
    'application/pdf': ascii(0, 5) === '%PDF-',
    'video/mp4': ascii(4, 8) === 'ftyp', 'video/quicktime': ['ftyp', 'moov', 'mdat', 'wide'].includes(ascii(4, 8)),
    'video/webm': sample.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])),
    'audio/mpeg': ascii(0, 3) === 'ID3' || (sample[0] === 255 && (sample[1] & 224) === 224),
    'audio/wav': ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE', 'audio/ogg': ascii(0, 4) === 'OggS',
  };
  if (mime in checks && !checks[mime]) fail('File bytes do not match the declared MIME type.');
}

export class PlanningStore {
  readonly maxAssetBytes: number;
  constructor(private readonly resolveWorkspace: (id: string) => { id: string; path: string } | undefined, options: { maxAssetBytes?: number } = {}) {
    this.maxAssetBytes = Math.min(options.maxAssetBytes ?? MAX_PLANNING_ASSET_BYTES, MAX_PLANNING_ASSET_BYTES);
    if (!Number.isSafeInteger(this.maxAssetBytes) || this.maxAssetBytes < 1) fail('Invalid asset size limit.');
  }
  workspace(workspaceId: string): { id: string; path: string } {
    if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 200) fail('workspaceId is required.');
    const workspace = this.resolveWorkspace(workspaceId);
    if (!workspace || workspace.id !== workspaceId) fail('Workspace not found.', 404, 'WORKSPACE_NOT_FOUND');
    return { id: workspaceId, path: fs.realpathSync(workspace.path) };
  }
  private root(workspaceId: string, create = false): string | undefined {
    const canonical = this.workspace(workspaceId).path;
    const root = contained(canonical, '.atris-plans');
    if (!fs.existsSync(root)) { if (!create) return undefined; fs.mkdirSync(root, { mode: 0o700 }); }
    if (!fs.lstatSync(root).isDirectory()) fail('Unsafe planning root.', 409);
    return root;
  }
  private records(workspaceId: string): Array<{ root: string; metadata: PlanningDocument }> {
    const root = this.root(workspaceId);
    if (!root) return [];
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length > 5000) fail('Planning library exceeds the entry limit.', 413);
    const records: Array<{ root: string; metadata: PlanningDocument }> = [];
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      safeName(entry.name);
      const planRoot = contained(root, entry.name);
      if (!fs.lstatSync(planRoot).isDirectory()) continue;
      const metadata = json<PlanningDocument>(planRoot, 'plan.json');
      if (!metadata || typeof metadata !== 'object' || typeof metadata.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(metadata.id)
        || metadata.schemaVersion !== 1 || typeof metadata.title !== 'string' || !metadata.title.trim() || metadata.title.length > 200 || !['draft', 'ready'].includes(metadata.status)
        || typeof metadata.pinned !== 'boolean' || typeof metadata.createdAt !== 'string' || typeof metadata.updatedAt !== 'string'
        || (metadata.archivedAt !== null && typeof metadata.archivedAt !== 'string') || ids.has(metadata.id)) fail('Invalid or duplicate planning metadata.', 409, 'INVALID_PLANNING_DATA');
      ids.add(metadata.id);
      // Portable folders belong to the workspace in which they are currently opened.
      records.push({ root: planRoot, metadata: { ...metadata, workspaceId } });
    }
    return records;
  }
  private plan(workspaceId: string, planId: string): { root: string; metadata: PlanningDocument } {
    identifier(planId);
    const result = this.records(workspaceId).find((record) => record.metadata.id === planId);
    if (!result) fail('Plan not found in this workspace.', 404, 'PLANNING_NOT_FOUND');
    return result;
  }
  list(workspaceId: string): PlanningDocument[] {
    return this.records(workspaceId).map((entry) => entry.metadata).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }
  create(workspaceId: string, input: { id: string; title: string; content?: string }): PlanningDocument {
    const id = identifier(input.id);
    const title = this.title(input.title);
    if (input.content !== undefined) {
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > MAX_PLANNING_DOCUMENT_BYTES) fail('Imported Markdown exceeds 4 MiB or is not text.', 413);
      text(Buffer.from(input.content));
    }
    if (this.list(workspaceId).some((plan) => plan.id === id)) fail('Plan already exists.', 409, 'PLANNING_EXISTS');
    const root = this.root(workspaceId, true)!;
    const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'plan';
    const name = `${slug}--${id}`;
    const destination = contained(root, name);
    if (fs.existsSync(destination)) fail('Plan directory already exists.', 409);
    const staging = directory(root, `.create-${randomUUID()}`);
    const metadata: PlanningDocument = { schemaVersion: 1, id, workspaceId, title, createdAt: now(), updatedAt: now(), status: 'draft', pinned: false, archivedAt: null };
    for (const dir of ['research', 'assets', 'chat', '.history', 'runs']) directory(staging, dir);
    atomic(staging, 'plan.md', input.content ?? `# ${title}\n\n## Purpose\n\n## Scope\n\n## Current state\n\n## Requirements\n\n## Decisions\n\n## Open questions\n\n## Implementation phases\n\n## Validation and completion criteria\n`);
    atomic(staging, 'chat/messages.jsonl', '');
    writeJson(staging, 'chat/conversations.json', { schemaVersion: 1, conversations: [] });
    writeJson(staging, 'plan.json', metadata);
    fs.renameSync(staging, destination);
    return metadata;
  }
  private title(value: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail('A title of 1–200 characters is required.');
    return value.trim();
  }
  get(workspaceId: string, planId: string): PlanningDocument { return this.plan(workspaceId, planId).metadata; }
  update(workspaceId: string, planId: string, input: { title?: string; status?: 'draft' | 'ready'; pinned?: boolean; archivedAt?: string | null }): PlanningDocument {
    const { root, metadata } = this.plan(workspaceId, planId);
    if (input.title !== undefined) metadata.title = this.title(input.title);
    if (input.status !== undefined) { if (!['draft', 'ready'].includes(input.status)) fail('Invalid plan status.'); metadata.status = input.status; }
    if (input.pinned !== undefined) { if (typeof input.pinned !== 'boolean') fail('pinned must be boolean.'); metadata.pinned = input.pinned; }
    if (input.archivedAt !== undefined) {
      if (input.archivedAt !== null && (typeof input.archivedAt !== 'string' || !Number.isFinite(Date.parse(input.archivedAt)))) fail('archivedAt must be an ISO date or null.');
      metadata.archivedAt = input.archivedAt;
    }
    metadata.updatedAt = now();
    writeJson(root, 'plan.json', metadata);
    return metadata;
  }
  readDocument(workspaceId: string, planId: string, relative: string): { path: string; content: string; revision: string } {
    validatePlanningPath(relative, true);
    const { root } = this.plan(workspaceId, planId);
    const data = readBytes(root, relative, MAX_PLANNING_DOCUMENT_BYTES);
    return { path: relative, content: text(data), revision: hash(data) };
  }
  writeDocument(workspaceId: string, planId: string, input: { path: string; content: string; expectedRevision: string | null }): { path: string; content: string; revision: string } {
    const relative = validatePlanningPath(input.path, true);
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > MAX_PLANNING_DOCUMENT_BYTES) fail('Document exceeds 4 MiB or is not text.', 413);
    text(Buffer.from(input.content));
    if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision))) fail('expectedRevision is required (null for a new document).');
    const { root } = this.plan(workspaceId, planId);
    const filename = contained(root, relative, true);
    const previous = fs.existsSync(filename) ? readBytes(root, relative, MAX_PLANNING_DOCUMENT_BYTES) : null;
    if ((previous === null ? null : hash(previous)) !== input.expectedRevision) fail('Document changed on disk. Reload and merge the draft.', 409, 'REVISION_CONFLICT');
    if (previous !== null && previous.equals(Buffer.from(input.content))) return { path: relative, content: input.content, revision: hash(previous) };
    if (previous !== null) {
      const history = directory(root, '.history');
      const prefix = `${hash(relative).slice(0, 16)}-`;
      atomic(history, `${prefix}${Date.now()}-${randomUUID()}.md`, previous);
      const entries = fs.readdirSync(history).filter((name) => name.startsWith(prefix) && name.endsWith('.md')).sort();
      for (const name of entries.slice(0, Math.max(0, entries.length - 20))) fs.unlinkSync(contained(history, name));
    }
    // Recheck after recovery is durable; external editors are not filesystem transactions.
    const current = fs.existsSync(filename) ? readBytes(root, relative, MAX_PLANNING_DOCUMENT_BYTES) : null;
    if ((current === null ? null : hash(current)) !== input.expectedRevision) fail('Document changed on disk.', 409, 'REVISION_CONFLICT');
    atomic(root, relative, input.content);
    this.update(workspaceId, planId, {});
    return { path: relative, content: input.content, revision: hash(input.content) };
  }
  listFiles(workspaceId: string, planId: string): PlanningFile[] {
    const { root } = this.plan(workspaceId, planId);
    const files: PlanningFile[] = [];
    let visited = 0;
    const walk = (relative: string, depth: number) => {
      if (++visited > MAX_FILES || depth > 8) fail('Plan file listing exceeds the limit.', 413);
      const filename = contained(root, relative);
      if (!fs.existsSync(filename)) return;
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) {
        const names = fs.readdirSync(filename);
        if (names.length > MAX_FILES) fail('Plan file listing exceeds the limit.', 413);
        for (const name of names) { if (name.startsWith('.')) continue; safeName(name); walk(`${relative}/${name}`, depth + 1); }
      } else { validatePlanningPath(relative); files.push({ path: relative, byteSize: stat.size, mimeType: planningMime(relative) }); }
    };
    for (const relative of ['plan.md', 'research', 'assets']) walk(relative, 0);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  async importAsset(workspaceId: string, planId: string, input: { filename: string; mimeType: string; stream: Readable }): Promise<PlanningFile> {
    safeName(input.filename);
    const mime = planningMime(input.filename);
    if (mime === 'application/octet-stream' || mime !== input.mimeType) fail('Unsupported MIME type or filename extension.');
    const { root } = this.plan(workspaceId, planId);
    const assets = directory(root, 'assets');
    const temporaryName = `.upload-${randomUUID()}`;
    const temporary = contained(assets, temporaryName);
    let byteSize = 0;
    let sample = Buffer.alloc(0);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    const output = fs.createWriteStream(temporary, { fd, autoClose: true, flush: true });
    try {
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        byteSize += chunk.length;
        if (byteSize > this.maxAssetBytes) return callback(new PlanningError('Asset exceeds the upload size limit.', 413));
        if (sample.length < 64) sample = Buffer.concat([sample, chunk.subarray(0, 64 - sample.length)]);
        callback(null, chunk);
      } });
      // Keep an HTTP request out of pipeline's destroy-on-error set so a limit
      // failure can still return a structured 413 response to the client.
      const onError = (error: Error) => meter.destroy(error);
      const onClose = () => { if (!input.stream.readableEnded) meter.destroy(new PlanningError('Upload interrupted.')); };
      input.stream.on('error', onError).on('close', onClose);
      input.stream.pipe(meter);
      try { await pipeline(meter, output); }
      finally {
        input.stream.unpipe(meter);
        input.stream.removeListener('error', onError).removeListener('close', onClose);
        if (!input.stream.readableEnded) input.stream.resume();
      }
      validateMime(sample, mime);
      if (mime.startsWith('text/') || mime === 'application/json') {
        const content = text(readBytes(assets, temporaryName, MAX_PLANNING_DOCUMENT_BYTES));
        if (mime === 'application/json') { try { JSON.parse(content); } catch { fail('Invalid JSON asset.'); } }
      }
      // The stream yielded: revalidate the entire workspace/plan ancestry before publishing.
      if (this.plan(workspaceId, planId).root !== root) fail('Plan moved during upload.', 409);
      contained(root, `assets/${temporaryName}`);
      const extension = path.extname(input.filename);
      const stem = input.filename.slice(0, input.filename.length - extension.length).slice(0, 100);
      let name = input.filename;
      if (fs.existsSync(contained(assets, name))) name = `${stem}-${randomUUID()}${extension}`;
      const destination = contained(assets, name);
      // Exclusive hard link publishes without overwriting another in-flight upload.
      try { fs.linkSync(temporary, destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('Asset filename conflict. Retry upload.', 409); throw error; }
      fs.unlinkSync(temporary);
      this.update(workspaceId, planId, {});
      return { path: `assets/${name}`, byteSize, mimeType: mime };
    } finally {
      // Never unlink through a root replaced while the stream was in flight.
      try { const filename = contained(root, `assets/${temporaryName}`); if (fs.existsSync(filename)) fs.unlinkSync(filename); } catch { /* Preserve unsafe paths for explicit recovery. */ }
    }
  }
  resolveFile(workspaceId: string, planId: string, relative: string): PlanningFile & { absolutePath: string } {
    validatePlanningPath(relative);
    const { root } = this.plan(workspaceId, planId);
    const absolutePath = contained(root, relative);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(absolutePath); } catch (error) { if (missing(error)) fail('Planning file not found.', 404); throw error; }
    if (!stat.isFile()) fail('Expected a planning file.', 404);
    const mimeType = planningMime(relative);
    const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { const sample = Buffer.alloc(64); const size = fs.readSync(fd, sample, 0, 64, 0); validateMime(sample.subarray(0, size), mimeType); }
    finally { fs.closeSync(fd); }
    return { path: relative, byteSize: stat.size, mimeType, absolutePath };
  }
  readMessages(workspaceId: string, planId: string): PlanningMessage[] {
    const { root } = this.plan(workspaceId, planId);
    const filename = contained(root, 'chat/messages.jsonl');
    if (!fs.existsSync(filename)) return [];
    const source = text(readBytes(root, 'chat/messages.jsonl', MAX_CHAT_BYTES));
    try {
      const result = source.split('\n').filter(Boolean).map((line) => JSON.parse(line) as PlanningMessage);
      const ids = new Set<string>();
      for (const message of result) { this.validateMessage(message); if (ids.has(message.id)) fail('Duplicate chat message ID.', 409); ids.add(message.id); }
      return result;
    } catch (error) { if (error instanceof SyntaxError) fail('Chat log is invalid; existing history was preserved.', 409, 'INVALID_PLANNING_DATA'); throw error; }
  }
  readConversations(workspaceId: string, planId: string): PlanningConversation[] {
    const { root } = this.plan(workspaceId, planId);
    if (!fs.existsSync(contained(root, 'chat/conversations.json'))) return [];
    const registry = json<{ schemaVersion: number; conversations: unknown }>(root, 'chat/conversations.json');
    if (registry?.schemaVersion !== 1) fail('Invalid conversation registry version.', 409);
    return validateConversations(registry.conversations, workspaceId, planId);
  }
  writeConversations(workspaceId: string, planId: string, conversations: PlanningConversation[]): void {
    validateConversations(conversations, workspaceId, planId);
    const serialized = JSON.stringify({ schemaVersion: 1, conversations });
    if (Buffer.byteLength(serialized) > 1024 * 1024) fail('Conversation registry exceeds 1 MiB.', 413);
    const { root } = this.plan(workspaceId, planId);
    atomic(root, 'chat/conversations.json', `${serialized}\n`);
  }
  /** Publish the entire bounded task atomically and exclusively, outside public file APIs. */
  prepareChatPrompt(workspaceId: string, planId: string, turnId: string, prompt: string): string {
    if (typeof turnId !== 'string' || !CHAT_REQUEST_ID.test(turnId)) fail('Expected a unique chat turn UUID.');
    if (typeof prompt !== 'string' || !prompt.length || Buffer.byteLength(prompt) > MAX_PLANNING_CHAT_REQUEST_BYTES) fail('Chat request exceeds 1 MiB or is not text.', 413);
    if (text(Buffer.from(prompt)) !== prompt) fail('Chat request must be valid UTF-8 text.');
    const { root } = this.plan(workspaceId, planId);
    directory(root, 'chat/requests');
    const relative = `chat/requests/${turnId.toLowerCase()}.md`;
    const filename = contained(root, relative);
    if (fs.existsSync(filename)) fail('Chat turn request already exists.', 409, 'CHAT_REQUEST_EXISTS');
    const temporaryRelative = `chat/requests/.request-${randomUUID()}`;
    const temporary = contained(root, temporaryRelative);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try { fs.writeFileSync(fd, prompt); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (this.plan(workspaceId, planId).root !== root) fail('Plan moved during request preparation.', 409);
      contained(root, temporaryRelative);
      contained(root, relative);
      // A rename can overwrite; an exclusive hard link publishes complete bytes only.
      try { fs.linkSync(temporary, filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('Chat turn request already exists.', 409, 'CHAT_REQUEST_EXISTS'); throw error; }
      fs.unlinkSync(temporary);
      activeChatRequests.add(filename);
      this.pruneChatRequests(root);
      return fs.realpathSync(filename);
    } finally {
      const remaining = contained(root, temporaryRelative);
      if (fs.existsSync(remaining)) fs.unlinkSync(remaining);
    }
  }
  /** Retain the latest 20 inputs for recovery, plus any older inputs still in use. */
  releaseChatPrompt(workspaceId: string, planId: string, turnId: string): void {
    if (typeof turnId !== 'string' || !CHAT_REQUEST_ID.test(turnId)) fail('Expected a unique chat turn UUID.');
    const { root } = this.plan(workspaceId, planId);
    activeChatRequests.delete(contained(root, `chat/requests/${turnId.toLowerCase()}.md`));
    this.pruneChatRequests(root);
  }
  private pruneChatRequests(root: string): void {
    const requests = contained(root, 'chat/requests');
    const entries: Array<{ filename: string; modified: number }> = [];
    for (const name of fs.readdirSync(requests)) {
      if (!name.endsWith('.md') || !CHAT_REQUEST_ID.test(name.slice(0, -3))) continue;
      // External edits/unsafe entries must never turn retention into an outside unlink.
      try {
        const filename = contained(root, `chat/requests/${name}`);
        const stat = fs.lstatSync(filename);
        if (stat.isFile()) entries.push({ filename, modified: stat.mtimeMs });
      } catch { /* Preserve unsafe or concurrently removed entries. */ }
    }
    entries.sort((a, b) => b.modified - a.modified || a.filename.localeCompare(b.filename));
    for (const entry of entries.slice(20)) {
      if (activeChatRequests.has(entry.filename)) continue;
      try { fs.unlinkSync(contained(root, `chat/requests/${path.basename(entry.filename)}`)); }
      catch { /* Recovery retention must not invalidate an already-published input. */ }
    }
  }
  private validateMessage(message: PlanningMessage): void {
    if (!message || typeof message !== 'object') fail('Invalid planning message.');
    identifier(message.id);
    if (!['user', 'assistant', 'system'].includes(message.role) || typeof message.text !== 'string' || Buffer.byteLength(message.text) > MAX_PLANNING_DOCUMENT_BYTES
      || typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt))) fail('Invalid planning message.');
    for (const field of ['turnId', 'catalogId'] as const) if (message[field] !== undefined && (typeof message[field] !== 'string' || message[field]!.length > 200)) fail('Invalid message reference.');
    if (message.planningChat !== undefined && (!message.planningChat || typeof message.planningChat !== 'object' || Array.isArray(message.planningChat))) fail('Invalid planning chat journal data.');
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_PLANNING_DOCUMENT_BYTES) fail('Planning message exceeds 4 MiB.', 413);
  }
  appendMessage(workspaceId: string, planId: string, message: PlanningMessage): PlanningMessage {
    this.validateMessage(message);
    const normalized: PlanningMessage = { id: message.id, role: message.role, text: message.text, createdAt: message.createdAt,
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }), ...(message.catalogId === undefined ? {} : { catalogId: message.catalogId }),
      ...(message.planningChat === undefined ? {} : { planningChat: JSON.parse(JSON.stringify(message.planningChat)) as Record<string, unknown> }) };
    const messages = this.readMessages(workspaceId, planId);
    const existing = messages.find((entry) => entry.id === message.id);
    if (existing) {
      if ((Object.keys(normalized) as Array<keyof PlanningMessage>).some((key) => key === 'planningChat' ? JSON.stringify(existing[key]) !== JSON.stringify(normalized[key]) : existing[key] !== normalized[key])
        || existing.turnId !== normalized.turnId || existing.catalogId !== normalized.catalogId
        || JSON.stringify(existing.planningChat) !== JSON.stringify(normalized.planningChat)) fail('Message ID already has different content.', 409, 'MESSAGE_CONFLICT');
      return existing;
    }
    const { root } = this.plan(workspaceId, planId);
    const source = `${messages.map((entry) => JSON.stringify(entry)).join('\n')}${messages.length ? '\n' : ''}${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(source) > MAX_CHAT_BYTES) fail('Chat log exceeds 16 MiB.', 413);
    atomic(root, 'chat/messages.jsonl', source);
    return normalized;
  }
  readChatState<T = Record<string, unknown>>(workspaceId: string, planId: string): T | null {
    const { root } = this.plan(workspaceId, planId);
    return fs.existsSync(contained(root, 'chat/state.json')) ? json<T>(root, 'chat/state.json') : null;
  }
  writeChatState<T>(workspaceId: string, planId: string, state: T): T {
    const serialized = JSON.stringify(state);
    if (serialized === undefined || Buffer.byteLength(serialized) > 1024 * 1024) fail('Chat state exceeds 1 MiB or is not JSON.', 413);
    const { root } = this.plan(workspaceId, planId);
    atomic(root, 'chat/state.json', `${serialized}\n`);
    return state;
  }
  createExecution(workspaceId: string, planId: string, input: { id: string; target: 'manual' | 'orchestrator'; paths?: string[] }): PlanningExecution & { snapshotPath: string } {
    identifier(input.id);
    if (!['manual', 'orchestrator'].includes(input.target)) fail('Invalid execution target.');
    if (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.length > MAX_FILES)) fail('Invalid snapshot file selection.');
    const selected = [...new Set(['plan.md', ...(input.paths ?? [])])].map((relative) => validatePlanningPath(relative)).sort();
    if (selected.length > MAX_FILES) fail('Snapshot selection exceeds the file limit.', 413);
    const { root } = this.plan(workspaceId, planId);
    const runs = directory(root, 'runs');
    const destination = contained(runs, input.id);
    if (fs.existsSync(destination)) {
      const existing = this.getExecution(workspaceId, planId, input.id);
      if (existing.target !== input.target || JSON.stringify(existing.files.map((file) => file.path).sort()) !== JSON.stringify(selected)) fail('Execution ID already has a different request.', 409, 'EXECUTION_CONFLICT');
      return existing;
    }
    const staging = directory(runs, `.prepare-${input.id}-${randomUUID()}`);
    const files: PlanningExecution['files'] = [];
    let total = 0;
    for (const relative of selected) {
      const source = this.resolveFile(workspaceId, planId, relative);
      total += source.byteSize;
      if (total > MAX_SNAPSHOT_BYTES) fail('Execution snapshot exceeds 1 GiB.', 413);
      const output = contained(staging, relative, true);
      const sourceFd = fs.openSync(source.absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const before = fs.fstatSync(sourceFd);
      const outputFd = fs.openSync(output, 'wx', 0o400);
      const digest = createHash('sha256');
      let copied = 0;
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) {
          const count = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
          if (!count) break;
          copied += count;
          if (copied > source.byteSize) fail('Source changed during snapshot.', 409, 'REVISION_CONFLICT');
          digest.update(buffer.subarray(0, count));
          let written = 0;
          while (written < count) written += fs.writeSync(outputFd, buffer, written, count - written);
        }
        fs.fsyncSync(outputFd);
        const after = fs.fstatSync(sourceFd);
        if (copied !== source.byteSize || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('Source changed during snapshot.', 409, 'REVISION_CONFLICT');
      } finally { fs.closeSync(sourceFd); fs.closeSync(outputFd); }
      files.push({ path: relative, mimeType: source.mimeType, byteSize: copied, sha256: digest.digest('hex') });
    }
    const receipt: PlanningExecution = { schemaVersion: 1, id: input.id, workspaceId, planId, target: input.target, createdAt: now(), status: 'prepared', files };
    writeJson(staging, 'request.json', receipt); // Manifest last; incomplete staging directories are never executions.
    contained(root, `runs/${input.id}`);
    fs.renameSync(staging, destination);
    return { ...receipt, snapshotPath: destination };
  }
  getExecution(workspaceId: string, planId: string, executionId: string): PlanningExecution & { snapshotPath: string } {
    identifier(executionId);
    const { root } = this.plan(workspaceId, planId);
    const snapshotPath = contained(root, `runs/${executionId}`);
    if (!fs.existsSync(snapshotPath)) fail('Execution not found.', 404, 'EXECUTION_NOT_FOUND');
    const receipt = json<PlanningExecution>(snapshotPath, 'request.json');
    if (receipt.schemaVersion !== 1 || receipt.id !== executionId || receipt.planId !== planId || !['manual', 'orchestrator'].includes(receipt.target)
      || !['prepared', 'linked'].includes(receipt.status) || !Array.isArray(receipt.files) || receipt.files.length > MAX_FILES
      || !receipt.files.some((file) => file.path === 'plan.md') || new Set(receipt.files.map((file) => file.path)).size !== receipt.files.length) fail('Invalid execution receipt.', 409);
    let total = 0;
    for (const file of receipt.files) {
      validatePlanningPath(file.path);
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0) fail('Invalid execution manifest.', 409);
      total += file.byteSize;
      if (total > MAX_SNAPSHOT_BYTES) fail('Execution manifest exceeds the size limit.', 413);
      const filename = contained(snapshotPath, file.path);
      if (!fs.existsSync(filename)) fail('Execution snapshot file is missing.', 409, 'EXECUTION_CHANGED');
      const actual = fileDigest(filename, file.byteSize);
      if (actual.byteSize !== file.byteSize || actual.sha256 !== file.sha256) fail('Execution snapshot changed.', 409, 'EXECUTION_CHANGED');
    }
    return { ...receipt, workspaceId, snapshotPath };
  }
  recordExecutionTarget(workspaceId: string, planId: string, executionId: string, targetId: string): PlanningExecution & { snapshotPath: string } {
    identifier(targetId);
    const { snapshotPath, ...receipt } = this.getExecution(workspaceId, planId, executionId);
    if (receipt.targetId && receipt.targetId !== targetId) fail('Execution is already linked to another target.', 409, 'EXECUTION_CONFLICT');
    receipt.targetId = targetId;
    receipt.status = 'linked';
    writeJson(snapshotPath, 'request.json', receipt);
    return { ...receipt, snapshotPath };
  }
}
