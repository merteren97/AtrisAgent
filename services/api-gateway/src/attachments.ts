import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import type { AttachmentRef, ProviderAttachment } from '@atris-agent-code/domain';
import { normalizeOrchestratorRequestOptions } from '@atris-agent-code/domain';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv',
  'application/json': 'json', 'application/octet-stream': 'bin',
};
function fail(message: string, statusCode = 400, code = 'INVALID_ATTACHMENT'): never {
  throw Object.assign(new Error(message), { statusCode, code });
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function validateMime(data: Buffer, mimeType: string): void {
  const signatures: Record<string, boolean> = {
    'image/png': data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': data[0] === 255 && data[1] === 216 && data[2] === 255,
    'image/gif': /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii')),
    'image/webp': data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP',
    'application/pdf': data.subarray(0, 5).toString('ascii') === '%PDF-',
  };
  if (mimeType in signatures && !signatures[mimeType]) fail('File bytes do not match the declared MIME type.');
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    if (data.includes(0) || !Buffer.from(data.toString('utf8'), 'utf8').equals(data)) fail('Text attachments must be valid UTF-8 without NUL bytes.');
    if (mimeType === 'application/json') {
      try { JSON.parse(data.toString('utf8')); } catch { fail('Invalid JSON attachment.'); }
    }
  }
}

/** App-owned files outside user workspaces; IDs and MIME determine paths, never names. */
export class AttachmentStore {
  readonly root: string;
  constructor(private readonly sqlite: Database.Database, dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dataRoot = fs.realpathSync(dataDir);
    const root = path.join(dataRoot, 'attachments');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) fail('Attachment root must be a canonical app-owned directory.', 503);
    this.root = root;
    sqlite.exec(`CREATE TABLE IF NOT EXISTS gateway_attachments (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  }

  private workspace(workspaceId: unknown): string {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) fail('workspaceId is required.');
    if (!this.sqlite.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)) fail('Workspace not found.', 404, 'WORKSPACE_NOT_FOUND');
    return workspaceId;
  }

  private file(ref: AttachmentRef): string {
    if (!/^[a-f0-9-]{36}$/.test(ref.id) || !Object.hasOwn(MIME_EXTENSIONS, ref.mimeType)) fail('Invalid stored attachment.', 503);
    if (fs.lstatSync(this.root).isSymbolicLink() || fs.realpathSync(this.root) !== this.root) fail('Unsafe attachment root.', 503);
    return path.join(this.root, `${ref.id}.${MIME_EXTENSIONS[ref.mimeType]}`);
  }

  upload(input: { workspaceId: unknown; name: unknown; mimeType: unknown; dataBase64: unknown }): AttachmentRef {
    const workspaceId = this.workspace(input.workspaceId);
    const { name, mimeType, dataBase64 } = input;
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\\/:\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') fail('name must be a safe filename, not a path.');
    if (typeof mimeType !== 'string' || !Object.hasOwn(MIME_EXTENSIONS, mimeType)) fail('Unsupported MIME type.');
    if (typeof dataBase64 !== 'string' || dataBase64.length > 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3)) fail('Attachment exceeds 10 MiB.', 413);
    if (!dataBase64 || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) fail('dataBase64 must be canonical base64.');
    const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
    if (dataBase64.length / 4 * 3 - padding > MAX_ATTACHMENT_BYTES) fail('Attachment exceeds 10 MiB.', 413);
    const data = Buffer.from(dataBase64, 'base64');
    if (data.length > MAX_ATTACHMENT_BYTES) fail('Attachment exceeds 10 MiB.', 413);
    if (data.toString('base64') !== dataBase64) fail('dataBase64 must be canonical base64.');
    validateMime(data, mimeType);
    const ref: AttachmentRef = { id: randomUUID(), workspaceId, name, mimeType, byteSize: data.length, sha256: digest(data), createdAt: new Date().toISOString() };
    const filename = this.file(ref);
    const fd = fs.openSync(filename, 'wx', 0o600);
    try {
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.sqlite.prepare('INSERT INTO gateway_attachments VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ref.id, workspaceId, name, mimeType, ref.byteSize, ref.sha256, ref.createdAt);
    } catch (error) { fs.unlinkSync(filename); throw error; }
    return ref;
  }

  /** Retryable physical cleanup: keep every ownership record until all unlinks succeed. */
  cleanupWorkspace(workspaceId: string): void {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) fail('workspaceId is required.');
    const refs = this.sqlite.prepare(`SELECT id, workspace_id AS workspaceId, name, mime_type AS mimeType,
      byte_size AS byteSize, sha256, created_at AS createdAt FROM gateway_attachments WHERE workspace_id = ? ORDER BY id`)
      .all(workspaceId) as AttachmentRef[];
    for (const ref of refs) {
      const filename = this.file(ref); // Revalidate the canonical root on every unlink; never traverse directories.
      try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(filename) !== filename) {
          fail('Attachment file is unsafe for cleanup.', 503);
        }
        fs.unlinkSync(filename);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    this.sqlite.prepare('DELETE FROM gateway_attachments WHERE workspace_id = ?').run(workspaceId);
  }

  read(id: string, workspaceId: string): ProviderAttachment & { dataBase64: string } {
    this.workspace(workspaceId);
    const ref = this.sqlite.prepare(`SELECT id, workspace_id AS workspaceId, name, mime_type AS mimeType,
      byte_size AS byteSize, sha256, created_at AS createdAt FROM gateway_attachments WHERE id = ? AND workspace_id = ?`)
      .get(id, workspaceId) as AttachmentRef | undefined;
    if (!ref) fail('Attachment not found in this workspace.', 404, 'ATTACHMENT_NOT_FOUND');
    const providerPath = this.file(ref);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(providerPath); }
    catch (error: any) {
      if (error.code === 'ENOENT') fail('Attachment file is missing.', 409, 'ATTACHMENT_CHANGED');
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== ref.byteSize || stat.size > MAX_ATTACHMENT_BYTES
      || fs.realpathSync(providerPath) !== providerPath) fail('Attachment file is unsafe or changed.', 409, 'ATTACHMENT_CHANGED');
    const data = fs.readFileSync(providerPath);
    if (digest(data) !== ref.sha256) fail('Attachment bytes changed.', 409, 'ATTACHMENT_CHANGED');
    return { ...ref, providerPath, dataBase64: data.toString('base64') };
  }

  resolve(ids: unknown, workspaceId: string): ProviderAttachment[] {
    const { attachmentIds } = normalizeOrchestratorRequestOptions({ attachmentIds: ids as string[] });
    let total = 0;
    return attachmentIds.map((id) => {
      const { dataBase64: _data, ...ref } = this.read(id, workspaceId);
      total += ref.byteSize;
      if (total > MAX_TURN_ATTACHMENT_BYTES) fail('Turn attachments exceed 25 MiB combined.', 413);
      return ref;
    });
  }
}

/** Register after gateway auth middleware; global JSON parser allows 14 MiB on this route only. */
export function installAttachmentRoutes(app: Express, store: AttachmentStore, fenced: (workspaceId: string) => boolean): void {
  app.post('/api/attachments', (req, res) => {
    try {
      if (fenced(req.body?.workspaceId)) return void res.status(409).json({ code: 'DELETION_IN_PROGRESS', error: 'Workspace deletion is in progress.' });
      res.status(201).json(store.upload(req.body || {}));
    } catch (error: any) { res.status(error.statusCode || 500).json({ code: error.code, error: error.message }); }
  });
  app.get('/api/attachments/:id', (req, res) => {
    try {
      if (typeof req.query.workspaceId !== 'string') return void res.status(400).json({ error: 'workspaceId is required.' });
      if (fenced(req.query.workspaceId)) return void res.status(409).json({ code: 'DELETION_IN_PROGRESS', error: 'Workspace deletion is in progress.' });
      const { providerPath: _path, ...record } = store.read(String(req.params.id), req.query.workspaceId);
      res.setHeader('Cache-Control', 'no-store');
      res.json(record);
    } catch (error: any) { res.status(error.statusCode || 500).json({ code: error.code, error: error.message }); }
  });
}
